// Minimal client for the Trino client REST protocol.
// https://trino.io/docs/current/develop/client-protocol.html
//
// We talk to Trino directly over HTTP rather than pulling in a driver so that
// we control polling, cancellation and row limits.

export class TrinoError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TrinoError';
    Object.assign(this, details);
  }
}

export class TrinoClient {
  /**
   * @param {object} opts
   * @param {string} opts.server   e.g. http://localhost:8080
   * @param {string} [opts.user]
   * @param {string} [opts.password]  enables HTTP basic auth (requires https on Trino)
   * @param {string} [opts.catalog]
   * @param {string} [opts.schema]
   * @param {string} [opts.source]
   * @param {typeof fetch} [opts.fetch]
   */
  constructor(opts) {
    this.server = opts.server.replace(/\/+$/, '');
    this.user = opts.user || 'sigma';
    this.password = opts.password;
    this.catalog = opts.catalog;
    this.schema = opts.schema;
    this.source = opts.source || 'sigma-prototype';
    this.fetch = opts.fetch || globalThis.fetch;
  }

  headers(extra = {}) {
    const h = {
      'X-Trino-User': this.user,
      'X-Trino-Source': this.source,
      ...extra,
    };
    if (this.catalog) h['X-Trino-Catalog'] = this.catalog;
    if (this.schema) h['X-Trino-Schema'] = this.schema;
    if (this.password) {
      h.Authorization = 'Basic ' + Buffer.from(`${this.user}:${this.password}`).toString('base64');
    }
    return h;
  }

  async request(url, init = {}) {
    // Trino answers 502/503/504 while busy; the protocol says to retry.
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, { ...init, headers: this.headers(init.headers) });
      if ([502, 503, 504].includes(res.status) && attempt < 5) {
        await sleep(100 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new TrinoError(`Trino HTTP ${res.status}: ${body.slice(0, 500) || res.statusText}`, {
          httpStatus: res.status,
        });
      }
      return res.json();
    }
  }

  /**
   * Start a query and iterate over protocol responses.
   * Yields each QueryResults page: { id, columns?, data?, stats, error?, nextUri? }
   * @param {string} sql
   * @param {{signal?: AbortSignal}} [opts]
   */
  async *pages(sql, { signal } = {}) {
    let page = await this.request(`${this.server}/v1/statement`, {
      method: 'POST',
      body: sql,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      signal,
    });
    while (true) {
      yield page;
      if (page.error) return;
      if (!page.nextUri) return;
      if (signal?.aborted) {
        await this.cancel(page.nextUri);
        return;
      }
      page = await this.request(page.nextUri, { signal });
    }
  }

  async cancel(uri) {
    try {
      await this.fetch(uri, { method: 'DELETE', headers: this.headers() });
    } catch {
      // best effort
    }
  }

  async cancelQuery(queryId) {
    try {
      await this.fetch(`${this.server}/v1/query/${encodeURIComponent(queryId)}`, {
        method: 'DELETE',
        headers: this.headers(),
      });
    } catch {
      // best effort
    }
  }

  /**
   * Run a query to completion and return all rows. Convenience for internal use.
   * @returns {Promise<{columns: {name:string,type:string}[], rows: any[][]}>}
   */
  async query(sql, { maxRows = Infinity } = {}) {
    let columns = [];
    const rows = [];
    for await (const page of this.pages(sql)) {
      if (page.error) throw toTrinoError(page.error);
      if (page.columns) columns = page.columns.map(c => ({ name: c.name, type: c.type }));
      if (page.data) {
        for (const r of page.data) {
          if (rows.length < maxRows) rows.push(r);
        }
      }
    }
    return { columns, rows };
  }

  async info() {
    return this.request(`${this.server}/v1/info`);
  }
}

export function toTrinoError(err) {
  const loc = err.errorLocation;
  return new TrinoError(err.message, {
    errorName: err.errorName,
    errorType: err.errorType,
    errorCode: err.errorCode,
    line: loc?.lineNumber,
    column: loc?.columnNumber,
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
