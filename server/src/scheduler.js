// Scheduled queries, modeled on Sigma's documented behavior:
// - run daily, weekly or monthly "as soon as the data for that period is available"
//   (here the data is live, so a run fires when the period closes at 00:00 UTC);
// - results go to email subscribers (name, date and a CSV download link, with an
//   unsubscribe link) and/or a webhook event `sigma.scheduled_query_run.created`;
// - the timeline shows the next run and the data period it covers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prepareQuery } from './sql.js';
import { toCsv } from './runner.js';

export const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const KEEP_SNAPSHOTS = 20;
const RESULT_RETENTION_MS = 7 * 86400_000;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Start of the period after the one containing `d` (UTC). Weeks end Sunday 24:00 UTC. */
function nextBoundary(frequency, d) {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (frequency === 'daily') day.setUTCDate(day.getUTCDate() + 1);
  else if (frequency === 'weekly') day.setUTCDate(day.getUTCDate() + (((8 - day.getUTCDay()) % 7) || 7));
  else { day.setUTCDate(1); day.setUTCMonth(day.getUTCMonth() + 1); }
  return day;
}

/** Next run strictly after `from`: when the current daily/weekly/monthly period closes. */
export function nextRunAt(schedule, from = new Date()) {
  return nextBoundary(schedule.frequency, from);
}

/** The data period a run at `runAt` reports on: [start, end). */
export function dataPeriod(frequency, runAt) {
  const end = new Date(runAt);
  const start = new Date(end);
  if (frequency === 'daily') start.setUTCDate(start.getUTCDate() - 1);
  else if (frequency === 'weekly') start.setUTCDate(start.getUTCDate() - 7);
  else start.setUTCMonth(start.getUTCMonth() - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function validateSchedule(input) {
  const frequency = input?.frequency;
  if (!FREQUENCIES.includes(frequency)) throw new Error(`frequency must be one of ${FREQUENCIES.join(', ')}`);
  const subscribers = [...new Set((Array.isArray(input.subscribers) ? input.subscribers : String(input.subscribers || '').split(/[\s,;]+/))
    .map(e => String(e).trim().toLowerCase()).filter(Boolean))];
  for (const e of subscribers) if (!EMAIL_RE.test(e)) throw new Error(`"${e}" is not a valid email address`);
  if (subscribers.length > 50) throw new Error('A scheduled query can have at most 50 subscribers');
  const webhookUrl = (input.webhookUrl || '').trim();
  if (webhookUrl && !/^https?:\/\//i.test(webhookUrl)) throw new Error('webhookUrl must be an http(s) URL');
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
  return { frequency, subscribers, webhookUrl: webhookUrl || null, title };
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDay = iso => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

export class Scheduler {
  /**
   * @param {object} opts
   * @param {import('./trino.js').TrinoClient} opts.client
   * @param {import('./store.js').Store} opts.store
   * @param {string|null} opts.dataDir
   * @param {number} opts.maxRows
   * @param {boolean} [opts.allowWrites]
   * @param {string} [opts.publicUrl]  absolute base URL used in emails and webhook file URLs
   * @param {{sendMail: (msg: object) => Promise<any>}|null} [opts.mailer]
   * @param {string} [opts.mailFrom]
   * @param {string} [opts.secret]  signs unsubscribe links
   */
  constructor({ client, store, dataDir, maxRows, allowWrites = false, fetch = globalThis.fetch, log = console.log,
    publicUrl = 'http://localhost:3001', mailer = null, mailFrom = 'Query Studio <reports@localhost>', secret }) {
    Object.assign(this, { client, store, maxRows, allowWrites, fetch, log, mailer, mailFrom });
    this.publicUrl = publicUrl.replace(/\/+$/, '');
    this.secret = secret || (store.data.secret ||= crypto.randomBytes(32).toString('hex'));
    this.dir = dataDir ? path.join(dataDir, 'snapshots') : null;
    this.memory = new Map();
    this.running = new Set();
  }

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => this.tick().catch(e => this.log('[scheduler]', e.message)), intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  /** Next run + the data period it covers, for the UI timeline. */
  timeline(schedule) {
    return { nextRunAt: schedule.nextRunAt, dataPeriod: dataPeriod(schedule.frequency, schedule.nextRunAt) };
  }

  setSchedule(queryId, input, { creator = null } = {}) {
    const q = this.store.getSaved(queryId);
    if (!q) return undefined;
    const { title, ...schedule } = validateSchedule(input);
    if (title) {
      const clash = this.store.listSaved().find(o => o.id !== q.id && o.schedule && o.title.toLowerCase() === title.toLowerCase());
      if (clash) throw new Error(`Another scheduled query is already named "${title}". Give each scheduled query a unique name.`);
      q.title = title;
    }
    // "Creators of scheduled queries are added as subscribers to email notifications by default."
    if (!q.schedule && creator && EMAIL_RE.test(creator) && !schedule.subscribers.includes(creator.toLowerCase())) {
      schedule.subscribers.unshift(creator.toLowerCase());
    }
    schedule.createdAt = q.schedule?.createdAt ?? new Date().toISOString();
    schedule.createdBy = q.schedule ? q.schedule.createdBy ?? null : creator ?? null;
    schedule.nextRunAt = nextRunAt(schedule).toISOString();
    q.schedule = schedule;
    q.updatedAt = new Date().toISOString();
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

  unsubscribeToken(queryId, email) {
    return crypto.createHmac('sha256', this.secret).update(`${queryId}:${email.toLowerCase()}`).digest('hex').slice(0, 32);
  }

  unsubscribe(queryId, email, token) {
    const q = this.store.getSaved(queryId);
    if (!q?.schedule) return false;
    const expected = this.unsubscribeToken(queryId, email);
    if (typeof token !== 'string' || token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return false;
    q.schedule.subscribers = q.schedule.subscribers.filter(s => s !== email.toLowerCase());
    this.store.flush();
    return true;
  }

  async tick(now = new Date()) {
    for (const q of this.store.listSaved()) {
      if (q.schedule && Date.parse(q.schedule.nextRunAt) <= now.getTime()) {
        const ranFor = q.schedule.nextRunAt;
        q.schedule.nextRunAt = nextRunAt(q.schedule, now).toISOString();
        this.store.flush();
        await this.runNow(q.id, { periodEnd: ranFor });
      }
    }
  }

  /** Run a saved query immediately, record a snapshot and deliver it. */
  async runNow(queryId, { periodEnd = null } = {}) {
    const q = this.store.getSaved(queryId);
    if (!q) return undefined;
    if (this.running.has(queryId)) throw new Error('This query is already running');
    this.running.add(queryId);
    const ranAt = new Date();
    const snap = {
      id: `sqr_${crypto.randomBytes(10).toString('hex')}`, queryId, title: q.title, sql: q.sql,
      ranAt: ranAt.toISOString(), dataLoadTime: periodEnd ?? ranAt.toISOString(),
      resultAvailableUntil: new Date(ranAt.getTime() + RESULT_RETENTION_MS).toISOString(),
      state: 'FINISHED', rowCount: 0, truncated: false, error: null, elapsedMs: 0, size: 0,
    };
    const t0 = Date.now();
    let columns = [];
    let rows = [];
    try {
      const sql = prepareQuery(q.sql, { allowWrites: this.allowWrites });
      ({ columns, rows } = await this.client.query(sql, { maxRows: this.maxRows + 1 }));
      if (rows.length > this.maxRows) { rows = rows.slice(0, this.maxRows); snap.truncated = true; }
      snap.rowCount = rows.length;
      snap.size = Buffer.byteLength(toCsv(columns, rows));
    } catch (e) {
      snap.state = 'FAILED';
      snap.error = e.message;
    } finally {
      snap.elapsedMs = Date.now() - t0;
      this.running.delete(queryId);
    }
    this.saveSnapshot(snap, { columns, rows });
    if (q.schedule?.webhookUrl) await this.notifyWebhook(q, snap);
    if (q.schedule?.subscribers?.length) await this.notifyEmail(q, snap);
    return snap;
  }

  csvUrl(snap) {
    return `${this.publicUrl}/api/snapshots/${snap.id}/csv`;
  }

  /** Payload in the shape Sigma documents for `sigma.scheduled_query_run.created`. */
  webhookEvent(q, snap) {
    const secs = iso => Math.floor(Date.parse(iso) / 1000);
    return {
      id: `evt_${crypto.randomBytes(12).toString('hex')}`,
      object: 'event',
      created: secs(snap.ranAt),
      type: 'sigma.scheduled_query_run.created',
      data: {
        object: {
          id: snap.id,
          object: 'scheduled_query_run',
          status: snap.state === 'FINISHED' ? 'completed' : 'failed',
          data_load_time: secs(snap.dataLoadTime),
          file: snap.state === 'FINISHED'
            ? { id: `file_${snap.id.slice(4)}`, object: 'file', url: this.csvUrl(snap), created: secs(snap.ranAt), purpose: 'sigma_scheduled_query', size: snap.size, type: 'csv' }
            : null,
          title: q.title,
          sql: snap.sql,
          created: secs(snap.ranAt),
          result_available_until: secs(snap.resultAvailableUntil),
          error: snap.error ? { message: snap.error } : null,
        },
      },
    };
  }

  async notifyWebhook(q, snap) {
    try {
      await this.fetch(q.schedule.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.webhookEvent(q, snap)),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.log(`[scheduler] webhook for "${q.title}" failed: ${e.message}`);
    }
  }

  /** The email a subscriber receives: name and date of the run plus a CSV link. */
  renderEmail(q, snap, recipient) {
    const date = fmtDay(snap.ranAt);
    const ok = snap.state === 'FINISHED';
    const unsub = recipient
      ? `${this.publicUrl}/api/unsubscribe?query=${encodeURIComponent(q.id)}&email=${encodeURIComponent(recipient)}&token=${this.unsubscribeToken(q.id, recipient)}`
      : '#';
    const subject = `${q.title} — ${date}`;
    const body = ok
      ? `<p style="margin:0 0 16px">Your scheduled query <strong>${esc(q.title)}</strong> ran on ${esc(date)} and returned ${snap.rowCount.toLocaleString('en-US')} rows.</p>
         <p style="margin:0 0 24px"><a href="${esc(this.csvUrl(snap))}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">Download results (CSV)</a></p>
         <p style="margin:0;color:#6b7280;font-size:13px">This link is available until ${esc(fmtDay(snap.resultAvailableUntil))}.</p>`
      : `<p style="margin:0 0 16px">Your scheduled query <strong>${esc(q.title)}</strong> failed on ${esc(date)}:</p><pre style="white-space:pre-wrap;background:#fef2f2;color:#991b1b;padding:12px;border-radius:6px">${esc(snap.error)}</pre>`;
    const html = `<!doctype html><html><body style="margin:0;background:#f6f8fa;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1f36">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #e3e8ee;border-radius:10px">
<tr><td style="padding:24px 28px;border-bottom:1px solid #e3e8ee;font-weight:600;font-size:16px">Scheduled query results</td></tr>
<tr><td style="padding:24px 28px;font-size:14px;line-height:1.5">
<h1 style="margin:0 0 4px;font-size:20px">${esc(q.title)}</h1>
<p style="margin:0 0 20px;color:#6b7280">${esc(q.schedule?.frequency ? q.schedule.frequency[0].toUpperCase() + q.schedule.frequency.slice(1) : '')} report · ${esc(date)}</p>
${body}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e3e8ee;color:#6b7280;font-size:12px">You're receiving this because you subscribed to this scheduled query. <a href="${esc(unsub)}" style="color:#6b7280">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
    const text = `${q.title} — ${date}\n\n${ok ? `${snap.rowCount} rows. Download: ${this.csvUrl(snap)}` : `Failed: ${snap.error}`}\n\nUnsubscribe: ${unsub}\n`;
    return { subject, html, text };
  }

  /** Preview using the latest run, or a sample when the query hasn't run yet. */
  previewEmail(queryId) {
    const q = this.store.getSaved(queryId);
    if (!q) return undefined;
    const last = this.listSnapshots(queryId)[0];
    const now = new Date().toISOString();
    const snap = last ?? { id: 'sqr_preview', ranAt: now, resultAvailableUntil: new Date(Date.now() + RESULT_RETENTION_MS).toISOString(), state: 'FINISHED', rowCount: 0 };
    return this.renderEmail(q, snap, q.schedule?.subscribers?.[0] ?? null);
  }

  async notifyEmail(q, snap) {
    if (!this.mailer) {
      this.log(`[scheduler] email delivery not configured (set SMTP_URL); skipped ${q.schedule.subscribers.length} subscriber(s) for "${q.title}"`);
      return;
    }
    for (const to of q.schedule.subscribers) {
      const { subject, html, text } = this.renderEmail(q, snap, to);
      try {
        await this.mailer.sendMail({ from: this.mailFrom, to, subject, html, text });
      } catch (e) {
        this.log(`[scheduler] email to ${to} for "${q.title}" failed: ${e.message}`);
      }
    }
  }

  saveSnapshot(snap, data) {
    const all = this.store.data.snapshots;
    all.unshift(snap);
    const mine = all.filter(s => s.queryId === snap.queryId);
    const drop = new Set(mine.slice(KEEP_SNAPSHOTS).map(s => s.id));
    for (const id of drop) this.deleteSnapshotData(id);
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
    return this.store.data.snapshots.filter(s => s.queryId === queryId);
  }

  getSnapshot(id) {
    const meta = this.store.data.snapshots.find(s => s.id === id);
    if (!meta) return undefined;
    let data = this.memory.get(id);
    if (!data && this.dir) {
      try { data = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')); } catch { data = null; }
    }
    return { ...meta, ...(data || { columns: [], rows: [] }) };
  }
}
