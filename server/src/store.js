// Tiny JSON-file persistence for saved queries and run history.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HISTORY_LIMIT = 200;

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { saved: [], history: [], snapshots: [] };
    if (file && fs.existsSync(file)) {
      try {
        this.data = { saved: [], history: [], snapshots: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
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

  listSaved() {
    return [...this.data.saved].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSaved(id) {
    return this.data.saved.find(q => q.id === id);
  }

  createSaved({ title, sql, description = '' }) {
    const now = new Date().toISOString();
    const q = { id: crypto.randomUUID(), title: title || 'Untitled query', sql: sql || '', description, createdAt: now, updatedAt: now };
    this.data.saved.push(q);
    this.flush();
    return q;
  }

  updateSaved(id, patch) {
    const q = this.getSaved(id);
    if (!q) return undefined;
    for (const k of ['title', 'sql', 'description']) if (typeof patch[k] === 'string') q[k] = patch[k];
    q.updatedAt = new Date().toISOString();
    this.flush();
    return q;
  }

  deleteSaved(id) {
    const before = this.data.saved.length;
    this.data.saved = this.data.saved.filter(q => q.id !== id);
    this.data.snapshots = this.data.snapshots.filter(s => s.queryId !== id);
    this.flush();
    return this.data.saved.length !== before;
  }

  addHistory(entry) {
    this.data.history.unshift(entry);
    this.data.history.length = Math.min(this.data.history.length, HISTORY_LIMIT);
    this.flush();
  }

  listHistory() {
    return this.data.history;
  }
}
