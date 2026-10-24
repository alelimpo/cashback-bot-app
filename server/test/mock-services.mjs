// Finto server per i test locali: imita l'API Awin (transazioni) e l'API Telegram (sendMessage).
// Avvio: node test/mock-services.mjs   (porta 8799)
import http from 'node:http';

let transactions = [];
const messages = [];
// Programmi Awin: iscrizioni, commissioni per categoria e KPI (impostabili dai test).
let programs = { joined: [], notjoined: [], groups: {}, details: {} };
const calls = [];
const emails = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let body = '';
  for await (const chunk of req) body += chunk;
  const send = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (url.pathname === '/__set' && req.method === 'POST') { transactions = JSON.parse(body || '[]'); return send(200, { ok: true }); }
  if (url.pathname === '/__programs' && req.method === 'POST') { programs = { joined: [], notjoined: [], groups: {}, details: {}, ...JSON.parse(body || '{}') }; return send(200, { ok: true }); }
  if (url.pathname === '/__messages') return send(200, messages);
  if (url.pathname === '/__calls') return send(200, calls);
  if (url.pathname === '/__emails') return send(200, emails);
  if (url.pathname === '/__reset') { transactions = []; messages.length = 0; calls.length = 0; emails.length = 0; programs = { joined: [], notjoined: [], groups: {}, details: {} }; return send(200, { ok: true }); }

  if (url.pathname.startsWith('/publishers/')) {
    calls.push(url.pathname);
    if (req.headers.authorization !== 'Bearer test-awin-token') return send(401, { error: 'unauthorized' });
  }
  if (/^\/publishers\/\d+\/programmes$/.test(url.pathname)) {
    const rel = url.searchParams.get('relationship');
    if (rel === 'notjoined') return send(200, programs.notjoined);
    if (rel !== 'joined') return send(400, { error: 'expected joined' });
    return send(200, programs.joined.map((id) => ({ id, name: `Programma ${id}`, status: 'Active' })));
  }
  if (/^\/publishers\/\d+\/commissiongroups$/.test(url.pathname)) {
    const mid = url.searchParams.get('advertiserId');
    if (!programs.joined.includes(Number(mid))) return send(403, { error: 'not joined' });
    return send(200, { advertiser: Number(mid), commissionGroups: programs.groups[mid] || [] });
  }
  if (/^\/publishers\/\d+\/programmedetails$/.test(url.pathname)) {
    const mid = url.searchParams.get('advertiserId');
    return send(200, programs.details[mid] || { programmeInfo: { id: Number(mid) }, kpi: null, commissionRange: [] });
  }

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

  // Email (finto Resend).
  if (url.pathname === '/emails' && req.method === 'POST') {
    if (req.headers.authorization !== 'Bearer test-resend-key') return send(401, { message: 'API key non valida' });
    emails.push(JSON.parse(body || '{}'));
    return send(200, { id: `email_${emails.length}` });
  }

  const tg = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname);
  if (tg) { messages.push({ method: tg[1], ...JSON.parse(body || '{}') }); return send(200, { ok: true, result: true }); }

  send(404, { error: 'not found' });
});

server.listen(8799, '127.0.0.1', () => console.log('mock pronto su 8799'));
