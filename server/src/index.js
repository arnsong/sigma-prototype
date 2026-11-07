import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrinoClient } from './trino.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { seed } from './seed.js';

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
  schemas: (env.SCHEMA_BROWSER || `${catalog}.${schema},tpch.tiny`).split(',').map(s => s.trim()).filter(Boolean),
  maxRows: Number(env.MAX_ROWS || 10000),
  allowWrites: env.ALLOW_WRITES === 'true',
  seed: env.SEED !== 'false',
  seedTarget: `${env.SEED_CATALOG || catalog}.${env.SEED_SCHEMA || schema}`,
  dataDir: env.DATA_DIR || path.resolve(here, '../../data'),
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
const app = createApp({ client, store, config });

app.listen(config.port, () => {
  console.log(`sigma-prototype API on http://localhost:${config.port} (Trino: ${config.trinoServer}, default ${catalog}.${schema})`);
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
