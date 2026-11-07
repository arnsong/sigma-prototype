// Tiny JSON-file persistence: saved queries, run history, scheduled-run snapshots,
// assistant chat history and metric groups.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HISTORY_LIMIT = 200;
export const MAX_METRIC_REPORTS = 20; // Sigma: "You can add up to 20 Sigma reports across all metric groups."

const EMPTY = () => ({ saved: [], history: [], snapshots: [], assistant: {}, metricGroups: [] });

export class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    if (file && fs.existsSync(file)) {
      try {
        this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (e) {
        console.warn(`Could not read ${file}, starting empty: ${e.message}`);
      }
    }
  }

  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ---- saved queries ---------------------------------------------------------
  listSaved() {
    return [...this.data.saved].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSaved(id) {
    return this.data.saved.find(q => q.id === id);
  }

  createSaved({ title, sql, description = '', chart = null, assistantKey = null, createdBy = null }) {
    const now = new Date().toISOString();
    const q = { id: crypto.randomUUID(), title: title || 'Untitled query', sql: sql || '', description, chart: validChart(chart), createdBy, createdAt: now, updatedAt: now };
    this.data.saved.push(q);
    // A draft's assistant conversation follows it when it is saved.
    if (assistantKey && this.data.assistant[assistantKey]) {
      this.data.assistant[q.id] = this.data.assistant[assistantKey];
      delete this.data.assistant[assistantKey];
    }
    this.flush();
    return q;
  }

  updateSaved(id, patch) {
    const q = this.getSaved(id);
    if (!q) return undefined;
    for (const k of ['title', 'sql', 'description']) if (typeof patch[k] === 'string') q[k] = patch[k];
    if ('chart' in patch) q.chart = validChart(patch.chart);
    q.updatedAt = new Date().toISOString();
    this.flush();
    return q;
  }

  deleteSaved(id) {
    const before = this.data.saved.length;
    this.data.saved = this.data.saved.filter(q => q.id !== id);
    this.data.snapshots = this.data.snapshots.filter(s => s.queryId !== id);
    delete this.data.assistant[id];
    for (const g of this.data.metricGroups) g.queryIds = g.queryIds.filter(q => q !== id);
    this.flush();
    return this.data.saved.length !== before;
  }

  // ---- run history -----------------------------------------------------------
  addHistory(entry) {
    this.data.history.unshift(entry);
    this.data.history.length = Math.min(this.data.history.length, HISTORY_LIMIT);
    this.flush();
  }

  listHistory() {
    return this.data.history;
  }

  // ---- assistant chat history (per saved query, or per draft key) -----------
  listChat(key) {
    return this.data.assistant[key] || [];
  }

  addChat(key, entry) {
    const e = { id: crypto.randomUUID(), at: new Date().toISOString(), feedback: null, ...entry };
    (this.data.assistant[key] ||= []).push(e);
    this.flush();
    return e;
  }

  setChatFeedback(key, id, feedback) {
    const e = this.listChat(key).find(x => x.id === id);
    if (!e) return undefined;
    e.feedback = { helpful: Boolean(feedback.helpful), details: String(feedback.details || '').slice(0, 4000), at: new Date().toISOString() };
    this.flush();
    return e;
  }

  // ---- metric groups ---------------------------------------------------------
  listMetricGroups() {
    return this.data.metricGroups;
  }

  metricReportCount() {
    return this.data.metricGroups.reduce((n, g) => n + g.queryIds.length, 0);
  }

  getMetricGroup(id) {
    return this.data.metricGroups.find(x => x.id === id);
  }

  createMetricGroup(name, createdBy = null) {
    const g = { id: crypto.randomUUID(), name: String(name || '').trim() || 'Untitled group', queryIds: [], createdBy, createdAt: new Date().toISOString() };
    this.data.metricGroups.push(g);
    this.flush();
    return g;
  }

  renameMetricGroup(id, name) {
    const g = this.data.metricGroups.find(x => x.id === id);
    if (!g) return undefined;
    g.name = String(name || '').trim() || g.name;
    this.flush();
    return g;
  }

  deleteMetricGroup(id) {
    const before = this.data.metricGroups.length;
    this.data.metricGroups = this.data.metricGroups.filter(g => g.id !== id);
    this.flush();
    return before !== this.data.metricGroups.length;
  }

  addMetric(groupId, queryId) {
    const g = this.data.metricGroups.find(x => x.id === groupId);
    if (!g) throw Object.assign(new Error('Metric group not found'), { status: 404 });
    if (!this.getSaved(queryId)) throw Object.assign(new Error('Query not found'), { status: 404 });
    if (g.queryIds.includes(queryId)) return g;
    if (this.metricReportCount() >= MAX_METRIC_REPORTS) {
      throw Object.assign(new Error(`You can add up to ${MAX_METRIC_REPORTS} reports across all metric groups.`), { status: 400 });
    }
    g.queryIds.push(queryId);
    this.flush();
    return g;
  }

  removeMetric(groupId, queryId) {
    const g = this.data.metricGroups.find(x => x.id === groupId);
    if (!g) return undefined;
    g.queryIds = g.queryIds.filter(q => q !== queryId);
    this.flush();
    return g;
  }
}

/** Records made before identities existed (no createdBy) stay editable by anyone. */
export const isAuthor = (obj, user) => !obj?.createdBy || obj.createdBy === user;

/** Saved chart settings: { kind: 'line'|'bar', x, y: [], groupBy } by column name. */
export function validChart(c) {
  if (!c || typeof c !== 'object') return null;
  const kind = c.kind === 'bar' ? 'bar' : 'line';
  const str = v => (typeof v === 'string' && v ? v.slice(0, 200) : null);
  const y = Array.isArray(c.y) ? c.y.map(str).filter(Boolean).slice(0, 8) : [];
  return { kind, x: str(c.x), y, groupBy: str(c.groupBy) };
}
