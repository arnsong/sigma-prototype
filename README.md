# sigma-prototype: Query Studio

A SQL analysis workspace that follows Stripe Sigma's documented UI and behaviour, backed by Trino. Sigma itself runs on Trino (v414), so the engine matches too.

The app has its own name and styling and carries no Stripe branding. Every Sigma behaviour it implements is listed, with its source in Stripe's docs and how it was verified, in **[docs/sigma-parity.md](docs/sigma-parity.md)**.

![layout](docs/screenshot.png)

## What's in it

- **Navigator** to the left of the editor:
  - **Queries** tab: Saved, Scheduled, Templates and History. Each saved query has a ⋯ menu with **Make a copy** and **Delete**.
  - **Schema** tab: tables grouped by product area, with column types and descriptions, search, **Insert** and **Preview**.
- **Editor** (CodeMirror 6) with Trino syntax and autocomplete from the live schema.
  - **Run** (⌘/Ctrl+Enter) runs the selection if there is one, otherwise the whole query.
  - Errors show the line number and position, with a link that jumps there.
- **Assistant** (Claude):
  - **Generate** writes a new query; **Edit** changes the SQL in the editor. The mode switches to Edit automatically when the editor has content.
  - A suggestion is loaded into the editor with a summary and run straight away.
  - Each query keeps its chat history, opened from the editor's top-right button, with **View SQL** and **View in editor**.
  - "Was this response helpful?" feedback appears between the editor and the results.
  - **Fix with assistant** is offered when a query fails.
- **Results**:
  - Up to 1,000 rows are shown. **Download CSV** gets all rows; if the run was capped, the query is re-run without the cap.
  - Click a header to sort; drag a header's edge to resize.
- **Charts** for results under 10,000 rows:
  - Line or bar, with X-axis, Y-axis and **Group by** any column.
  - **Save chart** stores the settings with the query, and the chart reappears on every run.
- **Save**: an untitled query gets an auto-generated, editable title. **Share** copies the query's unique URL.
- **Scheduled queries**:
  - Daily, weekly or monthly, running when the period's data closes (00:00 UTC; weeks end Sunday).
  - Each schedule has a unique name and a timeline showing the next run and the data period it covers.
  - Results go to email subscribers (creator included by default), with **Preview email** and unsubscribe links.
  - A webhook can receive a `sigma.scheduled_query_run.created` event in Sigma's payload shape.
  - Past runs can be viewed or downloaded.
- **Metrics**: metric groups of up to 20 reports. Each report shows its saved chart, or its row count if it has no chart.
- **Data available through …**: the `data_load_time` equivalent, shown in the top bar.
- **Read-only**: one SELECT / WITH / SHOW / DESCRIBE / EXPLAIN statement per run.
- **Sample data**: a small billing schema seeded into Trino's memory catalog at `memory.billing`. More schemas can be added later with `SCHEMA_BROWSER`.
  - Core: `balance_transactions`, `charges`, `customers`, `disputes`, `refunds`
  - Billing: `invoices`, `prices`, `products`, `subscriptions`

Deliberate differences from Sigma are listed at the end of the [parity checklist](docs/sigma-parity.md#deliberately-different). The main ones: no Stripe branding, no user accounts (everyone on the server is one team), and a small sample schema instead of Stripe's full one.

## Architecture

```
browser (React + Vite)  ──/api──▶  Node/Express server  ──HTTP /v1/statement──▶  Trino
                                    │  query runner (poll, 100k-row cap, cancel, full-CSV re-run)
                                    │  schema browser (information_schema)
                                    │  assistant (Claude, structured output)
                                    │  scheduler (period runs, email via SMTP, webhooks)
                                    └─ data/store.json + data/snapshots/
```

The server talks to Trino over its REST client protocol directly (`server/src/trino.js`). The browser never connects to Trino: every query goes through the server, which validates it and runs it as the configured user.

## Quick start (Docker)

```bash
docker compose up --build
```

Open http://localhost:3001. To turn on the assistant, export `ANTHROPIC_API_KEY` before running the command.

## Local development

You need Node 22+ and a Trino server with the `memory` catalog (see `trino/catalog/`).

```bash
docker compose up trino
```

```bash
npm install
```

```bash
npm run dev
```

The API runs on :3001 and Vite on http://localhost:5173, which proxies `/api` to the API. For a production-style run, use `npm run build && npm start`.

### Tests

Unit and API tests, using a fake Trino:

```bash
npm test
```

The same, plus seeding a real Trino and running every template against it:

```bash
TRINO_SERVER=http://localhost:8080 npm test
```

The browser check of every documented Sigma behaviour in [docs/sigma-parity.md](docs/sigma-parity.md) starts a stub of the Claude API, so no key is needed. Start the stub:

```bash
node scripts/fake-anthropic.cjs 4010 &
```

Start the app with the assistant pointed at the stub:

```bash
npm run build && ANTHROPIC_BASE_URL=http://127.0.0.1:4010 ANTHROPIC_API_KEY=test USER_EMAIL=me@example.com DATA_DIR=$(mktemp -d) npm start &
```

Run the check:

```bash
node scripts/e2e-parity.cjs http://localhost:3001
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TRINO_SERVER` | `http://localhost:8080` | Trino coordinator URL |
| `TRINO_USER` | `sigma` | User sent as `X-Trino-User` |
| `TRINO_PASSWORD` | – | HTTP basic auth (Trino requires HTTPS for this) |
| `TRINO_CATALOG` / `TRINO_SCHEMA` | `memory` / `billing` | Default catalog/schema; unqualified table names resolve here |
| `SCHEMA_BROWSER` | the default `catalog.schema` | Comma-separated `catalog.schema` (or `catalog`) list shown in the schema browser |
| `MAX_ROWS` | `100000` | Rows kept per run (the table shows 1,000; CSV gets everything) |
| `ALLOW_WRITES` | `false` | Allow non-read-only statements |
| `SEED` | `true` | Seed the sample dataset on startup (skipped if present) |
| `SEED_CATALOG` / `SEED_SCHEMA` | the default catalog/schema | Where to seed |
| `FRESHNESS_QUERY` | `SELECT max(created) FROM <seed>.balance_transactions` | Single value shown as "Data available through …"; empty to hide |
| `ANTHROPIC_API_KEY` | – | Turns on the assistant and model-written titles |
| `ASSISTANT_MODEL` | `claude-opus-5-5` | Claude model for the assistant |
| `SCHEDULER` | `true` | `false` turns off scheduled queries |
| `SMTP_URL` | – | Sends scheduled results by email, e.g. `smtps://user:pass@smtp.example.com` |
| `MAIL_FROM` | `Query Studio <reports@localhost>` | From address for those emails |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base URL for CSV and unsubscribe links in emails and webhooks |
| `USER_EMAIL` | – | Address auto-subscribed as a schedule's creator (no user accounts yet) |
| `PORT` | `3001` | HTTP port |
| `DATA_DIR` | `./data` | Where saved queries, history and scheduled results are stored |

To point the app at your own data, set `TRINO_CATALOG`, `TRINO_SCHEMA` and `SCHEMA_BROWSER` to catalogs your Trino already serves, and set `SEED=false`.

## HTTP API

| Method & path | Description |
|---|---|
| `GET /api/config` | Trino version, defaults, limits, enabled features |
| `GET /api/schema[?refresh=1]` | Tables and columns for the configured schemas |
| `GET /api/templates` | Starter queries |
| `POST /api/runs` `{sql}` | Start a query |
| `GET /api/runs/:id?wait=ms&offset=&limit=` | Status (long-polls up to 5s) and a page of rows |
| `POST /api/runs/:id/cancel` | Cancel the run and the Trino query |
| `GET /api/runs/:id/csv` | All results as CSV |
| `GET /api/history` | Recent runs |
| `GET/POST/PUT/DELETE /api/queries[/:id]` | Saved queries (`{title, sql, chart}`) |
| `POST /api/title` `{sql}` | Generate a title for a query |
| `POST /api/assistant` `{question, mode, sql?, error?, key}` | Generate or edit SQL; recorded in the chat history for `key` |
| `GET /api/assistant/history?key=` · `POST /api/assistant/feedback` | Chat history for a query; "Was this helpful?" |
| `PUT/DELETE /api/queries/:id/schedule` `{title, frequency, subscribers, webhookUrl}` | Schedule a query, or remove its schedule |
| `GET /api/queries/:id/schedule/email-preview` | The email subscribers receive |
| `POST/GET /api/queries/:id/snapshots` · `GET /api/snapshots/:id[/csv]` | Run now; past scheduled results |
| `GET /api/unsubscribe?query=&email=&token=` | Signed unsubscribe link from emails |
| `GET/POST/PUT/DELETE /api/metric-groups[/:id]` · `POST/DELETE /api/metric-groups/:id/queries[/:queryId]` | Metric groups |
