import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { prepareQuery } from './sql.js';
import { QueryRunner, serializeRun, toCsv } from './runner.js';
import { TEMPLATES } from './templates.js';
import { DESCRIPTIONS } from './descriptions.js';

/**
 * @param {object} deps
 * @param {import('./trino.js').TrinoClient} deps.client
 * @param {import('./store.js').Store} deps.store
 * @param {object} deps.config
 */
export function createApp({ client, store, config }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const runner = new QueryRunner(client, {
    maxRows: config.maxRows,
    onFinish(run) {
      store.addHistory({
        id: run.id,
        sql: run.sql,
        state: run.state,
        rowCount: run.rows.length,
        truncated: run.truncated,
        elapsedMs: run.elapsedMs,
        error: run.error?.message ?? null,
        savedQueryId: run.meta.savedQueryId ?? null,
        startedAt: run.startedAt,
      });
    },
  });

  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  app.get('/api/health', wrap(async (_req, res) => {
    const info = await client.info();
    res.json({ ok: !info.starting, trino: info.nodeVersion?.version ?? null });
  }));

  app.get('/api/config', wrap(async (_req, res) => {
    let version = null;
    try { version = (await client.info()).nodeVersion?.version ?? null; } catch { /* trino down */ }
    res.json({
      trinoServer: config.trinoServerDisplay ?? config.trinoServer,
      trinoVersion: version,
      catalog: config.catalog,
      schema: config.schema,
      maxRows: config.maxRows,
      allowWrites: config.allowWrites,
    });
  }));

  // ---- Schema browser -------------------------------------------------------
  let schemaCache = null;
  app.get('/api/schema', wrap(async (req, res) => {
    if (!schemaCache || req.query.refresh || Date.now() - schemaCache.at > 60_000) {
      schemaCache = { at: Date.now(), value: await loadSchema(client, config.schemas, config.seedTarget) };
    }
    res.json(schemaCache.value);
  }));

  app.get('/api/templates', (_req, res) => res.json(TEMPLATES));

  // ---- Query runs -----------------------------------------------------------
  app.post('/api/runs', (req, res) => {
    let sql;
    try {
      sql = prepareQuery(req.body?.sql, { allowWrites: config.allowWrites });
    } catch (e) {
      return res.status(400).json({ error: { message: e.message } });
    }
    const run = runner.start(sql, { savedQueryId: req.body?.savedQueryId });
    res.status(201).json(serializeRun(run));
  });

  app.get('/api/runs/:id', wrap(async (req, res) => {
    const run = runner.get(req.params.id);
    if (!run) return res.status(404).json({ error: { message: 'Run not found (results expire after a while; re-run the query).' } });
    // Long-poll briefly so the UI gets the final state without hammering us.
    if (!run.finishedAt && req.query.wait) {
      await Promise.race([run.done, new Promise(r => setTimeout(r, Math.min(Number(req.query.wait) || 0, 5000)))]);
    }
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(10000, Math.max(0, parseInt(req.query.limit ?? '1000', 10) || 0));
    res.json(serializeRun(run, { offset, limit }));
  }));

  app.post('/api/runs/:id/cancel', (req, res) => {
    const run = runner.cancel(req.params.id);
    if (!run) return res.status(404).json({ error: { message: 'Run not found' } });
    res.json(serializeRun(run));
  });

  app.get('/api/runs/:id/csv', (req, res) => {
    const run = runner.get(req.params.id);
    if (!run || !run.finishedAt) return res.status(404).json({ error: { message: 'Results not available' } });
    const name = String(req.query.filename || 'query_results').replace(/[^\w.-]+/g, '_').slice(0, 100);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(toCsv(run.columns, run.rows));
  });

  app.get('/api/history', (_req, res) => res.json(store.listHistory()));

  // ---- Saved queries --------------------------------------------------------
  app.get('/api/queries', (_req, res) => res.json(store.listSaved()));
  app.get('/api/queries/:id', (req, res) => {
    const q = store.getSaved(req.params.id);
    if (!q) return res.status(404).json({ error: { message: 'Query not found' } });
    res.json(q);
  });
  app.post('/api/queries', (req, res) => res.status(201).json(store.createSaved(req.body || {})));
  app.put('/api/queries/:id', (req, res) => {
    const q = store.updateSaved(req.params.id, req.body || {});
    if (!q) return res.status(404).json({ error: { message: 'Query not found' } });
    res.json(q);
  });
  app.delete('/api/queries/:id', (req, res) => {
    if (!store.deleteSaved(req.params.id)) return res.status(404).json({ error: { message: 'Query not found' } });
    res.status(204).end();
  });

  // ---- Static frontend ------------------------------------------------------
  if (config.webDist && fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: { message: 'Not found' } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(502).json({ error: { message: err.message || 'Internal error' } });
  });

  app.locals.runner = runner;
  return app;
}

/**
 * Load tables + columns for each "catalog.schema" (or whole "catalog") in `targets`.
 * Column docs from descriptions.js are attached to tables in `describedSchema`.
 */
export async function loadSchema(client, targets, describedSchema = null) {
  const out = [];
  for (const target of targets) {
    const [catalog, schema] = target.split('.');
    if (!/^\w+$/.test(catalog) || (schema && !/^\w+$/.test(schema))) continue;
    const where = schema
      ? `table_schema = '${schema}'`
      : `table_schema <> 'information_schema'`;
    let rows;
    try {
      ({ rows } = await client.query(
        `SELECT table_schema, table_name, column_name, data_type
         FROM ${catalog}.information_schema.columns
         WHERE ${where}
         ORDER BY table_schema, table_name, ordinal_position`,
      ));
    } catch (e) {
      out.push({ catalog, schema: schema ?? null, error: e.message, tables: [] });
      continue;
    }
    const bySchema = new Map();
    for (const [s, t, c, ty] of rows) {
      if (!bySchema.has(s)) bySchema.set(s, new Map());
      const tables = bySchema.get(s);
      const docs = `${catalog}.${s}` === describedSchema ? DESCRIPTIONS[t] : undefined;
      if (!tables.has(t)) {
        tables.set(t, { name: t, description: docs?._table ?? null, columns: [] });
      }
      tables.get(t).columns.push({ name: c, type: ty, description: docs?.[c] ?? null });
    }
    if (schema && !bySchema.has(schema)) bySchema.set(schema, new Map());
    for (const [s, tables] of bySchema) {
      out.push({ catalog, schema: s, tables: [...tables.values()] });
    }
  }
  return out;
}
