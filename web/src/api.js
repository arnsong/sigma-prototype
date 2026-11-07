const USER_KEY = 'query-studio.user';
export function getUser() {
  try { return localStorage.getItem(USER_KEY) || null; } catch { return null; }
}
export function setUser(email) {
  try { email ? localStorage.setItem(USER_KEY, email) : localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
}

async function req(method, url, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const user = getUser();
  if (user) headers['X-User-Email'] = user;
  const res = await fetch(url, {
    method,
    headers,
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
  ask: ({ question, mode, sql, error, key }) => req('POST', '/api/assistant', { question, mode, sql, error, key }),
  chatHistory: key => req('GET', `/api/assistant/history?key=${encodeURIComponent(key)}`),
  chatFeedback: (key, id, feedback) => req('POST', '/api/assistant/feedback', { key, id, ...feedback }),
  title: sql => req('POST', '/api/title', { sql }),
  emailPreview: id => req('GET', `/api/queries/${id}/schedule/email-preview?format=json`),
  metricGroups: () => req('GET', '/api/metric-groups'),
  createMetricGroup: name => req('POST', '/api/metric-groups', { name }),
  renameMetricGroup: (id, name) => req('PUT', `/api/metric-groups/${id}`, { name }),
  deleteMetricGroup: id => req('DELETE', `/api/metric-groups/${id}`),
  addMetric: (groupId, queryId) => req('POST', `/api/metric-groups/${groupId}/queries`, { queryId }),
  removeMetric: (groupId, queryId) => req('DELETE', `/api/metric-groups/${groupId}/queries/${queryId}`),
  setSchedule: (id, schedule) => req('PUT', `/api/queries/${id}/schedule`, schedule),
  clearSchedule: id => req('DELETE', `/api/queries/${id}/schedule`),
  runSnapshot: id => req('POST', `/api/queries/${id}/snapshots`),
  listSnapshots: id => req('GET', `/api/queries/${id}/snapshots`),
  getSnapshot: id => req('GET', `/api/snapshots/${id}`),
  snapshotCsvUrl: id => `/api/snapshots/${id}/csv`,
  csvUrl: (id, filename) => `/api/runs/${id}/csv?filename=${encodeURIComponent(filename)}`,
};

/** Start a run and wait for it, returning the run with up to `limit` rows. */
export async function runToCompletion(sql, { savedQueryId, limit = 10000, isCurrent = () => true, onProgress } = {}) {
  let r = await api.startRun(sql, savedQueryId);
  while (!r.done) {
    if (!isCurrent()) return null;
    onProgress?.(r);
    r = await api.getRun(r.id, { wait: 1500 });
  }
  if (r.state === 'FINISHED' && r.rowCount > 0) r = await api.getRun(r.id, { limit: Math.min(limit, r.rowCount) });
  return r;
}
