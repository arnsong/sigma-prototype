// Helpers for preparing user SQL before handing it to Trino.

/** Remove -- line comments and /* block comments *\/ outside of string literals. */
export function stripComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === "'" || c === '"') {
      // copy quoted literal/identifier verbatim ('' and "" are escapes)
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && n === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      // keep line/column positions stable so Trino error locations still match the editor
      out += sql.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Split on top-level semicolons, ignoring those inside literals and comments. */
export function splitStatements(sql) {
  const cleaned = stripComments(sql);
  const parts = [];
  let cur = '';
  let i = 0;
  while (i < cleaned.length) {
    const c = cleaned[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < cleaned.length) {
        if (cleaned[j] === c) {
          if (cleaned[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      cur += cleaned.slice(i, j + 1);
      i = j + 1;
    } else if (c === ';') {
      if (cur.trim()) parts.push(cur.trimEnd());
      cur = '';
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur.trim()) parts.push(cur.trimEnd());
  return parts;
}

const READ_ONLY = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'VALUES', 'TABLE']);

/**
 * Validate and normalize a user query. Returns the single statement to run.
 * Throws an Error with a user-facing message if the query is not allowed.
 */
export function prepareQuery(sql, { allowWrites = false } = {}) {
  const statements = splitStatements(sql || '');
  if (statements.length === 0) throw new Error('Query is empty.');
  if (statements.length > 1) {
    throw new Error('Only one statement can be run at a time. Remove the extra statements or select the one you want to run.');
  }
  const stmt = statements[0];
  const keyword = stmt.replace(/^[\s(]+/, '').split(/\s+/)[0].toUpperCase();
  if (!allowWrites && !READ_ONLY.has(keyword)) {
    throw new Error(`Only read-only queries are allowed (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN). "${keyword}" statements are disabled.`);
  }
  if (!allowWrites && keyword === 'EXPLAIN' && /^\s*EXPLAIN\s+ANALYZE\b/i.test(stmt)) {
    // EXPLAIN ANALYZE executes the query; allow it only for read-only statements.
    const inner = stmt.replace(/^\s*EXPLAIN\s+ANALYZE\s+(VERBOSE\s+)?/i, '').split(/\s+/)[0].toUpperCase();
    if (!READ_ONLY.has(inner)) throw new Error('EXPLAIN ANALYZE is only allowed for read-only statements.');
  }
  return stmt;
}
