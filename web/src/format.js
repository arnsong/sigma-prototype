const NUMERIC = /^(tinyint|smallint|integer|bigint|real|double|decimal)/;
export const isNumericType = t => NUMERIC.test(t || '');
export const isTemporalType = t => /^(date|timestamp|time)/.test(t || '');

const intFmt = new Intl.NumberFormat(undefined);
/** Display text for a result cell; null means SQL NULL. Values are shown as Trino returns them. */
export function formatCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export const formatInt = n => intFmt.format(n);

export function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function timeAgo(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Compare two cell values for sorting, nulls last. */
export function compareCells(a, b, numeric) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (numeric) return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}
