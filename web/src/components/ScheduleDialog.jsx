import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDuration, formatInt } from '../format.js';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const fmtDate = iso => `${new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;

/** Modal for scheduling a saved query and browsing its past scheduled results. */
export function ScheduleDialog({ query, onClose, onChanged, onViewSnapshot }) {
  const current = query.schedule;
  const [frequency, setFrequency] = useState(current?.frequency || 'daily');
  const [hour, setHour] = useState(current?.hour ?? 9);
  const [webhookUrl, setWebhookUrl] = useState(current?.webhookUrl || '');
  const [snapshots, setSnapshots] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => api.listSnapshots(query.id).then(setSnapshots).catch(e => setError(e.message));
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [query.id]);
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = async fn => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const save = () => act(async () => onChanged(await api.setSchedule(query.id, { frequency, hour, webhookUrl })));
  const remove = () => act(async () => onChanged(await api.clearSchedule(query.id)));
  const runNow = () => act(async () => { await api.runSnapshot(query.id); await refresh(); });

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="schedule-title">
        <div className="modal-head">
          <h2 id="schedule-title">Schedule “{query.savedTitle}”</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <p className="muted">Run this query automatically and keep each result so you can view or download it later. Times are in UTC.</p>
          <div className="form-row">
            <label>
              <span>Frequency</span>
              <select value={frequency} onChange={e => setFrequency(e.target.value)}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly (Mondays)</option>
                <option value="monthly">Monthly (1st of the month)</option>
              </select>
            </label>
            <label>
              <span>Time (UTC)</span>
              <select value={hour} onChange={e => setHour(Number(e.target.value))}>
                {HOURS.map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            </label>
          </div>
          <label className="form-field">
            <span>Webhook URL <span className="muted">(optional — receives a JSON POST after each run)</span></span>
            <input type="url" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://example.com/hooks/sigma" />
          </label>
          {current && <div className="muted">Next run: {fmtDate(current.nextRunAt)}</div>}
          {error && <div className="side-error">{error}</div>}
          <div className="modal-actions">
            {current && <button className="btn btn-ghost" onClick={remove} disabled={busy}>Remove schedule</button>}
            <button className="btn btn-secondary" onClick={runNow} disabled={busy}>Run now</button>
            <button className="btn btn-primary" onClick={save} disabled={busy}>{current ? 'Update schedule' : 'Schedule query'}</button>
          </div>

          <h3>Past runs</h3>
          {!snapshots && <div className="muted">Loading…</div>}
          {snapshots?.length === 0 && <div className="muted">No scheduled runs yet. Use “Run now” to try it.</div>}
          {snapshots?.length > 0 && (
            <table className="snapshots">
              <tbody>
                {snapshots.map(s => (
                  <tr key={s.id}>
                    <td><span className={`state-dot state-${s.state.toLowerCase()}`} /> {fmtDate(s.ranAt)}</td>
                    <td className="muted">{s.state === 'FINISHED' ? `${formatInt(s.rowCount)} rows · ${formatDuration(s.elapsedMs)}` : s.error}</td>
                    <td className="snap-actions">
                      {s.state === 'FINISHED' && <button className="mini-btn" onClick={() => onViewSnapshot(s.id)}>View</button>}
                      {s.state === 'FINISHED' && <a className="mini-btn" href={api.snapshotCsvUrl(s.id)} download>CSV</a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
