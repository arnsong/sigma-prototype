// Runs user queries against Trino asynchronously so the UI can poll progress,
// page through results, cancel, and download CSV.
import crypto from 'node:crypto';
import { toTrinoError } from './trino.js';

const KEEP_RUNS = 50;

export class QueryRunner {
  /**
   * @param {import('./trino.js').TrinoClient} client
   * @param {{maxRows?: number, onFinish?: (run) => void}} [opts]
   */
  constructor(client, { maxRows = 10000, onFinish } = {}) {
    this.client = client;
    this.maxRows = maxRows;
    this.onFinish = onFinish;
    this.runs = new Map();
  }

  start(sql, meta = {}) {
    const run = {
      id: crypto.randomUUID(),
      sql,
      meta,
      state: 'QUEUED',
      trinoQueryId: null,
      infoUri: null,
      columns: [],
      rows: [],
      truncated: false,
      totalRows: 0,
      progress: 0,
      stats: {},
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      elapsedMs: 0,
      controller: new AbortController(),
    };
    this.runs.set(run.id, run);
    this.evict();
    run.done = this.execute(run);
    return run;
  }

  async execute(run) {
    const t0 = Date.now();
    try {
      for await (const page of this.client.pages(run.sql, { signal: run.controller.signal })) {
        run.trinoQueryId = page.id;
        run.infoUri = page.infoUri;
        if (page.stats) {
          run.state = page.stats.state === 'QUEUED' ? 'QUEUED' : 'RUNNING';
          run.progress = page.stats.progressPercentage ?? run.progress;
          run.stats = {
            processedRows: page.stats.processedRows,
            processedBytes: page.stats.processedBytes,
            cpuTimeMillis: page.stats.cpuTimeMillis,
            wallTimeMillis: page.stats.wallTimeMillis,
            elapsedTimeMillis: page.stats.elapsedTimeMillis,
            peakMemoryBytes: page.stats.peakMemoryBytes,
          };
        }
        if (page.error) {
          throw toTrinoError(page.error);
        }
        if (page.columns && run.columns.length === 0) {
          run.columns = page.columns.map(c => ({ name: c.name, type: c.type }));
        }
        if (page.data) {
          run.totalRows += page.data.length;
          for (const row of page.data) {
            if (run.rows.length < this.maxRows) run.rows.push(row);
            else run.truncated = true;
          }
          if (run.truncated) {
            // We have as many rows as we keep; stop the query rather than streaming everything.
            run.controller.abort();
          }
        }
      }
      if (run.state !== 'CANCELED') {
        run.state = run.controller.signal.aborted && !run.truncated ? 'CANCELED' : 'FINISHED';
      }
      run.progress = run.state === 'FINISHED' ? 100 : run.progress;
    } catch (e) {
      if (run.controller.signal.aborted && e.name === 'AbortError') {
        run.state = run.truncated ? 'FINISHED' : 'CANCELED';
      } else {
        run.state = 'FAILED';
        run.error = {
          message: e.message,
          errorName: e.errorName,
          errorType: e.errorType,
          line: e.line,
          column: e.column,
        };
      }
    } finally {
      if (run.controller.signal.aborted && run.trinoQueryId) {
        this.client.cancelQuery(run.trinoQueryId);
      }
      run.elapsedMs = Date.now() - t0;
      run.finishedAt = new Date().toISOString();
      this.onFinish?.(run);
    }
  }

  get(id) {
    return this.runs.get(id);
  }

  cancel(id) {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (run.state === 'QUEUED' || run.state === 'RUNNING') {
      run.state = 'CANCELED';
      run.controller.abort();
    }
    return run;
  }

  evict() {
    if (this.runs.size <= KEEP_RUNS) return;
    for (const [id, run] of this.runs) {
      if (this.runs.size <= KEEP_RUNS) break;
      if (run.finishedAt) this.runs.delete(id);
    }
  }
}

/** Public JSON view of a run. Rows are paged with offset/limit. */
export function serializeRun(run, { offset = 0, limit = 0 } = {}) {
  const done = !!run.finishedAt;
  return {
    id: run.id,
    sql: run.sql,
    state: run.state,
    done,
    trinoQueryId: run.trinoQueryId,
    progress: run.progress,
    stats: run.stats,
    columns: run.columns,
    rowCount: run.rows.length,
    truncated: run.truncated,
    rows: done && limit > 0 ? run.rows.slice(offset, offset + limit) : [],
    offset,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    elapsedMs: done ? run.elapsedMs : Date.now() - Date.parse(run.startedAt),
  };
}

export function toCsv(columns, rows) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(c => esc(c.name)).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  return lines.join('\r\n') + '\r\n';
}
