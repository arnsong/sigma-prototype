async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  config: () => req('GET', '/api/config'),
  schema: (refresh = false) => req('GET', `/api/schema${refresh ? '?refresh=1' : ''}`),
  templates: () => req('GET', '/api/templates'),
  history: () => req('GET', '/api/history'),
  listQueries: () => req('GET', '/api/queries'),
  getQuery: id => req('GET', `/api/queries/${id}`),
  createQuery: q => req('POST', '/api/queries', q),
  updateQuery: (id, q) => req('PUT', `/api/queries/${id}`, q),
  deleteQuery: id => req('DELETE', `/api/queries/${id}`),
  startRun: (sql, savedQueryId) => req('POST', '/api/runs', { sql, savedQueryId }),
  getRun: (id, { wait = 0, offset = 0, limit = 0 } = {}) =>
    req('GET', `/api/runs/${id}?wait=${wait}&offset=${offset}&limit=${limit}`),
  cancelRun: id => req('POST', `/api/runs/${id}/cancel`),
  ask: (question, sql, error) => req('POST', '/api/assistant', { question, sql, error }),
  setSchedule: (id, schedule) => req('PUT', `/api/queries/${id}/schedule`, schedule),
  clearSchedule: id => req('DELETE', `/api/queries/${id}/schedule`),
  runSnapshot: id => req('POST', `/api/queries/${id}/snapshots`),
  listSnapshots: id => req('GET', `/api/queries/${id}/snapshots`),
  getSnapshot: id => req('GET', `/api/snapshots/${id}`),
  snapshotCsvUrl: id => `/api/snapshots/${id}/csv`,
  csvUrl: (id, filename) => `/api/runs/${id}/csv?filename=${encodeURIComponent(filename)}`,
};
