import { useEffect, useRef, useState } from 'react';

/**
 * Prompt field above the editor. Two modes, as in Sigma:
 * - Generate writes a new query, overwriting the editor;
 * - Edit modifies the SQL in the editor.
 * The mode switches to Edit automatically when the editor has content.
 */
export function AssistantBar({ enabled, editorHasSql, onAsk }) {
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState(editorHasSql ? 'edit' : 'generate');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { kind: 'info' | 'error', text }
  const lastHasSql = useRef(editorHasSql);

  useEffect(() => {
    if (editorHasSql !== lastHasSql.current) setMode(editorHasSql ? 'edit' : 'generate');
    lastHasSql.current = editorHasSql;
  }, [editorHasSql]);

  const submit = async e => {
    e?.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const entry = await onAsk(question.trim(), mode);
      setNote({ kind: entry.sql ? 'info' : 'error', text: entry.explanation });
      if (entry.sql) { setQuestion(''); setMode('edit'); }
    } catch (err) {
      setNote({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="assistant">
      <form className="assistant-form" onSubmit={submit}>
        <span className="assistant-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5l1.6 3.9 3.9 1.6-3.9 1.6L8 12.5 6.4 8.6 2.5 7l3.9-1.6zM13 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" /></svg>
        </span>
        <div className="segmented mini" role="radiogroup" aria-label="Assistant mode">
          <button type="button" role="radio" aria-checked={mode === 'generate'} className={mode === 'generate' ? 'active' : ''} onClick={() => setMode('generate')} disabled={!enabled}
            title="Write a new query, replacing what's in the editor">Generate</button>
          <button type="button" role="radio" aria-checked={mode === 'edit'} className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')} disabled={!enabled}
            title="Modify the query in the editor">Edit</button>
        </div>
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder={!enabled
            ? 'Assistant unavailable — set ANTHROPIC_API_KEY on the server to enable it'
            : mode === 'generate' ? 'Ask a question, e.g. "What was gross volume by card brand last month?"' : 'Describe a change, e.g. "Sort these results by amount"'}
          disabled={!enabled || busy}
          aria-label="Ask the assistant"
        />
        <button className="btn btn-primary btn-sm" disabled={!enabled || busy || !question.trim()}>
          {busy ? 'Thinking…' : mode === 'generate' ? 'Generate' : 'Edit'}
        </button>
      </form>
      {note && (
        <div className={`assistant-note ${note.kind}`} role="status">
          <span>{note.text}</span>
          <button className="icon-btn" onClick={() => setNote(null)} aria-label="Dismiss">×</button>
        </div>
      )}
    </div>
  );
}

/** Slide-over listing every prompt and response for the life of this query. */
export function ChatHistory({ entries, onClose, onViewInEditor }) {
  const [open, setOpen] = useState({});
  return (
    <aside className="chat-history" aria-label="Assistant chat history">
      <div className="chat-head">
        <strong>Chat history</strong>
        <button className="icon-btn" onClick={onClose} aria-label="Close chat history">×</button>
      </div>
      <div className="chat-body">
        {entries.length === 0 && <div className="muted">Questions you ask the assistant about this query appear here.</div>}
        {[...entries].reverse().map(e => (
          <div key={e.id} className="chat-entry">
            <div className="chat-prompt"><span className="chat-mode">{e.mode === 'edit' ? 'Edit' : 'Generate'}</span>{e.prompt}</div>
            <div className="chat-answer">{e.explanation}</div>
            <div className="chat-meta">
              <span className="muted">{new Date(e.at).toLocaleString()}</span>
              {e.feedback && <span className="muted">· {e.feedback.helpful ? 'Helpful' : 'Not helpful'}</span>}
              {e.sql && <button className="link" onClick={() => setOpen(o => ({ ...o, [e.id]: !o[e.id] }))}>{open[e.id] ? 'Hide SQL' : 'View SQL'}</button>}
            </div>
            {open[e.id] && (
              <>
                <pre className="chat-sql">{e.sql}</pre>
                <button className="btn btn-secondary btn-sm" onClick={() => onViewInEditor(e.sql)}>View in editor</button>
              </>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

/** "Was this response helpful?" shown between the editor and the results. */
export function AssistantFeedback({ entry, onSubmit }) {
  const [helpful, setHelpful] = useState(null);
  const [details, setDetails] = useState('');
  const [sent, setSent] = useState(Boolean(entry.feedback));
  useEffect(() => { setHelpful(null); setDetails(''); setSent(Boolean(entry.feedback)); }, [entry.id, entry.feedback]);

  if (sent) return <div className="feedback muted">Thanks for your feedback.</div>;
  return (
    <div className="feedback">
      <span>Was this response helpful?</span>
      <button className={`btn btn-sm ${helpful === true ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setHelpful(true)}>Yes</button>
      <button className={`btn btn-sm ${helpful === false ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setHelpful(false)}>No</button>
      {helpful !== null && (
        <form className="feedback-form" onSubmit={async e => { e.preventDefault(); await onSubmit({ helpful, details }); setSent(true); }}>
          <input value={details} onChange={e => setDetails(e.target.value)} placeholder="What worked or didn't? (optional)" aria-label="Feedback details" />
          <button className="btn btn-secondary btn-sm">Submit</button>
        </form>
      )}
    </div>
  );
}
