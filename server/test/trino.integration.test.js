// Runs against a real Trino when TRINO_SERVER is set, e.g.
//   TRINO_SERVER=http://localhost:8080 npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { TrinoClient } from '../src/trino.js';
import { seed } from '../src/seed.js';
import { TEMPLATES } from '../src/templates.js';
import { loadSchema } from '../src/app.js';

const server = process.env.TRINO_SERVER;
const opts = { skip: !server && 'TRINO_SERVER not set' };
const SCHEMA = 'billing_it';

test('seeds the sample dataset and every template runs', opts, async () => {
  const admin = new TrinoClient({ server });
  await seed(admin, { catalog: 'memory', schema: SCHEMA, force: true, log: () => {}, customers: 120 });
  const client = new TrinoClient({ server, catalog: 'memory', schema: SCHEMA });
  for (const t of TEMPLATES) {
    const { columns } = await client.query(t.sql);
    assert.ok(columns.length > 0, `${t.id} returned no columns`);
  }
  const schema = await loadSchema(client, [`memory.${SCHEMA}`], `memory.${SCHEMA}`);
  assert.equal(schema[0].tables.length, 9);
  assert.ok(schema[0].tables.find(t => t.name === 'charges').columns.some(c => c.name === 'amount' && c.description));
});
