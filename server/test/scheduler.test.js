import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRunAt, validateSchedule, Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store.js';
import { TrinoClient } from '../src/trino.js';
import { startFakeTrino } from './fake-trino.js';

test('nextRunAt: daily, weekly (Mondays), monthly (1st), always in the future', () => {
  const from = new Date('2026-11-07T15:30:00Z'); // a Saturday
  assert.equal(nextRunAt({ frequency: 'daily', hour: 9 }, from).toISOString(), '2026-11-08T09:00:00.000Z');
  assert.equal(nextRunAt({ frequency: 'daily', hour: 16 }, from).toISOString(), '2026-11-07T16:00:00.000Z');
  assert.equal(nextRunAt({ frequency: 'weekly', hour: 9 }, from).toISOString(), '2026-11-09T09:00:00.000Z');
  assert.equal(nextRunAt({ frequency: 'monthly', hour: 0 }, from).toISOString(), '2026-12-01T00:00:00.000Z');
  const monday = new Date('2026-11-09T09:00:00Z');
  assert.equal(nextRunAt({ frequency: 'weekly', hour: 9 }, monday).toISOString(), '2026-11-16T09:00:00.000Z');
});

test('validateSchedule rejects bad input', () => {
  assert.throws(() => validateSchedule({ frequency: 'hourly' }), /frequency/);
  assert.throws(() => validateSchedule({ frequency: 'daily', hour: 24 }), /hour/);
  assert.throws(() => validateSchedule({ frequency: 'daily', webhookUrl: 'ftp://x' }), /webhookUrl/);
  assert.deepEqual(validateSchedule({ frequency: 'weekly', hour: '7' }), { frequency: 'weekly', hour: 7, webhookUrl: null });
});

test('due schedules run, store a snapshot and call the webhook', async () => {
  const fake = await startFakeTrino({ pages: 2, rowsPerPage: 3 });
  const store = new Store(null);
  const hooks = [];
  const scheduler = new Scheduler({
    client: new TrinoClient({ server: fake.url }), store, dataDir: null, maxRows: 4,
    fetch: async (url, init) => { hooks.push({ url, body: JSON.parse(init.body) }); return new Response('ok'); },
    log: () => {},
  });
  try {
    const q = store.createSaved({ title: 'Daily', sql: 'select 1' });
    scheduler.setSchedule(q.id, { frequency: 'daily', hour: 9, webhookUrl: 'https://hooks.example/x' });
    const due = new Date(Date.parse(q.schedule.nextRunAt) + 1000);
    await scheduler.tick(due);
    const snaps = scheduler.listSnapshots(q.id);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].state, 'FINISHED');
    assert.equal(snaps[0].rowCount, 4);
    assert.equal(snaps[0].truncated, true);
    assert.equal(scheduler.getSnapshot(snaps[0].id).rows.length, 4);
    assert.ok(Date.parse(store.getSaved(q.id).schedule.nextRunAt) > due.getTime());
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].url, 'https://hooks.example/x');
    assert.equal(hooks[0].body.query.title, 'Daily');
    // not due again until the next slot
    await scheduler.tick(due);
    assert.equal(scheduler.listSnapshots(q.id).length, 1);
  } finally {
    await fake.close();
  }
});

test('scheduled runs respect the read-only guard', async () => {
  const store = new Store(null);
  const scheduler = new Scheduler({ client: new TrinoClient({ server: 'http://127.0.0.1:1' }), store, dataDir: null, maxRows: 10, log: () => {} });
  const q = store.createSaved({ title: 'Bad', sql: 'delete from charges' });
  const snap = await scheduler.runNow(q.id);
  assert.equal(snap.state, 'FAILED');
  assert.match(snap.error, /read-only/);
});
