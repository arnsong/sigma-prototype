import { useCallback, useEffect, useRef, useState } from 'react';
import { api, runToCompletion, getUser, setUser } from './api.js';
import { SqlEditor } from './components/SqlEditor.jsx';
import { ResultsTable } from './components/ResultsTable.jsx';
import { ResultsChart, fitChart } from './components/ResultsChart.jsx';
import { Sidebar, Icon } from './components/Sidebar.jsx';
import { AssistantBar, ChatHistory, AssistantFeedback } from './components/AssistantBar.jsx';
import { ScheduleDialog } from './components/ScheduleDialog.jsx';
import { MetricsView } from './components/MetricsView.jsx';
import { formatBytes, formatDuration, formatInt } from './format.js';

const DRAFT_KEY = 'query-studio.draft';
const DEFAULT_TITLE = 'Untitled query';
const newDraftKey = () => `draft-${crypto.randomUUID()}`;
const emptyQuery = (extra = {}) => ({ id: null, draftKey: newDraftKey(), title: DEFAULT_TITLE, sql: '', savedTitle: null, savedSql: null, chart: null, schedule: null, ...extra });

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (d && typeof d.sql === 'string') return { ...emptyQuery(), ...d, draftKey: d.draftKey || newDraftKey() };
  } catch { /* storage unavailable */ }
  return emptyQuery({ sql: 'SELECT *\nFROM charges\nORDER BY created DESC\nLIMIT 100' });
}

function saveDraft(q) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(q)); } catch { /* ignore */ }
}

const fromSaved = q => ({
  id: q.id, draftKey: null, title: q.title, sql: q.sql, savedTitle: q.title, savedSql: q.sql,
  chart: q.chart ?? null, schedule: q.schedule ?? null, timeline: q.timeline ?? null,
});

const isDirty = q => (q.id ? q.sql !== q.savedSql || q.title !== q.savedTitle : q.sql.trim() !== '');
const sameChart = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export default function App() {
  const [config, setConfig] = useState(null);
  const [user, setUserState] = useState(getUser);
  const [view, setView] = useState(location.hash.startsWith('#/metrics') ? 'metrics' : 'editor');
  const [schema, setSchema] = useState(null);
  const [schemaError, setSchemaError] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [saved, setSaved] = useState([]);
  const [history, setHistory] = useState([]);
  const [tab, setTab] = useState('queries');
  const [query, setQuery] = useState(loadDraft);
  const [run, setRun] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [resultTab, setResultTab] = useState('table');
  const [chart, setChart] = useState(null);
  const [toast, setToast] = useState(null);
  const [editorPct, setEditorPct] = useState(40);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [chat, setChat] = useState([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [lastAnswer, setLastAnswer] = useState(null);
  const [fixing, setFixing] = useState(false);
  const editor = useRef(null);
  const pollToken = useRef(0);
  const runOffsetLine = useRef(0);
  const toastTimer = useRef(null);

  const flash = msg => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  const refreshSaved = () => api.listQueries().then(setSaved).catch(() => {});
  const refreshHistory = () => api.history().then(setHistory).catch(() => {});
  const loadSchema = useCallback(refresh => {
    setSchemaError(null);
    return api.schema(refresh).then(setSchema).catch(e => setSchemaError(`Could not load schema: ${e.message}`));
  }, []);

  useEffect(() => {
    api.config().then(c => {
      setConfig(c);
      if (!getUser() && c.user) setUserState(c.user);
    }).catch(() => setConfig({ error: true }));
    api.templates().then(setTemplates).catch(() => {});
    refreshSaved();
    refreshHistory();
    loadSchema(false);
  }, [loadSchema]);

  // Open a saved query from its URL (#/queries/<id>).
  useEffect(() => {
    const m = location.hash.match(/^#\/queries\/([\w-]+)/);
    if (m) {
      api.getQuery(m[1]).then(q => setQuery(fromSaved(q))).catch(() => window.history.replaceState(null, '', location.pathname));
    }
  }, []);

  useEffect(() => { saveDraft(query); }, [query]);
  useEffect(() => {
    const want = view === 'metrics' ? '#/metrics' : query.id ? `#/queries/${query.id}` : '';
    if (location.hash !== want) window.history.replaceState(null, '', want || location.pathname);
    document.title = view === 'metrics' ? 'Metrics · Query Studio' : `${query.title} · Query Studio`;
  }, [query.id, query.title, view]);

  // Chat history belongs to the query (or to the draft until it is saved).
  const chatKey = query.id || query.draftKey;
  useEffect(() => {
    setLastAnswer(null);
    if (chatKey) api.chatHistory(chatKey).then(setChat).catch(() => setChat([]));
  }, [chatKey]);

  // A saved chart reappears with its settings every time the query runs.
  useEffect(() => { setChart(query.chart ?? null); }, [query.id, query.chart]);

  const changeUser = () => {
    const email = window.prompt('Your email (used to show what you created and who can edit charts, schedules and metric groups)', user || '');
    if (email === null) return;
    const clean = email.trim().toLowerCase();
    if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return flash('That doesn’t look like an email address');
    setUser(clean || null);
    setUserState(clean || config?.user || null);
    refreshSaved();
  };
  const savedEntry = saved.find(s => s.id === query.id);
  const isQueryAuthor = !savedEntry?.createdBy || savedEntry.createdBy === user;

  const dirty = isDirty(query);
  const running = run && !run.done;
  const confirmDiscard = () => !query.id || !dirty || window.confirm('Discard unsaved changes to this query?');

  const openQuery = next => {
    if (!confirmDiscard()) return false;
    pollToken.current++;
    setQuery(next);
    setRun(null);
    setSubmitError(null);
    setView('editor');
    return true;
  };

  // ---- Running ----------------------------------------------------------------
  const startRun = async (sqlText, savedQueryId = query.id) => {
    const token = ++pollToken.current;
    setSubmitError(null);
    setRun({ done: false, state: 'QUEUED', elapsedMs: 0, rows: [] });
    try {
      const r = await runToCompletion(sqlText, {
        savedQueryId: savedQueryId || undefined,
        limit: config?.chartRowLimit ?? 10000,
        isCurrent: () => token === pollToken.current,
        onProgress: r => token === pollToken.current && setRun({ ...r, rows: [] }),
      });
      if (!r || token !== pollToken.current) return;
      setRun(r);
      if (r.state === 'FINISHED' && query.chart) setResultTab('chart');
    } catch (e) {
      if (token === pollToken.current) { setSubmitError(e.message); setRun(null); }
    }
    refreshHistory();
  };

  const onRun = () => {
    if (running) return;
    const { sql, offsetLine } = editor.current.getRunnableSql();
    runOffsetLine.current = offsetLine;
    startRun(sql);
  };

  const onCancel = async () => {
    const id = run?.id;
    pollToken.current++;
    setRun({ done: true, state: 'CANCELED', rows: [] });
    if (id) { try { await api.cancelRun(id); } catch { /* ignore */ } }
  };

  const onPreviewTable = name => {
    const sql = `SELECT *\nFROM ${name}\nLIMIT 100`;
    if (openQuery(emptyQuery({ title: `Preview of ${name}`, sql }))) {
      runOffsetLine.current = 0;
      setTimeout(() => startRun(sql, null), 0);
    }
  };

  // ---- Assistant ----------------------------------------------------------------
  const ask = async (question, mode, error = '') => {
    const entry = await api.ask({ question, mode, sql: mode === 'edit' ? query.sql : '', error, key: chatKey });
    setChat(c => [...c, entry]);
    if (entry.sql) {
      setQuery(q => ({ ...q, sql: entry.sql }));
      setLastAnswer(entry);
      // "Runs the suggested query and returns the results in a table below the editor."
      runOffsetLine.current = 0;
      setResultTab('table');
      startRun(entry.sql);
    }
    return entry;
  };

  const onFixWithAssistant = async () => {
    setFixing(true);
    try {
      const entry = await ask('Fix this query so it runs.', 'edit', run?.error?.message || submitError || '');
      if (!entry.sql) flash(entry.explanation);
    } catch (e) {
      flash(e.message);
    } finally {
      setFixing(false);
    }
  };

  const onFeedback = async fb => {
    const e = await api.chatFeedback(chatKey, lastAnswer.id, fb);
    setChat(c => c.map(x => (x.id === e.id ? e : x)));
    setLastAnswer(e);
  };

  // ---- Saving -----------------------------------------------------------------
  const onSave = async () => {
    try {
      let title = query.title.trim();
      // "Stripe automatically generates an editable title for your query."
      if (!query.id && (!title || title === DEFAULT_TITLE)) title = (await api.title(query.sql)).title;
      const q = query.id
        ? await api.updateQuery(query.id, { title: title || DEFAULT_TITLE, sql: query.sql })
        : await api.createQuery({ title: title || DEFAULT_TITLE, sql: query.sql, chart, assistantKey: query.draftKey });
      setQuery(fromSaved(q));
      refreshSaved();
      flash(query.id ? 'Query saved' : `Saved as “${q.title}” — click the title to rename it`);
      return q;
    } catch (e) {
      flash(`Save failed: ${e.message}`);
      return null;
    }
  };

  const makeCopy = async src => {
    const q = await api.createQuery({ title: `${src.title} (copy)`, sql: src.sql, chart: src.chart ?? null });
    refreshSaved();
    if (openQuery(fromSaved(q))) flash('Copy created — changes are saved to the new query');
  };

  const deleteSaved = async q => {
    if (!window.confirm(`Delete “${q.title}”? This cannot be undone.`)) return;
    await api.deleteQuery(q.id);
    if (q.id === query.id) setQuery(emptyQuery({ sql: query.sql, title: query.title }));
    refreshSaved();
    flash('Query deleted');
  };

  const onShare = async () => {
    let id = query.id;
    if (!id || dirty) id = (await onSave())?.id;
    if (!id) return;
    const url = `${location.origin}${location.pathname}#/queries/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      flash('Link copied — saved queries are available to everyone on your team');
    } catch {
      window.prompt('Copy this link', url);
    }
  };

  const onSaveChart = async () => {
    if (!query.id) return flash('Save the query before saving a chart');
    const fitted = fitChart(chart, run.columns);
    const q = await api.updateQuery(query.id, { chart: fitted });
    setQuery(cur => ({ ...cur, chart: q.chart }));
    refreshSaved();
    flash('Chart saved — it appears every time this query runs');
  };

  const onViewSnapshot = async id => {
    const snap = await api.getSnapshot(id);
    pollToken.current++;
    setScheduleOpen(false);
    setSubmitError(null);
    setRun({
      id: snap.id, done: true, state: snap.state, columns: snap.columns, rows: snap.rows, rowCount: snap.rowCount,
      truncated: snap.truncated, elapsedMs: snap.elapsedMs, stats: {}, error: snap.error ? { message: snap.error } : null,
      snapshotAt: snap.ranAt, csvHref: api.snapshotCsvUrl(snap.id),
    });
  };

  // ---- Editor/results splitter ----------------------------------------------
  const main = useRef(null);
  const startDrag = e => {
    e.preventDefault();
    const rect = main.current.getBoundingClientRect();
    const move = ev => setEditorPct(Math.min(75, Math.max(15, ((ev.clientY - rect.top) / rect.height) * 100)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const errorLine = run?.error?.line ? run.error.line + runOffsetLine.current : null;
  const chartLimit = config?.chartRowLimit ?? 10000;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M22 9H10l7 7-7 7h12" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <span className="brand-name">Query Studio</span>
        </div>
        <nav className="topnav" aria-label="Sections">
          <button className={view === 'editor' ? 'active' : ''} aria-current={view === 'editor' ? 'page' : undefined} onClick={() => setView('editor')}>Queries</button>
          <button className={view === 'metrics' ? 'active' : ''} aria-current={view === 'metrics' ? 'page' : undefined} onClick={() => setView('metrics')}>Metrics</button>
        </nav>
        <span className="spacer" />
        {config?.dataFreshness && (
          <div className="freshness" title="data_load_time: the timestamp data is available through">
            Data available through {formatFreshness(config.dataFreshness)}
          </div>
        )}
        <button className="user-chip" onClick={changeUser} title="Change who you are in this workspace">
          <span className="avatar" aria-hidden="true">{(user || '?')[0].toUpperCase()}</span>
          {user || 'Set your email'}
        </button>
        <div className="conn" title={config?.trinoServer}>
          <span className={`conn-dot ${config?.trinoVersion ? 'ok' : config ? 'down' : ''}`} />
          {config?.trinoVersion ? <>Trino {config.trinoVersion}</> : config ? 'Trino unreachable' : 'Connecting…'}
        </div>
      </header>

      {view === 'metrics' ? (
        <div className="body metrics-body">
          <MetricsView saved={saved} user={user} maxReports={config?.maxMetricReports} onOpenQuery={q => openQuery(fromSaved(q))} flash={flash} />
        </div>
      ) : (
        <div className="body">
          <Sidebar
            tab={tab}
            onTab={setTab}
            saved={saved}
            templates={templates}
            history={history}
            schema={schema}
            schemaError={schemaError}
            currentId={query.id}
            user={user}
            defaultCatalog={config?.catalog}
            defaultSchema={config?.schema}
            onNew={() => openQuery(emptyQuery())}
            onOpenSaved={q => openQuery(fromSaved(q))}
            onOpenTemplate={t => openQuery(emptyQuery({ title: t.title, sql: t.sql }))}
            onOpenHistory={h => openQuery(emptyQuery({ title: 'Query from history', sql: h.sql }))}
            onCopySaved={makeCopy}
            onDeleteSaved={deleteSaved}
            onInsert={text => editor.current?.insert(text)}
            onPreviewTable={onPreviewTable}
            onRefreshSchema={() => loadSchema(true)}
          />

          <main className="main" ref={main}>
            <div className="query-head">
              <input
                className="query-title"
                value={query.title}
                onChange={e => setQuery(q => ({ ...q, title: e.target.value }))}
                aria-label="Query title"
              />
              <span className="save-state">{query.id ? (dirty ? 'Unsaved changes' : 'Saved') : 'Draft'}</span>
              <div className="query-actions">
                {query.id && <button className="btn btn-ghost" onClick={() => makeCopy({ ...query, title: query.title })}>Make a copy</button>}
                {query.id && <button className="btn btn-ghost" onClick={() => setMetricsOpen(true)}>Add to metrics</button>}
                <button className="btn btn-ghost" onClick={onShare} title="Copy a link to this query">Share</button>
                {config?.scheduling && (
                  <button className="btn btn-ghost" onClick={() => (query.id ? setScheduleOpen(true) : flash('Save the query before scheduling it'))}>
                    {query.schedule ? 'Edit schedule' : 'Schedule'}
                  </button>
                )}
                <button className="btn btn-secondary" onClick={onSave} disabled={Boolean(query.id) && !dirty} title="Save (⌘/Ctrl + S)">Save</button>
              </div>
            </div>

            <AssistantBar enabled={Boolean(config?.assistant)} editorHasSql={query.sql.trim() !== ''} onAsk={ask} />

            <div className="editor-pane" style={{ height: `${editorPct}%` }}>
              <SqlEditor
                ref={editor}
                value={query.sql}
                onChange={sql => setQuery(q => ({ ...q, sql }))}
                onRun={onRun}
                onSave={onSave}
                schema={schema}
                defaultCatalog={config?.catalog}
                defaultSchema={config?.schema}
              />
              <button className={`chat-toggle ${chatOpen ? 'active' : ''}`} onClick={() => setChatOpen(o => !o)} title="Assistant chat history" aria-label="Assistant chat history" aria-expanded={chatOpen}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></svg>
                {chat.length > 0 && <span className="chat-count">{chat.length}</span>}
              </button>
              {chatOpen && (
                <ChatHistory
                  entries={chat}
                  onClose={() => setChatOpen(false)}
                  onViewInEditor={sql => { setQuery(q => ({ ...q, sql })); setChatOpen(false); }}
                />
              )}
            </div>

            <div className="run-bar">
              {running ? (
                <button className="btn btn-danger" onClick={onCancel}>Cancel</button>
              ) : (
                <button className="btn btn-primary" onClick={onRun}><Icon name="play" /> Run</button>
              )}
              <span className="hint">⌘/Ctrl + Enter · runs the selection if you have one</span>
              {lastAnswer && <AssistantFeedback entry={lastAnswer} onSubmit={onFeedback} />}
              <div className="splitter" onPointerDown={startDrag} role="separator" aria-orientation="horizontal" aria-label="Resize editor" title="Drag to resize" />
            </div>

            <section className="results">
              <ResultsHeader run={run} resultTab={resultTab} setResultTab={setResultTab} title={query.title} />
              <div className="results-body">
                {submitError && <div className="error-box" role="alert"><strong>Could not run query</strong><pre>{submitError}</pre></div>}
                {!submitError && !run && (
                  <div className="results-empty big">
                    <div className="empty-title">Run a query to see results</div>
                    <div>Pick a template from the sidebar, ask the assistant, or browse tables in <button className="link" onClick={() => setTab('schema')}>Schema</button>.</div>
                  </div>
                )}
                {!submitError && running && (
                  <div className="results-empty big">
                    <div className="spinner" aria-hidden="true" />
                    <div className="empty-title">Running query…</div>
                    <div className="muted">More complex queries might take a few moments longer to complete.</div>
                  </div>
                )}
                {!submitError && run?.done && run.state === 'FAILED' && (
                  <div className="error-box" role="alert">
                    <strong>{run.error?.errorName ? run.error.errorName.replace(/_/g, ' ').toLowerCase() : 'Query failed'}</strong>
                    <pre>{run.error?.message}</pre>
                    <div className="error-actions">
                      {errorLine && <button className="link" onClick={() => editor.current?.goTo(errorLine, run.error.column)}>Go to line {errorLine}{run.error.column ? `, position ${run.error.column}` : ''}</button>}
                      {config?.assistant && !run.snapshotAt && (
                        <button className="btn btn-secondary btn-sm" onClick={onFixWithAssistant} disabled={fixing}>{fixing ? 'Fixing…' : 'Fix with assistant'}</button>
                      )}
                    </div>
                  </div>
                )}
                {!submitError && run?.done && run.state === 'CANCELED' && (
                  <div className="results-empty big"><div className="empty-title">Query canceled</div></div>
                )}
                {!submitError && run?.done && run.state === 'FINISHED' && (
                  resultTab === 'table'
                    ? <ResultsTable columns={run.columns} rows={run.rows} rowCount={run.rowCount} truncated={run.truncated} viewRows={config?.viewRows ?? 1000} />
                    : <ResultsChart
                      columns={run.columns} rows={run.rows} rowCount={run.rowCount} truncated={run.truncated} limit={chartLimit}
                      config={chart} onChange={setChart} onSave={run.snapshotAt ? null : onSaveChart} canSave={Boolean(query.id) && isQueryAuthor}
                      saveHint={!query.id ? 'Save the query first' : !isQueryAuthor ? 'Charts are only editable by the author of the query.' : 'Show this chart every time the query runs'}
                      savedState={query.chart && sameChart(fitChart(chart, run.columns), query.chart) ? 'saved' : 'unsaved'}
                    />
                )}
              </div>
            </section>
          </main>
        </div>
      )}

      {scheduleOpen && query.id && (
        <ScheduleDialog
          query={query}
          config={config}
          onClose={() => setScheduleOpen(false)}
          onChanged={q => { setQuery(cur => ({ ...cur, title: q.title, savedTitle: q.title, schedule: q.schedule ?? null, timeline: q.timeline ?? null })); refreshSaved(); flash(q.schedule ? 'Schedule saved' : 'Schedule deleted'); }}
          onViewSnapshot={onViewSnapshot}
        />
      )}
      {metricsOpen && query.id && (
        <AddToMetricsDialog queryId={query.id} onClose={() => setMetricsOpen(false)} flash={flash} />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function AddToMetricsDialog({ queryId, onClose, flash }) {
  const [groups, setGroups] = useState(null);
  const [groupId, setGroupId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => { api.metricGroups().then(g => { setGroups(g); setGroupId(g[0]?.id || 'new'); }).catch(e => setError(e.message)); }, []);
  const submit = async e => {
    e.preventDefault();
    setError(null);
    try {
      const id = groupId === 'new' ? (await api.createMetricGroup(name || 'Key metrics')).id : groupId;
      await api.addMetric(id, queryId);
      flash('Added to metrics');
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <form className="modal small" role="dialog" aria-modal="true" aria-labelledby="metrics-title" onSubmit={submit}>
        <div className="modal-head"><h2 id="metrics-title">Add to metrics</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="Close">×</button></div>
        <div className="modal-body">
          <label className="form-field">
            <span>Metric group</span>
            <select value={groupId} onChange={e => setGroupId(e.target.value)}>
              {groups?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              <option value="new">New group…</option>
            </select>
          </label>
          {groupId === 'new' && (
            <label className="form-field"><span>Group name</span><input value={name} onChange={e => setName(e.target.value)} placeholder="Key metrics" autoFocus /></label>
          )}
          {error && <div className="side-error">{error}</div>}
          <div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary">Add</button></div>
        </div>
      </form>
    </div>
  );
}

function ResultsHeader({ run, resultTab, setResultTab, title }) {
  const finished = run?.done && run.state === 'FINISHED';
  return (
    <div className="results-head">
      <div className="segmented" role="tablist" aria-label="Result view">
        <button role="tab" aria-selected={resultTab === 'table'} className={resultTab === 'table' ? 'active' : ''} onClick={() => setResultTab('table')}>Results</button>
        <button role="tab" aria-selected={resultTab === 'chart'} className={resultTab === 'chart' ? 'active' : ''} onClick={() => setResultTab('chart')}>Chart</button>
      </div>
      {finished && (
        <div className="results-meta">
          {run.snapshotAt && <span className="snapshot-tag">Scheduled run · {new Date(run.snapshotAt).toLocaleString()}</span>}
          <span><strong>{formatInt(run.rowCount)}{run.truncated ? '+' : ''}</strong> {run.rowCount === 1 ? 'row' : 'rows'}</span>
          <span>{formatDuration(run.elapsedMs)}</span>
          {run.stats?.processedBytes > 0 && <span>{formatBytes(run.stats.processedBytes)} scanned</span>}
          <a className="btn btn-secondary btn-sm" href={run.csvHref ?? api.csvUrl(run.id, title)} download>Download CSV</a>
        </div>
      )}
    </div>
  );
}

function formatFreshness(v) {
  const d = new Date(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
}
