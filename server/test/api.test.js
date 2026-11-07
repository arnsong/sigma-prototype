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
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
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
    assert.deepEqual(r.body, { sql: 'SELECT 1', explanation: 'answer to q?' });
  });
});
