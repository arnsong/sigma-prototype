import { useEffect, useMemo, useRef, useState } from 'react';
import { isNumericType, isTemporalType } from '../format.js';

const MAX_SERIES = 8; // categorical palette size; never generate extra hues
const MAX_LINE_POINTS = 2000;
const MAX_BARS = 60;
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function niceTicks(min, max, count = 5) {
  if (min === max) { min = min === 0 ? 0 : Math.min(0, min); max = max === 0 ? 1 : max; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || step0;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function useWidth(ref) {
  const [w, setW] = useState(800);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function ResultsChart({ columns, rows }) {
  const numericCols = useMemo(() => columns.map((c, i) => ({ ...c, i })).filter(c => isNumericType(c.type)), [columns]);
  const defaultX = useMemo(() => {
    const t = columns.findIndex(c => isTemporalType(c.type));
    if (t >= 0) return t;
    const nonNum = columns.findIndex(c => !isNumericType(c.type));
    return nonNum >= 0 ? nonNum : 0;
  }, [columns]);

  const [kind, setKind] = useState(null);
  const [x, setX] = useState(defaultX);
  const [ys, setYs] = useState([]);

  useEffect(() => {
    setX(defaultX);
    // One series by default: extra measures often have different scales and would share one axis.
    setYs(numericCols.filter(c => c.i !== defaultX).slice(0, 1).map(c => c.i));
    setKind(isTemporalType(columns[defaultX]?.type) ? 'line' : 'bar');
  }, [columns, defaultX, numericCols]);

  const box = useRef(null);
  const width = useWidth(box);
  const [hover, setHover] = useState(null);

  if (numericCols.length === 0) {
    return <div className="results-empty">Charts need at least one numeric column. Try aggregating with <code>count(*)</code> or <code>sum(...)</code>.</div>;
  }

  const series = ys.filter(i => i !== x).slice(0, MAX_SERIES);
  const limit = kind === 'bar' ? MAX_BARS : MAX_LINE_POINTS;
  const data = rows.slice(0, limit);
  const clipped = rows.length > limit;

  const height = 320;
  const m = { top: 16, right: 20, bottom: 44, left: 64 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;

  const values = data.flatMap(r => series.map(s => Number(r[s]))).filter(Number.isFinite);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const yScale = v => m.top + ih - ((v - y0) / (y1 - y0 || 1)) * ih;

  const n = data.length;
  const band = iw / Math.max(1, n);
  const xPos = i => (kind === 'bar' ? m.left + band * i + band / 2 : m.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw));
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 90))));
  const xLabel = v => {
    const s = v === null ? 'NULL' : String(v);
    return s.length > 14 ? s.slice(0, 13) + '…' : s;
  };

  const onMove = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let idx = kind === 'bar' ? Math.floor((px - m.left) / band) : Math.round(((px - m.left) / iw) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    setHover(idx);
  };

  const toggleY = i => setYs(cur => (cur.includes(i) ? cur.filter(c => c !== i) : [...cur, i].slice(-MAX_SERIES)));
  const groupW = Math.max(2, band * 0.72);
  const barW = Math.max(1, groupW / Math.max(1, series.length) - 2);
  const zeroY = yScale(Math.max(y0, Math.min(0, y1)));

  return (
    <div className="chart-panel">
      <div className="chart-controls">
        <div className="segmented" role="group" aria-label="Chart type">
          <button className={kind === 'line' ? 'active' : ''} onClick={() => setKind('line')}>Line</button>
          <button className={kind === 'bar' ? 'active' : ''} onClick={() => setKind('bar')}>Bar</button>
        </div>
        <label className="control">
          <span>X axis</span>
          <select value={x} onChange={e => setX(Number(e.target.value))}>
            {columns.map((c, i) => <option key={i} value={i}>{c.name}</option>)}
          </select>
        </label>
        <div className="control series-picker">
          <span>Series</span>
          {numericCols.filter(c => c.i !== x).map(c => (
            <label key={c.i} className="chip">
              <input type="checkbox" checked={series.includes(c.i)} onChange={() => toggleY(c.i)} />
              {c.name}
            </label>
          ))}
        </div>
      </div>

      {series.length >= 2 && (
        <div className="legend" aria-label="Legend">
          {series.map((s, k) => (
            <span key={s} className="legend-item">
              <span className={`swatch ${kind}`} style={{ background: `var(--series-${k + 1})` }} />
              {columns[s].name}
            </span>
          ))}
        </div>
      )}

      <div className="chart-box" ref={box}>
        {series.length === 0 ? (
          <div className="results-empty">Pick at least one series to plot.</div>
        ) : (
          <svg width={width} height={height} role="img" aria-label={`${kind} chart of ${series.map(s => columns[s].name).join(', ')} by ${columns[x]?.name}`}
            onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {ticks.map(t => (
              <g key={t}>
                <line x1={m.left} x2={m.left + iw} y1={yScale(t)} y2={yScale(t)} className={t === 0 ? 'axis-zero' : 'grid'} />
                <text x={m.left - 8} y={yScale(t)} className="tick" textAnchor="end" dominantBaseline="middle">{compact.format(t)}</text>
              </g>
            ))}
            {data.map((r, i) => (i % labelEvery === 0 || (kind === 'line' && i === n - 1 && (n - 1) % labelEvery > labelEvery / 2) ? (
              <text key={i} x={xPos(i)} y={m.top + ih + 18} className="tick"
                textAnchor={kind === 'line' && n > 1 && i === 0 ? 'start' : kind === 'line' && n > 1 && i === n - 1 ? 'end' : 'middle'}>{xLabel(r[x])}</text>
            ) : null))}

            {kind === 'bar' && hover !== null && (
              <rect x={m.left + band * hover} y={m.top} width={band} height={ih} className="hover-band" />
            )}

            {kind === 'line' && series.map((s, k) => {
              const pts = data.map((r, i) => [xPos(i), Number(r[s])]).filter(p => Number.isFinite(p[1]));
              const d = pts.map((p, j) => `${j ? 'L' : 'M'}${p[0].toFixed(1)},${yScale(p[1]).toFixed(1)}`).join('');
              return <path key={s} d={d} fill="none" stroke={`var(--series-${k + 1})`} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />;
            })}

            {kind === 'bar' && data.map((r, i) => series.map((s, k) => {
              const v = Number(r[s]);
              if (!Number.isFinite(v)) return null;
              const bx = m.left + band * i + (band - groupW) / 2 + k * (barW + 2);
              const top = Math.min(yScale(v), zeroY);
              const h = Math.max(1, Math.abs(yScale(v) - zeroY));
              const rr = Math.min(4, barW / 2, h);
              // round only the data end (away from the baseline)
              const path = v >= 0
                ? `M${bx},${top + h}V${top + rr}Q${bx},${top} ${bx + rr},${top}H${bx + barW - rr}Q${bx + barW},${top} ${bx + barW},${top + rr}V${top + h}Z`
                : `M${bx},${top}V${top + h - rr}Q${bx},${top + h} ${bx + rr},${top + h}H${bx + barW - rr}Q${bx + barW},${top + h} ${bx + barW},${top + h - rr}V${top}Z`;
              return <path key={`${i}-${s}`} d={path} fill={`var(--series-${k + 1})`} />;
            }))}

            {kind === 'line' && hover !== null && (
              <g>
                <line x1={xPos(hover)} x2={xPos(hover)} y1={m.top} y2={m.top + ih} className="crosshair" />
                {series.map((s, k) => {
                  const v = Number(data[hover]?.[s]);
                  return Number.isFinite(v)
                    ? <circle key={s} cx={xPos(hover)} cy={yScale(v)} r="4.5" fill={`var(--series-${k + 1})`} stroke="var(--surface)" strokeWidth="2" />
                    : null;
                })}
              </g>
            )}
            {/* transparent hit area so hover works anywhere in the plot */}
            <rect x={m.left} y={m.top} width={iw} height={ih} fill="transparent" />
          </svg>
        )}
        {hover !== null && data[hover] && series.length > 0 && (
          <div
            className="chart-tooltip"
            style={{ left: Math.min(xPos(hover) + 12, width - 200), top: 12 }}
          >
            <div className="tt-title">{String(data[hover][x] ?? 'NULL')}</div>
            {series.map((s, k) => (
              <div key={s} className="tt-row">
                <span className="swatch" style={{ background: `var(--series-${k + 1})` }} />
                <span className="tt-name">{columns[s].name}</span>
                <span className="tt-val">{data[hover][s] === null ? 'NULL' : full.format(Number(data[hover][s]))}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {clipped && <div className="chart-note">Chart shows the first {limit.toLocaleString()} of {rows.length.toLocaleString()} rows. Aggregate further for a complete picture.</div>}
    </div>
  );
}
