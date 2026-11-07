import { useState } from 'react';
import { api } from '../api.js';

/** "Ask a question" bar above the editor: natural language -> SQL. */
export function AssistantBar({ enabled, getSql, onSql }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { kind: 'info' | 'error', text }

  const submit = async e => {
    e?.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.ask(question, getSql());
      if (r.sql) onSql(r.sql);
      setNote({ kind: r.sql ? 'info' : 'error', text: r.explanation });
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
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder={enabled ? 'Ask a question about your data, e.g. "What was revenue by card brand last month?"' : 'Assistant unavailable — set ANTHROPIC_API_KEY on the server to enable it'}
          disabled={!enabled || busy}
          aria-label="Ask the assistant a question"
        />
        <button className="btn btn-secondary btn-sm" disabled={!enabled || busy || !question.trim()}>
          {busy ? 'Writing SQL…' : 'Generate SQL'}
        </button>
      </form>
      {note && (
        <div className={`assistant-note ${note.kind}`}>
          {note.text}
          <button className="icon-btn" onClick={() => setNote(null)} aria-label="Dismiss">×</button>
        </div>
      )}
    </div>
  );
}
