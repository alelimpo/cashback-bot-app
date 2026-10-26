// Test end-to-end in locale: richiede "wrangler dev" su 8787 e test/mock-services.mjs su 8799.
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const API = 'http://127.0.0.1:8787';
const MOCK = 'http://127.0.0.1:8799';
const BOT_TOKEN = '123456:TEST-TOKEN';
const NOTIFY_SECRET = 'local-notify-secret-123456';

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('OK   ', name);
  } catch (err) {
    console.log('FAIL ', name);
    console.log(err);
    process.exit(1);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function initData(user, extra = {}, token = BOT_TOKEN) {
  const p = new URLSearchParams();
  p.set('auth_date', String(Math.floor(Date.now() / 1000)));
  p.set('query_id', 'AAH' + user.id);
  p.set('user', JSON.stringify(user));
  p.set('signature', 'firma-ed25519-di-prova');
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}

async function call(path, body) {
  const res = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://alelimpo.github.io' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
}

async function notify(payload, secret = NOTIFY_SECRET) {
  const form = new URLSearchParams({ AwinTransactionPush: JSON.stringify(payload) });
  const res = await fetch(`${API}/awin/notify/${secret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: form.toString(),
  });
  return res.status;
}

async function setAwin(list) {
  await fetch(MOCK + '/__set', { method: 'POST', body: JSON.stringify(list) });
}
// Programmi a cui sei iscritto su Awin (finti), con commissioni per categoria e KPI.
const PROGRAMS = {
  joined: [9449, 118233, 9418],
  // Programmi Awin italiani a cui non sei iscritto: servono per le segnalazioni.
  notjoined: [
    { id: 99001, name: 'Zalando IT', primarySector: 'Clothing', displayUrl: 'https://www.zalando.it/', validDomains: [{ domain: '*.zalando.it' }] },
    { id: 99002, name: 'Myprotein IT', primarySector: 'Health & Beauty', displayUrl: 'https://www.myprotein.it/', validDomains: [{ domain: 'myprotein.it' }] },
  ],
  groups: {
    9449: [
      { groupId: 1, groupCode: 'SALE', groupName: 'SALE', type: 'percentage', percentage: 12 },
      { groupId: 2, groupCode: 'Voucher', groupName: 'Voucher', type: 'percentage', percentage: 10 },
      { groupId: 3, groupCode: 'DEFAULT', groupName: 'Default', type: 'percentage', percentage: 12 },
    ],
    9418: [
      { groupId: 4, groupCode: 'FIBRA', groupName: 'fibra online', type: 'fix', amount: 51, currency: 'EUR' },
      { groupId: 5, groupCode: 'CB', groupName: 'callback', type: 'fix', amount: 0, currency: 'EUR' },
    ],
    10139: [
      { groupId: 6, groupCode: 'E_HD', groupName: 'Elettrodomestici_HD', type: 'percentage', percentage: 4 },
      { groupId: 7, groupCode: 'E_SP', groupName: 'Elettrodomestici_SP', type: 'percentage', percentage: 2 },
      { groupId: 8, groupCode: 'G', groupName: 'Garanzia', type: 'percentage', percentage: 0 },
    ],
  },
  details: {
    9449: { programmeInfo: { id: 9449, deeplinkEnabled: true, trackingTransparency: ['CLIENT_SIDE_TAG', 'SERVER_TO_SERVER'] }, kpi: { averagePaymentTime: '91', approvalPercentage: 87.03, validationDays: 32 } },
    10139: { programmeInfo: { id: 10139, deeplinkEnabled: true, trackingTransparency: ['CLIENT_SIDE_TAG'] }, kpi: { averagePaymentTime: '158', approvalPercentage: 73.06, validationDays: 28 } },
    9685: { programmeInfo: { id: 9685, deeplinkEnabled: false, trackingTransparency: ['APP_TRACKING'] }, kpi: { averagePaymentTime: '138', approvalPercentage: 100, validationDays: 45 } },
  },
};
async function setPrograms(p) {
  await fetch(MOCK + '/__programs', { method: 'POST', body: JSON.stringify(p) });
}
async function messages() {
  return (await fetch(MOCK + '/__messages')).json();
}
async function emails() {
  return (await fetch(MOCK + '/__emails')).json();
}
async function runCron() {
  for (const path of ['/cdn-cgi/handler/scheduled?cron=17+*+*+*+*', '/__scheduled?cron=17+*+*+*+*']) {
    const res = await fetch(API + path);
    if (res.ok) { await sleep(1500); return; }
  }
  throw new Error('impossibile avviare il cron di prova');
}
function awinTx(id, clickRef, mid, commission, status, paid) {
  return {
    id, advertiserId: mid, commissionStatus: status, paidToPublisher: paid,
    commissionAmount: { amount: commission, currency: 'EUR' },
    saleAmount: { amount: commission * 10, currency: 'EUR' },
    clickRefs: { clickRef }, transactionDate: '2026-10-20T10:00:00',
  };
}

const alice = { id: 111, first_name: 'Alice', username: 'alice_admin' }; // admin (ADMIN_IDS=111)
const bruno = { id: 222, first_name: 'Bruno' };
let aliceCode, brunoDouglasClick, brunoVodafoneClick;

await fetch(MOCK + '/__reset');
await setPrograms(PROGRAMS);

await step('health', async () => {
  const r = await call('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

await step('CORS per GitHub Pages', async () => {
  const r = await call('/api/health');
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://alelimpo.github.io');
});

await step('initData falsa rifiutata', async () => {
  const r = await call('/api/me', { initData: initData(alice, {}, '999:ALTRO-BOT') });
  assert.equal(r.status, 401);
  const r2 = await call('/api/me', { initData: initData(alice).replace('Alice', 'Mallory') });
  assert.equal(r2.status, 401);
});

await step('initData scaduta rifiutata', async () => {
  const old = new URLSearchParams(initData(alice));
  old.set('auth_date', String(Math.floor(Date.now() / 1000) - 3 * 86400));
  const r = await call('/api/me', { initData: old.toString() });
  assert.equal(r.status, 401);
});

await step('utente Alice creato, negozi attivi con cashback utente', async () => {
  const r = await call('/api/me', { initData: initData(alice) });
  assert.equal(r.status, 200);
  assert.equal(r.data.isAdmin, true);
  aliceCode = r.data.user.refCode;
  assert.match(r.data.user.refLink, /^https:\/\/t\.me\/TestCashbackBot\?start=ref_/);
  const douglas = r.data.stores.find((s) => s.id === 'douglas');
  assert.equal(douglas.cashbackLabel, 'fino al 7,2%'); // 12% x 60%
  const vodafone = r.data.stores.find((s) => s.id === 'vodafone');
  assert.equal(vodafone.cashbackLabel, '30,60 €'); // 51 EUR x 60%
  assert.equal(r.data.stores.find((s) => s.id === 'unieuro'), undefined); // non attivo
});

await step('trasparenza: quota, percentuali per categoria, tempi e regole dalla scheda', async () => {
  const r = await call('/api/me', { initData: initData(alice) });
  assert.deepEqual(r.data.program, { userSharePercent: 60, minPayoutCents: 1000, referralBonusCents: 200, payoutWorkingDays: 7 });
  const douglas = r.data.stores.find((s) => s.id === 'douglas');
  assert.deepEqual(douglas.rates.map((x) => [x.label, x.storePays, x.youGet]), [
    ['Acquisti senza codice sconto', '12%', '7,2%'],
    ['Acquisti con codice sconto', '10%', '6%'],
  ]);
  assert.equal(douglas.timing.validationDays, 32);
  assert.equal(douglas.timing.avgPaymentDays, 91);
  assert.equal(douglas.timing.approvalPercent, 87.03);
  assert.equal(douglas.timing.autoApproveDays, 120);
  assert.equal(douglas.timing.payment.color, 'amber');
  assert.ok(douglas.timing.payment.text.includes('livello 2 di 4'));
  assert.equal(douglas.rules.appTracking, false);
  assert.equal(douglas.rules.cookieDays, 30);
  assert.equal(douglas.rules.vatIncluded, false);
  assert.equal(douglas.rules.commissionBase, 'prezzo senza IVA e senza spese di spedizione');
  assert.equal(douglas.rules.excludedProducts, false);
  assert.ok(douglas.rules.declineReasons.includes('il prodotto acquistato non dà diritto alla commissione'));
  assert.ok(!douglas.rules.declineReasons.includes('altri motivi previsti dai termini del negozio'));
  assert.equal(douglas.source, 'awin_profile');
  const vodafone = r.data.stores.find((s) => s.id === 'vodafone');
  assert.equal(vodafone.rules.cookieDays, 21);
  assert.equal(vodafone.rules.commissionBase, null); // importo fisso: niente base di calcolo
  assert.equal(vodafone.rules.excludedProducts, true);
  const temu = r.data.stores.find((s) => s.id === 'temu');
  assert.equal(temu.cashbackLabel, 'fino al 6%');
  assert.ok(temu.rules.notes.some((n) => n.includes('primo ordine')));
  assert.equal(temu.timing.avgPaymentDays, null); // Awin non ha ancora dati: nessun numero inventato
});

await step('Bruno arriva con l\'invito di Alice', async () => {
  const r = await call('/api/me', { initData: initData(bruno, { start_param: `ref_${aliceCode}` }) });
  assert.equal(r.status, 200);
  assert.equal(r.data.isAdmin, false);
  assert.equal(r.data.balance.availableCents, 0);
});

await step('link Douglas con prodotto: Awin con clickref e destinazione', async () => {
  const r = await call('/api/link', { initData: initData(bruno), storeId: 'douglas', url: 'https://www.douglas.it/it/p/5011237' });
  assert.equal(r.status, 200);
  const u = new URL(r.data.url);
  assert.equal(u.origin + u.pathname, 'https://www.awin1.com/cread.php');
  assert.equal(u.searchParams.get('awinmid'), '9449');
  assert.equal(u.searchParams.get('awinaffid'), '3133036');
  assert.equal(u.searchParams.get('ued'), 'https://www.douglas.it/it/p/5011237');
  brunoDouglasClick = u.searchParams.get('clickref');
  assert.match(brunoDouglasClick, /^[a-z0-9]{16}$/);
});

await step('link verso dominio sbagliato rifiutato', async () => {
  const r = await call('/api/link', { initData: initData(bruno), storeId: 'douglas', url: 'https://www.amazon.it/dp/B000' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'url_not_for_store');
  const r2 = await call('/api/link', { initData: initData(bruno), storeId: 'douglas', url: 'https://douglas.it.truffa.com/x' });
  assert.equal(r2.data.error, 'url_not_for_store');
});

await step('negozio non attivo rifiutato', async () => {
  const r = await call('/api/link', { initData: initData(bruno), storeId: 'unieuro' });
  assert.equal(r.status, 404);
});

await step('notifica Awin con segreto sbagliato ignorata', async () => {
  assert.equal(await notify({ transactionId: '1', clickRef: brunoDouglasClick }, 'segreto-sbagliato-0000000'), 404);
});

await step('notifica Awin: vendita Douglas in attesa per Bruno + messaggio', async () => {
  const status = await notify({
    transactionId: '900001', transactionDate: '2026-10-20 10:00:00', transactionCurrency: 'EUR',
    transactionAmount: '100.00', affiliateId: '3133036', merchantId: '9449', clickRef: brunoDouglasClick, commission: '12.00',
  });
  assert.equal(status, 200);
  const r = await call('/api/me', { initData: initData(bruno) });
  assert.equal(r.data.balance.pendingCents, 720);
  assert.equal(r.data.balance.availableCents, 0);
  assert.equal(r.data.transactions[0].store, 'Douglas');
  assert.equal(r.data.transactions[0].state, 'pending');
  assert.equal(r.data.transactions[0].expectedAvailableAt, '2027-01-19'); // 20/10/2026 + 91 giorni (media Douglas)
  const msgs = await messages();
  assert.ok(msgs.some((m) => String(m.chat_id) === '222' && m.text.includes('7,20')));
});

await step('notifica duplicata non duplica soldi ne messaggi', async () => {
  const before = (await messages()).length;
  await notify({ transactionId: '900001', affiliateId: '3133036', merchantId: '9449', clickRef: brunoDouglasClick, commission: '99.00' });
  const r = await call('/api/me', { initData: initData(bruno) });
  assert.equal(r.data.balance.pendingCents, 720);
  assert.equal((await messages()).length, before);
});

await step('notifica falsa senza riscontro Awin resta solo in attesa', async () => {
  await notify({ transactionId: '555555', affiliateId: '3133036', merchantId: '9449', clickRef: brunoDouglasClick, commission: '500.00' });
  const r = await call('/api/me', { initData: initData(bruno) });
  assert.equal(r.data.balance.availableCents, 0);
});

await step('cron: approvata ma non ancora pagata da Awin -> ancora in attesa', async () => {
  await setAwin([awinTx(900001, brunoDouglasClick, 9449, 12, 'approved', false)]);
  await runCron();
  const r = await call('/api/me', { initData: initData(bruno) });
  const t = r.data.transactions.find((x) => x.id === '900001');
  assert.equal(t.state, 'approved');
  assert.equal(r.data.balance.availableCents, 0);
});

await step('cron: pagata da Awin -> disponibile, bonus invito ad Alice, messaggio', async () => {
  await setAwin([awinTx(900001, brunoDouglasClick, 9449, 12, 'approved', true)]);
  await runCron();
  const b = await call('/api/me', { initData: initData(bruno) });
  assert.equal(b.data.balance.availableCents, 720);
  const a = await call('/api/me', { initData: initData(alice) });
  assert.equal(a.data.balance.availableCents, 200);
  const msgs = await messages();
  assert.ok(msgs.some((m) => String(m.chat_id) === '222' && m.text.includes('disponibili')));
});

await step('cron ripetuto: nessun bonus o messaggio doppio', async () => {
  const before = (await messages()).length;
  await runCron();
  const a = await call('/api/me', { initData: initData(alice) });
  assert.equal(a.data.balance.availableCents, 200);
  assert.equal((await messages()).length, before);
});

await step('prelievo sotto soglia rifiutato', async () => {
  const r = await call('/api/withdraw', { initData: initData(bruno), method: 'paypal', destination: 'bruno@example.com' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'below_minimum');
});

await step('cron: schede aggiornate dall\'API Awin (commissioni per categoria e tempi)', async () => {
  const r = await call('/api/me', { initData: initData(alice) });
  const douglas = r.data.stores.find((s) => s.id === 'douglas');
  assert.equal(douglas.source, 'awin_api');
  assert.deepEqual(douglas.rates.map((x) => [x.label, x.youGet]), [
    ['Acquisti senza codice sconto', '7,2%'],
    ['Acquisti con codice sconto', '6%'],
    ['Altri acquisti', '7,2%'],
  ]);
  const vodafone = r.data.stores.find((s) => s.id === 'vodafone');
  assert.deepEqual(vodafone.rates.map((x) => [x.label, x.storePays, x.youGet]), [['Attivazione fibra online', '51,00 €', '30,60 €']]);
  const temu = r.data.stores.find((s) => s.id === 'temu');
  assert.equal(temu.source, 'awin_profile'); // nessuna categoria dall'API: resta la scheda
});

await step('Vodafone: 60% della commissione fissa all\'utente, vendita arrivata solo dal cron', async () => {
  const link = await call('/api/link', { initData: initData(bruno), storeId: 'vodafone' });
  brunoVodafoneClick = new URL(link.data.url).searchParams.get('clickref');
  await setAwin([
    awinTx(900001, brunoDouglasClick, 9449, 12, 'approved', true),
    awinTx(900002, brunoVodafoneClick, 9418, 51, 'approved', true),
    awinTx(900003, brunoDouglasClick, 9449, 6, 'declined', false),
  ]);
  await runCron();
  const r = await call('/api/me', { initData: initData(bruno) });
  assert.equal(r.data.balance.availableCents, 720 + 3060);
  assert.equal(r.data.transactions.find((x) => x.id === '900003').state, 'cancelled');
});

await step('Temu in dollari: commissione convertita in euro', async () => {
  const link = await call('/api/link', { initData: initData(bruno), storeId: 'temu' });
  const temuClick = new URL(link.data.url).searchParams.get('clickref');
  const usd = { ...awinTx(900004, temuClick, 118233, 10, 'pending', false), commissionAmount: { amount: 10, currency: 'USD' }, saleAmount: { amount: 100, currency: 'USD' } };
  await setAwin([
    awinTx(900001, brunoDouglasClick, 9449, 12, 'approved', true),
    awinTx(900002, brunoVodafoneClick, 9418, 51, 'approved', true),
    awinTx(900003, brunoDouglasClick, 9449, 6, 'declined', false),
    usd,
  ]);
  await runCron();
  const r = await call('/api/me', { initData: initData(bruno) });
  const t = r.data.transactions.find((x) => x.id === '900004');
  assert.equal(t.amountCents, 528); // 10 USD x 0,88 = 8,80 EUR; 60% = 5,28 EUR
  assert.equal(t.state, 'pending');
});

await step('notifica falsa vecchia, sconosciuta ad Awin: annullata dal cron', async () => {
  const old = new Date(Date.now() - 45 * 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  await notify({ transactionId: '777777', transactionDate: old, affiliateId: '3133036', merchantId: '9449', clickRef: brunoDouglasClick, commission: '300.00' });
  let r = await call('/api/me', { initData: initData(bruno) });
  const before = r.data.balance.pendingCents;
  await runCron();
  r = await call('/api/me', { initData: initData(bruno) });
  assert.equal(r.data.transactions.find((x) => x.id === '777777').state, 'cancelled');
  assert.equal(r.data.balance.pendingCents, before - 18000);
});

await step('prelievo: email non valida rifiutata', async () => {
  const r = await call('/api/withdraw', { initData: initData(bruno), method: 'paypal', destination: 'non-una-email' });
  assert.equal(r.data.error, 'invalid_destination');
});

await step('prelievo: due richieste insieme -> ne passa una sola', async () => {
  const req = () => call('/api/withdraw', { initData: initData(bruno), method: 'paypal', destination: 'bruno@example.com' });
  const [r1, r2] = await Promise.all([req(), req()]);
  const ok = [r1, r2].filter((r) => r.status === 200);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].data.amountCents, 3780);
  const me = await call('/api/me', { initData: initData(bruno) });
  assert.equal(me.data.balance.availableCents, 0);
  const msgs = await messages();
  assert.ok(msgs.some((m) => String(m.chat_id) === '111' && m.text.includes('Nuova richiesta di prelievo')));
});

await step('area admin vietata a chi non e\' admin', async () => {
  const r = await call('/api/admin/withdrawals', { initData: initData(bruno) });
  assert.equal(r.status, 403);
});

await step('admin rifiuta: importo torna nel saldo di Bruno', async () => {
  const list = await call('/api/admin/withdrawals', { initData: initData(alice) });
  assert.equal(list.data.withdrawals.length, 1);
  const id = list.data.withdrawals[0].id;
  const r = await call('/api/admin/withdrawals/update', { initData: initData(alice), id, status: 'rejected' });
  assert.equal(r.status, 200);
  const me = await call('/api/me', { initData: initData(bruno) });
  assert.equal(me.data.balance.availableCents, 3780);
  const again = await call('/api/admin/withdrawals/update', { initData: initData(alice), id, status: 'paid' });
  assert.equal(again.status, 409);
});

await step('nuova richiesta e admin la segna pagata', async () => {
  const w = await call('/api/withdraw', { initData: initData(bruno), method: 'buono_regalo', destination: 'bruno@example.com' });
  assert.equal(w.status, 200);
  const list = await call('/api/admin/withdrawals', { initData: initData(alice) });
  const r = await call('/api/admin/withdrawals/update', { initData: initData(alice), id: list.data.withdrawals[0].id, status: 'paid' });
  assert.equal(r.status, 200);
  const me = await call('/api/me', { initData: initData(bruno) });
  assert.equal(me.data.balance.availableCents, 0);
  assert.equal(me.data.withdrawals[0].status, 'paid');
  const msgs = await messages();
  assert.ok(msgs.some((m) => String(m.chat_id) === '222' && m.text.includes('inviato')));
});

await step('webhook bot: /start risponde con il pulsante della Mini App', async () => {
  const update = { message: { message_id: 1, chat: { id: 333 }, from: { id: 333, first_name: 'Carla' }, text: `/start ref_${aliceCode}` } };
  const bad = await fetch(API + '/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) });
  assert.equal(bad.status, 404);
  const res = await fetch(API + '/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'local-webhook-secret' },
    body: JSON.stringify(update),
  });
  assert.equal(res.status, 200);
  const msgs = await messages();
  const m = msgs.find((x) => String(x.chat_id) === '333');
  assert.equal(m.reply_markup.inline_keyboard[0][0].web_app.url, 'https://alelimpo.github.io/cashback-bot-app/');
});

await step('segnalazione negozio: salvata, avviso Telegram ed email con il programma Awin trovato', async () => {
  const before = (await messages()).length;
  const r = await call('/api/store-request', { initData: initData(bruno), storeName: 'Zalando', website: 'https://www.zalando.it/scarpe-uomo/', note: 'Compro spesso scarpe' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'new');
  assert.equal(r.data.comingSoon, null);
  await sleep(800);
  const msg = (await messages()).slice(before).find((m) => String(m.chat_id) === '111' && m.text && m.text.includes('Zalando'));
  assert.ok(msg, 'avviso all\'admin su Telegram');
  assert.ok(msg.text.includes('Sito: zalando.it'));
  assert.ok(msg.text.includes('merchant-profile/99001'), 'link al programma Awin trovato');
  assert.ok(!msg.text.includes('Myprotein'));
  const mail = (await emails()).find((e) => e.subject === 'Segnalazione negozio: Zalando');
  assert.ok(mail, 'email inviata');
  assert.deepEqual(mail.to, ['admin@example.com']);
  assert.ok(mail.text.includes('Compro spesso scarpe'));
});

await step('segnalazione: doppioni, negozi gia\' presenti e dati non validi', async () => {
  let r = await call('/api/store-request', { initData: initData(bruno), storeName: 'zalando.it' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'already_requested');
  r = await call('/api/store-request', { initData: initData(bruno), storeName: 'Douglas' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'store_available');
  r = await call('/api/store-request', { initData: initData(bruno), storeName: 'Negozio', website: 'non è un sito' });
  assert.equal(r.status, 400);
  r = await call('/api/store-request', { initData: initData(bruno), storeName: 'x' });
  assert.equal(r.status, 400);
  // Unieuro e' nel catalogo ma Awin non l'ha ancora approvato: "in arrivo".
  r = await call('/api/store-request', { initData: initData(bruno), storeName: 'Unieuro' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'working');
  assert.equal(r.data.comingSoon, 'Unieuro');
});

await step('segnalazione: massimo 5 al giorno per utente', async () => {
  for (const name of ['Ikea', 'Lidl', 'Decathlon']) {
    const r = await call('/api/store-request', { initData: initData(bruno), storeName: name });
    assert.equal(r.status, 200, name);
  }
  const r = await call('/api/store-request', { initData: initData(bruno), storeName: 'Leroy Merlin' });
  assert.equal(r.status, 429);
});

await step('admin: segnalazioni raggruppate per negozio, risposta a tutti via bot', async () => {
  let r = await call('/api/store-request', { initData: initData(alice), storeName: 'ZALANDO' });
  assert.equal(r.status, 200);
  r = await call('/api/admin/store-requests', { initData: initData(bruno) });
  assert.equal(r.status, 403);
  r = await call('/api/admin/store-requests', { initData: initData(alice) });
  assert.equal(r.status, 200);
  const z = r.data.requests.find((g) => g.key === 'zalando');
  assert.equal(z.users, 2);
  assert.equal(r.data.requests[0].key, 'zalando', 'prima i negozi piu\' richiesti');
  assert.deepEqual(z.websites, ['zalando.it']);
  assert.equal(z.awinMatches[0].id, 99001);
  assert.match(z.awinMatches[0].url, /merchant-profile\/99001$/);
  assert.ok(z.notes.some((n) => n.includes('Compro spesso scarpe')));

  r = await call('/api/admin/store-requests/update', { initData: initData(alice), key: 'zalando', status: 'alternative' });
  assert.equal(r.status, 400, 'per un\'alternativa serve il testo');
  const before = (await messages()).length;
  r = await call('/api/admin/store-requests/update', { initData: initData(alice), key: 'zalando', status: 'alternative', reply: 'Per le scarpe trovi adidas nella Mini App.' });
  assert.equal(r.status, 200);
  assert.equal(r.data.notified, 2);
  await sleep(500);
  const sent = (await messages()).slice(before);
  assert.ok(sent.some((m) => String(m.chat_id) === '222' && m.text.includes('Zalando') && m.text.includes('adidas')));
  assert.ok(sent.some((m) => String(m.chat_id) === '111' && m.text.includes('adidas')));
  const me = await call('/api/me', { initData: initData(bruno) });
  const mine = me.data.storeRequests.find((x) => x.storeName === 'Zalando');
  assert.equal(mine.status, 'alternative');
  assert.equal(mine.reply, 'Per le scarpe trovi adidas nella Mini App.');
  r = await call('/api/admin/store-requests', { initData: initData(alice) });
  assert.equal(r.data.requests.find((g) => g.key === 'zalando'), undefined, 'chiusa');
});

await step('configurazione admin: webhook, pulsante menu e indirizzo Awin', async () => {
  const denied = await call('/api/admin/setup', { initData: initData(bruno) });
  assert.equal(denied.status, 403);
  const r = await call('/api/admin/setup', { initData: initData(alice) });
  assert.equal(r.status, 200);
  assert.equal(r.data.awinNotifyUrl, `${API}/awin/notify/${NOTIFY_SECRET}`);
  assert.equal(r.data.telegram.webhook.ok, true);
  assert.equal(r.data.telegram.menuButton.ok, true);
  assert.equal(r.data.checks.awinApiToken, true);
  assert.equal(r.data.checks.email.ok, true);
  assert.ok((await emails()).some((e) => e.subject === 'Cashback Bot: email di prova'));
  assert.equal(r.data.checks.activeStores, 3);
  assert.ok(r.data.lastSync && r.data.lastSync.synced >= 1, 'ultima sincronizzazione registrata');
  const msgs = await messages();
  const hook = msgs.find((m) => m.method === 'setWebhook');
  assert.equal(hook.url, `${API}/telegram/webhook`);
  assert.equal(hook.secret_token, 'local-webhook-secret');
  const menu = msgs.find((m) => m.method === 'setChatMenuButton');
  assert.equal(menu.menu_button.web_app.url, 'https://alelimpo.github.io/cashback-bot-app/');
});

await step('cron: negozi accesi e spenti da soli in base alle iscrizioni Awin', async () => {
  const before = (await messages()).length;
  // Approvati Unieuro, Italo e zooplus (seconda ondata), Temu chiuso; Ikea approvato ma non nel catalogo.
  await setPrograms({
    ...PROGRAMS,
    joined: [9449, 9418, 10139, 9685, 9500, 88888],
    rejected: [9690, 12427], // JD Sports e Tiqets rifiutano
    info: { 88888: { name: 'Ikea IT', primarySector: 'Home & Garden', displayUrl: 'https://www.ikea.com/it/it/', validDomains: [{ domain: '*.ikea.com' }] } },
    groups: { ...PROGRAMS.groups, 88888: [{ groupId: 9, groupCode: 'DEFAULT', groupName: 'Default', type: 'percentage', percentage: 3 }] },
  });
  await runCron();
  const r = await call('/api/me', { initData: initData(bruno) });
  const ids = r.data.stores.map((s) => s.id).sort();
  // zooplus e' attivo ma senza commissioni lette da Awin: resta nascosto finche' non arrivano.
  assert.deepEqual(ids, ['douglas', 'ikea', 'italo', 'unieuro', 'vodafone']);
  const ikea = r.data.stores.find((s) => s.id === 'ikea');
  assert.equal(ikea.name, 'Ikea');
  assert.equal(ikea.category, 'Casa');
  assert.deepEqual(ikea.domains, ['ikea.com']);
  assert.equal(ikea.cashbackLabel, '1,8%');
  const zoo = (await call('/api/link', { initData: initData(bruno), storeId: 'zooplus' }));
  assert.equal(zoo.status, 200, 'zooplus e\' attivo anche se non ancora in elenco');
  const unieuro = r.data.stores.find((s) => s.id === 'unieuro');
  assert.deepEqual(unieuro.rates.map((x) => [x.label, x.youGet]), [
    ['Elettrodomestici (consegna a casa)', '2,4%'],
    ['Elettrodomestici (ritiro in negozio)', '1,2%'],
    ['Garanzie ed estensioni', '0%'],
  ]);
  assert.equal(unieuro.rules.appTracking, false);
  assert.equal(unieuro.rules.cookieDays, 30);
  assert.ok(unieuro.rules.declineReasons.includes('non sei un nuovo cliente del negozio'));
  const msgs = (await messages()).slice(before);
  assert.ok(msgs.some((m) => String(m.chat_id) === '111' && m.text.includes('Awin ti ha approvato') && m.text.includes('Unieuro')));
  assert.ok(msgs.some((m) => String(m.chat_id) === '111' && m.text.includes('Aggiunti da soli al catalogo: Ikea')));
  assert.ok(msgs.some((m) => String(m.chat_id) === '111' && m.text.includes('Richiesta rifiutata su Awin') && m.text.includes('JD Sports') && m.text.includes('Tiqets')));
  // Un negozio che ha rifiutato non e' "in arrivo" per chi lo segnala.
  const jd = await call('/api/store-request', { initData: initData(alice), storeName: 'JD Sports' });
  assert.equal(jd.status, 200);
  assert.equal(jd.data.status, 'new');
  assert.equal(jd.data.comingSoon, null);
  const setup = await call('/api/admin/setup', { initData: initData(alice) });
  assert.equal(setup.data.checks.programmes.joined, 6);
  assert.equal(setup.data.checks.programmes.rejected, 2);
  // Al giro successivo nessun nuovo avviso di rifiuto.
  const n = (await messages()).length;
  await runCron();
  assert.ok(!(await messages()).slice(n).some((m) => m.text && m.text.includes('Richiesta rifiutata')));
  // Bruno aveva segnalato Ikea: ora c'e'.
  assert.ok(msgs.some((m) => String(m.chat_id) === '222' && m.text.includes('Ikea è ora nella Mini App')));
  assert.ok(msgs.some((m) => String(m.chat_id) === '111' && m.text.includes('Temu')));
  // Bruno aveva segnalato Unieuro: ora e' approvato e il bot glielo dice.
  assert.ok(msgs.some((m) => String(m.chat_id) === '222' && m.text.includes('Unieuro è ora nella Mini App')));
  const req = (await call('/api/me', { initData: initData(bruno) })).data.storeRequests.find((x) => x.storeName === 'Unieuro');
  assert.equal(req.status, 'added');
  assert.match(unieuro.logo, /^https:\/\/ui\.awin\.com\//);
});

await step('Italo non accetta link a una pagina: si apre la home', async () => {
  const r = await call('/api/link', { initData: initData(bruno), storeId: 'italo', url: 'https://www.italotreno.it/it/offerte' });
  assert.equal(r.status, 200);
  const u = new URL(r.data.url);
  assert.equal(u.searchParams.get('awinmid'), '9685');
  assert.equal(u.searchParams.get('ued'), null);
  const me = await call('/api/me', { initData: initData(bruno) });
  assert.equal(me.data.stores.find((s) => s.id === 'italo').productLinks, false);
});

await step('elenco negozi pubblico senza login', async () => {
  const r = await call('/api/stores');
  assert.equal(r.status, 200);
  assert.ok(r.data.stores.length >= 3);
});

console.log(`\nTutti i ${passed} test superati.`);
