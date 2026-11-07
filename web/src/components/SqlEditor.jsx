import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { sql, SQLDialect, PostgreSQL } from '@codemirror/lang-sql';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
  { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--syn-type)' },
  { tag: tags.operator, color: 'var(--syn-operator)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--editor-bg)', color: 'var(--text-primary)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0' },
  '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--text-muted)', border: 'none', paddingLeft: '6px' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-secondary)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--editor-selection) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-tooltip': { border: '1px solid var(--border)', backgroundColor: 'var(--surface-raised)', borderRadius: '6px', boxShadow: 'var(--shadow-md)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text-primary)' },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  '.cm-error-line': { backgroundColor: 'var(--danger-soft)' },
});

/** Build CodeMirror's completion schema from /api/schema output. */
function completionSchema(schema, defaultCatalog, defaultSchema) {
  const out = {};
  for (const s of schema || []) {
    for (const t of s.tables) {
      const cols = t.columns.map(c => ({ label: c.name, type: 'property', detail: c.type, info: c.description || undefined }));
      out[`${s.catalog}.${s.schema}.${t.name}`] = cols;
      if (s.catalog === defaultCatalog && s.schema === defaultSchema) out[t.name] = cols;
    }
  }
  return out;
}

// Trino dialect: Postgres' broad keyword list plus Trino-specific keywords, types and functions.
const TrinoSQL = SQLDialect.define({
  ...PostgreSQL.spec,
  doubleDollarQuotedStrings: false,
  specialVar: '?',
  keywords: PostgreSQL.spec.keywords + ' unnest tablesample bernoulli lateral fetch rows only ordinality filter respect ignore nulls',
  types: 'boolean tinyint smallint integer int bigint real double decimal varchar char varbinary json date time timestamp interval array map row ipaddress uuid hyperloglog with zone',
  builtin:
    'abs approx_distinct approx_percentile arbitrary array_agg array_join avg bool_and bool_or cardinality ceil coalesce concat ' +
    'contains count count_if current_date current_timestamp date date_add date_diff date_format date_parse date_trunc day ' +
    'day_of_week element_at every exp extract filter floor format format_datetime from_iso8601_timestamp from_unixtime ' +
    'greatest histogram hour if json_extract json_extract_scalar json_format json_parse lag lead least length lower lpad ' +
    'map_agg max max_by min min_by minute month now nullif percent_rank quarter rank regexp_extract regexp_like ' +
    'regexp_replace replace round row_number rpad sequence split split_part sqrt stddev strpos substr sum to_unixtime ' +
    'transform trim try try_cast typeof upper url_extract_host variance week with_timezone year zip dense_rank ntile ' +
    'first_value last_value nth_value cume_dist listagg reduce',
});

export const SqlEditor = forwardRef(function SqlEditor({ value, onChange, onRun, onSave, schema, defaultCatalog, defaultSchema }, ref) {
  const host = useRef(null);
  const view = useRef(null);
  const langConf = useRef(new Compartment());
  const handlers = useRef({ onChange, onRun, onSave });
  handlers.current = { onChange, onRun, onSave };

  useEffect(() => {
    const runKeys = Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: () => { handlers.current.onRun?.(); return true; } },
      { key: 'Shift-Enter', run: () => { handlers.current.onRun?.(); return true; } },
      { key: 'Mod-s', run: () => { handlers.current.onSave?.(); return true; } },
    ]));
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          runKeys,
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          autocompletion({ activateOnTyping: true }),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, ...searchKeymap, indentWithTab]),
          syntaxHighlighting(highlight),
          langConf.current.of(sql({ dialect: TrinoSQL, upperCaseKeywords: false })),
          placeholder('Write a SQL query… (⌘/Ctrl + Enter to run)'),
          theme,
          EditorView.lineWrapping,
          EditorView.updateListener.of(u => {
            if (u.docChanged) handlers.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the document in sync when the query is switched from outside.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: langConf.current.reconfigure(sql({
        dialect: TrinoSQL,
        schema: completionSchema(schema, defaultCatalog, defaultSchema),
        defaultSchema: defaultCatalog && defaultSchema ? `${defaultCatalog}.${defaultSchema}` : undefined,
        upperCaseKeywords: false,
      })),
    });
  }, [schema, defaultCatalog, defaultSchema]);

  useImperativeHandle(ref, () => ({
    /** The selected text if any, otherwise the whole document. */
    getRunnableSql() {
      const v = view.current;
      const sel = v.state.selection.main;
      if (!sel.empty) return { sql: v.state.sliceDoc(sel.from, sel.to), offsetLine: v.state.doc.lineAt(sel.from).number - 1, selection: true };
      return { sql: v.state.doc.toString(), offsetLine: 0, selection: false };
    },
    insert(text) {
      const v = view.current;
      const { from, to } = v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      v.focus();
    },
    goTo(line, column = 1) {
      const v = view.current;
      const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
      const pos = Math.min(l.from + Math.max(0, column - 1), l.to);
      v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      v.focus();
    },
    focus() { view.current?.focus(); },
  }), []);

  return <div className="sql-editor" ref={host} />;
});
