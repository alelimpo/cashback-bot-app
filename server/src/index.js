// Cashback Bot - backend su Cloudflare Workers + D1 (piano gratuito).
//
// Cosa fa:
//  - verifica che le richieste arrivino davvero dalla Mini App Telegram (firma initData)
//  - mostra il catalogo dei negozi attivi e crea link Awin con un clickref per ogni clic
//  - riceve le notifiche di vendita da Awin e le collega all'utente tramite il clickref
//  - ogni ora legge le transazioni dall'API Awin e aggiorna stati e pagamenti
//  - calcola i saldi (in attesa / disponibile), gestisce inviti e richieste di prelievo
//
// Regola di sicurezza principale: il saldo diventa prelevabile solo quando l'API Awin
// conferma che la transazione e' approvata E pagata a te. Una notifica falsa resta
// "in attesa" per sempre e non genera mai denaro prelevabile.

const MAX_INITDATA_AGE_SEC = 24 * 60 * 60;
const SYNC_WINDOW_DAYS = 30; // l'API Awin accetta al massimo 31 giorni per richiesta
const MAX_ID_LOOKUPS_PER_RUN = 4; // l'API Awin permette 20 chiamate al minuto
const IDS_PER_LOOKUP = 50;
const STORE_REFRESH_PER_RUN = 4; // 2 chiamate per negozio: totale per esecuzione sotto le 20
const STORE_REFRESH_HOURS = 24;
const WITHDRAW_METHODS = ['paypal', 'buono_regalo'];
const PAYOUT_WORKING_DAYS = 7;

// Motivi di rifiuto letti dai termini Awin di ogni negozio, in italiano.
const DECLINE_REASONS_IT = {
  returned: 'ordine reso',
  partially_returned: 'ordine reso in parte (il cashback si riduce)',
  cancelled: 'ordine annullato o non pagato',
  not_new_customer: 'non sei un nuovo cliente del negozio',
  coupon: 'hai usato un codice sconto non autorizzato',
  other_partner: "l'ultimo clic prima dell'acquisto è di un altro sito",
  min_order: "l'ordine non raggiunge l'importo minimo",
  not_fulfilled: "l'ordine non è stato evaso",
  credit_check: 'la verifica di pagamento non è andata a buon fine',
};

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      // Endpoint chiamati da Awin e da Telegram: niente CORS, protetti da un segreto.
      if (url.pathname.startsWith('/awin/notify/')) return await handleAwinNotify(request, env, url, ctx);
      if (url.pathname === '/telegram/webhook') return await handleTelegramWebhook(request, env);

      let res;
      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/health': res = json({ ok: true }); break;
        case 'GET /api/stores': res = json({ stores: await listStores(env), program: programInfo(env) }); break;
        case 'POST /api/me': res = await handleMe(request, env); break;
        case 'POST /api/link': res = await handleLink(request, env); break;
        case 'POST /api/withdraw': res = await handleWithdraw(request, env, ctx); break;
        case 'POST /api/admin/withdrawals': res = await handleAdminList(request, env); break;
        case 'POST /api/admin/withdrawals/update': res = await handleAdminUpdate(request, env, ctx); break;
        case 'POST /api/admin/setup': res = await handleAdminSetup(request, env); break;
        default: res = json({ error: 'not_found' }, 404);
      }
      return withHeaders(res, cors);
    } catch (err) {
      if (err instanceof HttpError) return withHeaders(json({ error: err.code }, err.status), cors);
      console.error('Errore non gestito', err && err.stack ? err.stack : err);
      return withHeaders(json({ error: 'server_error' }, 500), cors);
    }
  },

  async scheduled(controller, env, ctx) {
    const run = async (key, fn) => {
      try {
        const result = await fn(env);
        await saveSetting(env, key, { at: new Date().toISOString(), ...result });
      } catch (err) {
        console.error(`${key} fallita`, err);
        await saveSetting(env, key, { at: new Date().toISOString(), error: String(err && err.message ? err.message : err) });
      }
    };
    ctx.waitUntil(run('last_sync', syncAwin).then(() => run('last_programs_sync', syncPrograms)));
  },
};

// ------------------------------------------------- segreti e impostazioni

// I segreti degli indirizzi per Awin e Telegram, se non impostati a mano,
// vengono ricavati dal token del bot: cosi' bastano due soli segreti.
export async function secretFor(env, name) {
  const explicit = String(env[name] || '');
  if (explicit.length >= 16) return explicit;
  if (!env.TELEGRAM_BOT_TOKEN) return '';
  const mac = await hmacSha256(new TextEncoder().encode(String(env.TELEGRAM_BOT_TOKEN)), `cashback-bot:${name}`);
  return toHex(mac).slice(0, 40);
}

async function saveSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, JSON.stringify(value)).run();
}

async function readSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

// ---------------------------------------------------------------- utilita'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

function corsHeaders(request, env) {
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('origin') || '';
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || '*';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function randomId(len = 16) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function toCents(value) {
  const n = typeof value === 'object' && value !== null ? Number(value.amount) : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function userShare(env) {
  const s = Number(env.USER_SHARE);
  return Number.isFinite(s) && s >= 0 && s <= 1 ? s : 0.6;
}

function eurosToCents(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : fallback;
}

function isAdmin(env, userId) {
  return String(env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(String(userId));
}

function formatPercent(n) {
  return (Math.round(n * 100) / 100).toString().replace('.', ',');
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function toNumber(v) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.').replace(/[^\d.]/g, '')) : Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? n : null;
}

function formatEuro(cents) {
  return (cents / 100).toFixed(2).replace('.', ',') + ' €';
}

function hostMatches(host, domains) {
  host = host.toLowerCase();
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'bad_request');
  }
}

// ------------------------------------------------- verifica Telegram initData
// Documentazione Telegram: "Validating data received via the Mini App".

async function hmacSha256(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyInitData(initData, botToken, nowSec = Math.floor(Date.now() / 1000)) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = await hmacSha256(new TextEncoder().encode('WebAppData'), botToken);
  const expected = toHex(await hmacSha256(secretKey, dataCheckString));
  if (!safeEqual(expected, hash.toLowerCase())) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || nowSec - authDate > MAX_INITDATA_AGE_SEC) return null;
  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user || !user.id) return null;
  return { user, startParam: params.get('start_param') || null };
}

async function authenticate(request, env) {
  const body = await readBody(request);
  const tg = await verifyInitData(String(body.initData || ''), env.TELEGRAM_BOT_TOKEN);
  if (!tg) throw new HttpError(401, 'unauthorized');
  const user = await upsertUser(env, tg.user, tg.startParam);
  return { body, user };
}

// --------------------------------------------------------------- utenti

async function upsertUser(env, tgUser, startParam) {
  const id = String(tgUser.id);
  const firstName = String(tgUser.first_name || '').slice(0, 64);
  const username = tgUser.username ? String(tgUser.username).slice(0, 64) : null;

  const existing = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (existing) {
    if (existing.first_name !== firstName || existing.username !== username) {
      await env.DB.prepare('UPDATE users SET first_name = ?, username = ? WHERE id = ?').bind(firstName, username, id).run();
    }
    return { ...existing, first_name: firstName, username };
  }

  // Nuovo utente: registra chi lo ha invitato (solo alla prima apertura).
  let referredBy = null;
  const m = /^ref_([a-z0-9]{4,16})$/.exec(String(startParam || ''));
  if (m) {
    const inviter = await env.DB.prepare('SELECT id FROM users WHERE ref_code = ?').bind(m[1]).first();
    if (inviter && inviter.id !== id) referredBy = inviter.id;
  }

  // INSERT OR IGNORE: se due richieste arrivano insieme, vince la prima.
  // Se il codice invito casuale fosse gia' usato (molto improbabile), si riprova.
  for (let attempt = 0; attempt < 5; attempt++) {
    await env.DB.prepare('INSERT OR IGNORE INTO users (id, first_name, username, ref_code, referred_by) VALUES (?, ?, ?, ?, ?)')
      .bind(id, firstName, username, randomId(8), referredBy)
      .run();
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (row) return row;
  }
  throw new Error('Impossibile creare l\'utente');
}

function refLink(env, refCode) {
  if (env.TELEGRAM_APP_LINK) return `${env.TELEGRAM_APP_LINK}?startapp=ref_${refCode}`;
  if (env.BOT_USERNAME) return `https://t.me/${env.BOT_USERNAME}?start=ref_${refCode}`;
  return null;
}

async function getBalance(env, userId) {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE((SELECT SUM(user_amount_cents) FROM transactions
                 WHERE user_id = ?1 AND status = 'approved' AND paid_to_publisher = 1), 0) AS earned,
       COALESCE((SELECT SUM(user_amount_cents) FROM transactions
                 WHERE user_id = ?1 AND (status = 'pending' OR (status = 'approved' AND paid_to_publisher = 0))), 0) AS pending,
       COALESCE((SELECT SUM(amount_cents) FROM bonuses WHERE user_id = ?1), 0) AS bonus,
       COALESCE((SELECT SUM(amount_cents) FROM withdrawals
                 WHERE user_id = ?1 AND status IN ('requested', 'paid')), 0) AS withdrawn`
  ).bind(userId).first();
  return {
    availableCents: row.earned + row.bonus - row.withdrawn,
    pendingCents: row.pending,
    bonusCents: row.bonus,
  };
}

// --------------------------------------------------------------- negozi

// Scheda negozio mostrata all'utente: ogni numero viene da Awin (commissioni per categoria,
// tempi medi, ordini approvati) o, finche' Awin non li fornisce, dalla scheda in "details".
// Le percentuali "a te" sono sempre la commissione del negozio x la quota utente (USER_SHARE).

const TECH_GROUP = /download|install|callback|lead/i;

// Nome leggibile di un gruppo di commissione Awin. "labels" (dalla scheda del negozio)
// traduce i nomi tecnici; i suffissi _HD/_SP di Unieuro diventano consegna/ritiro.
export function groupLabel(name, labels = {}) {
  const raw = String(name || '').trim();
  if (Object.prototype.hasOwnProperty.call(labels, raw)) return labels[raw];
  if (/^default$/i.test(raw)) return labels.Default || 'Tutti gli altri prodotti';
  let suffix = '';
  let base = raw;
  const m = /^(.*?)[_ ](HD|SP)$/i.exec(raw);
  if (m) {
    base = m[1];
    suffix = m[2].toUpperCase() === 'HD' ? ' (consegna a casa)' : ' (ritiro in negozio)';
  }
  const pretty = Object.prototype.hasOwnProperty.call(labels, base)
    ? labels[base]
    : base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return pretty + suffix;
}

function rateEntry(label, type, value, currency, ctx) {
  if (type === 'fixed') {
    const storeCents = toEurCents(Math.round(value * 100), currency || 'EUR', ctx.env);
    const userCents = ctx.fixedOverride != null ? Math.min(ctx.fixedOverride, storeCents) : Math.floor(storeCents * ctx.share);
    return { label, type, storePays: formatEuro(storeCents), youGet: formatEuro(userCents), sortValue: storeCents, userValue: userCents };
  }
  const user = value * ctx.share;
  return { label, type: 'percent', storePays: `${formatPercent(value)}%`, youGet: `${formatPercent(user)}%`, sortValue: value, userValue: user };
}

export function buildStoreView(s, env) {
  const share = userShare(env);
  const details = parseJson(s.details, {});
  const info = parseJson(s.awin_info, null);
  const labels = details.labels || {};
  const hidden = new Set(details.hideGroups || []);
  const ctx = { env, share, fixedOverride: s.user_fixed_cents };

  const fromAwin = !!(info && Array.isArray(info.groups) && info.groups.length);
  const groups = fromAwin ? info.groups : Array.isArray(details.groups) && details.groups.length ? details.groups : null;
  let rates = [];
  let defaultRate = null;
  if (groups) {
    for (const g of groups) {
      const name = String(g.groupName || g.groupCode || '');
      if (hidden.has(name) || hidden.has(String(g.groupCode || ''))) continue;
      const fixed = g.type === 'fix';
      const value = toNumber(fixed ? g.amount : g.percentage);
      if (value === null || (value === 0 && TECH_GROUP.test(name))) continue;
      const entry = rateEntry(groupLabel(name, labels), fixed ? 'fixed' : 'percent', value, fixed ? g.currency : null, ctx);
      if (/^default$/i.test(name)) defaultRate = entry; else rates.push(entry);
    }
  } else if (Array.isArray(details.rates) && details.rates.length) {
    for (const r of details.rates) rates.push(rateEntry(r.label, r.type || 'percent', Number(r.value), r.currency || 'EUR', ctx));
  } else {
    rates.push(rateEntry('Tutti i prodotti', s.rate_type, Number(s.rate_max), 'EUR', ctx));
  }
  // Stessa etichetta e stessa percentuale: una riga sola. Prima le piu' alte, "tutti gli altri" in fondo.
  const seen = new Set();
  rates = rates.filter((r) => {
    const k = `${r.label}|${r.youGet}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (a.type === b.type ? b.sortValue - a.sortValue : a.type === 'percent' ? -1 : 1));
  if (defaultRate) rates.push(defaultRate);

  const percents = rates.filter((r) => r.type === 'percent' && r.userValue > 0).map((r) => r.userValue);
  const fixeds = rates.filter((r) => r.type === 'fixed' && r.userValue > 0).map((r) => r.userValue);
  let headline;
  if (percents.length) {
    const max = Math.max(...percents);
    headline = percents.every((p) => p === max) && !fixeds.length ? `${formatPercent(max)}%` : `fino al ${formatPercent(max)}%`;
  } else if (fixeds.length) {
    const max = Math.max(...fixeds);
    headline = fixeds.every((f) => f === max) ? formatEuro(max) : `fino a ${formatEuro(max)}`;
  } else {
    headline = 'nessun cashback';
  }

  const kpi = { ...(details.kpi || {}), ...((info && info.kpi) || {}) };
  const rules = { ...(details.rules || {}) };
  if (info && typeof info.appTracking === 'boolean') rules.appTracking = info.appTracking;
  const deeplink = info && typeof info.deeplinkEnabled === 'boolean' ? info.deeplinkEnabled
    : typeof details.deeplinkEnabled === 'boolean' ? details.deeplinkEnabled : true;
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    domains: String(s.domains || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    cashbackLabel: headline,
    note: s.rate_note,
    productLinks: deeplink,
    rates: rates.map(({ label, type, storePays, youGet }) => ({ label, type, storePays, youGet })),
    timing: {
      validationDays: toNumber(kpi.validationDays),
      avgPaymentDays: toNumber(kpi.averagePaymentTime),
      approvalPercent: toNumber(kpi.approvalPercentage),
    },
    rules: {
      cookieDays: toNumber(rules.cookieDays),
      appTracking: typeof rules.appTracking === 'boolean' ? rules.appTracking : null,
      commissionBase: rules.commissionBase || null,
      declineReasons: (rules.declineReasons || []).map((k) => DECLINE_REASONS_IT[k] || k),
      notes: rules.notes || [],
    },
    source: fromAwin ? 'awin_api' : 'awin_profile',
    updatedAt: fromAwin ? s.awin_info_at : details.checkedAt || null,
  };
}

const STORE_COLUMNS = 'id, name, domains, category, rate_type, rate_max, rate_note, user_fixed_cents, details, awin_info, awin_info_at';

async function listStores(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${STORE_COLUMNS} FROM stores WHERE active = 1 ORDER BY sort, name`
  ).all();
  return results.map((s) => buildStoreView(s, env));
}

function programInfo(env) {
  return {
    userSharePercent: Math.round(userShare(env) * 100),
    minPayoutCents: eurosToCents(env.MIN_PAYOUT_EUR, 1000),
    referralBonusCents: eurosToCents(env.REFERRAL_BONUS_EUR, 0),
    payoutWorkingDays: PAYOUT_WORKING_DAYS,
  };
}

// ------------------------------------------------------------- endpoint utente

async function handleMe(request, env) {
  const { user } = await authenticate(request, env);
  const [balance, stores, txs, wds] = await Promise.all([
    getBalance(env, user.id),
    listStores(env),
    env.DB.prepare(
      `SELECT t.id, t.status, t.paid_to_publisher, t.user_amount_cents, t.transaction_date, t.created_at,
              s.name AS store_name, s.details AS store_details, s.awin_info AS store_info
         FROM transactions t LEFT JOIN stores s ON s.awin_mid = t.awin_mid
        WHERE t.user_id = ? ORDER BY COALESCE(t.transaction_date, t.created_at) DESC LIMIT 30`
    ).bind(user.id).all(),
    env.DB.prepare(
      'SELECT id, amount_cents, method, status, created_at, processed_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 10'
    ).bind(user.id).all(),
  ]);

  return json({
    user: { id: user.id, firstName: user.first_name, refCode: user.ref_code, refLink: refLink(env, user.ref_code) },
    isAdmin: isAdmin(env, user.id),
    balance: { ...balance, minPayoutCents: eurosToCents(env.MIN_PAYOUT_EUR, 1000) },
    referralBonusCents: eurosToCents(env.REFERRAL_BONUS_EUR, 0),
    program: programInfo(env),
    stores,
    transactions: txs.results.map((t) => {
      const state = t.status === 'pending' ? 'pending'
        : t.status === 'approved' ? (t.paid_to_publisher ? 'available' : 'approved')
        : 'cancelled';
      return {
        id: t.id,
        store: t.store_name || 'Negozio',
        amountCents: t.user_amount_cents,
        date: t.transaction_date,
        state,
        expectedAvailableAt: state === 'pending' || state === 'approved' ? expectedDate(t) : null,
      };
    }),
    withdrawals: wds.results,
  });
}

// Data indicativa in cui il cashback diventa prelevabile: data dell'acquisto + tempo
// medio di pagamento del negozio secondo Awin. E' una media, non una promessa.
function expectedDate(t) {
  const kpi = { ...((parseJson(t.store_details, {}) || {}).kpi || {}), ...((parseJson(t.store_info, null) || {}).kpi || {}) };
  const days = toNumber(kpi.averagePaymentTime);
  const base = Date.parse(String(t.transaction_date || t.created_at || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(t.transaction_date || '')) ? '' : 'Z'));
  if (!days || !Number.isFinite(base)) return null;
  return new Date(base + days * 86400 * 1000).toISOString().slice(0, 10);
}

async function handleLink(request, env) {
  const { body, user } = await authenticate(request, env);
  const store = await env.DB.prepare('SELECT * FROM stores WHERE id = ? AND active = 1').bind(String(body.storeId || '')).first();
  if (!store) throw new HttpError(404, 'store_not_found');

  // Alcuni negozi (es. Italo) non accettano link a una pagina precisa: si apre la home.
  const view = buildStoreView(store, env);
  let destination = null;
  if (body.url && view.productLinks) {
    let parsed;
    try {
      parsed = new URL(String(body.url).trim());
    } catch {
      throw new HttpError(400, 'invalid_url');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'invalid_url');
    const domains = store.domains.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (!hostMatches(parsed.hostname, domains)) throw new HttpError(400, 'url_not_for_store');
    destination = parsed.toString();
  }

  // Limite semplice contro gli abusi: massimo 20 link al minuto per utente.
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM clicks WHERE user_id = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(user.id).first();
  if (recent.n >= 20) throw new HttpError(429, 'rate_limited');

  const clickId = randomId(16);
  await env.DB.prepare('INSERT INTO clicks (id, user_id, store_id, dest_url) VALUES (?, ?, ?, ?)')
    .bind(clickId, user.id, store.id, destination)
    .run();

  const link = new URL('https://www.awin1.com/cread.php');
  link.searchParams.set('awinmid', String(store.awin_mid));
  link.searchParams.set('awinaffid', String(env.AWIN_PUBLISHER_ID));
  link.searchParams.set('clickref', clickId);
  if (destination) link.searchParams.set('ued', destination);
  return json({ url: link.toString() });
}

async function handleWithdraw(request, env, ctx) {
  const { body, user } = await authenticate(request, env);
  const method = String(body.method || '');
  const destination = String(body.destination || '').trim().slice(0, 254);
  if (!WITHDRAW_METHODS.includes(method)) throw new HttpError(400, 'invalid_method');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) throw new HttpError(400, 'invalid_destination');

  const balance = await getBalance(env, user.id);
  const minCents = eurosToCents(env.MIN_PAYOUT_EUR, 1000);
  if (balance.availableCents < minCents) throw new HttpError(400, 'below_minimum');

  // Una sola richiesta aperta per utente, anche con due clic contemporanei.
  const res = await env.DB.prepare(
    `INSERT INTO withdrawals (user_id, amount_cents, method, destination)
     SELECT ?1, ?2, ?3, ?4
      WHERE NOT EXISTS (SELECT 1 FROM withdrawals WHERE user_id = ?1 AND status = 'requested')`
  ).bind(user.id, balance.availableCents, method, destination).run();
  if (!res.meta || res.meta.changes === 0) throw new HttpError(409, 'request_pending');

  const who = user.username ? `@${user.username}` : user.first_name || user.id;
  const text = `Nuova richiesta di prelievo\n${who} (ID ${user.id})\nImporto: ${formatEuro(balance.availableCents)}\nMetodo: ${method}\nDestinatario: ${destination}`;
  ctx.waitUntil(notifyAdmins(env, text));
  return json({ ok: true, amountCents: balance.availableCents });
}

// -------------------------------------------------------------- endpoint admin

async function requireAdmin(request, env) {
  const auth = await authenticate(request, env);
  if (!isAdmin(env, auth.user.id)) throw new HttpError(403, 'forbidden');
  return auth;
}

async function handleAdminList(request, env) {
  await requireAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.user_id, w.amount_cents, w.method, w.destination, w.created_at, u.first_name, u.username
       FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.status = 'requested' ORDER BY w.id`
  ).all();
  return json({ withdrawals: results });
}

async function handleAdminUpdate(request, env, ctx) {
  const { body } = await requireAdmin(request, env);
  const id = Number(body.id);
  const status = String(body.status || '');
  if (!Number.isInteger(id) || !['paid', 'rejected'].includes(status)) throw new HttpError(400, 'bad_request');
  const row = await env.DB.prepare('SELECT * FROM withdrawals WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'not_found');
  const res = await env.DB.prepare(
    "UPDATE withdrawals SET status = ?, processed_at = datetime('now') WHERE id = ? AND status = 'requested'"
  ).bind(status, id).run();
  if (!res.meta || res.meta.changes === 0) throw new HttpError(409, 'already_processed');

  const text = status === 'paid'
    ? `Il tuo prelievo di ${formatEuro(row.amount_cents)} e' stato inviato. Grazie per usare il bot!`
    : `La tua richiesta di prelievo di ${formatEuro(row.amount_cents)} non e' andata a buon fine: l'importo e' tornato nel saldo. Scrivici se hai domande.`;
  ctx.waitUntil(tgSend(env, row.user_id, text));
  return json({ ok: true });
}

// Configurazione in un tocco dall'area admin: collega il webhook del bot, imposta il
// pulsante menu che apre la Mini App e restituisce l'indirizzo da incollare in Awin.
async function handleAdminSetup(request, env) {
  await requireAdmin(request, env);
  const origin = new URL(request.url).origin;
  const webhookSecret = await secretFor(env, 'TELEGRAM_WEBHOOK_SECRET');
  const notifySecret = await secretFor(env, 'NOTIFY_SECRET');

  const webhook = await tgCall(env, 'setWebhook', {
    url: `${origin}/telegram/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ['message'],
  });
  const menuButton = env.MINI_APP_URL
    ? await tgCall(env, 'setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Cashback', web_app: { url: env.MINI_APP_URL } },
      })
    : { ok: false, description: 'MINI_APP_URL non impostato' };

  return json({
    awinNotifyUrl: notifySecret ? `${origin}/awin/notify/${notifySecret}` : null,
    telegram: {
      webhook: { ok: !!webhook.ok, description: webhook.description || null },
      menuButton: { ok: !!menuButton.ok, description: menuButton.description || null },
    },
    checks: {
      awinApiToken: !!env.AWIN_API_TOKEN,
      botUsername: env.BOT_USERNAME || null,
      activeStores: (await env.DB.prepare('SELECT COUNT(*) AS n FROM stores WHERE active = 1').first()).n,
    },
    lastSync: await readSetting(env, 'last_sync'),
    lastProgramsSync: await readSetting(env, 'last_programs_sync'),
  });
}

// --------------------------------------------------- transazioni: scrittura

// Inserisce o aggiorna una transazione. user_id e importo fisso vengono letti dal clic
// e dal negozio; la quota utente resta quella in vigore al primo inserimento.
function upsertStatement(env, tx, { authoritative }) {
  const insert = `
    INSERT INTO transactions (id, click_id, user_id, awin_mid, sale_amount_cents, commission_cents, currency,
                              status, paid_to_publisher, user_share, user_fixed_cents, user_amount_cents, transaction_date)
    SELECT ?1, ?2, (SELECT user_id FROM clicks WHERE id = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, f.fixed,
           CASE WHEN f.fixed IS NOT NULL THEN MIN(f.fixed, ?5) ELSE CAST(?5 * ?9 AS INTEGER) END, ?10
      FROM (SELECT COALESCE((SELECT s.user_fixed_cents FROM clicks c JOIN stores s ON s.id = c.store_id WHERE c.id = ?2),
                            (SELECT user_fixed_cents FROM stores WHERE awin_mid = ?3)) AS fixed) AS f
     WHERE true`;
  const onConflict = authoritative
    ? `
    ON CONFLICT(id) DO UPDATE SET
      click_id          = COALESCE(transactions.click_id, excluded.click_id),
      user_id           = COALESCE(transactions.user_id, excluded.user_id),
      awin_mid          = excluded.awin_mid,
      sale_amount_cents = excluded.sale_amount_cents,
      commission_cents  = excluded.commission_cents,
      currency          = excluded.currency,
      status            = excluded.status,
      paid_to_publisher = excluded.paid_to_publisher,
      user_amount_cents = CASE WHEN transactions.user_fixed_cents IS NOT NULL
                               THEN MIN(transactions.user_fixed_cents, excluded.commission_cents)
                               ELSE CAST(excluded.commission_cents * transactions.user_share AS INTEGER) END,
      transaction_date  = COALESCE(excluded.transaction_date, transactions.transaction_date),
      updated_at        = datetime('now')`
    : ' ON CONFLICT(id) DO NOTHING';
  return env.DB.prepare(insert + onConflict).bind(
    tx.id, tx.clickRef, tx.mid, tx.saleCents, tx.commissionCents, tx.currency,
    tx.status, tx.paid, userShare(env), tx.date
  );
}

function normalizeStatus(s) {
  const v = String(s || 'pending').toLowerCase();
  return ['pending', 'approved', 'declined', 'deleted'].includes(v) ? v : 'pending';
}

// Alcuni programmi (es. Temu) pagano in dollari: gli importi vengono convertiti in euro
// con il cambio impostato in FX_TO_EUR. Una valuta senza cambio vale 0 finche' non lo aggiungi.
export function toEurCents(cents, currency, env) {
  const cur = String(currency || 'EUR').toUpperCase();
  if (cur === 'EUR') return cents;
  let rates = {};
  try { rates = JSON.parse(env.FX_TO_EUR || '{}'); } catch { rates = {}; }
  const rate = Number(rates[cur]);
  if (!Number.isFinite(rate) || rate <= 0) {
    console.warn(`Valuta ${cur} senza cambio in FX_TO_EUR: importo trattato come 0`);
    return 0;
  }
  return Math.floor(cents * rate);
}

function normalizeApiTransaction(t, env) {
  const clickRefs = t.clickRefs && typeof t.clickRefs === 'object' ? t.clickRefs : {};
  const currency = (t.commissionAmount && t.commissionAmount.currency) || t.currency || 'EUR';
  const saleCurrency = (t.saleAmount && t.saleAmount.currency) || currency;
  return {
    id: String(t.id),
    clickRef: clickRefs.clickRef || t.clickRef || null,
    mid: Number(t.advertiserId) || null,
    saleCents: toEurCents(toCents(t.saleAmount), saleCurrency, env),
    commissionCents: toEurCents(toCents(t.commissionAmount), currency, env),
    currency,
    status: normalizeStatus(t.commissionStatus),
    paid: t.paidToPublisher === true || t.paidToPublisher === 1 || t.paidToPublisher === 'true' ? 1 : 0,
    date: t.transactionDate ? String(t.transactionDate) : null,
  };
}

// ------------------------------------------------- notifiche push da Awin

async function handleAwinNotify(request, env, url, ctx) {
  const secret = await secretFor(env, 'NOTIFY_SECRET');
  if (secret.length < 16 || url.pathname !== `/awin/notify/${secret}`) return new Response('Not found', { status: 404 });

  let data = {};
  if (request.method === 'GET') {
    data = Object.fromEntries(url.searchParams);
  } else if (request.method === 'POST') {
    const type = request.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      data = await request.json().catch(() => ({}));
    } else {
      const form = await request.formData().catch(() => null);
      const raw = form && form.get('AwinTransactionPush');
      if (raw) {
        try { data = JSON.parse(String(raw)); } catch { data = {}; }
      } else if (form) {
        data = Object.fromEntries(form);
      }
    }
  } else {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!data.transactionId) return new Response('Missing transactionId', { status: 400 });
  if (data.affiliateId && String(data.affiliateId) !== String(env.AWIN_PUBLISHER_ID)) {
    return new Response('Wrong publisher', { status: 400 });
  }

  const tx = {
    id: String(data.transactionId),
    clickRef: data.clickRef ? String(data.clickRef) : null,
    mid: Number(data.merchantId) || null,
    saleCents: toEurCents(toCents(data.transactionAmount), data.transactionCurrency, env),
    commissionCents: toEurCents(toCents(data.commission), data.transactionCurrency, env),
    currency: data.transactionCurrency || 'EUR',
    status: 'pending', // la notifica crea solo cashback "in attesa"
    paid: 0,
    date: data.transactionDate ? String(data.transactionDate).replace(' ', 'T') : null,
  };
  const res = await upsertStatement(env, tx, { authoritative: false }).run();

  if (res.meta && res.meta.changes > 0) {
    const row = await env.DB.prepare(
      `SELECT t.user_id, t.user_amount_cents, s.name AS store_name
         FROM transactions t LEFT JOIN stores s ON s.awin_mid = t.awin_mid WHERE t.id = ?`
    ).bind(tx.id).first();
    if (row && row.user_id) {
      ctx.waitUntil(tgSend(env, row.user_id,
        `Abbiamo registrato il tuo acquisto da ${row.store_name || 'un negozio partner'}: ${formatEuro(row.user_amount_cents)} di cashback in attesa. Diventa prelevabile quando il negozio conferma l'ordine e Awin ci paga.`));
    }
  }
  return new Response('OK', { status: 200 });
}

// ------------------------------------------- sincronizzazione oraria con Awin

function awinDate(d) {
  return d.toISOString().slice(0, 19);
}

async function awinGetJson(env, path, params) {
  const base = env.AWIN_API_BASE || 'https://api.awin.com';
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { authorization: `Bearer ${env.AWIN_API_TOKEN}`, accept: 'application/json' } });
  if (!res.ok) throw new Error(`Awin API ${res.status} su ${path}`);
  return res.json();
}

async function awinGet(env, path, params) {
  const data = await awinGetJson(env, path, params);
  return Array.isArray(data) ? data : [];
}

// Catalogo automatico: un negozio compare nella Mini App solo quando Awin ti ha
// approvato nel suo programma, e sparisce se l'iscrizione viene chiusa o sospesa.
// Per i negozi attivi, una volta al giorno legge da Awin commissioni per categoria e tempi medi.
export async function syncPrograms(env) {
  if (!env.AWIN_API_TOKEN || !env.AWIN_PUBLISHER_ID) return { skipped: true };
  const pub = String(env.AWIN_PUBLISHER_ID);

  const joined = await awinGet(env, `/publishers/${pub}/programmes`, { relationship: 'joined' });
  const joinedIds = new Set(joined.map((p) => Number(p.id)).filter(Boolean));
  const { results: stores } = await env.DB.prepare('SELECT id, name, awin_mid, active, awin_info_at FROM stores').all();

  const turnedOn = [];
  const turnedOff = [];
  if (String(env.AUTO_ACTIVATE_STORES || 'true') !== 'false') {
    for (const s of stores) {
      const want = joinedIds.has(Number(s.awin_mid)) ? 1 : 0;
      if (want === s.active) continue;
      await env.DB.prepare('UPDATE stores SET active = ? WHERE id = ?').bind(want, s.id).run();
      s.active = want;
      (want ? turnedOn : turnedOff).push(s.name);
    }
  }
  if (turnedOn.length) await notifyAdmins(env, `Awin ti ha approvato: ${turnedOn.join(', ')}. Ora ${turnedOn.length === 1 ? 'è visibile' : 'sono visibili'} nella Mini App.`);
  if (turnedOff.length) await notifyAdmins(env, `Iscrizione non più attiva su Awin: ${turnedOff.join(', ')}. ${turnedOff.length === 1 ? 'Il negozio è stato nascosto' : 'I negozi sono stati nascosti'} dalla Mini App.`);

  const cutoff = Date.now() - STORE_REFRESH_HOURS * 3600 * 1000;
  const due = stores
    .filter((s) => s.active && (!s.awin_info_at || Date.parse(String(s.awin_info_at).replace(' ', 'T') + 'Z') < cutoff))
    .slice(0, STORE_REFRESH_PER_RUN);
  const refreshed = [];
  const failed = [];
  for (const s of due) {
    try {
      const params = { advertiserId: String(s.awin_mid) };
      const groupsRes = await awinGetJson(env, `/publishers/${pub}/commissiongroups`, params);
      const details = await awinGetJson(env, `/publishers/${pub}/programmedetails`, { ...params, relationship: 'joined' });
      const groups = (groupsRes && Array.isArray(groupsRes.commissionGroups) ? groupsRes.commissionGroups : []).map((g) => ({
        groupCode: g.groupCode || null,
        groupName: g.groupName || g.groupCode || null,
        type: g.type === 'fix' ? 'fix' : 'percentage',
        percentage: g.percentage ?? null,
        amount: g.amount ?? null,
        currency: g.currency || null,
      }));
      const kpi = details && details.kpi ? {
        averagePaymentTime: details.kpi.averagePaymentTime ?? null,
        approvalPercentage: details.kpi.approvalPercentage ?? null,
        validationDays: details.kpi.validationDays ?? null,
      } : null;
      const p = (details && details.programmeInfo) || {};
      const tracking = Array.isArray(p.trackingTransparency) ? p.trackingTransparency : null;
      const info = {
        groups,
        kpi,
        appTracking: tracking ? tracking.includes('APP_TRACKING') : null,
        deeplinkEnabled: typeof p.deeplinkEnabled === 'boolean' ? p.deeplinkEnabled : null,
      };
      await env.DB.prepare("UPDATE stores SET awin_info = ?, awin_info_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(info), s.id).run();
      refreshed.push(s.id);
    } catch (err) {
      failed.push(`${s.id}: ${String(err && err.message ? err.message : err)}`);
    }
  }
  return { joined: joinedIds.size, turnedOn, turnedOff, refreshed, failed };
}

export async function syncAwin(env) {
  if (!env.AWIN_API_TOKEN || !env.AWIN_PUBLISHER_ID) {
    console.log('Sync Awin saltata: manca AWIN_API_TOKEN o AWIN_PUBLISHER_ID');
    return { skipped: true };
  }
  const pub = String(env.AWIN_PUBLISHER_ID);
  const end = new Date();
  const start = new Date(end.getTime() - SYNC_WINDOW_DAYS * 86400 * 1000);
  const range = { startDate: awinDate(start), endDate: awinDate(end), timezone: 'UTC' };

  const byId = new Map();
  for (const dateType of ['transaction', 'validation']) {
    const list = await awinGet(env, `/publishers/${pub}/transactions/`, { ...range, dateType });
    for (const t of list) byId.set(String(t.id), t);
  }

  // Transazioni piu' vecchie della finestra ancora "aperte": approvate ma non pagate,
  // oppure in attesa da molto. Le rileggiamo per ID.
  const { results: open } = await env.DB.prepare(
    `SELECT id FROM transactions
      WHERE (status = 'approved' AND paid_to_publisher = 0)
         OR (status = 'pending' AND COALESCE(transaction_date, created_at) < ?)
      ORDER BY updated_at LIMIT ?`
  ).bind(awinDate(start), MAX_ID_LOOKUPS_PER_RUN * IDS_PER_LOOKUP).all();
  const openIds = open.map((r) => r.id).filter((id) => !byId.has(id));
  const lookupIds = openIds.filter((id) => /^\d+$/.test(id));
  for (let i = 0; i < lookupIds.length; i += IDS_PER_LOOKUP) {
    const ids = lookupIds.slice(i, i + IDS_PER_LOOKUP).join(',');
    const list = await awinGet(env, `/publishers/${pub}/transactions`, { ids, timezone: 'UTC' });
    for (const t of list) byId.set(String(t.id), t);
  }

  // Transazioni che Awin non conosce (es. notifiche false o cancellate): una "in attesa"
  // fuori dalla finestra e assente anche nella ricerca per ID viene annullata.
  const unknown = openIds.filter((id) => !byId.has(id));
  if (unknown.length) {
    await env.DB.batch(unknown.map((id) => env.DB.prepare(
      `UPDATE transactions SET status = CASE WHEN status = 'pending' THEN 'deleted' ELSE status END,
              updated_at = datetime('now') WHERE id = ?`
    ).bind(id)));
  }

  const txs = [...byId.values()].map((t) => normalizeApiTransaction(t, env)).filter((t) => t.id && t.id !== 'undefined');
  if (txs.length === 0) {
    await grantReferralBonuses(env);
    return { synced: 0 };
  }

  // Stato precedente, per avvisare chi ha appena ricevuto saldo prelevabile.
  const before = new Map();
  for (let i = 0; i < txs.length; i += 90) {
    const chunk = txs.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT id, status, paid_to_publisher FROM transactions WHERE id IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk.map((t) => t.id)).all();
    for (const r of results) before.set(r.id, r);
  }

  await env.DB.batch(txs.map((tx) => upsertStatement(env, tx, { authoritative: true })));

  const newlyAvailable = txs.filter((t) => {
    if (!(t.status === 'approved' && t.paid === 1)) return false;
    const prev = before.get(t.id);
    return !prev || !(prev.status === 'approved' && prev.paid_to_publisher === 1);
  });
  for (let i = 0; i < newlyAvailable.length; i += 90) {
    const chunk = newlyAvailable.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT t.user_id, t.user_amount_cents, s.name AS store_name FROM transactions t
         LEFT JOIN stores s ON s.awin_mid = t.awin_mid
        WHERE t.user_id IS NOT NULL AND t.id IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk.map((t) => t.id)).all();
    for (const r of results) {
      await tgSend(env, r.user_id, `${formatEuro(r.user_amount_cents)} di cashback da ${r.store_name || 'un negozio partner'} ora sono disponibili nel tuo saldo.`);
    }
  }

  await grantReferralBonuses(env);
  return { synced: txs.length, newlyAvailable: newlyAvailable.length };
}

// Bonus a chi invita: quando l'invitato ha il primo cashback disponibile.
async function grantReferralBonuses(env) {
  const bonus = eurosToCents(env.REFERRAL_BONUS_EUR, 0);
  if (bonus <= 0) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO bonuses (user_id, amount_cents, reason, ref_user_id)
     SELECT u.referred_by, ?, 'referral', u.id FROM users u
      WHERE u.referred_by IS NOT NULL
        AND EXISTS (SELECT 1 FROM transactions t
                     WHERE t.user_id = u.id AND t.status = 'approved' AND t.paid_to_publisher = 1)`
  ).bind(bonus).run();
}

// ---------------------------------------------------------------- Telegram

async function tgSend(env, chatId, text, extra = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  try {
    await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
  } catch (err) {
    // L'utente potrebbe non aver mai avviato il bot: non e' un errore grave.
    console.log('Invio Telegram non riuscito', String(err));
  }
}

async function tgCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, description: 'TELEGRAM_BOT_TOKEN non impostato' };
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  try {
    const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, description: String(err) };
  }
}

async function notifyAdmins(env, text) {
  const ids = String(env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  await Promise.all(ids.map((id) => tgSend(env, id, text)));
}

// Webhook del bot (facoltativo): risponde a /start con il pulsante della Mini App
// e registra gli inviti arrivati con t.me/NomeBot?start=ref_CODICE.
async function handleTelegramWebhook(request, env) {
  const secret = await secretFor(env, 'TELEGRAM_WEBHOOK_SECRET');
  if (!secret || request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('Not found', { status: 404 });
  }
  const update = await request.json().catch(() => ({}));
  const msg = update.message;
  if (msg && msg.from && typeof msg.text === 'string' && msg.text.startsWith('/start')) {
    const payload = msg.text.split(/\s+/)[1] || null;
    await upsertUser(env, msg.from, payload);
    const share = Math.round(userShare(env) * 100);
    await tgSend(env, msg.chat.id,
      `Ciao! Fai la spesa online che faresti comunque, allo stesso prezzo, ma partendo da qui: così una parte dei soldi ti torna indietro.\n\nOgni negozio ci paga una commissione: il ${share}% è tuo, noi teniamo il ${100 - share}%. I tempi sono lunghi (spesso qualche mese, perché il negozio paga solo dopo aver confermato l'ordine), ma nella Mini App vedi sempre percentuali, tempi medi e regole di ogni negozio. Prelievo da ${formatEuro(eurosToCents(env.MIN_PAYOUT_EUR, 1000))} con PayPal o buono regalo.`,
      { reply_markup: { inline_keyboard: [[{ text: 'Apri Cashback Bot', web_app: { url: env.MINI_APP_URL } }]] } });
  }
  return new Response('OK');
}
