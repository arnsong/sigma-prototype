import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDuration, formatInt } from '../format.js';

const utc = (iso, opts = { dateStyle: 'medium', timeStyle: 'short' }) => `${new Date(iso).toLocaleString(undefined, { ...opts, timeZone: 'UTC' })} UTC`;
const utcDay = iso => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

// Wording follows Sigma's "Schedule queries" documentation.
const FREQUENCIES = {
  daily: { label: 'Daily', help: 'Runs as soon as each day’s data (ending at 12:00am UTC) is available.' },
  weekly: { label: 'Weekly', help: 'Runs as soon as the previous week’s data (ending Sunday at 12:00am UTC) is available.' },
  monthly: { label: 'Monthly', help: 'Runs as soon as the previous month’s data is available, on the 1st of the month.' },
};

/** Client-side copy of the server's period logic, for the live timeline preview. */
function previewTimeline(frequency, now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (frequency === 'daily') next.setUTCDate(next.getUTCDate() + 1);
  else if (frequency === 'weekly') next.setUTCDate(next.getUTCDate() + (((8 - next.getUTCDay()) % 7) || 7));
  else { next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1); }
  const start = new Date(next);
  if (frequency === 'daily') start.setUTCDate(start.getUTCDate() - 1);
  else if (frequency === 'weekly') start.setUTCDate(start.getUTCDate() - 7);
  else start.setUTCMonth(start.getUTCMonth() - 1);
  return { nextRunAt: next.toISOString(), dataPeriod: { start: start.toISOString(), end: next.toISOString() } };
}

export function ScheduleDialog({ query, config, onClose, onChanged, onViewSnapshot }) {
  const current = query.schedule;
  const [title, setTitle] = useState(query.savedTitle || query.title);
  const [frequency, setFrequency] = useState(current?.frequency || 'daily');
  const [subscribers, setSubscribers] = useState((current?.subscribers || []).join(', '));
  const [webhookUrl, setWebhookUrl] = useState(current?.webhookUrl || '');
  const [snapshots, setSnapshots] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => api.listSnapshots(query.id).then(setSnapshots).catch(e => setError(e.message));
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [query.id]);
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && (preview ? setPreview(null) : onClose());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, preview]);

  const act = async fn => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const save = () => act(async () => onChanged(await api.setSchedule(query.id, { title, frequency, subscribers, webhookUrl })));
  const remove = () => act(async () => { if (window.confirm('Delete this schedule?')) onChanged(await api.clearSchedule(query.id)); });
  const runNow = () => act(async () => { await api.runSnapshot(query.id); await refresh(); });
  const showPreview = () => act(async () => setPreview(await api.emailPreview(query.id)));

  const timeline = current && current.frequency === frequency ? query.timeline ?? previewTimeline(frequency) : previewTimeline(frequency);

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="schedule-title">
        <div className="modal-head">
          <h2 id="schedule-title">{current ? 'Edit schedule' : 'Schedule query'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        {preview ? (
          <div className="modal-body">
            <div className="muted">Subject: <strong>{preview.subject}</strong></div>
            <iframe className="email-preview" title="Email preview" srcDoc={preview.html} sandbox="" />
            <div className="modal-actions"><button className="btn btn-secondary" onClick={() => setPreview(null)}>Back</button></div>
          </div>
        ) : (
          <div className="modal-body">
            <label className="form-field">
              <span>Name</span>
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Give each scheduled query a unique name" />
            </label>
            <fieldset className="freq">
              <legend>Schedule</legend>
              {Object.entries(FREQUENCIES).map(([k, f]) => (
                <label key={k} className={`freq-option ${frequency === k ? 'active' : ''}`}>
                  <input type="radio" name="frequency" value={k} checked={frequency === k} onChange={() => setFrequency(k)} />
                  <span><strong>{f.label}</strong><span className="muted">{f.help}</span></span>
                </label>
              ))}
            </fieldset>
            <div className="timeline" aria-label="Timeline">
              <div><span className="muted">Next run</span><strong>{utc(timeline.nextRunAt)}</strong></div>
              <div><span className="muted">Data processed</span><strong>{utcDay(timeline.dataPeriod.start)} – {utcDay(new Date(Date.parse(timeline.dataPeriod.end) - 1).toISOString())}</strong></div>
            </div>
            <label className="form-field">
              <span>Subscribers <span className="muted">(email addresses that receive the results)</span></span>
              <input value={subscribers} onChange={e => setSubscribers(e.target.value)} placeholder="you@example.com, teammate@example.com" />
              {config?.userEmail && !current && <span className="muted small">You ({config.userEmail}) are added as a subscriber by default.</span>}
              {!config?.emailDelivery && <span className="muted small">Email delivery isn’t configured on this server (set SMTP_URL); results are still kept below and sent to the webhook.</span>}
            </label>
            <label className="form-field">
              <span>Webhook URL <span className="muted">(optional — receives a <code>sigma.scheduled_query_run.created</code> event)</span></span>
              <input type="url" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://example.com/webhooks" />
            </label>
            {error && <div className="side-error">{error}</div>}
            <div className="modal-actions">
              {current && <button className="btn btn-ghost danger-text" onClick={remove} disabled={busy}>Delete schedule</button>}
              <span className="spacer" />
              {current && <button className="btn btn-ghost" onClick={showPreview} disabled={busy}>Preview email</button>}
              {current && <button className="btn btn-secondary" onClick={runNow} disabled={busy}>Run now</button>}
              <button className="btn btn-primary" onClick={save} disabled={busy}>{current ? 'Save schedule' : 'Schedule'}</button>
            </div>

            {current && (
              <>
                <h3>Past runs</h3>
                {!snapshots && <div className="muted">Loading…</div>}
                {snapshots?.length === 0 && <div className="muted">No runs yet. Use “Run now” to try it.</div>}
                {snapshots?.length > 0 && (
                  <table className="snapshots">
                    <tbody>
                      {snapshots.map(s => (
                        <tr key={s.id}>
                          <td><span className={`state-dot state-${s.state.toLowerCase()}`} /> {utc(s.ranAt)}</td>
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
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
