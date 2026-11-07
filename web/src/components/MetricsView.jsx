import { useEffect, useState } from 'react';
import { api, runToCompletion } from '../api.js';
import { formatInt } from '../format.js';
import { ResultsChart } from './ResultsChart.jsx';

/** One report in a metric group: its saved chart, or the row count if it has none. */
function MetricCard({ query, onOpen, onRemove }) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    setRun(null);
    setError(null);
    runToCompletion(query.sql, { savedQueryId: query.id, isCurrent: () => live })
      .then(r => live && r && (r.state === 'FINISHED' ? setRun(r) : setError(r.error?.message || r.state.toLowerCase())))
      .catch(e => live && setError(e.message));
    return () => { live = false; };
  }, [query.id, query.sql]);

  return (
    <div className="metric-card">
      <div className="metric-head">
        <button className="link metric-title" onClick={() => onOpen(query)} title="Open in the editor">{query.title}</button>
        <button className="icon-btn" onClick={onRemove} aria-label={`Remove ${query.title} from this group`} title="Remove from group">×</button>
      </div>
      {!run && !error && <div className="metric-loading"><div className="spinner" aria-hidden="true" /></div>}
      {error && <div className="side-error">{error}</div>}
      {run && (query.chart
        ? <ResultsChart columns={run.columns} rows={run.rows} rowCount={run.rowCount} truncated={run.truncated} limit={10000} config={query.chart} compactView />
        : <div className="metric-count"><strong>{formatInt(run.rowCount)}</strong><span className="muted">{run.rowCount === 1 ? 'row' : 'rows'}</span></div>)}
    </div>
  );
}

export function MetricsView({ saved, maxReports = 20, onOpenQuery, flash }) {
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const refresh = () => api.metricGroups().then(setGroups).catch(e => setError(e.message));
  useEffect(() => { refresh(); }, []);

  const used = groups?.reduce((n, g) => n + g.queryIds.length, 0) ?? 0;
  const byId = Object.fromEntries(saved.map(q => [q.id, q]));
  const guard = fn => async (...a) => { try { await fn(...a); await refresh(); } catch (e) { flash(e.message); } };

  const create = guard(async () => {
    const name = window.prompt('Name for the new metric group', 'Key metrics');
    if (name) await api.createMetricGroup(name);
  });
  const rename = guard(async g => {
    const name = window.prompt('Rename metric group', g.name);
    if (name) await api.renameMetricGroup(g.id, name);
  });
  const remove = guard(async g => { if (window.confirm(`Delete the metric group "${g.name}"? The reports in it are not deleted.`)) await api.deleteMetricGroup(g.id); });
  const add = guard(async (g, queryId) => { if (queryId) await api.addMetric(g.id, queryId); });
  const drop = guard(async (g, queryId) => api.removeMetric(g.id, queryId));

  return (
    <div className="metrics">
      <div className="metrics-head">
        <div>
          <h1>Metrics</h1>
          <p className="muted">Monitor your most important reports. Groups show each report’s saved chart, or its row count when it has no chart. {formatInt(used)} of {maxReports} reports used.</p>
        </div>
        <button className="btn btn-primary" onClick={create}>New metric group</button>
      </div>
      {error && <div className="side-error">{error}</div>}
      {groups?.length === 0 && (
        <div className="results-empty big">
          <div className="empty-title">No metric groups yet</div>
          <div>Create a group, then add saved reports to it.</div>
        </div>
      )}
      {groups?.map(g => {
        const available = saved.filter(q => !g.queryIds.includes(q.id));
        return (
          <section key={g.id} className="metric-group">
            <div className="metric-group-head">
              <h2>{g.name}</h2>
              <select value="" onChange={e => add(g, e.target.value)} disabled={used >= maxReports || available.length === 0} aria-label={`Add a report to ${g.name}`}>
                <option value="">{used >= maxReports ? `Limit of ${maxReports} reports reached` : available.length ? 'Add report…' : 'No saved reports to add'}</option>
                {available.map(q => <option key={q.id} value={q.id}>{q.title}</option>)}
              </select>
              <button className="btn btn-ghost btn-sm" onClick={() => rename(g)}>Rename</button>
              <button className="btn btn-ghost btn-sm danger-text" onClick={() => remove(g)}>Delete</button>
            </div>
            {g.queryIds.length === 0 && <div className="muted">Add saved reports to this group.</div>}
            <div className="metric-grid">
              {g.queryIds.filter(id => byId[id]).map(id => (
                <MetricCard key={id} query={byId[id]} onOpen={onOpenQuery} onRemove={() => drop(g, id)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
