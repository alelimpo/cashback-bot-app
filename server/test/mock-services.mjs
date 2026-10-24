// Finto server per i test locali: imita l'API Awin (transazioni) e l'API Telegram (sendMessage).
// Avvio: node test/mock-services.mjs   (porta 8799)
import http from 'node:http';

let transactions = [];
const messages = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let body = '';
  for await (const chunk of req) body += chunk;
  const send = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (url.pathname === '/__set' && req.method === 'POST') { transactions = JSON.parse(body || '[]'); return send(200, { ok: true }); }
  if (url.pathname === '/__messages') return send(200, messages);
  if (url.pathname === '/__reset') { transactions = []; messages.length = 0; return send(200, { ok: true }); }

  if (/^\/publishers\/\d+\/transactions\/?$/.test(url.pathname)) {
    if (req.headers.authorization !== 'Bearer test-awin-token') return send(401, { error: 'unauthorized' });
    const ids = url.searchParams.get('ids');
    if (ids) {
      const wanted = new Set(ids.split(','));
      return send(200, transactions.filter((t) => wanted.has(String(t.id))));
    }
    for (const p of ['startDate', 'endDate', 'timezone']) if (!url.searchParams.get(p)) return send(400, { error: 'missing ' + p });
    return send(200, transactions);
  }

  const tg = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname);
  if (tg) { messages.push({ method: tg[1], ...JSON.parse(body || '{}') }); return send(200, { ok: true, result: true }); }

  send(404, { error: 'not found' });
});

server.listen(8799, '127.0.0.1', () => console.log('mock pronto su 8799'));
