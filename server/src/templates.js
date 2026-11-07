// Starter queries shown in the "Templates" section of the sidebar.
// Written against the sample billing dataset (default catalog/schema).

export const TEMPLATES = [
  {
    id: 'mrr-by-month',
    category: 'Revenue',
    title: 'Monthly recurring revenue',
    description: 'MRR from active subscriptions at the end of each month, normalizing annual plans.',
    sql: `-- MRR at the end of each month (annual plans divided by 12), in dollars
WITH months AS (
  SELECT m AS month_start
  FROM UNNEST(sequence(
    date_trunc('month', (SELECT date(min(start_date)) FROM subscriptions)),
    date_trunc('month', current_date),
    INTERVAL '1' MONTH)) AS t(m)
)
SELECT
  months.month_start AS month,
  round(sum(
    CASE s.plan_interval WHEN 'year' THEN s.plan_amount / 12.0 ELSE s.plan_amount END
    * s.quantity) / 100.0, 2) AS mrr,
  count(*) AS active_subscriptions
FROM months
JOIN subscriptions s
  ON s.start_date < months.month_start + INTERVAL '1' MONTH
 AND (s.ended_at IS NULL OR s.ended_at >= months.month_start + INTERVAL '1' MONTH)
 AND s.status <> 'trialing'
GROUP BY 1
ORDER BY 1`,
  },
  {
    id: 'daily-volume',
    category: 'Revenue',
    title: 'Daily gross volume (last 30 days)',
    description: 'Successful charge volume and count per day.',
    sql: `SELECT
  date(created) AS day,
  count(*) AS charges,
  sum(amount) / 100.0 AS gross_volume
FROM charges
WHERE status = 'succeeded'
  AND created >= current_timestamp - INTERVAL '30' DAY
GROUP BY 1
ORDER BY 1`,
  },
  {
    id: 'net-by-month',
    category: 'Revenue',
    title: 'Net revenue after fees and refunds',
    description: 'Gross, fees, refunds and net from balance transactions, by month.',
    sql: `SELECT
  date(date_trunc('month', created)) AS month,
  sum(CASE WHEN type = 'charge' THEN amount ELSE 0 END) / 100.0 AS gross,
  sum(fee) / 100.0 AS fees,
  -sum(CASE WHEN type = 'refund' THEN amount ELSE 0 END) / 100.0 AS refunds,
  -sum(CASE WHEN type = 'adjustment' THEN amount ELSE 0 END) / 100.0 AS disputes,
  sum(net) / 100.0 AS net
FROM balance_transactions
GROUP BY 1
ORDER BY 1`,
  },
  {
    id: 'top-customers',
    category: 'Customers',
    title: 'Top customers by lifetime spend',
    description: 'Customers ranked by total successful, non-refunded charges.',
    sql: `SELECT
  c.id AS customer_id,
  c.email,
  c.address_country AS country,
  count(ch.id) AS charges,
  sum(ch.amount - ch.amount_refunded) / 100.0 AS lifetime_value
FROM customers c
JOIN charges ch ON ch.customer_id = c.id
WHERE ch.status = 'succeeded'
GROUP BY 1, 2, 3
ORDER BY lifetime_value DESC
LIMIT 25`,
  },
  {
    id: 'new-customers',
    category: 'Customers',
    title: 'New customers by month and country',
    description: 'Customer sign-ups grouped by month and billing country.',
    sql: `SELECT
  date(date_trunc('month', created)) AS month,
  address_country AS country,
  count(*) AS new_customers
FROM customers
GROUP BY 1, 2
ORDER BY 1, 3 DESC`,
  },
  {
    id: 'churn',
    category: 'Subscriptions',
    title: 'Subscription churn by plan',
    description: 'Active vs. canceled subscriptions and churn rate for each product.',
    sql: `SELECT
  p.name AS product,
  s.plan_interval AS billing_interval,
  count(*) AS subscriptions,
  count_if(s.status = 'canceled') AS canceled,
  round(100.0 * count_if(s.status = 'canceled') / count(*), 1) AS churn_pct
FROM subscriptions s
JOIN products p ON p.id = s.product_id
GROUP BY 1, 2
ORDER BY subscriptions DESC`,
  },
  {
    id: 'failed-payments',
    category: 'Payments',
    title: 'Failed payments by decline code',
    description: 'Why charges fail, with the card brand breakdown.',
    sql: `SELECT
  failure_code,
  card_brand,
  count(*) AS failed_charges,
  sum(amount) / 100.0 AS failed_volume
FROM charges
WHERE status = 'failed'
GROUP BY 1, 2
ORDER BY failed_charges DESC`,
  },
  {
    id: 'disputes',
    category: 'Payments',
    title: 'Open disputes needing a response',
    description: 'Disputes awaiting evidence, with the original charge and customer.',
    sql: `SELECT
  d.id AS dispute_id,
  d.reason,
  d.amount / 100.0 AS amount,
  d.created,
  ch.id AS charge_id,
  c.email AS customer_email
FROM disputes d
JOIN charges ch ON ch.id = d.charge_id
JOIN customers c ON c.id = ch.customer_id
WHERE d.status = 'needs_response'
ORDER BY d.created`,
  },
  {
    id: 'card-brands',
    category: 'Payments',
    title: 'Payment volume by card brand',
    description: 'Share of successful volume per card network.',
    sql: `SELECT
  card_brand,
  count(*) AS charges,
  sum(amount) / 100.0 AS volume,
  round(100.0 * sum(amount) / sum(sum(amount)) OVER (), 1) AS pct_of_volume
FROM charges
WHERE status = 'succeeded'
GROUP BY 1
ORDER BY volume DESC`,
  },
];
