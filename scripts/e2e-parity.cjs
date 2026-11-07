// End-to-end check of the documented Sigma behaviours in docs/sigma-parity.md.
// Needs the app running against Trino with the sample data, and the assistant pointed
// at scripts/fake-anthropic.cjs:
//   node scripts/fake-anthropic.cjs 4010 &
//   ANTHROPIC_BASE_URL=http://127.0.0.1:4010 ANTHROPIC_API_KEY=test USER_EMAIL=me@example.com npm start &
//   node scripts/e2e-parity.cjs http://localhost:3001 [screenshot-dir]
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:3001';
const SHOTS = process.argv[3] || null;
const results = [];
let page = null;
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split('\n')[0] });
    if (SHOTS && page) await page.screenshot({ path: `${SHOTS}/FAIL-${results.length}.png` }).catch(() => {});
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  page = p;
  const pageErrors = [];
  p.on('pageerror', e => pageErrors.push(e.message));
  let promptAnswer = 'Key metrics';
  p.on('dialog', d => d.accept(d.type() === 'prompt' ? promptAnswer : undefined));
  const shot = async n => SHOTS && p.screenshot({ path: `${SHOTS}/${n}.png` });
  const editorText = () => p.textContent('.cm-content');
  const setSql = async sql => {
    await p.click('.cm-content');
    await p.keyboard.press('Control+a');
    await p.keyboard.press('Delete');
    await p.evaluate(s => navigator.clipboard.writeText(s), sql);
    await p.keyboard.press('Control+v');
  };
  const run = async () => {
    await p.click('.run-bar .btn-primary');
    await p.waitForSelector('.results-meta, .error-box', { timeout: 30000 });
  };

  await p.goto(BASE);
  await p.evaluate(() => localStorage.clear());
  await p.goto(BASE);
  await p.waitForSelector('.cm-content');

  await check('Engine: top bar shows Trino connection', async () => {
    await p.waitForSelector('.conn-dot.ok', { timeout: 10000 });
    assert(/Trino \d+/.test(await p.textContent('.conn')), 'no Trino version shown');
  });
  await check('data_load_time: "Data available through …" shown', async () => {
    assert((await p.textContent('.freshness')).startsWith('Data available through'), 'freshness text missing');
  });
  await check('Navigator left of editor: saved, scheduled, templates, schema', async () => {
    const side = await p.$('.sidebar'); const main = await p.$('.main');
    assert((await side.boundingBox()).x < (await main.boundingBox()).x, 'sidebar not left of editor');
    const text = await p.textContent('.side-scroll');
    for (const s of ['Saved', 'Scheduled', 'Templates']) assert(text.includes(s), `missing ${s}`);
    assert(await p.$('.sidebar-tabs >> text=Schema'), 'no Schema tab');
  });
  await check('Selecting a template loads it into the editor; Run shows results below', async () => {
    await p.click('text=Daily gross volume (last 30 days)');
    assert((await editorText()).includes('gross_volume'), 'template SQL not loaded');
    await run();
    const ed = await (await p.$('.editor-pane')).boundingBox();
    const tb = await (await p.$('.results-table')).boundingBox();
    assert(tb.y > ed.y, 'results not below editor');
  });
  await check('Invalid query: error with line number and position', async () => {
    await setSql('SELECT id,\n  nope\nFROM charges');
    await run();
    const t = await p.textContent('.error-box');
    assert(/line 2:3/.test(t) && /Go to line 2, position 3/.test(t), `unexpected error text: ${t}`);
  });
  await check('Results: at most 1,000 rows viewable, CSV for the rest', async () => {
    await p.click('text=New query');
    await setSql('SELECT id, amount, currency, created FROM charges');
    await run();
    const n = await p.$$eval('.results-table tbody tr', r => r.length);
    assert(n === 1000, `expected 1000 rows, got ${n}`);
    assert(/Showing the first 1,000 of [\d,]+ rows\. Download CSV/.test(await p.textContent('.pager')), 'missing cap note');
    await shot('01-results-cap');
  });
  await check('Results: sort by clicking a column header', async () => {
    await p.click('.results-table th >> text=amount');
    assert((await p.getAttribute('.results-table th:nth-child(3)', 'aria-sort')) === 'ascending', 'not sorted');
    const vals = await p.$$eval('.results-table tbody tr td:nth-child(3)', tds => tds.slice(0, 50).map(td => Number(td.textContent)));
    assert(vals.every((v, i) => i === 0 || vals[i - 1] <= v), 'values not ascending');
  });
  await check('Results: resize a column by dragging its edge', async () => {
    const th = await p.$('.results-table th:nth-child(2)');
    const before = (await th.boundingBox()).width;
    const h = await (await th.$('.col-resizer')).boundingBox();
    await p.mouse.move(h.x + 2, h.y + h.height / 2);
    await p.mouse.down();
    await p.mouse.move(h.x + 122, h.y + h.height / 2, { steps: 5 });
    await p.mouse.up();
    const after = (await th.boundingBox()).width;
    assert(after > before + 80, `width ${before} -> ${after}`);
  });
  await check('Chart: line/bar, x/y axes and group by any column', async () => {
    await setSql("SELECT date(date_trunc('month', created)) AS month, card_brand, sum(amount) / 100.0 AS volume\nFROM charges\nWHERE status = 'succeeded'\nGROUP BY 1, 2\nORDER BY 1");
    await run();
    await p.click('.results-head >> text=Chart');
    await p.waitForSelector('.chart-box svg');
    await p.selectOption('.chart-controls label:has-text("Group by") select', 'card_brand');
    const legend = await p.$$eval('.legend-item', e => e.map(x => x.textContent));
    assert(legend.length === 4 && legend.includes('visa'), `legend: ${legend}`);
    await p.click('.chart-controls >> text=Bar');
    assert(await p.$('.chart-box svg path[fill^="var(--series"]'), 'no bars');
    await shot('02-chart-group-by');
  });
  await check('Save: auto-generated, editable title', async () => {
    await p.click('.query-actions >> text=Save');
    await p.waitForSelector('.save-state:has-text("Saved")');
    const title = await p.inputValue('.query-title');
    assert(title === 'Card brand volume', `title was "${title}"`);
  });
  await check('Chart saved to a query reappears on every run', async () => {
    // Saving the query stored the chart as it was (Bar, grouped). Change it and save the chart.
    await p.click('.results-head >> text=Chart');
    await p.waitForSelector('.chart-save:has-text("Chart saved")');
    await p.click('.chart-controls >> text=Line');
    await p.click('.chart-save:has-text("Save chart")');
    await p.waitForSelector('.chart-save:has-text("Chart saved")');
    await p.click('text=New query');
    await p.click('.side-item >> text=Card brand volume');
    await run();
    await p.waitForSelector('.chart-box svg');
    assert((await p.$$('.legend-item')).length === 4, 'group-by not restored');
    assert(await p.$('.chart-controls .segmented button.active:has-text("Line")'), 'line not restored');
  });
  await check('Chart only for fewer than 10,000 results', async () => {
    await p.click('text=New query');
    await setSql('SELECT a * 100 + b AS n, a, b FROM UNNEST(sequence(1, 120)) AS x(a) CROSS JOIN UNNEST(sequence(1, 100)) AS y(b)');
    await run();
    await p.click('.results-head >> text=Chart');
    assert((await p.textContent('.results-body')).includes('fewer than 10,000 results'), 'no chart limit message');
  });
  await check('Share copies a unique URL for the saved query', async () => {
    await p.click('.side-item >> text=Card brand volume');
    await p.click('.query-actions >> text=Share');
    const url = await p.evaluate(() => navigator.clipboard.readText());
    assert(/#\/queries\/[0-9a-f-]{36}$/.test(url), `clipboard: ${url}`);
  });
  await check('Overflow menu: Make a copy', async () => {
    const row = p.locator('.side-item-row', { hasText: 'Card brand volume' }).first();
    await row.hover();
    await row.locator('.overflow-btn').click();
    await p.click('.menu >> text=Make a copy');
    await p.waitForSelector('.side-item >> text=Card brand volume (copy)');
    assert((await p.inputValue('.query-title')) === 'Card brand volume (copy)', 'copy not opened');
  });

  // ---- Assistant ---------------------------------------------------------------
  await check('Assistant: mode switches to Edit when the editor has content', async () => {
    await p.waitForSelector('.assistant .segmented button.active:has-text("Edit")', { timeout: 3000 });
    await p.click('text=New query');
    await p.waitForSelector('.assistant .segmented button.active:has-text("Generate")', { timeout: 3000 });
  });
  await check('Assistant Generate: loads SQL, shows summary, runs it, switches to Edit', async () => {
    await p.fill('.assistant-form input', 'Volume by card brand');
    await p.click('.assistant-form button.btn-primary');
    await p.waitForSelector('.assistant-note');
    assert((await p.textContent('.assistant-note')).includes('per card brand'), 'no summary');
    assert((await editorText()).includes('ORDER BY volume DESC'), 'SQL not loaded');
    await p.waitForSelector('.results-table tbody tr', { timeout: 30000 });
    assert(await p.$('.assistant .segmented button.active:has-text("Edit")'), 'did not switch to Edit');
    await shot('03-assistant');
  });
  await check('Assistant Edit: modifies the SQL in the editor', async () => {
    await p.fill('.assistant-form input', 'Sort these results by amount');
    await p.click('.assistant-form button.btn-primary');
    await p.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('ORDER BY volume ASC'));
  });
  await check('"Was this response helpful?" between editor and results', async () => {
    const fb = await p.$('.feedback');
    assert((await fb.textContent()).includes('Was this response helpful?'), 'no prompt');
    const ed = await (await p.$('.editor-pane')).boundingBox();
    const res = await (await p.$('.results')).boundingBox();
    const f = await fb.boundingBox();
    assert(f.y > ed.y && f.y < res.y, 'not between editor and results');
    await p.click('.feedback >> text=No');
    await p.fill('.feedback-form input', 'Wanted it grouped by currency too');
    await p.click('.feedback-form >> text=Submit');
    await p.waitForSelector('text=Thanks for your feedback.');
  });
  await check('Chat history slider (top right of editor): View SQL / View in editor', async () => {
    const tog = await (await p.$('.chat-toggle')).boundingBox();
    const ed = await (await p.$('.editor-pane')).boundingBox();
    assert(tog.x > ed.x + ed.width / 2 && tog.y < ed.y + 40, 'toggle not top-right');
    await p.click('.chat-toggle');
    const prompts = await p.$$eval('.chat-prompt', e => e.map(x => x.textContent));
    assert(prompts.length === 2, `entries: ${prompts}`);
    await p.click('.chat-entry:last-child >> text=View SQL');
    await p.click('.chat-entry:last-child >> text=View in editor');
    await p.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('ORDER BY volume DESC'));
    await p.click('.query-actions >> text=Save');
    await p.waitForSelector('.save-state:has-text("Saved")');
    await p.click('.chat-toggle');
    assert((await p.$$('.chat-entry')).length === 2, 'history did not follow the saved query');
    await p.click('.chat-head .icon-btn');
  });

  // ---- Scheduling ----------------------------------------------------------------
  await check('Schedule: name, frequency, timeline, subscribers (creator by default)', async () => {
    await p.click('.query-actions >> text=Schedule');
    await p.waitForSelector('.modal');
    await p.fill('.modal .form-field:has-text("Name") input', 'Weekly card brand volume');
    await p.check('.freq input[value="weekly"]');
    const tl = await p.textContent('.timeline');
    assert(tl.includes('Next run') && tl.includes('Data processed'), 'no timeline');
    assert((await p.textContent('.modal')).includes('me@example.com'), 'creator not mentioned');
    await p.fill('.modal .form-field:has-text("Subscribers") input', 'finance@example.com');
    await p.click('.modal-actions >> text=Schedule');
    await p.waitForSelector('.modal h2:has-text("Edit schedule")');
    await shot('04-schedule');
  });
  await check('Schedule: Preview email shows name, date and CSV link', async () => {
    await p.click('.modal >> text=Preview email');
    const frame = await (await p.waitForSelector('iframe.email-preview')).contentFrame();
    const t = await frame.textContent('body');
    assert(t.includes('Weekly card brand volume') && t.includes('Unsubscribe'), 'email missing content');
    await p.click('.modal >> text=Back');
  });
  await check('Schedule: run now, past results viewable', async () => {
    await p.click('.modal >> text=Run now');
    await p.waitForSelector('.snapshots tr');
    await p.click('.snapshots >> text=View');
    await p.waitForSelector('.snapshot-tag');
  });
  await check('Scheduled queries listed under Scheduled in the Queries tab; Edit schedule', async () => {
    const t = await p.textContent('.side-scroll');
    assert(/Scheduled\s*1[\s\S]*Created by you[\s\S]*Weekly card brand volume/.test(t), 'not in Scheduled section');
    assert(await p.$('.query-actions >> text=Edit schedule'), 'no Edit schedule button');
  });

  // ---- Metrics ---------------------------------------------------------------------
  await check('Metrics: groups show the saved chart, or the row count without one', async () => {
    await p.click('.query-actions >> text=Add to metrics');
    await p.fill('.modal .form-field:has-text("Group name") input', 'Key metrics');
    await p.click('.modal-actions >> text=Add');
    await p.waitForSelector('text=Added to metrics');
    await p.click('.side-item >> text=Card brand volume (copy)');
    await p.click('.query-actions >> text=Add to metrics');
    await p.click('.modal-actions >> text=Add');
    await p.waitForSelector('text=Added to metrics');
    await p.click('.topnav >> text=Metrics');
    await p.waitForSelector('.metric-card');
    await p.waitForFunction(() => document.querySelectorAll('.metric-card .metric-loading').length === 0, null, { timeout: 30000 });
    const cards = await p.$$eval('.metric-card', cs => cs.map(c => ({ title: c.querySelector('.metric-title').textContent, chart: !!c.querySelector('svg path'), count: c.querySelector('.metric-count')?.textContent ?? null })));
    const charted = cards.find(c => c.title === 'Card brand volume (copy)');
    const counted = cards.find(c => c.title === 'Weekly card brand volume');
    assert(charted?.chart, `copy (has a saved chart) should render a chart: ${JSON.stringify(cards)}`);
    assert(counted?.count && /\d+\s*rows/.test(counted.count), `query without a chart should show row count: ${JSON.stringify(cards)}`);
    assert((await p.textContent('.metrics-head')).includes('2 of 20 reports'), 'report counter');
    await shot('05-metrics');
  });

  // ---- Identity: "your" vs "your team's" queries, author-only edits -------------------
  await check('Saved queries: yours vs your team\'s; scheduled: you vs others', async () => {
    await p.click('.topnav >> text=Queries');
    assert((await p.textContent('.user-chip')).includes('me@example.com'), 'not acting as USER_EMAIL');
    assert(/Saved\s*\d+\s*Created by you/.test(await p.textContent('.side-scroll')), 'no "Created by you" group');
    promptAnswer = 'bo@example.com';
    await p.click('.user-chip');
    await p.waitForFunction(() => document.querySelector('.user-chip').textContent.includes('bo@example.com'));
    await p.waitForFunction(() => document.querySelector('.side-scroll').textContent.includes('Created by your team'));
    const t = await p.textContent('.side-scroll');
    assert(/Created by your team[\s\S]*me@example\.com/.test(t), 'team queries not attributed');
    assert(/Scheduled\s*1\s*Created by others/.test(t), 'schedule not under "Created by others"');
  });
  await check('"Charts are only editable by the author of the query."', async () => {
    await p.click('.side-item >> text=Card brand volume (copy)');
    await run();
    await p.click('.results-head >> text=Chart');
    await p.waitForSelector('.chart-box svg');
    await p.click('.chart-controls >> text=Bar');
    assert(await p.$('.chart-save[disabled]'), 'teammate can save the chart');
    assert((await p.textContent('.chart-controls')).includes('Charts are only editable by the author of the query.'), 'no author note');
    await shot('06-teammate-chart');
  });
  await check('"Only the author of the metric group can edit or delete" it', async () => {
    await p.click('.topnav >> text=Metrics');
    await p.waitForSelector('.metric-group');
    const head = await p.textContent('.metric-group-head');
    assert(head.includes('Only the author can edit this group') && head.includes('by me@example.com'), `head: ${head}`);
    assert(!(await p.$('.metric-group-head >> text=Delete')) && !(await p.$('.metric-card .icon-btn')), 'teammate has edit controls');
    promptAnswer = 'me@example.com';
    await p.click('.user-chip');
    await p.waitForSelector('.metric-group-head >> text=Delete');
  });

  await check('No page errors during the run', async () => { assert(pageErrors.length === 0, pageErrors.join('; ')); });
  await browser.close();

  const w = Math.max(...results.map(r => r.name.length));
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}${r.ok ? '' : `  — ${r.error}`}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
