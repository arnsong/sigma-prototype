// Runs saved queries on a daily/weekly/monthly schedule and keeps their results.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prepareQuery } from './sql.js';

export const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const KEEP_SNAPSHOTS = 20;

/**
 * Next run strictly after `from` (UTC). Weekly runs on Mondays, monthly on the 1st.
 * @param {{frequency: string, hour: number}} schedule
 */
export function nextRunAt(schedule, from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), schedule.hour, 0, 0));
  const advance = () => {
    if (schedule.frequency === 'daily') d.setUTCDate(d.getUTCDate() + 1);
    else if (schedule.frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + 1);
  };
  if (schedule.frequency === 'weekly') {
    const delta = (8 - d.getUTCDay()) % 7; // days until Monday
    d.setUTCDate(d.getUTCDate() + delta);
  } else if (schedule.frequency === 'monthly') {
    d.setUTCDate(1);
  }
  while (d <= from) advance();
  return d;
}

export function validateSchedule(input) {
  const frequency = input?.frequency;
  if (!FREQUENCIES.includes(frequency)) throw new Error(`frequency must be one of ${FREQUENCIES.join(', ')}`);
  const hour = Number(input.hour ?? 9);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('hour must be an integer 0–23 (UTC)');
  const webhookUrl = (input.webhookUrl || '').trim();
  if (webhookUrl && !/^https?:\/\//i.test(webhookUrl)) throw new Error('webhookUrl must be an http(s) URL');
  return { frequency, hour, webhookUrl: webhookUrl || null };
}

export class Scheduler {
  /**
   * @param {{client: import('./trino.js').TrinoClient, store: import('./store.js').Store, dataDir: string|null, maxRows: number, allowWrites?: boolean, fetch?: typeof fetch, log?: Function}} opts
   */
  constructor({ client, store, dataDir, maxRows, allowWrites = false, fetch = globalThis.fetch, log = console.log }) {
    Object.assign(this, { client, store, maxRows, allowWrites, fetch, log });
    this.dir = dataDir ? path.join(dataDir, 'snapshots') : null;
    this.memory = new Map(); // snapshot rows when there is no data dir (tests)
    this.running = new Set();
  }

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => this.tick().catch(e => this.log('[scheduler]', e.message)), intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  setSchedule(queryId, input) {
    const q = this.store.getSaved(queryId);
    if (!q) return undefined;
    const schedule = validateSchedule(input);
    schedule.nextRunAt = nextRunAt(schedule).toISOString();
    q.schedule = schedule;
    this.store.flush();
    return q;
  }

  clearSchedule(queryId) {
    const q = this.store.getSaved(queryId);
    if (!q) return undefined;
    delete q.schedule;
    this.store.flush();
    return q;
  }

  async tick(now = new Date()) {
    for (const q of this.store.listSaved()) {
      if (q.schedule && Date.parse(q.schedule.nextRunAt) <= now.getTime()) {
        q.schedule.nextRunAt = nextRunAt(q.schedule, now).toISOString();
        this.store.flush();
        await this.runNow(q.id);
      }
    }
  }

  /** Run a saved query immediately and record a snapshot. */
  async runNow(queryId) {
    const q = this.store.getSaved(queryId);
    if (!q) return undefined;
    if (this.running.has(queryId)) throw new Error('This query is already running');
    this.running.add(queryId);
    const snap = { id: crypto.randomUUID(), queryId, title: q.title, ranAt: new Date().toISOString(), state: 'FINISHED', rowCount: 0, truncated: false, error: null, elapsedMs: 0 };
    const t0 = Date.now();
    let columns = [];
    let rows = [];
    try {
      const sql = prepareQuery(q.sql, { allowWrites: this.allowWrites });
      ({ columns, rows } = await this.client.query(sql, { maxRows: this.maxRows + 1 }));
      if (rows.length > this.maxRows) { rows = rows.slice(0, this.maxRows); snap.truncated = true; }
      snap.rowCount = rows.length;
    } catch (e) {
      snap.state = 'FAILED';
      snap.error = e.message;
    } finally {
      snap.elapsedMs = Date.now() - t0;
      this.running.delete(queryId);
    }
    this.saveSnapshot(snap, { columns, rows });
    if (q.schedule?.webhookUrl) await this.notify(q, snap);
    return snap;
  }

  saveSnapshot(snap, data) {
    const all = this.store.data.snapshots ||= [];
    all.unshift(snap);
    const mine = all.filter(s => s.queryId === snap.queryId);
    for (const old of mine.slice(KEEP_SNAPSHOTS)) this.deleteSnapshotData(old.id);
    const drop = new Set(mine.slice(KEEP_SNAPSHOTS).map(s => s.id));
    this.store.data.snapshots = all.filter(s => !drop.has(s.id));
    this.store.flush();
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${snap.id}.json`), JSON.stringify(data));
    } else {
      this.memory.set(snap.id, data);
    }
  }

  deleteSnapshotData(id) {
    this.memory.delete(id);
    if (this.dir) fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }

  listSnapshots(queryId) {
    return (this.store.data.snapshots || []).filter(s => s.queryId === queryId);
  }

  getSnapshot(id) {
    const meta = (this.store.data.snapshots || []).find(s => s.id === id);
    if (!meta) return undefined;
    let data = this.memory.get(id);
    if (!data && this.dir) {
      try { data = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')); } catch { data = { columns: [], rows: [] }; }
    }
    return { ...meta, ...(data || { columns: [], rows: [] }) };
  }

  async notify(q, snap) {
    try {
      await this.fetch(q.schedule.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'scheduled_query.completed', query: { id: q.id, title: q.title }, snapshot: snap }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.log(`[scheduler] webhook for "${q.title}" failed: ${e.message}`);
    }
  }
}
