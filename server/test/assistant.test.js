import test from 'node:test';
import assert from 'node:assert/strict';
import { Assistant, schemaToText, heuristicTitle } from '../src/assistant.js';

const SCHEMA = [{ catalog: 'memory', schema: 'billing', tables: [{ name: 'charges', description: 'Card charges', columns: [{ name: 'amount', type: 'bigint', description: 'Cents' }] }] }];

function fakeClient(answer, stop_reason = 'end_turn') {
  const calls = [];
  return { calls, beta: { messages: { parse: async params => { calls.push(params); return { stop_reason, parsed_output: answer }; } } } };
}

test('schemaToText marks the default schema and includes docs', () => {
  const text = schemaToText(SCHEMA, 'memory', 'billing');
  assert.match(text, /memory\.billing \(default/);
  assert.match(text, /amount bigint -- Cents/);
});

test('ask sends schema in a cached system prompt and returns validated SQL', async () => {
  const client = fakeClient({ sql: 'SELECT sum(amount) FROM charges;', explanation: 'Total volume.' });
  const a = new Assistant({ getSchema: async () => SCHEMA, catalog: 'memory', schema: 'billing', client });
  const r = await a.ask({ question: 'total volume?', mode: 'edit', currentSql: 'select 1', error: 'boom', history: [{ prompt: 'earlier ask', sql: 'x' }] });
  assert.deepEqual(r, { sql: 'SELECT sum(amount) FROM charges', explanation: 'Total volume.' });
  const p = client.calls[0];
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.system[0].cache_control.type, 'ephemeral');
  assert.match(p.system[0].text, /table charges/);
  assert.match(p.messages[0].content, /total volume\?/);
  assert.match(p.messages[0].content, /boom/);
  assert.match(p.messages[0].content, /Modify this query from the editor:[\s\S]*select 1/);
  assert.match(p.messages[0].content, /earlier ask/);
});

test('generate mode ignores what is in the editor', async () => {
  const client = fakeClient({ sql: 'SELECT 1', explanation: 'x' });
  const a = new Assistant({ getSchema: async () => SCHEMA, catalog: 'memory', schema: 'billing', client });
  await a.ask({ question: 'new one', mode: 'generate', currentSql: 'SELECT secret_old_query' });
  assert.doesNotMatch(client.calls[0].messages[0].content, /secret_old_query/);
  assert.match(client.calls[0].messages[0].content, /Write a new query for this question: new one/);
});

test('titles: model title when available, heuristic otherwise', async () => {
  const a = new Assistant({ getSchema: async () => SCHEMA, catalog: 'memory', schema: 'billing', client: fakeClient({ title: '  Volume by brand ' }) });
  assert.equal(await a.title('select 1'), 'Volume by brand');
  assert.equal(heuristicTitle('select * from charges c join memory.billing.customers cu on 1=1'), 'Charges and customers query');
  assert.equal(heuristicTitle('select 1'), 'Untitled query');
  assert.equal(heuristicTitle('select * from balance_transactions'), 'Balance transactions query');
});

test('ask refuses to hand back write statements and surfaces refusals', async () => {
  const bad = new Assistant({ getSchema: async () => SCHEMA, catalog: 'memory', schema: 'billing', client: fakeClient({ sql: 'DROP TABLE charges', explanation: 'x' }) });
  await assert.rejects(bad.ask({ question: 'drop it' }), /read-only/);
  const refused = new Assistant({ getSchema: async () => SCHEMA, catalog: 'memory', schema: 'billing', client: fakeClient(null, 'refusal') });
  await assert.rejects(refused.ask({ question: 'x' }), /declined/);
});

test('empty sql is allowed when the question cannot be answered', async () => {
  const a = new Assistant({ getSchema: async () => SCHEMA, catalog: 'memory', schema: 'billing', client: fakeClient({ sql: '', explanation: 'No such data.' }) });
  assert.deepEqual(await a.ask({ question: 'weather?' }), { sql: '', explanation: 'No such data.' });
});
