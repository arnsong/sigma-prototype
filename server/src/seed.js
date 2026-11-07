// Seeds a sample billing dataset (customers, subscriptions, invoices, charges, ...)
// into a writable Trino catalog (the memory connector by default) so the UI has
// something realistic to query out of the box.

const FIRST = ['Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Ken', 'Barbara', 'Dennis', 'Frances', 'Edsger', 'Radia', 'John', 'Hedy', 'Tim', 'Katherine', 'Guido', 'Sophie', 'Niklaus', 'Anita', 'Bjarne'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Hamilton', 'Thompson', 'Liskov', 'Ritchie', 'Allen', 'Dijkstra', 'Perlman', 'McCarthy', 'Lamarr', 'Berners-Lee', 'Johnson', 'van Rossum', 'Wilson', 'Wirth', 'Borg', 'Stroustrup'];
const COUNTRIES = [['US', 'usd', 40], ['GB', 'gbp', 12], ['DE', 'eur', 10], ['FR', 'eur', 8], ['CA', 'cad', 8], ['AU', 'aud', 6], ['JP', 'jpy', 5], ['NL', 'eur', 4], ['IE', 'eur', 3], ['SG', 'sgd', 4]];
const CARD_BRANDS = [['visa', 55], ['mastercard', 30], ['amex', 10], ['discover', 5]];
const PRODUCTS = [
  ['prod_starter', 'Starter', [['price_starter_m', 1900, 'month'], ['price_starter_y', 19000, 'year']]],
  ['prod_growth', 'Growth', [['price_growth_m', 4900, 'month'], ['price_growth_y', 49000, 'year']]],
  ['prod_scale', 'Scale', [['price_scale_m', 19900, 'month'], ['price_scale_y', 199000, 'year']]],
  ['prod_enterprise', 'Enterprise', [['price_enterprise_m', 99900, 'month']]],
];
const DECLINE_CODES = [['insufficient_funds', 40], ['card_declined', 25], ['expired_card', 15], ['incorrect_cvc', 10], ['processing_error', 10]];
const DISPUTE_REASONS = [['fraudulent', 50], ['product_not_received', 20], ['duplicate', 10], ['subscription_canceled', 20]];

// Deterministic PRNG so every environment gets the same data.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function idGen(prefix, rand) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return () => {
    let s = '';
    for (let i = 0; i < 14; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
    return `${prefix}_${s}`;
  };
}

function weighted(rand, items) {
  const total = items.reduce((a, it) => a + it[it.length - 1], 0);
  let r = rand() * total;
  for (const it of items) {
    r -= it[it.length - 1];
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

const DAY = 86400_000;

/** Build the dataset in memory. `now` anchors dates so data always looks recent. */
export function generateDataset({ now = Date.now(), customers: nCustomers = 400, seed = 42 } = {}) {
  const rand = mulberry32(seed);
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const ids = {
    cus: idGen('cus', rand), sub: idGen('sub', rand), in: idGen('in', rand), ch: idGen('ch', rand),
    re: idGen('re', rand), txn: idGen('txn', rand), dp: idGen('dp', rand), card: idGen('card', rand),
  };
  const start = now - 540 * DAY; // ~18 months of history
  const ts = ms => new Date(Math.min(ms, now));

  const t = {
    customers: [], products: [], prices: [], subscriptions: [], invoices: [],
    charges: [], refunds: [], disputes: [], balance_transactions: [],
  };

  for (const [pid, name, prices] of PRODUCTS) {
    t.products.push({ id: pid, name, active: true, created: ts(start - 30 * DAY) });
    for (const [id, amount, interval] of prices) {
      t.prices.push({ id, product_id: pid, unit_amount: amount, currency: 'usd', recurring_interval: interval, active: true, created: ts(start - 30 * DAY) });
    }
  }

  const addCharge = ({ customer, amount, currency, created, invoiceId, description }) => {
    const failed = rand() < 0.06;
    const brand = weighted(rand, CARD_BRANDS)[0];
    const charge = {
      id: ids.ch(), customer_id: customer.id, invoice_id: invoiceId, amount, currency,
      amount_refunded: 0, captured: !failed, paid: !failed, refunded: false, disputed: false,
      status: failed ? 'failed' : 'succeeded', failure_code: failed ? weighted(rand, DECLINE_CODES)[0] : null,
      card_brand: brand, card_country: customer.address_country, description, created: ts(created),
    };
    t.charges.push(charge);
    if (failed) return charge;
    const fee = Math.round(amount * 0.029) + 30;
    t.balance_transactions.push({
      id: ids.txn(), source_id: charge.id, type: 'charge', amount, fee, net: amount - fee, currency,
      status: created < now - 2 * DAY ? 'available' : 'pending', created: ts(created), available_on: ts(created + 2 * DAY),
    });
    if (rand() < 0.04) {
      const full = rand() < 0.6;
      const ramount = full ? amount : Math.round(amount * (0.2 + rand() * 0.5));
      const rcreated = created + Math.floor(rand() * 20 * DAY);
      if (rcreated < now) {
        const refund = { id: ids.re(), charge_id: charge.id, amount: ramount, currency, reason: pick(['requested_by_customer', 'duplicate', 'fraudulent']), status: 'succeeded', created: ts(rcreated) };
        t.refunds.push(refund);
        charge.amount_refunded = ramount;
        charge.refunded = full;
        t.balance_transactions.push({ id: ids.txn(), source_id: refund.id, type: 'refund', amount: -ramount, fee: 0, net: -ramount, currency, status: 'available', created: ts(rcreated), available_on: ts(rcreated) });
      }
    } else if (rand() < 0.008) {
      const dcreated = created + Math.floor((5 + rand() * 40) * DAY);
      if (dcreated < now) {
        const status = dcreated > now - 21 * DAY ? 'needs_response' : pick(['won', 'lost', 'lost']);
        t.disputes.push({ id: ids.dp(), charge_id: charge.id, amount, currency, reason: weighted(rand, DISPUTE_REASONS)[0], status, created: ts(dcreated) });
        charge.disputed = true;
        t.balance_transactions.push({ id: ids.txn(), source_id: charge.id, type: 'adjustment', amount: -amount, fee: 1500, net: -amount - 1500, currency, status: 'available', created: ts(dcreated), available_on: ts(dcreated) });
      }
    }
    return charge;
  };

  for (let i = 0; i < nCustomers; i++) {
    const first = pick(FIRST), last = pick(LAST);
    const [country, currency] = weighted(rand, COUNTRIES);
    // Customer growth accelerates over time.
    const created = start + Math.floor(Math.sqrt(rand()) * (now - start));
    const customer = {
      id: ids.cus(), email: `${first}.${last}${i}@example.com`.toLowerCase().replace(/[^a-z0-9.@]/g, ''),
      name: `${first} ${last}`, description: null, currency, address_country: country,
      delinquent: false, created: ts(created),
    };
    t.customers.push(customer);

    // Most customers subscribe; a few buy one-off.
    if (rand() < 0.82) {
      const product = weighted(rand, PRODUCTS.map((p, idx) => [...p, [50, 30, 15, 5][idx]]));
      const price = rand() < 0.75 || product[2].length === 1 ? product[2][0] : product[2][1];
      const [priceId, unitAmount, interval] = price;
      const quantity = product[0] === 'prod_enterprise' ? 1 + Math.floor(rand() * 5) : 1;
      const subStart = created + Math.floor(rand() * 3 * DAY);
      const churnPerPeriod = interval === 'month' ? 0.035 : 0.15;
      const periodMs = (interval === 'month' ? 30 : 365) * DAY;
      const trial = rand() < 0.3 ? 14 * DAY : 0;
      let periodStart = subStart + trial;
      let canceledAt = null;
      let status = trial && periodStart > now ? 'trialing' : 'active';
      const subInvoices = [];
      while (periodStart < now) {
        const inv = { id: ids.in(), customer_id: customer.id, subscription_id: null, amount_due: unitAmount * quantity, amount_paid: 0, currency: 'usd', status: 'open', billing_reason: periodStart === subStart + trial ? 'subscription_create' : 'subscription_cycle', period_start: ts(periodStart), period_end: ts(periodStart + periodMs), created: ts(periodStart) };
        const charge = addCharge({ customer, amount: inv.amount_due, currency: 'usd', created: periodStart + Math.floor(rand() * 3600_000), invoiceId: inv.id, description: `Subscription ${product[1]}` });
        if (charge.paid) {
          inv.status = 'paid';
          inv.amount_paid = inv.amount_due;
        } else if (rand() < 0.5) {
          // retry succeeds
          const retry = addCharge({ customer, amount: inv.amount_due, currency: 'usd', created: periodStart + 3 * DAY, invoiceId: inv.id, description: `Subscription ${product[1]}` });
          if (retry.paid) { inv.status = 'paid'; inv.amount_paid = inv.amount_due; }
        }
        if (inv.status !== 'paid') {
          if (periodStart > now - 30 * DAY) {
            status = 'past_due';
            customer.delinquent = true;
          } else {
            inv.status = 'uncollectible';
          }
        }
        t.invoices.push(inv);
        subInvoices.push(inv);
        if (inv.status === 'uncollectible' || rand() < churnPerPeriod) {
          canceledAt = periodStart + periodMs - Math.floor(rand() * 5 * DAY);
          if (canceledAt < now) { status = 'canceled'; break; }
          canceledAt = null;
        }
        periodStart += periodMs;
      }
      const sub = {
        id: ids.sub(), customer_id: customer.id, price_id: priceId, product_id: product[0], status, quantity,
        plan_amount: unitAmount, plan_interval: interval, trial_start: trial ? ts(subStart) : null,
        trial_end: trial ? ts(subStart + trial) : null, start_date: ts(subStart), canceled_at: canceledAt ? ts(canceledAt) : null,
        ended_at: canceledAt ? ts(canceledAt) : null, created: ts(subStart),
      };
      t.subscriptions.push(sub);
      for (const inv of subInvoices) inv.subscription_id = sub.id;
    }
    // One-off purchases
    const oneOffs = rand() < 0.35 ? 1 + Math.floor(rand() * 4) : 0;
    for (let k = 0; k < oneOffs; k++) {
      const when = created + Math.floor(rand() * (now - created));
      addCharge({ customer, amount: [500, 1500, 2500, 9900, 24900][Math.floor(rand() * 5)], currency: customer.currency === 'jpy' ? 'usd' : customer.currency, created: when, invoiceId: null, description: 'One-time purchase' });
    }
  }
  return t;
}

export const SCHEMA = {
  customers: { id: 'varchar', email: 'varchar', name: 'varchar', description: 'varchar', currency: 'varchar', address_country: 'varchar', delinquent: 'boolean', created: 'timestamp(3)' },
  products: { id: 'varchar', name: 'varchar', active: 'boolean', created: 'timestamp(3)' },
  prices: { id: 'varchar', product_id: 'varchar', unit_amount: 'bigint', currency: 'varchar', recurring_interval: 'varchar', active: 'boolean', created: 'timestamp(3)' },
  subscriptions: { id: 'varchar', customer_id: 'varchar', price_id: 'varchar', product_id: 'varchar', status: 'varchar', quantity: 'bigint', plan_amount: 'bigint', plan_interval: 'varchar', trial_start: 'timestamp(3)', trial_end: 'timestamp(3)', start_date: 'timestamp(3)', canceled_at: 'timestamp(3)', ended_at: 'timestamp(3)', created: 'timestamp(3)' },
  invoices: { id: 'varchar', customer_id: 'varchar', subscription_id: 'varchar', amount_due: 'bigint', amount_paid: 'bigint', currency: 'varchar', status: 'varchar', billing_reason: 'varchar', period_start: 'timestamp(3)', period_end: 'timestamp(3)', created: 'timestamp(3)' },
  charges: { id: 'varchar', customer_id: 'varchar', invoice_id: 'varchar', amount: 'bigint', currency: 'varchar', amount_refunded: 'bigint', captured: 'boolean', paid: 'boolean', refunded: 'boolean', disputed: 'boolean', status: 'varchar', failure_code: 'varchar', card_brand: 'varchar', card_country: 'varchar', description: 'varchar', created: 'timestamp(3)' },
  refunds: { id: 'varchar', charge_id: 'varchar', amount: 'bigint', currency: 'varchar', reason: 'varchar', status: 'varchar', created: 'timestamp(3)' },
  disputes: { id: 'varchar', charge_id: 'varchar', amount: 'bigint', currency: 'varchar', reason: 'varchar', status: 'varchar', created: 'timestamp(3)' },
  balance_transactions: { id: 'varchar', source_id: 'varchar', type: 'varchar', amount: 'bigint', fee: 'bigint', net: 'bigint', currency: 'varchar', status: 'varchar', created: 'timestamp(3)', available_on: 'timestamp(3)' },
};

function literal(v, type) {
  if (v === null || v === undefined) return `CAST(NULL AS ${type})`;
  if (type === 'boolean') return v ? 'true' : 'false';
  if (type === 'bigint') return String(Math.round(v));
  if (type.startsWith('timestamp')) return `TIMESTAMP '${v.toISOString().replace('T', ' ').replace('Z', '')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Create and populate tables under `${catalog}.${schema}`. Skips if already seeded.
 * @param {import('./trino.js').TrinoClient} client
 */
export async function seed(client, { catalog = 'memory', schema = 'billing', force = false, log = console.log, ...genOpts } = {}) {
  const fq = `${catalog}.${schema}`;
  const existing = await client.query(`SHOW SCHEMAS FROM ${catalog} LIKE '${schema}'`);
  if (existing.rows.length > 0 && !force) {
    const tables = await client.query(`SHOW TABLES FROM ${fq}`);
    if (tables.rows.length >= Object.keys(SCHEMA).length) {
      log(`[seed] ${fq} already populated, skipping`);
      return false;
    }
  }
  log(`[seed] creating sample dataset in ${fq}`);
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${fq}`);
  const data = generateDataset(genOpts);
  for (const [table, cols] of Object.entries(SCHEMA)) {
    await client.query(`DROP TABLE IF EXISTS ${fq}.${table}`);
    const colDefs = Object.entries(cols).map(([c, ty]) => `${c} ${ty}`).join(', ');
    await client.query(`CREATE TABLE ${fq}.${table} (${colDefs})`);
    const rows = data[table];
    const names = Object.keys(cols);
    for (let i = 0; i < rows.length; i += 500) {
      const values = rows.slice(i, i + 500)
        .map(r => `(${names.map(n => literal(r[n], cols[n])).join(', ')})`)
        .join(',\n');
      await client.query(`INSERT INTO ${fq}.${table} (${names.join(', ')}) VALUES ${values}`);
    }
    log(`[seed]   ${table}: ${rows.length} rows`);
  }
  return true;
}
