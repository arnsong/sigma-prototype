import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { prepareQuery } from './sql.js';
import { QueryRunner, serializeRun, toCsv } from './runner.js';
import { TEMPLATES } from './templates.js';
import { DESCRIPTIONS, CATEGORIES } from './descriptions.js';
import { heuristicTitle } from './assistant.js';
import { MAX_METRIC_REPORTS } from './store.js';

/**
 * @param {object} deps
 * @param {import('./trino.js').TrinoClient} deps.client
 * @param {import('./store.js').Store} deps.store
 * @param {object} deps.config
 * @param {import('./assistant.js').Assistant|null} [deps.assistant]
 * @param {import('./scheduler.js').Scheduler|null} [deps.scheduler]
 */
// Sigma: "View a maximum of 1,000 results" and charts "for queries with fewer than 10,000 results".
export const VIEW_ROWS = 1000;
export const CHART_ROW_LIMIT = 10000;

export function createApp({ client, store, config, assistant = null, scheduler = null }) {
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
      viewRows: VIEW_ROWS,
      chartRowLimit: CHART_ROW_LIMIT,
      maxMetricReports: MAX_METRIC_REPORTS,
      allowWrites: config.allowWrites,
      userEmail: config.userEmail ?? null,
      emailDelivery: Boolean(config.emailDelivery),
      assistant: Boolean(assistant),
      scheduling: Boolean(scheduler),
      dataFreshness: await freshness(),
    });
  }));

  // "Data available up to ..." indicator: the newest timestamp in the data, cached for a minute.
  let freshCache = null;
  async function freshness() {
    if (!config.freshnessQuery) return null;
    if (freshCache && Date.now() - freshCache.at < 60_000) return freshCache.value;
    let value = null;
    try {
      const { rows } = await client.query(config.freshnessQuery, { maxRows: 1 });
      value = rows[0]?.[0] ?? null;
    } catch { /* table may not exist yet (still seeding) */ }
    if (value) freshCache = { at: Date.now(), value };
    return value;
  }

  // ---- Schema browser -------------------------------------------------------
  let schemaCache = null;
  const getSchema = async (refresh = false) => {
    if (!schemaCache || refresh || Date.now() - schemaCache.at > 60_000) {
      schemaCache = { at: Date.now(), value: await loadSchema(client, config.schemas, config.seedTarget) };
    }
    return schemaCache.value;
  };
  app.get('/api/schema', wrap(async (req, res) => res.json(await getSchema(Boolean(req.query.refresh)))));

  // ---- Assistant (natural language -> SQL) ---------------------------------
  app.post('/api/assistant', wrap(async (req, res) => {
    if (!assistant) {
      return res.status(503).json({ error: { message: 'The assistant is not configured. Set ANTHROPIC_API_KEY on the server to enable it.' } });
    }
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: { message: 'Ask a question first.' } });
    const mode = req.body?.mode === 'edit' ? 'edit' : 'generate';
    const key = chatKey(req.body?.key);
    try {
      const answer = await assistant.ask({
        question: question.slice(0, 4000),
        mode,
        currentSql: String(req.body?.sql || '').slice(0, 20000),
        error: String(req.body?.error || '').slice(0, 4000),
        history: key ? store.listChat(key) : [],
      });
      const entry = key ? store.addChat(key, { prompt: question, mode, ...answer }) : { id: null, prompt: question, mode, ...answer };
      res.json(entry);
    } catch (e) {
      res.status(e.status && e.status < 500 ? 400 : 502).json({ error: { message: `Assistant error: ${e.message}` } });
    }
  }));

  // Chat history is kept per query "for the life of the query".
  const chatKey = k => (typeof k === 'string' && /^[\w-]{1,64}$/.test(k) ? k : null);
  app.get('/api/assistant/history', (req, res) => {
    const key = chatKey(req.query.key);
    res.json(key ? store.listChat(key) : []);
  });
  app.post('/api/assistant/feedback', (req, res) => {
    const key = chatKey(req.body?.key);
    const e = key && store.setChatFeedback(key, String(req.body?.id || ''), req.body || {});
    if (!e) return res.status(404).json({ error: { message: 'Assistant response not found' } });
    res.json(e);
  });

  // "Stripe automatically generates an editable title for your query."
  app.post('/api/title', wrap(async (req, res) => {
    const sql = String(req.body?.sql || '');
    let title = null;
    if (assistant) {
      try { title = await assistant.title(sql); } catch { /* fall back */ }
    }
    res.json({ title: title || heuristicTitle(sql) });
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
    if (!run.truncated) return res.send(toCsv(run.columns, run.rows));
    // "The downloaded CSV includes all query results": stream a fresh run without the row cap.
    streamCsv(run.sql, res).catch(e => { console.error('[csv]', e.message); res.end(); });
  });

  async function streamCsv(sql, res) {
    let header = false;
    for await (const page of client.pages(sql)) {
      if (page.error) { res.write(`\r\n# query failed: ${page.error.message}\r\n`); break; }
      if (page.columns && !header) { res.write(toCsv(page.columns, [])); header = true; }
      if (page.data?.length) {
        const chunk = toCsv([], page.data).replace(/^\r\n/, '');
        if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
      }
    }
    res.end();
  }

  app.get('/api/history', (_req, res) => res.json(store.listHistory()));

  // ---- Saved queries --------------------------------------------------------
  const view = q => (q.schedule && scheduler ? { ...q, timeline: scheduler.timeline(q.schedule) } : q);
  app.get('/api/queries', (_req, res) => res.json(store.listSaved().map(view)));
  app.get('/api/queries/:id', (req, res) => {
    const q = store.getSaved(req.params.id);
    if (!q) return res.status(404).json({ error: { message: 'Query not found' } });
    res.json(view(q));
  });
  app.post('/api/queries', (req, res) => {
    const body = req.body || {};
    res.status(201).json(store.createSaved({ ...body, assistantKey: chatKey(body.assistantKey) }));
  });
  app.put('/api/queries/:id', (req, res) => {
    const q = store.updateSaved(req.params.id, req.body || {});
    if (!q) return res.status(404).json({ error: { message: 'Query not found' } });
    res.json(view(q));
  });
  app.delete('/api/queries/:id', (req, res) => {
    if (!store.deleteSaved(req.params.id)) return res.status(404).json({ error: { message: 'Query not found' } });
    res.status(204).end();
  });

  // ---- Scheduled queries ----------------------------------------------------
  const needScheduler = (_req, res, next) => (scheduler ? next() : res.status(503).json({ error: { message: 'Scheduling is disabled' } }));
  app.put('/api/queries/:id/schedule', needScheduler, (req, res) => {
    let q;
    try {
      q = scheduler.setSchedule(req.params.id, req.body || {}, { creator: config.userEmail });
    } catch (e) {
      return res.status(400).json({ error: { message: e.message } });
    }
    if (!q) return res.status(404).json({ error: { message: 'Query not found' } });
    res.json(view(q));
  });
  app.get('/api/queries/:id/schedule/email-preview', needScheduler, (req, res) => {
    const email = scheduler.previewEmail(req.params.id);
    if (!email) return res.status(404).json({ error: { message: 'Query not found' } });
    if (req.query.format === 'json') return res.json(email);
    res.type('html').send(email.html);
  });
  app.get('/api/unsubscribe', needScheduler, (req, res) => {
    const ok = scheduler.unsubscribe(String(req.query.query || ''), String(req.query.email || ''), String(req.query.token || ''));
    res.status(ok ? 200 : 400).type('html').send(ok
      ? '<!doctype html><p style="font-family:sans-serif">You have been unsubscribed from this scheduled query.</p>'
      : '<!doctype html><p style="font-family:sans-serif">This unsubscribe link is invalid or has already been used.</p>');
  });
  app.delete('/api/queries/:id/schedule', needScheduler, (req, res) => {
    const q = scheduler.clearSchedule(req.params.id);
    if (!q) return res.status(404).json({ error: { message: 'Query not found' } });
    res.json(q);
  });
  app.post('/api/queries/:id/snapshots', needScheduler, wrap(async (req, res) => {
    const snap = await scheduler.runNow(req.params.id);
    if (!snap) return res.status(404).json({ error: { message: 'Query not found' } });
    res.status(201).json(snap);
  }));
  app.get('/api/queries/:id/snapshots', needScheduler, (req, res) => res.json(scheduler.listSnapshots(req.params.id)));
  app.get('/api/snapshots/:id', needScheduler, (req, res) => {
    const snap = scheduler.getSnapshot(req.params.id);
    if (!snap) return res.status(404).json({ error: { message: 'Snapshot not found' } });
    res.json(snap);
  });
  app.get('/api/snapshots/:id/csv', needScheduler, (req, res) => {
    const snap = scheduler.getSnapshot(req.params.id);
    if (!snap) return res.status(404).json({ error: { message: 'Snapshot not found' } });
    const name = `${snap.title}_${snap.ranAt.slice(0, 16)}`.replace(/[^\w.-]+/g, '_').slice(0, 100);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(toCsv(snap.columns, snap.rows));
  });

  // ---- Metric groups ---------------------------------------------------------
  const fail = (res, e) => res.status(e.status || 400).json({ error: { message: e.message } });
  app.get('/api/metric-groups', (_req, res) => res.json(store.listMetricGroups()));
  app.post('/api/metric-groups', (req, res) => res.status(201).json(store.createMetricGroup(req.body?.name)));
  app.put('/api/metric-groups/:id', (req, res) => {
    const g = store.renameMetricGroup(req.params.id, req.body?.name);
    if (!g) return res.status(404).json({ error: { message: 'Metric group not found' } });
    res.json(g);
  });
  app.delete('/api/metric-groups/:id', (req, res) => {
    if (!store.deleteMetricGroup(req.params.id)) return res.status(404).json({ error: { message: 'Metric group not found' } });
    res.status(204).end();
  });
  app.post('/api/metric-groups/:id/queries', (req, res) => {
    try { res.status(201).json(store.addMetric(req.params.id, String(req.body?.queryId || ''))); } catch (e) { fail(res, e); }
  });
  app.delete('/api/metric-groups/:id/queries/:queryId', (req, res) => {
    const g = store.removeMetric(req.params.id, req.params.queryId);
    if (!g) return res.status(404).json({ error: { message: 'Metric group not found' } });
    res.json(g);
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
        tables.set(t, { name: t, description: docs?._table ?? null, category: docs ? CATEGORIES[t] ?? null : null, columns: [] });
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
