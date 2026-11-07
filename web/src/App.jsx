import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { SqlEditor } from './components/SqlEditor.jsx';
import { ResultsTable } from './components/ResultsTable.jsx';
import { ResultsChart } from './components/ResultsChart.jsx';
import { Sidebar, Icon } from './components/Sidebar.jsx';
import { formatBytes, formatDuration, formatInt } from './format.js';

const DRAFT_KEY = 'query-studio.draft';
const EMPTY = { id: null, title: 'Untitled query', sql: '', savedTitle: null, savedSql: null };

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (d && typeof d.sql === 'string') return { ...EMPTY, ...d };
  } catch { /* storage unavailable */ }
  return { ...EMPTY, sql: 'SELECT *\nFROM charges\nORDER BY created DESC\nLIMIT 100' };
}

function saveDraft(q) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(q)); } catch { /* ignore */ }
}

const isDirty = q => (q.id ? q.sql !== q.savedSql || q.title !== q.savedTitle : q.sql.trim() !== '');

export default function App() {
  const [config, setConfig] = useState(null);
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
  const [toast, setToast] = useState(null);
  const [editorPct, setEditorPct] = useState(42);
  const editor = useRef(null);
  const pollToken = useRef(0);
  const runOffsetLine = useRef(0);

  const toastTimer = useRef(null);
  const flash = msg => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };

  const refreshSaved = () => api.listQueries().then(setSaved).catch(() => {});
  const refreshHistory = () => api.history().then(setHistory).catch(() => {});
  const loadSchema = useCallback(refresh => {
    setSchemaError(null);
    return api.schema(refresh).then(setSchema).catch(e => setSchemaError(`Could not load schema: ${e.message}`));
  }, []);

  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig({ error: true }));
    api.templates().then(setTemplates).catch(() => {});
    refreshSaved();
    refreshHistory();
    loadSchema(false);
  }, [loadSchema]);

  // Open a saved query from the URL (#/queries/<id>).
  useEffect(() => {
    const m = location.hash.match(/^#\/queries\/([\w-]+)/);
    if (m) {
      api.getQuery(m[1]).then(q => setQuery({ id: q.id, title: q.title, sql: q.sql, savedTitle: q.title, savedSql: q.sql }))
        .catch(() => { window.history.replaceState(null, '', location.pathname); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { saveDraft(query); }, [query]);
  useEffect(() => {
    const want = query.id ? `#/queries/${query.id}` : '';
    if (location.hash !== want) window.history.replaceState(null, '', want || location.pathname);
    document.title = `${query.title} · Query Studio`;
  }, [query.id, query.title]);

  const dirty = isDirty(query);
  const running = run && !run.done;

  const confirmDiscard = () => !query.id || !dirty || window.confirm('Discard unsaved changes to this query?');

  const openQuery = next => {
    if (!confirmDiscard()) return;
    setQuery(next);
    setSubmitError(null);
  };

  // ---- Running ----------------------------------------------------------------
  const startRun = async sqlText => {
    const token = ++pollToken.current;
    setSubmitError(null);
    let r;
    try {
      r = await api.startRun(sqlText, query.id || undefined);
    } catch (e) {
      setSubmitError(e.message);
      setRun(null);
      return;
    }
    setRun({ ...r, rows: [] });
    while (token === pollToken.current) {
      try {
        r = await api.getRun(r.id, { wait: 1500 });
      } catch (e) {
        setSubmitError(e.message);
        return;
      }
      if (token !== pollToken.current) return;
      if (r.done) break;
      setRun({ ...r, rows: [] });
    }
    if (token !== pollToken.current) return;
    if (r.state === 'FINISHED' && r.rowCount > 0) {
      r = await api.getRun(r.id, { limit: r.rowCount });
    }
    if (token !== pollToken.current) return;
    setRun(r);
    refreshHistory();
  };

  const onRun = () => {
    if (running) return;
    const { sql, offsetLine } = editor.current.getRunnableSql();
    runOffsetLine.current = offsetLine;
    startRun(sql);
  };

  const onCancel = async () => {
    if (!run) return;
    try { await api.cancelRun(run.id); } catch { /* ignore */ }
  };

  const onPreviewTable = name => {
    const sql = `SELECT *\nFROM ${name}\nLIMIT 100`;
    openQuery({ ...EMPTY, title: `Preview of ${name}`, sql });
    runOffsetLine.current = 0;
    setTimeout(() => startRun(sql), 0);
  };

  // ---- Saving -----------------------------------------------------------------
  const onSave = async () => {
    const title = query.title.trim() || 'Untitled query';
    try {
      const q = query.id
        ? await api.updateQuery(query.id, { title, sql: query.sql })
        : await api.createQuery({ title, sql: query.sql });
      setQuery({ id: q.id, title: q.title, sql: q.sql, savedTitle: q.title, savedSql: q.sql });
      refreshSaved();
      flash('Query saved');
    } catch (e) {
      flash(`Save failed: ${e.message}`);
    }
  };

  const onSaveAs = async () => {
    const title = window.prompt('Name for the copy', `${query.title} (copy)`);
    if (!title) return;
    const q = await api.createQuery({ title, sql: query.sql });
    setQuery({ id: q.id, title: q.title, sql: q.sql, savedTitle: q.title, savedSql: q.sql });
    refreshSaved();
    flash('Saved a copy');
  };

  const onDelete = async () => {
    if (!query.id || !window.confirm(`Delete "${query.savedTitle}"? This cannot be undone.`)) return;
    await api.deleteQuery(query.id);
    setQuery({ ...EMPTY, sql: query.sql, title: query.title });
    refreshSaved();
    flash('Query deleted');
  };

  // ---- Editor/results splitter ----------------------------------------------
  const main = useRef(null);
  const startDrag = e => {
    e.preventDefault();
    const rect = main.current.getBoundingClientRect();
    const move = ev => setEditorPct(Math.min(80, Math.max(15, ((ev.clientY - rect.top) / rect.height) * 100)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const errorLine = run?.error?.line ? run.error.line + runOffsetLine.current : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M22 9H10l7 7-7 7h12" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <span className="brand-name">Query Studio</span>
        </div>
        <div className="conn" title={config?.trinoServer}>
          <span className={`conn-dot ${config?.trinoVersion ? 'ok' : config ? 'down' : ''}`} />
          {config?.trinoVersion ? <>Trino {config.trinoVersion}</> : config ? 'Trino unreachable' : 'Connecting…'}
          {config?.catalog && <span className="conn-schema">{config.catalog}.{config.schema}</span>}
        </div>
      </header>

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
          defaultCatalog={config?.catalog}
          defaultSchema={config?.schema}
          onNew={() => openQuery({ ...EMPTY })}
          onOpenSaved={q => openQuery({ id: q.id, title: q.title, sql: q.sql, savedTitle: q.title, savedSql: q.sql })}
          onOpenTemplate={t => openQuery({ ...EMPTY, title: t.title, sql: t.sql })}
          onOpenHistory={h => openQuery({ ...EMPTY, title: 'Query from history', sql: h.sql })}
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
            <span className="save-state">
              {query.id ? (dirty ? 'Unsaved changes' : 'Saved') : 'Draft'}
            </span>
            <div className="query-actions">
              {query.id && <button className="btn btn-ghost" onClick={onDelete}>Delete</button>}
              {query.id && <button className="btn btn-ghost" onClick={onSaveAs}>Save as…</button>}
              <button className="btn btn-secondary" onClick={onSave} disabled={query.id && !dirty} title="Save (⌘/Ctrl + S)">
                {query.id ? 'Save' : 'Save query'}
              </button>
            </div>
          </div>

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
          </div>

          <div className="run-bar">
            {running ? (
              <button className="btn btn-danger" onClick={onCancel}>Cancel</button>
            ) : (
              <button className="btn btn-primary" onClick={onRun}><Icon name="play" /> Run</button>
            )}
            <span className="hint">⌘/Ctrl + Enter · runs the selection if you have one</span>
            <div className="splitter" onPointerDown={startDrag} role="separator" aria-orientation="horizontal" aria-label="Resize editor" title="Drag to resize" />
          </div>

          <section className="results">
            <ResultsHeader run={run} resultTab={resultTab} setResultTab={setResultTab} title={query.title} maxRows={config?.maxRows} />
            <div className="results-body">
              {submitError && <div className="error-box" role="alert"><strong>Could not run query</strong><pre>{submitError}</pre></div>}
              {!submitError && !run && (
                <div className="results-empty big">
                  <div className="empty-title">Run a query to see results</div>
                  <div>Pick a template from the sidebar, or browse tables in <button className="link" onClick={() => setTab('schema')}>Schema</button>.</div>
                </div>
              )}
              {!submitError && running && (
                <div className="results-empty big">
                  <div className="spinner" aria-hidden="true" />
                  <div className="empty-title">{run.state === 'QUEUED' ? 'Queued…' : 'Running…'}</div>
                  <div className="progress"><div className="progress-fill" style={{ width: `${Math.max(3, run.progress || 0)}%` }} /></div>
                  <div className="muted">
                    {formatDuration(run.elapsedMs)}
                    {run.stats?.processedRows ? ` · ${formatInt(run.stats.processedRows)} rows scanned` : ''}
                  </div>
                </div>
              )}
              {!submitError && run?.done && run.state === 'FAILED' && (
                <div className="error-box" role="alert">
                  <strong>{run.error?.errorName ? `${run.error.errorName.replace(/_/g, ' ').toLowerCase()}` : 'Query failed'}</strong>
                  <pre>{run.error?.message}</pre>
                  {errorLine && <button className="link" onClick={() => editor.current?.goTo(errorLine, run.error.column)}>Go to line {errorLine}</button>}
                </div>
              )}
              {!submitError && run?.done && run.state === 'CANCELED' && (
                <div className="results-empty big"><div className="empty-title">Query canceled</div></div>
              )}
              {!submitError && run?.done && run.state === 'FINISHED' && (
                resultTab === 'table'
                  ? <ResultsTable columns={run.columns} rows={run.rows} />
                  : <ResultsChart key={run.id} columns={run.columns} rows={run.rows} />
              )}
            </div>
          </section>
        </main>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function ResultsHeader({ run, resultTab, setResultTab, title, maxRows }) {
  const finished = run?.done && run.state === 'FINISHED';
  return (
    <div className="results-head">
      <div className="segmented" role="tablist" aria-label="Result view">
        <button role="tab" aria-selected={resultTab === 'table'} className={resultTab === 'table' ? 'active' : ''} onClick={() => setResultTab('table')}>Results</button>
        <button role="tab" aria-selected={resultTab === 'chart'} className={resultTab === 'chart' ? 'active' : ''} onClick={() => setResultTab('chart')}>Chart</button>
      </div>
      {finished && (
        <div className="results-meta">
          <span><strong>{formatInt(run.rowCount)}</strong> {run.rowCount === 1 ? 'row' : 'rows'}{run.truncated ? ` (limited to first ${formatInt(maxRows ?? run.rowCount)})` : ''}</span>
          <span>{formatDuration(run.elapsedMs)}</span>
          {run.stats?.processedBytes > 0 && <span>{formatBytes(run.stats.processedBytes)} scanned</span>}
          {run.trinoQueryId && <span className="mono muted" title="Trino query ID">{run.trinoQueryId}</span>}
          <a className="btn btn-secondary btn-sm" href={api.csvUrl(run.id, title)} download>Download CSV</a>
        </div>
      )}
    </div>
  );
}
