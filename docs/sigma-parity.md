# Sigma parity checklist

Each row is a behaviour stated in Stripe's Sigma documentation, fetched on 2026-11-07, with how this app implements it and how that was checked.

Sources:
- **WQ**: [Write queries](https://docs.stripe.com/stripe-data/write-queries)
- **HSW**: [How Sigma works](https://docs.stripe.com/stripe-data/access-data-in-dashboard)
- **SQ**: [Schedule queries](https://docs.stripe.com/stripe-data/schedule-queries)
- **QT**: [Query transactional data](https://docs.stripe.com/data/query-transactions)
- **MQ**: [Migrate queries](https://docs.stripe.com/data/migrate-queries)

Verification legend:
- **unit**: `server/test/*.test.js`
- **trino**: integration test against a real Trino
- **e2e**: Playwright run against the built UI with a real Trino (`scripts/e2e-parity.cjs`)

## Engine and data

| Sigma behaviour (source) | Here | Verified |
|---|---|---|
| Sigma runs on Trino (queries migrated "from … Presto v334 to … Trino v414") (MQ) | Every query runs on Trino over its client REST protocol | trino, e2e |
| "The available data within Sigma is read-only." (HSW) | Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN, one statement per run | unit |
| Amounts "in the lowest available currency unit, such as cents" (WQ) | Sample data stores amounts in cents | trino |
| "The `data_load_time` parameter provides the timestamp that data is available through." (HSW) | Top bar: "Data available through …" (`FRESHNESS_QUERY`); scheduled runs record `data_load_time` | unit, e2e |

## Navigator (left of the editor)

| Sigma behaviour (source) | Here | Verified |
|---|---|---|
| "The navigator window to the left of the editor" shows saved queries, the team's queries, the table schema and templates (WQ) | Left sidebar with a **Queries** tab (Saved, Scheduled, Templates, History) and a **Schema** tab. Saved queries are shared by everyone on the server | e2e |
| Selecting a saved query or template "loads it into the query editor", then you click **Run** (WQ) | Same | e2e |
| To start from a saved query: its "overflow menu" → **Make a copy**, or load it and click **Make a copy** (WQ) | ⋯ menu on saved items (**Make a copy**, **Delete**), plus a **Make a copy** button in the editor header | e2e |
| Upcoming scheduled queries appear "under Scheduled within the Queries tab", grouped by creator (SQ) | **Scheduled** section, "Created by you" (there are no user accounts yet, so there is one group) | e2e |

## Editor and running

| Sigma behaviour (source) | Here | Verified |
|---|---|---|
| Write standard SQL directly in the editor (WQ) | CodeMirror editor with Trino keywords and schema autocomplete | e2e |
| "Click Run to execute the query and view the results in a table below the editor." (WQ) | **Run** (or ⌘/Ctrl+Enter); results table below | e2e |
| An invalid query gives "an error message that contains the line number and position of the error" (WQ) | Trino's error plus a "Go to line N, position M" link | e2e |
| "More complex queries might take a few moments longer" (WQ) | Running state, with **Cancel** | unit, e2e |

## Assistant

| Sigma behaviour (source) | Here | Verified |
|---|---|---|
| Built-in LLM assistant that writes SQL from a natural-language prompt (WQ) | Assistant bar above the editor (Claude) | unit, e2e (with a stubbed response) |
| **Generate** "write[s] a new query, overwriting any SQL" in the editor; **Edit** "modif[ies] the SQL in the query editor" (WQ) | **Generate** / **Edit** toggle. Generate ignores the editor contents; Edit sends them | unit, e2e |
| "When the editor contains content, the mode automatically switches to Edit." (WQ) | Same | e2e |
| After Generate, the assistant "loads the query suggestion into the editor", "displays a summary", "runs the suggested query and returns the results", and "switches the mode to Edit" (WQ) | Same, in that order | e2e |
| "Sigma saves every interaction … in the chat history for that query"; a button "in the top-right of the editor" opens the "chat history slider" with **View SQL** and **View in editor** (WQ) | Chat button at the editor's top right opens a slide-over. History is stored per query and follows a draft once it's saved | unit, e2e |
| "Was this response helpful?" between the editor and the results, with **Yes** / **No** and details (WQ) | Same, stored with the chat entry | unit, e2e |

## Results and charts

| Sigma behaviour (source) | Here | Verified |
|---|---|---|
| "View a maximum of 1,000 results." (WQ) | The table shows up to 1,000 rows, then "Showing the first 1,000 of N rows. Download CSV to get all results." | e2e |
| "Sort the results by clicking the column headers." (WQ) | Same | e2e |
| "Resize each column." (WQ) | Drag a header's right edge | e2e |
| Chart "for queries with fewer than 10,000 results"; "line or bar charts with custom y-axes and x-axes"; "Group by any table column" (WQ) | **Chart** tab: Line/Bar, X-axis, Y-axis, Group by; a message instead of a chart at 10,000+ rows | e2e |
| A chart saved to a query "appears with your chosen settings every time you run the query" (WQ) | **Save chart** stores the settings on the query and reapplies them on each run | unit, e2e |
| "Download CSV … includes all query results, so you're not limited to the 1,000 viewable results." (WQ) | **Download CSV** sends every row, re-running the query without the cap when needed | unit |

## Saving and sharing

| Sigma behaviour (source) | Here | Verified |
|---|---|---|
| "Click Save. Stripe automatically generates an editable title for your query." (WQ) | Saving an untitled query generates a title (by the assistant if configured, otherwise from the tables used). It stays editable | unit, e2e |
| Saved queries are "available to every team member"; each has "a unique URL you can share by clicking Share" (WQ) | **Share** copies `…/#/queries/<id>` | e2e |

## Scheduled queries

| Sigma behaviour (source) | Here | Verified |
|---|---|---|
| "With a query loaded into the editor, click Schedule. Give each scheduled query a unique name" (SQ) | **Schedule** opens the dialog with a Name field; duplicate names are rejected | unit, e2e |
| Daily, weekly or monthly, run "as soon as the data for that period is available"; days end at 12:00am UTC and weeks on Sunday (SQ) | Runs fire when the period closes: 00:00 UTC daily, Monday 00:00 UTC weekly, the 1st monthly | unit |
| "Timeline displays the date your query runs next, and the processing date of the data it uses" (SQ) | **Next run** and **Data processed** in the dialog | unit, e2e |
| Results are emailed to subscribers; "Creators … are added as subscribers … by default"; the email has "the name and date … and a link to download the results in CSV format"; **Preview email**; **Unsubscribe** link (SQ) | Subscribers field, `USER_EMAIL` auto-subscribed, SMTP delivery (`SMTP_URL`), **Preview email**, signed unsubscribe links | unit, e2e (preview) |
| **Edit schedule**; delete from a menu (SQ) | **Edit schedule** button; **Delete schedule** in the dialog | e2e |
| Webhook event `sigma.scheduled_query_run.created` with `data.object` = `scheduled_query_run` {status, data_load_time, file{url, purpose: sigma_scheduled_query, …}, title, sql, result_available_until, error} (SQ) | Same payload shape; `file.url` points at this server's CSV download | unit |

## Metrics

| Sigma behaviour (source) | Here | Verified |
|---|---|---|
| "Create metrics from your Sigma reports and organize them in metric groups"; groups show the report's chart, or "the number of rows" when no chart is set (HSW) | **Metrics** page with groups of report cards: saved chart, or row count | e2e |
| "You can add up to 20 Sigma reports across all metric groups." Deleting a group doesn't delete its reports (HSW) | Enforced on the server | unit |

## Deliberately different

| Sigma | Here | Why |
|---|---|---|
| Stripe Dashboard branding and navigation (Reports > Sigma) | Own name ("Query Studio") and styling | Copying Stripe's brand would be impersonation |
| Stripe accounts, team permissions, "Charts are only editable by the author", per-creator schedule groups | No accounts: everyone on the server is one team | There's no user model yet |
| The full Stripe schema (charges, payouts, Connect, Issuing, Tax, …) | A small sample billing schema (Core, Billing). Add more with `SCHEMA_BROWSER` | We're adding schemas selectively later |
| Report templates tied to Stripe financial reports; Queries and Reports API | Starter templates for the sample data; this app's own HTTP API | Stripe-specific |
| Training-data consent setting for the assistant | Not applicable | |
