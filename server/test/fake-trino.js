// A fake Trino coordinator implementing the bits of the client protocol we use.
import http from 'node:http';

export function startFakeTrino({ pages = 3, rowsPerPage = 2, failWith = null, delayMs = 0 } = {}) {
  const deleted = [];
  const statements = [];
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/v1/info') return send({ nodeVersion: { version: 'fake' }, starting: false });
    if (req.method === 'DELETE') { deleted.push(req.url); res.statusCode = 204; return res.end(); }
    if (req.method === 'POST' && req.url === '/v1/statement') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        statements.push({ sql: body, user: req.headers['x-trino-user'], catalog: req.headers['x-trino-catalog'] });
        send({ id: 'q1', nextUri: `${base}/v1/statement/q1/0`, stats: { state: 'QUEUED' } });
      });
      return;
    }
    const m = req.url.match(/^\/v1\/statement\/q1\/(\d+)$/);
    if (m) {
      const i = Number(m[1]);
      setTimeout(() => {
        if (failWith) return send({ id: 'q1', stats: { state: 'FAILED' }, error: failWith });
        const out = { id: 'q1', stats: { state: 'RUNNING', progressPercentage: (i / pages) * 100, processedRows: i * 10 } };
        out.columns = [{ name: 'n', type: 'bigint' }, { name: 's', type: 'varchar' }];
        if (i > 0) out.data = Array.from({ length: rowsPerPage }, (_, k) => [(i - 1) * rowsPerPage + k, `row,"${k}"`]);
        if (i < pages) out.nextUri = `${base}/v1/statement/q1/${i + 1}`;
        else out.stats.state = 'FINISHED';
        send(out);
      }, delayMs);
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, server, deleted, statements,
    close: () => new Promise(r => server.close(r)),
  })));
}
