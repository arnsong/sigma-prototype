import { useMemo, useState, useEffect } from 'react';
import { compareCells, formatCell, formatInt, isNumericType } from '../format.js';

const PAGE_SIZE = 100;

export function ResultsTable({ columns, rows }) {
  const [sort, setSort] = useState(null); // { index, dir: 1 | -1 }
  const [page, setPage] = useState(0);

  useEffect(() => { setSort(null); setPage(0); }, [columns, rows]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const numeric = isNumericType(columns[sort.index]?.type);
    return [...rows].sort((a, b) => sort.dir * compareCells(a[sort.index], b[sort.index], numeric));
  }, [rows, columns, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const visible = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const toggleSort = i => {
    setPage(0);
    setSort(s => (!s || s.index !== i ? { index: i, dir: 1 } : s.dir === 1 ? { index: i, dir: -1 } : null));
  };

  if (columns.length === 0) {
    return <div className="results-empty">The statement ran successfully and returned no columns.</div>;
  }

  return (
    <div className="results-table-wrap">
      <div className="results-scroll">
        <table className="results-table">
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
                <td className="rownum">{page * PAGE_SIZE + ri + 1}</td>
                {r.map((v, ci) => {
                  const text = formatCell(v);
                  const numeric = isNumericType(columns[ci].type);
                  return (
                    <td key={ci} className={numeric ? 'num' : ''} title={text ?? 'NULL'}>
                      {text === null ? <span className="null">NULL</span> : text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager">
          <span>
            Rows {formatInt(page * PAGE_SIZE + 1)}–{formatInt(Math.min(sorted.length, (page + 1) * PAGE_SIZE))} of {formatInt(sorted.length)}
          </span>
          <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(0)} aria-label="First page">«</button>
          <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span className="pager-page">Page {page + 1} of {pages}</span>
          <button className="btn btn-ghost btn-sm" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}>Next</button>
          <button className="btn btn-ghost btn-sm" disabled={page >= pages - 1} onClick={() => setPage(pages - 1)} aria-label="Last page">»</button>
        </div>
      )}
    </div>
  );
}
