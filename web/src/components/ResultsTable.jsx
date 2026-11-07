import { useMemo, useState, useEffect } from 'react';
import { compareCells, formatCell, formatInt, isNumericType } from '../format.js';

/**
 * Sigma-style results table: up to `viewRows` rows (1,000), sortable by clicking a
 * header, resizable by dragging a header's right edge. CSV download has everything.
 */
export function ResultsTable({ columns, rows, rowCount, viewRows = 1000, truncated }) {
  const [sort, setSort] = useState(null); // { index, dir: 1 | -1 }
  const [widths, setWidths] = useState({});

  useEffect(() => { setSort(null); setWidths({}); }, [columns]);

  const visible = useMemo(() => {
    const base = rows.slice(0, viewRows);
    if (!sort) return base;
    const numeric = isNumericType(columns[sort.index]?.type);
    return [...base].sort((a, b) => sort.dir * compareCells(a[sort.index], b[sort.index], numeric));
  }, [rows, columns, sort, viewRows]);

  const toggleSort = i => setSort(s => (!s || s.index !== i ? { index: i, dir: 1 } : s.dir === 1 ? { index: i, dir: -1 } : null));

  const startResize = (e, i) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.parentElement;
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    const move = ev => setWidths(w => ({ ...w, [i]: Math.max(60, Math.round(startW + ev.clientX - startX)) }));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (columns.length === 0) {
    return <div className="results-empty">The statement ran successfully and returned no columns.</div>;
  }

  const total = rowCount ?? rows.length;
  const hidden = total > viewRows || truncated;

  return (
    <div className="results-table-wrap">
      <div className="results-scroll">
        <table className="results-table" style={{ tableLayout: Object.keys(widths).length ? 'fixed' : 'auto' }}>
          <colgroup>
            <col style={{ width: 52 }} />
            {columns.map((_, i) => <col key={i} style={widths[i] ? { width: widths[i] } : undefined} />)}
          </colgroup>
          <thead>
            <tr>
              <th className="rownum" aria-label="Row number" />
              {columns.map((c, i) => (
                <th
                  key={i}
                  className={isNumericType(c.type) ? 'num' : ''}
                  onClick={() => toggleSort(i)}
                  title={`${c.name} · ${c.type} — click to sort`}
                  aria-sort={sort?.index === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                >
                  <span className="th-name">{c.name}</span>
                  <span className="th-type">{c.type}</span>
                  {sort?.index === i && <span className="th-sort">{sort.dir === 1 ? '▲' : '▼'}</span>}
                  <span className="col-resizer" onPointerDown={e => startResize(e, i)} onClick={e => e.stopPropagation()} role="separator" aria-orientation="vertical" aria-label={`Resize ${c.name}`} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td className="no-rows" colSpan={columns.length + 1}>No rows returned</td></tr>
            )}
            {visible.map((r, ri) => (
              <tr key={ri}>
                <td className="rownum">{ri + 1}</td>
                {r.map((v, ci) => {
                  const text = formatCell(v);
                  return (
                    <td key={ci} className={isNumericType(columns[ci].type) ? 'num' : ''} title={text ?? 'NULL'}>
                      {text === null ? <span className="null">NULL</span> : text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden && (
        <div className="pager">
          <span>Showing the first {formatInt(Math.min(viewRows, rows.length))} of {formatInt(total)}{truncated ? '+' : ''} rows. Download CSV to get all results.</span>
        </div>
      )}
    </div>
  );
}
