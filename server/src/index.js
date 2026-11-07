import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrinoClient } from './trino.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { seed } from './seed.js';
import { Assistant, assistantEnabled } from './assistant.js';
import { Scheduler } from './scheduler.js';
import { loadSchema } from './app.js';
import nodemailer from 'nodemailer';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const catalog = env.TRINO_CATALOG || 'memory';
const schema = env.TRINO_SCHEMA || 'billing';
const config = {
  port: Number(env.PORT || 3001),
  trinoServer: env.TRINO_SERVER || 'http://localhost:8080',
  catalog,
  schema,
  // Schemas shown in the schema browser: comma-separated "catalog.schema" or "catalog".
  schemas: (env.SCHEMA_BROWSER || `${catalog}.${schema}`).split(',').map(s => s.trim()).filter(Boolean),
  // Rows kept per run for paging/CSV; the UI shows at most 1,000 (as Sigma does).
  maxRows: Number(env.MAX_ROWS || 100000),
  allowWrites: env.ALLOW_WRITES === 'true',
  seed: env.SEED !== 'false',
  seedTarget: `${env.SEED_CATALOG || catalog}.${env.SEED_SCHEMA || schema}`,
  dataDir: env.DATA_DIR || path.resolve(here, '../../data'),
  // Query whose single value is shown as "Data available up to ..." in the UI.
  freshnessQuery: env.FRESHNESS_QUERY ?? (env.SEED !== 'false'
    ? `SELECT max(created) FROM ${env.SEED_CATALOG || catalog}.${env.SEED_SCHEMA || schema}.balance_transactions`
    : ''),
  // There are no user accounts yet; this address is the "creator" auto-subscribed to schedules.
  userEmail: env.USER_EMAIL || null,
  publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT || 3001}`,
  emailDelivery: Boolean(env.SMTP_URL),
  webDist: env.WEB_DIST || path.resolve(here, '../../web/dist'),
};

const client = new TrinoClient({
  server: config.trinoServer,
  user: env.TRINO_USER || 'sigma',
  password: env.TRINO_PASSWORD,
  catalog,
  schema,
});

const store = new Store(path.join(config.dataDir, 'store.json'));

const assistant = assistantEnabled(env)
  ? new Assistant({
    catalog,
    schema,
    model: env.ASSISTANT_MODEL,
    getSchema: () => loadSchema(client, config.schemas, config.seedTarget),
  })
  : null;

const scheduler = env.SCHEDULER === 'false'
  ? null
  : new Scheduler({
    client, store, dataDir: config.dataDir, maxRows: config.maxRows, allowWrites: config.allowWrites,
    publicUrl: config.publicUrl,
    mailer: env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null,
    mailFrom: env.MAIL_FROM || 'Query Studio <reports@localhost>',
  });
scheduler?.start();

const app = createApp({ client, store, config, assistant, scheduler });

app.listen(config.port, () => {
  console.log(`sigma-prototype API on http://localhost:${config.port} (Trino: ${config.trinoServer}, default ${catalog}.${schema})`);
  console.log(`assistant: ${assistant ? `enabled (${assistant.model})` : 'disabled (set ANTHROPIC_API_KEY to enable)'}; scheduler: ${scheduler ? 'on' : 'off'}; email: ${config.emailDelivery ? 'SMTP' : 'off (set SMTP_URL)'}`);
});

if (config.seed) {
  seedWhenReady().catch(e => console.error('[seed] failed:', e.message));
}

async function seedWhenReady() {
  // Trino may still be starting (e.g. under docker compose); wait for it.
  const seedClient = new TrinoClient({ server: config.trinoServer, user: env.TRINO_USER || 'sigma', password: env.TRINO_PASSWORD });
  const [seedCatalog, seedSchema] = config.seedTarget.split('.');
  for (let i = 0; ; i++) {
    try {
      const info = await seedClient.info();
      if (!info.starting) break;
    } catch (e) {
      if (i % 10 === 0) console.log(`[seed] waiting for Trino at ${config.trinoServer} (${e.cause?.code || e.message})`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  await seed(seedClient, { catalog: seedCatalog, schema: seedSchema });
}
