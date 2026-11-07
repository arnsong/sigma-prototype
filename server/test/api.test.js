import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { TrinoClient } from '../src/trino.js';
import { startFakeTrino } from './fake-trino.js';
import { Scheduler } from '../src/scheduler.js';

async function withApp(fakeOpts, config, fn) {
  const fake = await startFakeTrino(fakeOpts);
  const client = new TrinoClient({ server: fake.url, user: 'tester', catalog: 'memory', schema: 'billing' });
  const store = new Store(null);
  const scheduler = new Scheduler({ client, store, dataDir: null, maxRows: 1000, log: () => {} });
  const assistant = config.assistant ?? null;
  const app = createApp({ client, store, scheduler, assistant, config: { maxRows: 1000, schemas: [], ...config } });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, user) => {
    const headers = body ? { 'content-type': 'application/json' } : {};
    if (user) headers['x-user-email'] = user;
    const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  try {
    await fn({ call, fake, app });
  } finally {
    server.close();
    await fake.close();
  }
}

async function waitDone(call, id) {
  for (;;) {
    const r = await call('GET', `/api/runs/${id}?wait=2000&limit=100`);
    if (r.body.done) return r.body;
  }
}

test('runs a query through every protocol page and returns rows', () => withApp({}, {}, async ({ call, fake }) => {
  const start = await call('POST', '/api/runs', { sql: 'select * from t;' });
  assert.equal(start.status, 201);
  const run = await waitDone(call, start.body.id);
  assert.equal(run.state, 'FINISHED');
  assert.equal(run.rowCount, 6);
  assert.deepEqual(run.columns.map(c => c.name), ['n', 's']);
  assert.deepEqual(run.rows.map(r => r[0]), [0, 1, 2, 3, 4, 5]);
  assert.equal(fake.statements[0].sql, 'select * from t');
  assert.equal(fake.statements[0].user, 'tester');
  assert.equal(fake.statements[0].catalog, 'memory');

  const page = await call('GET', `/api/runs/${run.id}?offset=4&limit=10`);
  assert.deepEqual(page.body.rows.map(r => r[0]), [4, 5]);

  const csv = await call('GET', `/api/runs/${run.id}/csv?filename=my report`);
  assert.match(csv.headers.get('content-disposition'), /my_report\.csv/);
  assert.equal(csv.body.split('\r\n')[0], 'n,s');
  assert.equal(csv.body.split('\r\n')[1], '0,"row,""0"""');

  const history = await call('GET', '/api/history');
  assert.equal(history.body[0].state, 'FINISHED');
  assert.equal(history.body[0].rowCount, 6);
}));

test('truncates at maxRows and stops the Trino query', () => withApp({ pages: 10, rowsPerPage: 5 }, { maxRows: 7 }, async ({ call, fake }) => {
  const start = await call('POST', '/api/runs', { sql: 'select 1' });
  const run = await waitDone(call, start.body.id);
  assert.equal(run.state, 'FINISHED');
  assert.equal(run.rowCount, 7);
  assert.equal(run.truncated, true);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(fake.deleted.length > 0, 'expected the Trino query to be canceled');
}));

test('surfaces Trino errors with location', () => withApp({ failWith: { message: "line 1:8: Column 'x' cannot be resolved", errorName: 'COLUMN_NOT_FOUND', errorType: 'USER_ERROR', errorLocation: { lineNumber: 1, columnNumber: 8 } } }, {}, async ({ call }) => {
  const start = await call('POST', '/api/runs', { sql: 'select x' });
  const run = await waitDone(call, start.body.id);
  assert.equal(run.state, 'FAILED');
  assert.equal(run.error.errorName, 'COLUMN_NOT_FOUND');
  assert.equal(run.error.line, 1);
  assert.equal(run.error.column, 8);
}));

test('cancel stops a running query', () => withApp({ pages: 50, delayMs: 30 }, {}, async ({ call, fake }) => {
  const start = await call('POST', '/api/runs', { sql: 'select 1' });
  await new Promise(r => setTimeout(r, 80));
  const c = await call('POST', `/api/runs/${start.body.id}/cancel`);
  assert.equal(c.body.state, 'CANCELED');
  const run = await waitDone(call, start.body.id);
  assert.equal(run.state, 'CANCELED');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(fake.deleted.length > 0);
}));

test('rejects write statements unless enabled', () => withApp({}, {}, async ({ call }) => {
  const r = await call('POST', '/api/runs', { sql: 'drop table x' });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /read-only/);
}));

test('saved query CRUD', () => withApp({}, {}, async ({ call }) => {
  const created = await call('POST', '/api/queries', { title: 'Q', sql: 'select 1' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const updated = await call('PUT', `/api/queries/${id}`, { sql: 'select 2' });
  assert.equal(updated.body.sql, 'select 2');
  assert.equal(updated.body.title, 'Q');
  assert.equal((await call('GET', '/api/queries')).body.length, 1);
  assert.equal((await call('DELETE', `/api/queries/${id}`)).status, 204);
  assert.equal((await call('GET', `/api/queries/${id}`)).status, 404);
}));

test('schedule a saved query, run it now and download the snapshot', () => withApp({}, {}, async ({ call }) => {
  const q = (await call('POST', '/api/queries', { title: 'Weekly', sql: 'select 1' })).body;
  const bad = await call('PUT', `/api/queries/${q.id}/schedule`, { frequency: 'yearly' });
  assert.equal(bad.status, 400);
  const sched = await call('PUT', `/api/queries/${q.id}/schedule`, { frequency: 'weekly', hour: 8 });
  assert.equal(sched.body.schedule.frequency, 'weekly');
  assert.ok(sched.body.schedule.nextRunAt);
  const snap = await call('POST', `/api/queries/${q.id}/snapshots`);
  assert.equal(snap.status, 201);
  assert.equal(snap.body.rowCount, 6);
  const list = await call('GET', `/api/queries/${q.id}/snapshots`);
  assert.equal(list.body.length, 1);
  const full = await call('GET', `/api/snapshots/${snap.body.id}`);
  assert.equal(full.body.rows.length, 6);
  const csv = await call('GET', `/api/snapshots/${snap.body.id}/csv`);
  assert.equal(csv.body.split('\r\n')[0], 'n,s');
  const cleared = await call('DELETE', `/api/queries/${q.id}/schedule`);
  assert.equal(cleared.body.schedule, undefined);
}));

test('assistant endpoint: 503 when unconfigured, answers when configured', async () => {
  await withApp({}, {}, async ({ call }) => {
    const r = await call('POST', '/api/assistant', { question: 'hi' });
    assert.equal(r.status, 503);
    assert.equal((await call('GET', '/api/config')).body.assistant, false);
  });
  const assistant = { ask: async ({ question }) => ({ sql: 'SELECT 1', explanation: `answer to ${question}` }) };
  await withApp({}, { assistant }, async ({ call }) => {
    assert.equal((await call('POST', '/api/assistant', { question: '' })).status, 400);
    const r = await call('POST', '/api/assistant', { question: 'q?' });
    assert.equal(r.body.sql, 'SELECT 1');
    assert.equal(r.body.explanation, 'answer to q?');
    assert.equal(r.body.mode, 'generate');
  });
});

test('chat history is kept per query, follows a draft when saved, and records feedback', async () => {
  let n = 0;
  const assistant = { ask: async ({ question, mode, history }) => ({ sql: `SELECT ${++n}`, explanation: `${mode}:${question}:${history.length}` }) };
  await withApp({}, { assistant }, async ({ call }) => {
    const a = await call('POST', '/api/assistant', { question: 'first', mode: 'generate', key: 'draft-abc' });
    assert.equal(a.body.explanation, 'generate:first:0');
    const b = await call('POST', '/api/assistant', { question: 'second', mode: 'edit', key: 'draft-abc' });
    assert.equal(b.body.explanation, 'edit:second:1', 'edit sees earlier turns');
    const q = (await call('POST', '/api/queries', { title: 'T', sql: 'SELECT 2', assistantKey: 'draft-abc' })).body;
    const hist = await call('GET', `/api/assistant/history?key=${q.id}`);
    assert.deepEqual(hist.body.map(e => e.prompt), ['first', 'second']);
    assert.equal((await call('GET', '/api/assistant/history?key=draft-abc')).body.length, 0);
    const fb = await call('POST', '/api/assistant/feedback', { key: q.id, id: b.body.id, helpful: false, details: 'wrong table' });
    assert.deepEqual([fb.body.feedback.helpful, fb.body.feedback.details], [false, 'wrong table']);
  });
});

test('titles are generated on save (heuristic without the assistant)', () => withApp({}, {}, async ({ call }) => {
  const r = await call('POST', '/api/title', { sql: 'select * from refunds join charges on 1=1' });
  assert.equal(r.body.title, 'Refunds and charges query');
}));

test('saved chart settings persist with the query', () => withApp({}, {}, async ({ call }) => {
  const q = (await call('POST', '/api/queries', { title: 'C', sql: 'select 1', chart: { kind: 'bar', x: 'day', y: ['amount'], groupBy: 'currency' } })).body;
  assert.deepEqual(q.chart, { kind: 'bar', x: 'day', y: ['amount'], groupBy: 'currency' });
  const u = (await call('PUT', `/api/queries/${q.id}`, { chart: { kind: 'nonsense', x: 'day', y: 'oops' } })).body;
  assert.deepEqual(u.chart, { kind: 'line', x: 'day', y: [], groupBy: null });
}));

test('CSV includes all results even when the view was capped', () => withApp({ pages: 4, rowsPerPage: 5 }, { maxRows: 7 }, async ({ call }) => {
  const start = await call('POST', '/api/runs', { sql: 'select 1' });
  const run = await waitDone(call, start.body.id);
  assert.equal(run.truncated, true);
  const csv = await call('GET', `/api/runs/${run.id}/csv`);
  const lines = csv.body.trim().split('\r\n');
  assert.equal(lines[0], 'n,s');
  assert.equal(lines.length, 1 + 20, 'header + every row from a fresh, uncapped run');
}));

test('metric groups hold up to 20 reports', () => withApp({}, {}, async ({ call }) => {
  const g = (await call('POST', '/api/metric-groups', { name: 'Key' })).body;
  const ids = [];
  for (let i = 0; i < 21; i++) ids.push((await call('POST', '/api/queries', { title: `Q${i}`, sql: 'select 1' })).body.id);
  for (let i = 0; i < 20; i++) assert.equal((await call('POST', `/api/metric-groups/${g.id}/queries`, { queryId: ids[i] })).status, 201);
  const over = await call('POST', `/api/metric-groups/${g.id}/queries`, { queryId: ids[20] });
  assert.equal(over.status, 400);
  assert.match(over.body.error.message, /up to 20/);
  assert.equal((await call('DELETE', `/api/metric-groups/${g.id}/queries/${ids[0]}`)).body.queryIds.length, 19);
  await call('DELETE', `/api/queries/${ids[1]}`);
  assert.equal((await call('GET', '/api/metric-groups')).body[0].queryIds.length, 18, 'deleting a query removes it from groups');
  assert.equal((await call('DELETE', `/api/metric-groups/${g.id}`)).status, 204);
}));

test('schedule API: timeline, email preview and unsubscribe', () => withApp({}, {}, async ({ call }) => {
  const q = (await call('POST', '/api/queries', { title: 'Weekly', sql: 'select 1' })).body;
  const s = (await call('PUT', `/api/queries/${q.id}/schedule`, { frequency: 'weekly', subscribers: 'a@x.com' })).body;
  assert.equal(new Date(s.timeline.nextRunAt).getUTCDay(), 1, 'weekly runs on Monday 00:00 UTC');
  assert.ok(s.timeline.dataPeriod.start < s.timeline.dataPeriod.end);
  const preview = await call('GET', `/api/queries/${q.id}/schedule/email-preview?format=json`);
  assert.match(preview.body.subject, /^Weekly — /);
  const bad = await call('GET', `/api/unsubscribe?query=${q.id}&email=a@x.com&token=nope`);
  assert.equal(bad.status, 400);
}));

test('identity: saved queries record their creator; only the author can edit a chart', () => withApp({}, {}, async ({ call }) => {
  const q = (await call('POST', '/api/queries', { title: 'Mine', sql: 'select 1' }, 'ana@example.com')).body;
  assert.equal(q.createdBy, 'ana@example.com');
  const denied = await call('PUT', `/api/queries/${q.id}`, { chart: { kind: 'bar', x: 'a', y: ['b'] } }, 'bo@example.com');
  assert.equal(denied.status, 403);
  assert.match(denied.body.error.message, /only editable by the author/);
  const ok = await call('PUT', `/api/queries/${q.id}`, { chart: { kind: 'bar', x: 'a', y: ['b'] } }, 'ana@example.com');
  assert.equal(ok.status, 200);
  // teammates can still open and edit the SQL of shared queries
  assert.equal((await call('PUT', `/api/queries/${q.id}`, { sql: 'select 2' }, 'bo@example.com')).status, 200);
  assert.equal((await call('GET', '/api/config', undefined, 'bo@example.com')).body.user, 'bo@example.com');
}));

test('identity: schedule creator is subscribed and recorded; only the author edits a metric group', () => withApp({}, {}, async ({ call }) => {
  const q = (await call('POST', '/api/queries', { title: 'S', sql: 'select 1' }, 'ana@example.com')).body;
  const s = (await call('PUT', `/api/queries/${q.id}/schedule`, { frequency: 'daily', subscribers: 'team@example.com' }, 'ana@example.com')).body;
  assert.deepEqual(s.schedule.subscribers, ['ana@example.com', 'team@example.com']);
  assert.equal(s.schedule.createdBy, 'ana@example.com');
  const g = (await call('POST', '/api/metric-groups', { name: 'Ana metrics' }, 'ana@example.com')).body;
  assert.equal(g.createdBy, 'ana@example.com');
  assert.equal((await call('PUT', `/api/metric-groups/${g.id}`, { name: 'x' }, 'bo@example.com')).status, 403);
  assert.equal((await call('POST', `/api/metric-groups/${g.id}/queries`, { queryId: q.id }, 'bo@example.com')).status, 403);
  assert.equal((await call('DELETE', `/api/metric-groups/${g.id}`, undefined, 'bo@example.com')).status, 403);
  assert.equal((await call('POST', `/api/metric-groups/${g.id}/queries`, { queryId: q.id }, 'ana@example.com')).status, 201);
  assert.equal((await call('DELETE', `/api/metric-groups/${g.id}`, undefined, 'ana@example.com')).status, 204);
}));
