import { useMemo, useState } from 'react';
import { timeAgo } from '../format.js';

function Icon({ name }) {
  const paths = {
    table: 'M2 3h12v10H2zM2 6.5h12M6 6.5V13',
    chevron: 'M6 4l4 4-4 4',
    plus: 'M8 3v10M3 8h10',
    search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM11 11l3 3',
    doc: 'M4 2h5l3 3v9H4zM9 2v3h3',
    clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 5v3l2 2',
    spark: 'M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2',
    refresh: 'M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3',
    play: 'M5 3l8 5-8 5z',
    calendar: 'M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3',
  };
  return (
    <svg className={`icon icon-${name}`} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
export { Icon };

export function Sidebar({
  tab, onTab, saved, templates, history, schema, schemaError, currentId,
  onNew, onOpenSaved, onOpenTemplate, onOpenHistory, onInsert, onPreviewTable, onRefreshSchema, defaultCatalog, defaultSchema,
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'queries'} className={tab === 'queries' ? 'active' : ''} onClick={() => onTab('queries')}>Queries</button>
        <button role="tab" aria-selected={tab === 'schema'} className={tab === 'schema' ? 'active' : ''} onClick={() => onTab('schema')}>Schema</button>
      </div>
      {tab === 'queries'
        ? <QueriesPanel {...{ saved, templates, history, currentId, onNew, onOpenSaved, onOpenTemplate, onOpenHistory }} />
        : <SchemaPanel {...{ schema, schemaError, onInsert, onPreviewTable, onRefreshSchema, defaultCatalog, defaultSchema }} />}
    </aside>
  );
}

function Section({ title, icon, count, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="side-section">
      <button className="side-section-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className={`caret ${open ? 'open' : ''}`}><Icon name="chevron" /></span>
        <Icon name={icon} />
        <span className="side-section-title">{title}</span>
        {count != null && <span className="count">{count}</span>}
      </button>
      {open && <div className="side-section-body">{children}</div>}
    </section>
  );
}

function QueriesPanel({ saved, templates, history, currentId, onNew, onOpenSaved, onOpenTemplate, onOpenHistory }) {
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  const match = (...s) => !f || s.some(x => (x || '').toLowerCase().includes(f));
  const groups = useMemo(() => {
    const g = new Map();
    for (const t of templates) {
      if (!match(t.title, t.description, t.category)) continue;
      if (!g.has(t.category)) g.set(t.category, []);
      g.get(t.category).push(t);
    }
    return [...g];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates, f]);
  const savedFiltered = saved.filter(q => match(q.title, q.sql));
  const scheduled = savedFiltered.filter(q => q.schedule);
  const historyFiltered = history.filter(h => match(h.sql)).slice(0, 30);

  return (
    <div className="side-panel">
      <div className="side-actions">
        <button className="btn btn-primary btn-block" onClick={onNew}><Icon name="plus" /> New query</button>
        <div className="search">
          <Icon name="search" />
          <input placeholder="Search queries and templates" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Search queries and templates" />
        </div>
      </div>
      <div className="side-scroll">
        <Section title="Saved" icon="doc" count={savedFiltered.length}>
          {savedFiltered.length === 0 && <div className="side-empty">{f ? 'No matches' : 'Queries you save appear here.'}</div>}
          {savedFiltered.map(q => (
            <button key={q.id} className={`side-item ${q.id === currentId ? 'current' : ''}`} onClick={() => onOpenSaved(q)}>
              <span className="side-item-title">{q.title}</span>
              <span className="side-item-meta">Edited {timeAgo(q.updatedAt)}</span>
            </button>
          ))}
        </Section>
        <Section title="Scheduled" icon="calendar" count={scheduled.length}>
          {scheduled.length === 0 && <div className="side-empty">Schedule a saved query to run it daily, weekly or monthly.</div>}
          {scheduled.map(q => (
            <button key={q.id} className={`side-item ${q.id === currentId ? 'current' : ''}`} onClick={() => onOpenSaved(q)}>
              <span className="side-item-title">{q.title}</span>
              <span className="side-item-meta">
                {q.schedule.frequency[0].toUpperCase() + q.schedule.frequency.slice(1)} at {String(q.schedule.hour).padStart(2, '0')}:00 UTC
              </span>
            </button>
          ))}
        </Section>
        <Section title="Templates" icon="spark" count={groups.reduce((a, [, ts]) => a + ts.length, 0)}>
          {groups.map(([cat, ts]) => (
            <div key={cat} className="template-group">
              <div className="template-cat">{cat}</div>
              {ts.map(t => (
                <button key={t.id} className="side-item" onClick={() => onOpenTemplate(t)} title={t.description}>
                  <span className="side-item-title">{t.title}</span>
                  <span className="side-item-meta">{t.description}</span>
                </button>
              ))}
            </div>
          ))}
        </Section>
        <Section title="History" icon="clock" count={historyFiltered.length} defaultOpen={false}>
          {historyFiltered.length === 0 && <div className="side-empty">Queries you run appear here.</div>}
          {historyFiltered.map(h => (
            <button key={h.id} className="side-item history-item" onClick={() => onOpenHistory(h)} title={h.sql}>
              <span className="side-item-title mono">{h.sql.replace(/\s+/g, ' ').slice(0, 80)}</span>
              <span className="side-item-meta">
                <span className={`state-dot state-${h.state.toLowerCase()}`} />
                {h.state === 'FINISHED' ? `${h.rowCount.toLocaleString()} rows` : h.state.toLowerCase()} · {timeAgo(h.startedAt)}
              </span>
            </button>
          ))}
        </Section>
      </div>
    </div>
  );
}

const CATEGORY_ORDER = ['Core', 'Billing'];
const categoryRank = c => (c ? (CATEGORY_ORDER.indexOf(c) + 1 || CATEGORY_ORDER.length + 1) : CATEGORY_ORDER.length + 2);

function SchemaPanel({ schema, schemaError, onInsert, onPreviewTable, onRefreshSchema, defaultCatalog, defaultSchema }) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState({});
  const f = filter.trim().toLowerCase();

  const qualify = (s, t) => (s.catalog === defaultCatalog && s.schema === defaultSchema ? t.name : `${s.catalog}.${s.schema}.${t.name}`);

  return (
    <div className="side-panel">
      <div className="side-actions">
        <div className="search">
          <Icon name="search" />
          <input placeholder="Search tables and columns" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Search tables and columns" />
          <button className="icon-btn" onClick={onRefreshSchema} title="Refresh schema" aria-label="Refresh schema"><Icon name="refresh" /></button>
        </div>
      </div>
      <div className="side-scroll">
        {schemaError && <div className="side-error">{schemaError}</div>}
        {!schema && !schemaError && <div className="side-empty">Loading schema…</div>}
        {schema?.map(s => {
          const tables = s.tables
            .map(t => {
              if (!f) return { t, cols: t.columns, hit: false };
              const tableHit = t.name.toLowerCase().includes(f);
              const cols = tableHit ? t.columns : t.columns.filter(c => c.name.toLowerCase().includes(f));
              return tableHit || cols.length ? { t, cols, hit: !tableHit } : null;
            })
            .filter(Boolean)
            .sort((a, b) => categoryRank(a.t.category) - categoryRank(b.t.category) || a.t.name.localeCompare(b.t.name));
          if (f && tables.length === 0) return null;
          return (
            <Section key={`${s.catalog}.${s.schema}`} title={`${s.catalog}.${s.schema}`} icon="doc" count={tables.length}>
              {s.error && <div className="side-error">{s.error}</div>}
              {tables.map(({ t, cols, hit }, idx) => {
                const key = `${s.catalog}.${s.schema}.${t.name}`;
                const heading = t.category && t.category !== tables[idx - 1]?.t.category
                  ? <div className="template-cat schema-cat">{t.category}</div>
                  : null;
                const isOpen = open[key] ?? hit;
                return (
                  <div key={key} className="schema-table">
                    {heading}
                    <div className="schema-table-row">
                      <button className="schema-table-name" onClick={() => setOpen(o => ({ ...o, [key]: !isOpen }))} aria-expanded={isOpen} title={t.description || t.name}>
                        <span className={`caret ${isOpen ? 'open' : ''}`}><Icon name="chevron" /></span>
                        <Icon name="table" />
                        <span>{t.name}</span>
                      </button>
                      <div className="schema-table-actions">
                        <button className="mini-btn" onClick={() => onInsert(qualify(s, t))} title="Insert table name">Insert</button>
                        <button className="mini-btn" onClick={() => onPreviewTable(qualify(s, t))} title="Preview first 100 rows">Preview</button>
                      </div>
                    </div>
                    {isOpen && (
                      <div className="schema-columns">
                        {t.description && <div className="schema-table-desc">{t.description}</div>}
                        {cols.map(c => (
                          <button key={c.name} className="schema-col" onClick={() => onInsert(c.name)} title={c.description ? `${c.description}\n\nClick to insert` : 'Click to insert'}>
                            <span className="col-name">{c.name}</span>
                            <span className="col-type">{c.type}</span>
                            {c.description && <span className="col-desc">{c.description}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </Section>
          );
        })}
      </div>
    </div>
  );
}
