import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRunAt, dataPeriod, validateSchedule, Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store.js';
import { TrinoClient } from '../src/trino.js';
import { startFakeTrino } from './fake-trino.js';

test('runs fire when the period closes (00:00 UTC; weeks end Sunday; months on the 1st)', () => {
  const sat = new Date('2026-11-07T15:30:00Z'); // a Saturday
  assert.equal(nextRunAt({ frequency: 'daily' }, sat).toISOString(), '2026-11-08T00:00:00.000Z');
  assert.equal(nextRunAt({ frequency: 'weekly' }, sat).toISOString(), '2026-11-09T00:00:00.000Z');
  assert.equal(nextRunAt({ frequency: 'monthly' }, sat).toISOString(), '2026-12-01T00:00:00.000Z');
  const mondayMidnight = new Date('2026-11-09T00:00:00Z');
  assert.equal(nextRunAt({ frequency: 'weekly' }, mondayMidnight).toISOString(), '2026-11-16T00:00:00.000Z');
  assert.equal(nextRunAt({ frequency: 'monthly' }, new Date('2026-12-31T23:59:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
  assert.deepEqual(dataPeriod('weekly', '2026-11-09T00:00:00.000Z'), { start: '2026-11-02T00:00:00.000Z', end: '2026-11-09T00:00:00.000Z' });
  assert.deepEqual(dataPeriod('monthly', '2026-12-01T00:00:00.000Z'), { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' });
});

test('validateSchedule checks frequency, subscribers and webhook', () => {
  assert.throws(() => validateSchedule({ frequency: 'hourly' }), /frequency/);
  assert.throws(() => validateSchedule({ frequency: 'daily', subscribers: 'not-an-email' }), /valid email/);
  assert.throws(() => validateSchedule({ frequency: 'daily', webhookUrl: 'ftp://x' }), /webhookUrl/);
  assert.deepEqual(validateSchedule({ frequency: 'weekly', subscribers: 'A@x.com, b@y.org;a@x.com', title: ' Weekly ' }),
    { frequency: 'weekly', subscribers: ['a@x.com', 'b@y.org'], webhookUrl: null, title: 'Weekly' });
});

function setup(fakeOpts = {}, opts = {}) {
  return startFakeTrino({ pages: 2, rowsPerPage: 3, ...fakeOpts }).then(fake => {
    const store = new Store(null);
    const hooks = [];
    const mails = [];
    const scheduler = new Scheduler({
      client: new TrinoClient({ server: fake.url }), store, dataDir: null, maxRows: 4, log: () => {},
      publicUrl: 'https://studio.example', secret: 's3cret',
      fetch: async (url, init) => { hooks.push({ url, body: JSON.parse(init.body) }); return new Response('ok'); },
      mailer: { sendMail: async m => { mails.push(m); } },
      ...opts,
    });
    return { fake, store, scheduler, hooks, mails };
  });
}

test('a due schedule runs, keeps the result, emails subscribers and sends the Sigma webhook event', async () => {
  const { fake, store, scheduler, hooks, mails } = await setup();
  try {
    const q = store.createSaved({ title: 'Daily volume', sql: 'select 1' });
    scheduler.setSchedule(q.id, { frequency: 'daily', subscribers: 'ops@example.com', webhookUrl: 'https://hooks.example/x' }, { creator: 'me@example.com' });
    assert.deepEqual(store.getSaved(q.id).schedule.subscribers, ['me@example.com', 'ops@example.com'], 'creator subscribed by default');
    const due = new Date(Date.parse(q.schedule.nextRunAt) + 1000);
    await scheduler.tick(due);

    const [snap] = scheduler.listSnapshots(q.id);
    assert.equal(snap.state, 'FINISHED');
    assert.equal(snap.rowCount, 4);
    assert.equal(snap.truncated, true);
    assert.match(snap.id, /^sqr_/);
    assert.equal(scheduler.getSnapshot(snap.id).rows.length, 4);
    assert.ok(Date.parse(store.getSaved(q.id).schedule.nextRunAt) > due.getTime());

    assert.equal(hooks.length, 1);
    const evt = hooks[0].body;
    assert.equal(evt.type, 'sigma.scheduled_query_run.created');
    assert.equal(evt.object, 'event');
    assert.equal(evt.data.object.object, 'scheduled_query_run');
    assert.equal(evt.data.object.status, 'completed');
    assert.equal(evt.data.object.title, 'Daily volume');
    assert.equal(evt.data.object.file.purpose, 'sigma_scheduled_query');
    assert.equal(evt.data.object.file.url, `https://studio.example/api/snapshots/${snap.id}/csv`);
    assert.equal(evt.data.object.data_load_time, Math.floor(Date.parse(snap.dataLoadTime) / 1000));

    assert.deepEqual(mails.map(m => m.to), ['me@example.com', 'ops@example.com']);
    assert.match(mails[0].subject, /^Daily volume — /);
    assert.ok(mails[0].html.includes(`https://studio.example/api/snapshots/${snap.id}/csv`), 'email has CSV link');
    assert.match(mails[0].html, /Unsubscribe/);

    await scheduler.tick(due); // not due again until the next period
    assert.equal(scheduler.listSnapshots(q.id).length, 1);
  } finally {
    await fake.close();
  }
});

test('unsubscribe links are signed per query and address', async () => {
  const { fake, store, scheduler } = await setup();
  try {
    const q = store.createSaved({ title: 'Q', sql: 'select 1' });
    scheduler.setSchedule(q.id, { frequency: 'weekly', subscribers: ['a@x.com', 'b@x.com'] });
    assert.equal(scheduler.unsubscribe(q.id, 'a@x.com', 'wrong'), false);
    assert.equal(scheduler.unsubscribe(q.id, 'a@x.com', scheduler.unsubscribeToken(q.id, 'b@x.com')), false);
    assert.equal(scheduler.unsubscribe(q.id, 'a@x.com', scheduler.unsubscribeToken(q.id, 'a@x.com')), true);
    assert.deepEqual(store.getSaved(q.id).schedule.subscribers, ['b@x.com']);
  } finally {
    await fake.close();
  }
});

test('scheduled query names must be unique', async () => {
  const { fake, store, scheduler } = await setup();
  try {
    const a = store.createSaved({ title: 'Revenue', sql: 'select 1' });
    const b = store.createSaved({ title: 'Other', sql: 'select 1' });
    scheduler.setSchedule(a.id, { frequency: 'daily' });
    assert.throws(() => scheduler.setSchedule(b.id, { frequency: 'daily', title: 'revenue' }), /unique name/);
    scheduler.setSchedule(b.id, { frequency: 'daily', title: 'Revenue (EU)' });
    assert.equal(store.getSaved(b.id).title, 'Revenue (EU)');
  } finally {
    await fake.close();
  }
});

test('failed runs are reported as failed in the event, and writes are refused', async () => {
  const { fake, store, scheduler, hooks } = await setup();
  try {
    const q = store.createSaved({ title: 'Bad', sql: 'delete from charges' });
    scheduler.setSchedule(q.id, { frequency: 'daily', webhookUrl: 'https://hooks.example/x' });
    const snap = await scheduler.runNow(q.id);
    assert.equal(snap.state, 'FAILED');
    assert.match(snap.error, /read-only/);
    assert.equal(hooks[0].body.data.object.status, 'failed');
    assert.equal(hooks[0].body.data.object.file, null);
  } finally {
    await fake.close();
  }
});

test('email preview renders without a run and when email is not configured nothing is sent', async () => {
  const { fake, store, scheduler } = await setup({}, { mailer: null });
  try {
    const q = store.createSaved({ title: 'Preview me', sql: 'select 1' });
    scheduler.setSchedule(q.id, { frequency: 'monthly', subscribers: 'a@x.com' });
    const p = scheduler.previewEmail(q.id);
    assert.match(p.subject, /^Preview me — /);
    assert.match(p.html, /Monthly report/);
    const snap = await scheduler.runNow(q.id);
    assert.equal(snap.state, 'FINISHED');
  } finally {
    await fake.close();
  }
});
