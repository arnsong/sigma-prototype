import { useEffect, useMemo, useRef, useState } from 'react';
import { isNumericType, isTemporalType } from '../format.js';

const MAX_SERIES = 8; // categorical palette size; extra groups fold into "Other"
const MAX_BARS = 60;
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function niceTicks(min, max, count = 5) {
  if (min === max) { min = Math.min(0, min); max = max === 0 ? 1 : max; }
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || step0;
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Default chart settings for a result: temporal/text X, first numeric Y. */
export function defaultChart(columns) {
  const t = columns.find(c => isTemporalType(c.type)) ?? columns.find(c => !isNumericType(c.type)) ?? columns[0];
  const y = columns.find(c => isNumericType(c.type) && c.name !== t?.name);
  return { kind: t && isTemporalType(t.type) ? 'line' : 'bar', x: t?.name ?? null, y: y ? [y.name] : [], groupBy: null };
}

/** Keep only settings that still match the result's columns. */
export function fitChart(config, columns) {
  const names = new Set(columns.map(c => c.name));
  if (!config || !names.has(config.x)) return defaultChart(columns);
  const numeric = new Set(columns.filter(c => isNumericType(c.type)).map(c => c.name));
  const y = (config.y || []).filter(n => numeric.has(n) && n !== config.x);
  return { kind: config.kind === 'bar' ? 'bar' : 'line', x: config.x, y: y.length ? y : defaultChart(columns).y, groupBy: names.has(config.groupBy) ? config.groupBy : null };
}

/** Turn rows into { labels, series: [{name, values}] }, pivoting on groupBy if set. */
export function buildSeries(columns, rows, cfg) {
  const idx = Object.fromEntries(columns.map((c, i) => [c.name, i]));
  const xi = idx[cfg.x];
  if (!cfg.groupBy) {
    return {
      labels: rows.map(r => r[xi]),
      series: cfg.y.slice(0, MAX_SERIES).map(n => ({ name: n, values: rows.map(r => Number(r[idx[n]])) })),
    };
  }
  // Group by: one series per distinct value of the group column (first Y measure).
  const yi = idx[cfg.y[0]];
  const gi = idx[cfg.groupBy];
  const labels = [];
  const pos = new Map();
  const totals = new Map();
  for (const r of rows) {
    const k = String(r[xi]);
    if (!pos.has(k)) { pos.set(k, labels.length); labels.push(r[xi]); }
    const g = r[gi] === null ? 'NULL' : String(r[gi]);
    totals.set(g, (totals.get(g) || 0) + Math.abs(Number(r[yi]) || 0));
  }
  const ranked = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a));
  const keep = ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked;
  const names = ranked.length > MAX_SERIES ? [...keep, 'Other'] : keep;
  const values = names.map(() => new Array(labels.length).fill(null));
  for (const r of rows) {
    const g = r[gi] === null ? 'NULL' : String(r[gi]);
    const si = keep.includes(g) ? keep.indexOf(g) : names.length - 1;
    const p = pos.get(String(r[xi]));
    const v = Number(r[yi]);
    if (Number.isFinite(v)) values[si][p] = (values[si][p] ?? 0) + v;
  }
  return { labels, series: names.map((name, i) => ({ name, values: values[i] })) };
}

export function ResultsChart({ columns, rows, rowCount, truncated, limit, config, onChange, onSave, canSave, saveHint, savedState, compactView = false }) {
  const [box, width] = useWidth();
  const [hover, setHover] = useState(null);
  const numericCols = columns.filter(c => isNumericType(c.type));
  const cfg = useMemo(() => fitChart(config, columns), [config, columns]);

  if (!compactView && (truncated || rowCount >= limit)) {
    return <div className="results-empty">Charts are available for queries with fewer than {limit.toLocaleString()} results. Aggregate the data (for example with <code>GROUP BY</code>) to chart it.</div>;
  }
  if (numericCols.length === 0) {
    return <div className="results-empty">Charts need at least one numeric column. Try aggregating with <code>count(*)</code> or <code>sum(...)</code>.</div>;
  }

  const set = patch => onChange?.({ ...cfg, ...patch });
  const { labels: allLabels, series: allSeries } = buildSeries(columns, rows, cfg);
  const n0 = allLabels.length;
  const cap = cfg.kind === 'bar' ? MAX_BARS : n0;
  const labels = allLabels.slice(0, cap);
  const series = allSeries.map(s => ({ ...s, values: s.values.slice(0, cap) }));

  const height = compactView ? 160 : 320;
  const m = compactView ? { top: 8, right: 8, bottom: 24, left: 44 } : { top: 16, right: 20, bottom: 44, left: 64 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const vals = series.flatMap(s => s.values).filter(Number.isFinite);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), compactView ? 3 : 5);
  const y0 = ticks[0], y1 = ticks.at(-1);
  const yScale = v => m.top + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  const n = labels.length;
  const band = iw / Math.max(1, n);
  const xPos = i => (cfg.kind === 'bar' ? m.left + band * i + band / 2 : m.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw));
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / (compactView ? 110 : 90)))));
  // Label the last point too, unless it would crowd the previous label.
  const labelLast = cfg.kind === 'line' && n > 1 && (n - 1) % labelEvery >= labelEvery * 0.8;
  const xLabel = v => { const s = v === null ? 'NULL' : String(v); return s.length > 14 ? s.slice(0, 13) + '…' : s; };
  const groupW = Math.max(2, band * 0.72);
  const barW = Math.max(1, groupW / Math.max(1, series.length) - 2);
  const zeroY = yScale(Math.max(y0, Math.min(0, y1)));

  const onMove = e => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let i = cfg.kind === 'bar' ? Math.floor((px - m.left) / band) : Math.round(((px - m.left) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div className={`chart-panel ${compactView ? 'compact' : ''}`}>
      {!compactView && (
        <div className="chart-controls">
          <div className="segmented" role="group" aria-label="Chart type">
            <button className={cfg.kind === 'line' ? 'active' : ''} onClick={() => set({ kind: 'line' })}>Line</button>
            <button className={cfg.kind === 'bar' ? 'active' : ''} onClick={() => set({ kind: 'bar' })}>Bar</button>
          </div>
          <label className="control">
            <span>X-axis</span>
            <select value={cfg.x ?? ''} onChange={e => set({ x: e.target.value })}>
              {columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </label>
          <div className="control series-picker">
            <span>Y-axis</span>
            {numericCols.filter(c => c.name !== cfg.x).map(c => (
              <label key={c.name} className="chip">
                <input
                  type={cfg.groupBy ? 'radio' : 'checkbox'}
                  name="y-axis"
                  checked={cfg.y.includes(c.name)}
                  onChange={() => set({ y: cfg.groupBy ? [c.name] : cfg.y.includes(c.name) ? cfg.y.filter(y => y !== c.name) : [...cfg.y, c.name].slice(-MAX_SERIES) })}
                />
                {c.name}
              </label>
            ))}
          </div>
          <label className="control">
            <span>Group by</span>
            <select value={cfg.groupBy ?? ''} onChange={e => set({ groupBy: e.target.value || null, y: e.target.value ? cfg.y.slice(0, 1) : cfg.y })}>
              <option value="">None</option>
              {columns.filter(c => c.name !== cfg.x && !cfg.y.includes(c.name)).map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </label>
          {onSave && (
            <button className="btn btn-secondary btn-sm chart-save" onClick={onSave} disabled={!canSave || savedState === 'saved'} title={saveHint}>
              {savedState === 'saved' ? 'Chart saved' : 'Save chart'}
            </button>
          )}
          {onSave && !canSave && saveHint?.startsWith('Charts') && (
            <span className="muted small chart-readonly">{saveHint}</span>
          )}
        </div>
      )}

      {series.length >= 2 && (
        <div className="legend" aria-label="Legend">
          {series.map((s, k) => (
            <span key={s.name} className="legend-item">
              <span className={`swatch ${cfg.kind}`} style={{ background: `var(--series-${k + 1})` }} />
              {s.name}
            </span>
          ))}
        </div>
      )}

      <div className="chart-box" ref={box}>
        {series.length === 0 ? (
          <div className="results-empty">Pick a Y-axis column to plot.</div>
        ) : (
          <svg width={width} height={height} role="img" aria-label={`${cfg.kind} chart of ${series.map(s => s.name).join(', ')} by ${cfg.x}`}
            onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {ticks.map(t => (
              <g key={t}>
                <line x1={m.left} x2={m.left + iw} y1={yScale(t)} y2={yScale(t)} className={t === 0 ? 'axis-zero' : 'grid'} />
                <text x={m.left - 8} y={yScale(t)} className="tick" textAnchor="end" dominantBaseline="middle">{compact.format(t)}</text>
              </g>
            ))}
            {labels.map((l, i) => (i % labelEvery === 0 || (labelLast && i === n - 1) ? (
              <text key={i} x={xPos(i)} y={m.top + ih + (compactView ? 14 : 18)} className="tick"
                textAnchor={cfg.kind === 'line' && n > 1 && i === 0 ? 'start' : cfg.kind === 'line' && n > 1 && i === n - 1 ? 'end' : 'middle'}>{xLabel(l)}</text>
            ) : null))}
            {cfg.kind === 'bar' && hover !== null && <rect x={m.left + band * hover} y={m.top} width={band} height={ih} className="hover-band" />}
            {cfg.kind === 'line' && series.map((s, k) => {
              let d = '';
              let pen = false;
              s.values.forEach((v, i) => {
                if (!Number.isFinite(v)) { pen = false; return; }
                d += `${pen ? 'L' : 'M'}${xPos(i).toFixed(1)},${yScale(v).toFixed(1)}`;
                pen = true;
              });
              return <path key={s.name} d={d} fill="none" stroke={`var(--series-${k + 1})`} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />;
            })}
            {cfg.kind === 'bar' && labels.map((_, i) => series.map((s, k) => {
              const v = s.values[i];
              if (!Number.isFinite(v)) return null;
              const bx = m.left + band * i + (band - groupW) / 2 + k * (barW + 2);
              const top = Math.min(yScale(v), zeroY);
              const h = Math.max(1, Math.abs(yScale(v) - zeroY));
              const rr = Math.min(4, barW / 2, h);
              const path = v >= 0
                ? `M${bx},${top + h}V${top + rr}Q${bx},${top} ${bx + rr},${top}H${bx + barW - rr}Q${bx + barW},${top} ${bx + barW},${top + rr}V${top + h}Z`
                : `M${bx},${top}V${top + h - rr}Q${bx},${top + h} ${bx + rr},${top + h}H${bx + barW - rr}Q${bx + barW},${top + h} ${bx + barW},${top + h - rr}V${top}Z`;
              return <path key={`${i}-${k}`} d={path} fill={`var(--series-${k + 1})`} />;
            }))}
            {cfg.kind === 'line' && hover !== null && (
              <g>
                <line x1={xPos(hover)} x2={xPos(hover)} y1={m.top} y2={m.top + ih} className="crosshair" />
                {series.map((s, k) => Number.isFinite(s.values[hover])
                  ? <circle key={s.name} cx={xPos(hover)} cy={yScale(s.values[hover])} r="4.5" fill={`var(--series-${k + 1})`} stroke="var(--surface)" strokeWidth="2" />
                  : null)}
              </g>
            )}
            <rect x={m.left} y={m.top} width={Math.max(0, iw)} height={Math.max(0, ih)} fill="transparent" />
          </svg>
        )}
        {hover !== null && labels[hover] !== undefined && series.length > 0 && (
          <div className="chart-tooltip" style={{ left: Math.max(0, Math.min(xPos(hover) + 12, width - 200)), top: 8 }}>
            <div className="tt-title">{String(labels[hover] ?? 'NULL')}</div>
            {series.map((s, k) => (
              <div key={s.name} className="tt-row">
                <span className="swatch" style={{ background: `var(--series-${k + 1})` }} />
                <span className="tt-name">{s.name}</span>
                <span className="tt-val">{Number.isFinite(s.values[hover]) ? full.format(s.values[hover]) : '—'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {!compactView && n0 > cap && <div className="chart-note">Bar charts show the first {cap} categories of {n0.toLocaleString()}. Switch to a line chart or aggregate further.</div>}
    </div>
  );
}
