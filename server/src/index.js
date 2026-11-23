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

import CATALOG from './catalog.json';

const MAX_INITDATA_AGE_SEC = 24 * 60 * 60;
const SYNC_WINDOW_DAYS = 30; // l'API Awin accetta al massimo 31 giorni per richiesta
const MAX_ID_LOOKUPS_PER_RUN = 4; // l'API Awin permette 20 chiamate al minuto
const IDS_PER_LOOKUP = 50;
const STORE_REFRESH_PER_RUN = 4; // 2 chiamate per negozio: totale per esecuzione sotto le 20
const STORE_REFRESH_HOURS = 24;
const WITHDRAW_METHODS = ['paypal', 'buono_regalo'];
const PAYOUT_WORKING_DAYS = 7;
// Segnalazioni di negozi da aggiungere.
const MAX_STORE_REQUESTS_PER_DAY = 5;
const MAX_EMAILS_PER_DAY = 50; // il piano gratuito di Resend arriva a 100 email al giorno
const DIRECTORY_CACHE_HOURS = 24;
const OPEN_REQUEST_STATUSES = ['new', 'working'];
const REQUEST_REPLY_STATUSES = ['working', 'added', 'alternative', 'not_possible'];
// Offerte dei negozi (Offers API di Awin): lette al massimo ogni 3 ore.
const OFFERS_REFRESH_HOURS = 3;
const MAX_OFFERS = 40;
const MAX_OFFERS_PER_STORE = 3;
// Messaggi a tutti gli utenti: il piano gratuito di Workers permette 50 chiamate esterne per
// richiesta, quindi si invia a gruppi di 40 e la Mini App chiede il gruppo successivo.
const BROADCAST_BATCH = 40;

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
  product_not_eligible: 'il prodotto acquistato non dà diritto alla commissione',
  invalid_order: "il negozio non trova l'ordine o non lo considera valido",
  program_closed: "il negozio chiude il programma di affiliazione prima di confermare l'ordine",
  other: 'altri motivi previsti dai termini del negozio',
};

// Stato dei pagamenti del negozio verso Awin (il "semaforo" del profilo Awin).
// Definizioni Awin: https://success.awin.com/s/article/What-does-the-Traffic-Light-in-the-Advertiser-Payment-Status-mean
const PAYMENT_STATUS_IT = {
  green: 'Il negozio paga regolarmente il network di affiliazione (stato verde): la commissione ci arriva con il primo pagamento utile dopo la conferma.',
  amber: 'Pagamenti del negozio in stato giallo: il network di affiliazione ci paga la commissione solo dopo che il negozio ha pagato, per cui i tempi possono allungarsi.',
  red: 'Pagamenti del negozio in stato rosso: il network ci paga solo quando il negozio salda tutte le fatture arretrate. I tempi sono incerti.',
};
const PAYMENT_LEVEL_IT = {
  1: 'livello 1 di 4, rischio basso: paga con addebito diretto ma ha superato il limite di credito',
  2: 'livello 2 di 4, rischio medio: ha superato il limite della sua assicurazione sul credito',
  3: 'livello 3 di 4, rischio medio: ha fatture scadute con il network',
  4: 'livello 4 di 4, rischio alto: ha superato il limite di credito e ha fatture scadute',
};

function paymentStatusView(p) {
  if (!p || !PAYMENT_STATUS_IT[p.color]) return null;
  let text = PAYMENT_STATUS_IT[p.color];
  const level = PAYMENT_LEVEL_IT[p.level];
  if (p.color === 'amber' && level) text = text.replace('in stato giallo:', `in stato giallo (${level}):`);
  return { color: p.color, level: toNumber(p.level), text, checkedAt: p.checkedAt || null };
}

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
      if (url.pathname === '/telegram/webhook') return await handleTelegramWebhook(request, env, ctx);
      // Pagine pubbliche per i motori di ricerca.
      if (request.method === 'GET' || request.method === 'HEAD') {
        const page = await handleWeb(request, env, url);
        if (page) return page;
      }

      let res;
      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/health': res = json({ ok: true }); break;
        case 'GET /api/stores': {
          const stores = await listStores(env);
          res = json({ stores, offers: await listOffers(env, stores), program: programInfo(env) });
          break;
        }
        case 'POST /api/me': res = await handleMe(request, env); break;
        case 'POST /api/link': res = await handleLink(request, env); break;
        case 'POST /api/withdraw': res = await handleWithdraw(request, env, ctx); break;
        case 'POST /api/admin/withdrawals': res = await handleAdminList(request, env); break;
        case 'POST /api/admin/withdrawals/update': res = await handleAdminUpdate(request, env, ctx); break;
        case 'POST /api/admin/setup': res = await handleAdminSetup(request, env); break;
        case 'POST /api/admin/sync': res = await handleAdminSync(request, env); break;
        case 'POST /api/admin/stores': res = await handleAdminStores(request, env); break;
        case 'POST /api/admin/stores/visibility': res = await handleAdminStoreVisibility(request, env); break;
        case 'POST /api/store-request': res = await handleStoreRequest(request, env, ctx); break;
        case 'POST /api/admin/store-requests': res = await handleAdminStoreRequests(request, env); break;
        case 'POST /api/admin/store-requests/update': res = await handleAdminStoreRequestUpdate(request, env, ctx); break;
        case 'POST /api/admin/stats': res = await handleAdminStats(request, env); break;
        case 'POST /api/admin/broadcast': res = await handleAdminBroadcast(request, env); break;
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
    ctx.waitUntil(runSync(env));
  },
};

// Giro completo con Awin: vendite, poi programmi e negozi. Parte ogni ora dal cron
// oppure dal pulsante "Aggiorna ora" nell'area admin.
async function runSync(env, { forceOffers = false } = {}) {
  const out = {};
  for (const [key, fn] of [['last_sync', syncAwin], ['last_programs_sync', syncPrograms], ['last_offers_sync', syncOffers], ['last_channel_post', postToChannel]]) {
    let value;
    try {
      value = { at: new Date().toISOString(), ...(await fn(env, key === 'last_offers_sync' ? { force: forceOffers } : {})) };
    } catch (err) {
      console.error(`${key} fallita`, err);
      value = { at: new Date().toISOString(), error: String(err && err.message ? err.message : err) };
    }
    await saveSetting(env, key, value);
    out[key] = value;
  }
  await checkAwinAuth(env, out);
  return out;
}

// Se Awin rifiuta il token (401/403) l'admin riceve un avviso sul bot, al massimo ogni 12 ore,
// e un secondo messaggio quando il collegamento torna a funzionare.
async function checkAwinAuth(env, out) {
  const errors = Object.entries(out).filter(([k]) => k !== 'last_channel_post').map(([, v]) => (v && v.error) || '').filter(Boolean).join(' ');
  const authFailed = /Awin API (401|403)/.test(errors);
  const state = (await readSetting(env, 'awin_auth_alert')) || {};
  if (authFailed) {
    const last = state.at ? Date.parse(state.at) : 0;
    if (!state.failing || Date.now() - last > 12 * 3600 * 1000) {
      await notifyAdmins(env, "Awin non accetta più il token API del server (errore 401): vendite e nuove approvazioni non vengono lette.\n\nPer sistemare: su Awin, menu utente > API Credentials > Show my API token, copia il token; su Cloudflare, Worker cashback-bot > Impostazioni > Variabili e segreti > AWIN_API_TOKEN > Modifica, incolla e distribuisci. Poi nella Mini App premi \"Aggiorna negozi da Awin ora\".");
      await saveSetting(env, 'awin_auth_alert', { failing: true, at: new Date().toISOString() });
    }
  } else if (state.failing && !errors) {
    await notifyAdmins(env, 'Il collegamento con Awin funziona di nuovo: vendite e negozi sono aggiornati.');
    await saveSetting(env, 'awin_auth_alert', { failing: false, at: new Date().toISOString() });
  }
}

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
  const refToken = String(startParam || '').split('__').find((p) => /^ref_/.test(p)) || '';
  const m = /^ref_([a-z0-9]{4,16})$/.exec(refToken);
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
  } else if (Number(s.rate_max) > 0) {
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
    awinMid: Number(s.awin_mid) || null,
    category: s.category,
    domains: String(s.domains || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    cashbackLabel: headline,
    hasRates: rates.length > 0,
    hidden: details.hidden === true,
    note: s.rate_note,
    productLinks: deeplink,
    logo: (info && info.logoUrl) || (s.awin_mid ? `https://ui.awin.com/images/upload/merchant/profile/${s.awin_mid}.png` : null),
    rates: rates.map(({ label, type, storePays, youGet }) => ({ label, type, storePays, youGet })),
    timing: {
      validationDays: toNumber(kpi.validationDays),
      avgPaymentDays: toNumber(kpi.averagePaymentTime),
      approvalPercent: toNumber(kpi.approvalPercentage),
      autoApproveDays: toNumber(details.autoApproveDays),
      payment: paymentStatusView(details.paymentStatus),
    },
    rules: {
      cookieDays: toNumber(rules.cookieDays),
      appTracking: typeof rules.appTracking === 'boolean' ? rules.appTracking : null,
      commissionBase: rules.commissionBase || null,
      vatIncluded: typeof rules.vatIncluded === 'boolean' ? rules.vatIncluded : null,
      excludedProducts: rules.excludedProducts === true,
      declineReasons: (rules.declineReasons || []).map((k) => DECLINE_REASONS_IT[k] || k),
      notes: rules.notes || [],
    },
    source: fromAwin ? 'awin_api' : 'awin_profile',
    updatedAt: fromAwin ? s.awin_info_at : details.checkedAt || null,
  };
}

const STORE_COLUMNS = 'id, name, awin_mid, domains, category, rate_type, rate_max, rate_note, user_fixed_cents, details, awin_info, awin_info_at';

async function listStores(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${STORE_COLUMNS} FROM stores WHERE active = 1 ORDER BY sort, name`
  ).all();
  // Un negozio appena approvato compare quando il server ha letto le sue commissioni da Awin.
  // I negozi nascosti a mano (details.hidden) non compaiono mai.
  return results.map((s) => buildStoreView(s, env)).filter((v) => v.hasRates && !v.hidden);
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
  const [balance, stores, txs, wds, reqs] = await Promise.all([
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
    env.DB.prepare(
      'SELECT id, store_name, website, status, reply, created_at, handled_at FROM store_requests WHERE user_id = ? ORDER BY id DESC LIMIT 10'
    ).bind(user.id).all(),
  ]);

  return json({
    user: { id: user.id, firstName: user.first_name, refCode: user.ref_code, refLink: refLink(env, user.ref_code) },
    isAdmin: isAdmin(env, user.id),
    balance: { ...balance, minPayoutCents: eurosToCents(env.MIN_PAYOUT_EUR, 1000) },
    referralBonusCents: eurosToCents(env.REFERRAL_BONUS_EUR, 0),
    program: programInfo(env),
    stores,
    offers: await listOffers(env, stores),
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
    storeRequests: reqs.results.map((r) => ({
      id: r.id,
      storeName: r.store_name,
      website: r.website,
      status: r.status,
      reply: r.reply,
      createdAt: r.created_at,
      handledAt: r.handled_at,
    })),
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
  if (view.hidden) throw new HttpError(404, 'store_not_found');
  let destination = null;
  if (body.offerId) {
    // Offerta letta da Awin: la pagina dell'offerta arriva dal negozio stesso, quindi e' affidabile.
    const offer = await findOffer(env, String(body.offerId));
    if (!offer || offer.storeId !== store.id) throw new HttpError(404, 'offer_not_found');
    if (view.productLinks && offer.url) destination = offer.url;
  } else if (body.url && view.productLinks) {
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
  return json({ url: await createTrackedLink(env, user.id, store, destination) });
}

// Registra il clic (il suo id e' il clickref che Awin restituisce con la vendita) e crea il link Awin.
async function createTrackedLink(env, userId, store, destination) {
  // Limite semplice contro gli abusi: massimo 20 link al minuto per utente.
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM clicks WHERE user_id = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(userId).first();
  if (recent.n >= 20) throw new HttpError(429, 'rate_limited');

  const clickId = randomId(16);
  await env.DB.prepare('INSERT INTO clicks (id, user_id, store_id, dest_url) VALUES (?, ?, ?, ?)')
    .bind(clickId, userId, store.id, destination)
    .run();

  const link = new URL('https://www.awin1.com/cread.php');
  link.searchParams.set('awinmid', String(store.awin_mid));
  link.searchParams.set('awinaffid', String(env.AWIN_PUBLISHER_ID));
  link.searchParams.set('clickref', clickId);
  if (destination) link.searchParams.set('ued', destination);
  return link.toString();
}

// ------------------------------------------------------------- offerte Awin

function cleanText(value, max) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&euro;/gi, '€').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Le date di Awin sono in UTC senza fuso ("2026-11-30T00:00:00.000").
function parseUtc(s) {
  if (!s) return NaN;
  const t = String(s).replace(' ', 'T');
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
}

function httpUrlOrNull(value) {
  try {
    const u = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

const SEASONAL = /black|cyber|week ?end|natal|christmas|xmas|saldi|sale/i;

// Offerte e codici sconto dei negozi a cui sei iscritto, per l'Italia (Offers API di Awin).
// I codici esclusivi di altri siti non arrivano: Awin li restituisce senza codice e vengono scartati.
export async function syncOffers(env, { force = false } = {}) {
  if (!env.AWIN_API_TOKEN || !env.AWIN_PUBLISHER_ID) return { skipped: true };
  const cached = await readSetting(env, 'offers');
  const refreshHours = Number.isFinite(Number(env.OFFERS_REFRESH_HOURS)) && env.OFFERS_REFRESH_HOURS !== '' && env.OFFERS_REFRESH_HOURS != null
    ? Number(env.OFFERS_REFRESH_HOURS) : OFFERS_REFRESH_HOURS;
  if (!force && cached && cached.at && Date.now() - Date.parse(cached.at) < refreshHours * 3600 * 1000) {
    return { skipped: 'recenti', offers: (cached.items || []).length };
  }
  const base = env.AWIN_API_BASE || 'https://api.awin.com';
  const url = new URL(`${base}/publisher/${env.AWIN_PUBLISHER_ID}/promotions`);
  url.searchParams.set('accessToken', env.AWIN_API_TOKEN);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { authorization: `Bearer ${env.AWIN_API_TOKEN}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      filters: { membership: 'joined', regionCodes: ['IT'], status: 'active', type: 'all' },
      pagination: { page: 1, pageSize: 200 },
    }),
  });
  // Messaggio diverso da "Awin API 401": un problema delle sole offerte non deve far scattare
  // l'avviso "token Awin non valido".
  if (!res.ok) throw new Error(`Awin Offers ${res.status}`);
  const data = await res.json().catch(() => null);
  const list = Array.isArray(data) ? data
    : data && Array.isArray(data.data) ? data.data
    : data && Array.isArray(data.promotions) ? data.promotions
    : [];

  const { results: stores } = await env.DB.prepare('SELECT id, awin_mid FROM stores WHERE active = 1').all();
  const byMid = new Map(stores.map((s) => [Number(s.awin_mid), s.id]));
  const now = Date.now();
  const items = [];
  for (const o of list) {
    if (!o || !o.advertiser) continue;
    const storeId = byMid.get(Number(o.advertiser.id));
    if (!storeId) continue;
    const voucher = o.type === 'voucher';
    const code = voucher && o.voucher && o.voucher.code ? cleanText(o.voucher.code, 40) : null;
    if (voucher && !code) continue;
    const end = parseUtc(o.endDate);
    if (Number.isFinite(end) && end < now) continue;
    // Una promozione "valida" per anni e' quasi sempre una scheda vecchia mai chiusa.
    if (Number.isFinite(end) && end > now + 400 * 86400 * 1000) continue;
    const title = cleanText(o.title, 140);
    if (!title) continue;
    items.push({
      id: String(o.promotionId),
      storeId,
      type: voucher ? 'voucher' : 'promotion',
      title,
      description: cleanText(o.description, 400),
      terms: cleanText(o.terms, 500),
      startDate: o.startDate || null,
      endDate: o.endDate || null,
      code,
      url: httpUrlOrNull(o.url),
    });
  }
  // Prima le offerte stagionali (Black Friday, Natale...), poi quelle che scadono prima.
  items.sort((a, b) => (SEASONAL.test(b.title) - SEASONAL.test(a.title))
    || ((Number.isFinite(parseUtc(a.endDate)) ? parseUtc(a.endDate) : Infinity) - (Number.isFinite(parseUtc(b.endDate)) ? parseUtc(b.endDate) : Infinity)));
  const kept = pickOffers(items, MAX_OFFERS_PER_STORE, MAX_OFFERS);
  await saveSetting(env, 'offers', { at: new Date().toISOString(), items: kept });
  const changed = ((cached && cached.items) || []).map((o) => o.id).join(',') !== kept.map((o) => o.id).join(',');
  const pinged = changed || !(await readSetting(env, 'indexnow_at')) ? await pingIndexNow(env) : false;
  return { offers: kept.length, received: list.length, ...(pinged ? { indexNow: pinged } : {}) };
}

// Al massimo "perStore" offerte per negozio, senza doppioni dello stesso titolo, e negozi alternati
// (la migliore di ogni negozio, poi la seconda...): un negozio con 15 promozioni non riempie la sezione.
export function pickOffers(sorted, perStore, max) {
  const byStore = new Map();
  for (const o of sorted) {
    const list = byStore.get(o.storeId) || [];
    const key = o.title.toLowerCase().replace(/[^a-z0-9%€]+/g, ' ').trim();
    if (list.length >= perStore || list.some((x) => x.key === key)) continue;
    list.push({ key, o });
    byStore.set(o.storeId, list);
  }
  const out = [];
  for (let round = 0; round < perStore; round++) {
    for (const list of byStore.values()) if (list[round]) out.push(list[round].o);
  }
  return out.slice(0, max);
}

// Avvisa i motori di ricerca (IndexNow) che le pagine pubbliche sono cambiate: al massimo una volta
// ogni 12 ore, e solo quando le offerte cambiano. Indirizzo del sito: PUBLIC_ORIGIN.
async function pingIndexNow(env) {
  const key = String(env.INDEXNOW_KEY || '');
  const origin = String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  if (!/^[a-f0-9]{32}$/.test(key) || !/^https:\/\//.test(origin)) return false;
  const last = await readSetting(env, 'indexnow_at');
  if (last && Date.now() - Date.parse(last) < 12 * 3600 * 1000) return false;
  const stores = await listStores(env);
  const urlList = ['/', '/offerte', '/negozi', ...stores.map((s) => `/negozi/${s.id}`)].map((p) => origin + p);
  try {
    const res = await fetch(env.INDEXNOW_ENDPOINT || 'https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: new URL(origin).host, key, keyLocation: `${origin}/${key}.txt`, urlList }),
    });
    await saveSetting(env, 'indexnow_at', new Date().toISOString());
    return `${res.status} (${urlList.length} pagine)`;
  } catch (err) {
    console.log('IndexNow non raggiunto', String(err));
    return false;
  }
}

async function findOffer(env, id) {
  const cached = await readSetting(env, 'offers');
  return ((cached && cached.items) || []).find((o) => o.id === id) || null;
}

// Offerte da mostrare: solo dei negozi visibili e non scadute, con il cashback del negozio.
async function listOffers(env, stores) {
  const cached = await readSetting(env, 'offers');
  if (!cached || !Array.isArray(cached.items)) return [];
  const byId = new Map(stores.map((s) => [s.id, s]));
  const now = Date.now();
  return cached.items
    .filter((o) => byId.has(o.storeId) && !(Number.isFinite(parseUtc(o.endDate)) && parseUtc(o.endDate) < now))
    .map((o) => {
      const s = byId.get(o.storeId);
      return {
        id: o.id,
        storeId: o.storeId,
        storeName: s.name,
        logo: s.logo,
        cashbackLabel: s.cashbackLabel,
        type: o.type,
        title: o.title,
        description: o.description,
        terms: o.terms,
        endDate: o.endDate ? String(o.endDate).slice(0, 10) : null,
        code: o.code,
        opensHome: !s.productLinks,
      };
    });
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

// ------------------------------------------------ segnalazioni di nuovi negozi

// Chiave per riconoscere lo stesso negozio scritto in modi diversi:
// "Zalando", "zalando.it", "www.Zalando.it" -> "zalando".
export function storeKey(text) {
  let s = String(text || '').trim().toLowerCase();
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const host = hostFromInput(s);
  if (host) s = domainBase(host);
  return s.replace(/[^a-z0-9]/g, '');
}

function hostFromInput(text) {
  let s = String(text || '').trim().toLowerCase();
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/.test(s)) return null;
    s = `https://${s}`;
  }
  try {
    const host = new URL(s).hostname.replace(/^www\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

function domainBase(host) {
  const parts = String(host).replace(/^\*\./, '').replace(/^www\./, '').split('.').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || '';
}

// Il negozio segnalato e' gia' nel nostro catalogo (attivo o in attesa di Awin)?
function findKnownStore(stores, key, host) {
  return stores.find((s) => {
    const domains = String(s.domains || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (host && hostMatches(host, domains)) return true;
    if (!key) return false;
    const nameKey = storeKey(s.name);
    const firstWord = storeKey(String(s.name).split(/\s+/)[0]);
    return key === s.id || key === nameKey || key === firstWord || domains.some((d) => domainBase(d) === key);
  }) || null;
}

// Elenco dei programmi Awin italiani a cui non sei iscritto, salvato per un giorno:
// serve a dirti subito se il negozio segnalato si puo' aggiungere tramite Awin.
async function awinDirectory(env) {
  if (!env.AWIN_API_TOKEN || !env.AWIN_PUBLISHER_ID) return null;
  const cached = await readSetting(env, 'awin_directory_it');
  if (cached && cached.at && Date.now() - Date.parse(cached.at) < DIRECTORY_CACHE_HOURS * 3600 * 1000) return cached.items;
  const list = await awinGet(env, `/publishers/${env.AWIN_PUBLISHER_ID}/programmes`, { relationship: 'notjoined', countryCode: 'IT' });
  const items = list.map((p) => {
    const domains = (Array.isArray(p.validDomains) ? p.validDomains : []).map((d) => String(d.domain || '').toLowerCase()).filter(Boolean);
    const display = hostFromInput(p.displayUrl || '');
    const base = String(p.name || '').replace(/[\s_-]+(it|ita|italia|italy)$/i, '');
    const keys = new Set([storeKey(base), ...domains.map(domainBase), display ? domainBase(display) : ''].filter(Boolean));
    return { id: p.id, name: p.name, sector: p.primarySector || null, keys: [...keys] };
  });
  await saveSetting(env, 'awin_directory_it', { at: new Date().toISOString(), items });
  return items;
}

export function findAwinMatches(items, key, host) {
  if (!items || !key) return [];
  const hostKey = host ? domainBase(host) : null;
  const exact = items.filter((p) => p.keys.includes(key) || (hostKey && p.keys.includes(hostKey)));
  const loose = key.length >= 4 ? items.filter((p) => !exact.includes(p) && p.keys.some((k) => k.startsWith(key))) : [];
  return [...exact, ...loose].slice(0, 3).map(({ id, name, sector }) => ({ id, name, sector }));
}

function awinProfileUrl(env, id) {
  return `https://ui.awin.com/awin/affiliate/${env.AWIN_PUBLISHER_ID}/merchant-profile/${id}`;
}

async function handleStoreRequest(request, env, ctx) {
  const { body, user } = await authenticate(request, env);
  return json(await createStoreRequest(env, ctx, user, body));
}

// Usata dalla Mini App e dal bot (quando un utente manda il link di un negozio che non abbiamo).
async function createStoreRequest(env, ctx, user, body) {
  const storeName = String(body.storeName || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const note = String(body.note || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
  const websiteRaw = String(body.website || '').trim();
  if (storeName.length < 2) throw new HttpError(400, 'invalid_store_name');
  const host = hostFromInput(websiteRaw) || hostFromInput(storeName);
  if (websiteRaw && !hostFromInput(websiteRaw)) throw new HttpError(400, 'invalid_website');
  const key = storeKey(storeName);
  if (!key) throw new HttpError(400, 'invalid_store_name');

  const { results: allStores } = await env.DB.prepare('SELECT id, name, domains, active, awin_status FROM stores').all();
  // I negozi che hanno rifiutato la nostra richiesta su Awin non sono "in arrivo".
  const rejectedStore = findKnownStore(allStores.filter((s) => s.awin_status === 'rejected'), key, host);
  const known = findKnownStore(allStores.filter((s) => s.awin_status !== 'rejected'), key, host);
  if (known && known.active) throw new HttpError(409, 'store_available');

  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM store_requests WHERE user_id = ? AND created_at > datetime('now', '-1 day')"
  ).bind(user.id).first();
  if (recent.n >= MAX_STORE_REQUESTS_PER_DAY) throw new HttpError(429, 'rate_limited');
  const dup = await env.DB.prepare(
    `SELECT id FROM store_requests WHERE user_id = ? AND store_key = ? AND status IN ('new', 'working')`
  ).bind(user.id, key).first();
  if (dup) throw new HttpError(409, 'already_requested');

  // Se il negozio e' tra quelli gia' chiesti ad Awin, la segnalazione e' "in lavorazione"
  // e si chiude da sola quando Awin approva (vedi syncPrograms).
  const status = known ? 'working' : 'new';
  const ins = await env.DB.prepare(
    'INSERT INTO store_requests (user_id, store_name, store_key, website, note, store_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(user.id, storeName, key, host, note, known ? known.id : null, status).run();
  const id = ins.meta ? ins.meta.last_row_id : null;

  ctx.waitUntil(notifyStoreRequest(env, { id, user, storeName, key, host, note, known, rejectedStore }));
  return { ok: true, id, status, comingSoon: known ? known.name : null };
}

async function notifyStoreRequest(env, { id, user, storeName, key, host, note, known, rejectedStore }) {
  let matches = [];
  let directoryError = null;
  if (!known) {
    try {
      matches = findAwinMatches(await awinDirectory(env), key, host);
    } catch (err) {
      directoryError = String(err && err.message ? err.message : err);
    }
    if (matches.length && id) {
      await env.DB.prepare('UPDATE store_requests SET awin_matches = ? WHERE id = ?').bind(JSON.stringify(matches), id).run();
    }
  }
  const count = (await env.DB.prepare(
    "SELECT COUNT(DISTINCT user_id) AS n FROM store_requests WHERE store_key = ? AND status IN ('new', 'working')"
  ).bind(key).first()).n;

  const who = user.username ? `@${user.username}` : user.first_name || 'utente';
  const lines = [
    `Nuova segnalazione negozio: ${storeName}`,
    host ? `Sito: ${host}` : null,
    note ? `Nota: ${note}` : null,
    `Da: ${who} (ID ${user.id})`,
    `Utenti che lo chiedono: ${count}`,
    '',
  ];
  if (rejectedStore) {
    lines.push(`${rejectedStore.name} ha rifiutato la tua richiesta su Awin: puoi chiedergli di riconsiderarla dal suo profilo Awin, oppure proporre un'alternativa.`);
  } else if (known) {
    lines.push(`È già nel catalogo (${known.name}) in attesa dell'approvazione Awin: l'utente verrà avvisato da solo quando si attiva.`);
  } else if (matches.length) {
    lines.push('Su Awin (Italia) c\'è:');
    for (const m of matches) lines.push(`- ${m.name}${m.sector ? ` (${m.sector})` : ''}: ${awinProfileUrl(env, m.id)}`);
    lines.push('Se ti iscrivi al programma e lo aggiungi al catalogo, rispondi dalla Mini App (Admin > Segnalazioni).');
  } else {
    lines.push(directoryError
      ? `Controllo su Awin non riuscito (${directoryError}).`
      : 'Non trovato tra i programmi Awin italiani a cui puoi iscriverti: prova su altri network (es. Tradedoubler, TradeTracker, CJ, Admitad) o proponi un\'alternativa.');
  }
  const text = lines.filter((l) => l !== null).join('\n');
  await notifyAdmins(env, text);

  const sentToday = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM store_requests WHERE created_at > datetime('now', '-1 day')"
  ).first();
  if (sentToday.n <= MAX_EMAILS_PER_DAY) {
    const res = await sendEmail(env, `Segnalazione negozio: ${storeName}`, text);
    if (!res.ok && !res.skipped) console.log('Email segnalazione non inviata', res.error);
  }
}

// Email con Resend (piano gratuito: 3000 al mese, 100 al giorno). Senza un dominio
// verificato si puo' scrivere solo all'indirizzo dell'account Resend: va benissimo per
// ricevere le segnalazioni. Segreti: RESEND_API_KEY e NOTIFY_EMAIL.
async function sendEmail(env, subject, text) {
  const to = String(env.NOTIFY_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!env.RESEND_API_KEY || !to.length) return { ok: false, skipped: true };
  const base = env.RESEND_API_BASE || 'https://api.resend.com';
  try {
    const res = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM || 'Cashback Bot <onboarding@resend.dev>', to, subject, text }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, id: data.id || null } : { ok: false, error: data.message || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const REQUEST_MESSAGES = {
  working: (name, reply) => `Stiamo lavorando alla tua segnalazione di ${name}: abbiamo chiesto di poterlo aggiungere. Ti scriviamo appena è disponibile.${reply ? `\n\n${reply}` : ''}`,
  added: (name, reply) => `Buone notizie: ${name} è ora nella Mini App, con il suo cashback. Grazie per la segnalazione!${reply ? `\n\n${reply}` : ''}`,
  alternative: (name, reply) => `Per ${name} non abbiamo ancora un accordo. Ti proponiamo un'alternativa:\n\n${reply}`,
  not_possible: (name, reply) => `Per ora non riusciamo ad aggiungere ${name}.${reply ? `\n\n${reply}` : ''} Grazie comunque per la segnalazione.`,
};

async function handleAdminStoreRequests(request, env) {
  await requireAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT r.*, u.first_name, u.username FROM store_requests r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.status IN ('new', 'working') ORDER BY r.id`
  ).all();
  const groups = new Map();
  for (const r of results) {
    let g = groups.get(r.store_key);
    if (!g) {
      g = { key: r.store_key, storeName: r.store_name, status: r.status, users: 0, websites: [], notes: [], awinMatches: [], firstAt: r.created_at, lastAt: r.created_at, ids: [] };
      groups.set(r.store_key, g);
    }
    g.ids.push(r.id);
    g.users += 1;
    g.lastAt = r.created_at;
    if (r.status === 'working') g.status = 'working';
    if (r.website && !g.websites.includes(r.website)) g.websites.push(r.website);
    if (r.note) g.notes.push(`${r.first_name || r.username || r.user_id}: ${r.note}`);
    for (const m of parseJson(r.awin_matches, [])) {
      if (!g.awinMatches.some((x) => x.id === m.id)) g.awinMatches.push({ ...m, url: awinProfileUrl(env, m.id) });
    }
  }
  const list = [...groups.values()].sort((a, b) => b.users - a.users || (a.firstAt < b.firstAt ? -1 : 1));
  return json({ requests: list });
}

// Risposta a tutte le segnalazioni aperte dello stesso negozio: ogni utente riceve un messaggio dal bot.
async function handleAdminStoreRequestUpdate(request, env, ctx) {
  const { body } = await requireAdmin(request, env);
  const key = String(body.key || '');
  const status = String(body.status || '');
  const reply = String(body.reply || '').trim().slice(0, 500) || null;
  if (!key || !REQUEST_REPLY_STATUSES.includes(status)) throw new HttpError(400, 'bad_request');
  if (status === 'alternative' && !reply) throw new HttpError(400, 'reply_required');
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, store_name FROM store_requests WHERE store_key = ? AND status IN ('new', 'working')"
  ).bind(key).all();
  if (!results.length) throw new HttpError(404, 'not_found');
  await env.DB.prepare(
    `UPDATE store_requests SET status = ?, reply = ?, handled_at = datetime('now')
      WHERE store_key = ? AND status IN ('new', 'working')`
  ).bind(status, reply, key).run();
  const notified = new Set();
  const sends = [];
  for (const r of results) {
    if (notified.has(r.user_id)) continue;
    notified.add(r.user_id);
    sends.push(tgSend(env, r.user_id, REQUEST_MESSAGES[status](r.store_name, reply)));
  }
  ctx.waitUntil(Promise.all(sends));
  return json({ ok: true, updated: results.length, notified: notified.size });
}

// Quando Awin approva un negozio, chiude le segnalazioni che lo riguardano e avvisa chi l'aveva chiesto.
async function resolveRequestsForStores(env, activated) {
  let resolved = 0;
  for (const s of activated) {
    const domains = String(s.domains || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
    const keys = [...new Set([storeKey(s.name), storeKey(String(s.name).split(/\s+/)[0]), s.id, ...domains.map(domainBase)].filter(Boolean))];
    const marks = keys.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, user_id, store_name FROM store_requests
        WHERE status IN ('new', 'working') AND (store_id = ? OR store_key IN (${marks}))`
    ).bind(s.id, ...keys).all();
    if (!results.length) continue;
    await env.DB.prepare(
      `UPDATE store_requests SET status = 'added', store_id = ?, handled_at = datetime('now')
        WHERE id IN (${results.map(() => '?').join(',')})`
    ).bind(s.id, ...results.map((r) => r.id)).run();
    const seen = new Set();
    for (const r of results) {
      if (seen.has(r.user_id)) continue;
      seen.add(r.user_id);
      await tgSend(env, r.user_id, REQUEST_MESSAGES.added(s.name, null));
    }
    resolved += results.length;
  }
  return resolved;
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

// Negozi attivi con la loro visibilita' nella Mini App, per l'area admin.
async function handleAdminStores(request, env) {
  await requireAdmin(request, env);
  const { results } = await env.DB.prepare(`SELECT ${STORE_COLUMNS} FROM stores WHERE active = 1 ORDER BY sort, name`).all();
  return json({
    stores: results.map((s) => {
      const v = buildStoreView(s, env);
      const d = parseJson(s.details, {});
      return { id: s.id, name: s.name, category: s.category, region: d.region || null, hidden: v.hidden, hasRates: v.hasRates, cashbackLabel: v.cashbackLabel };
    }),
  });
}

async function handleAdminStoreVisibility(request, env) {
  const { body } = await requireAdmin(request, env);
  const id = String(body.id || '');
  const hidden = body.hidden === true;
  const res = await env.DB.prepare(
    "UPDATE stores SET details = json_set(COALESCE(details, '{}'), '$.hidden', json(?)) WHERE id = ?"
  ).bind(hidden ? 'true' : 'false', id).run();
  if (!res.meta || !res.meta.changes) throw new HttpError(404, 'store_not_found');
  return json({ ok: true, id, hidden });
}

// Numeri del servizio per l'admin: utenti, clic, acquisti e commissioni.
async function handleAdminStats(request, env) {
  await requireAdmin(request, env);
  const live = "status IN ('pending', 'approved')";
  const t = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM users WHERE created_at > datetime('now', '-7 days')) AS users7,
       (SELECT COUNT(*) FROM users WHERE referred_by IS NOT NULL) AS referred,
       (SELECT COUNT(*) FROM clicks) AS clicks,
       (SELECT COUNT(*) FROM clicks WHERE created_at > datetime('now', '-7 days')) AS clicks7,
       (SELECT COUNT(DISTINCT user_id) FROM clicks) AS clickers,
       (SELECT COUNT(*) FROM transactions WHERE ${live}) AS sales,
       (SELECT COUNT(*) FROM transactions WHERE ${live} AND user_id IS NOT NULL) AS salesLinked,
       (SELECT COUNT(*) FROM transactions WHERE status = 'pending') AS salesPending,
       (SELECT COUNT(*) FROM transactions WHERE status = 'approved') AS salesApproved,
       (SELECT COUNT(*) FROM transactions WHERE status IN ('declined', 'deleted')) AS salesCancelled,
       (SELECT COALESCE(SUM(sale_amount_cents), 0) FROM transactions WHERE ${live}) AS salesCents,
       (SELECT COALESCE(SUM(commission_cents), 0) FROM transactions WHERE ${live}) AS commissionCents,
       (SELECT COALESCE(SUM(user_amount_cents), 0) FROM transactions WHERE ${live}) AS userCents,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM withdrawals WHERE status = 'paid') AS paidOutCents`
  ).first();
  const { results: topStores } = await env.DB.prepare(
    `SELECT s.name AS name, COUNT(*) AS clicks FROM clicks c JOIN stores s ON s.id = c.store_id
      WHERE c.created_at > datetime('now', '-30 days') GROUP BY s.name ORDER BY clicks DESC LIMIT 5`
  ).all();
  await ensureNewsTable(env);
  await ensureSourcesTable(env);
  const optOut = (await env.DB.prepare('SELECT COUNT(*) AS n FROM news_optout').first()).n;
  const { results: sources } = await env.DB.prepare(
    "SELECT source, COUNT(*) AS users FROM user_sources WHERE created_at > datetime('now', '-30 days') GROUP BY source ORDER BY users DESC"
  ).all();
  const ch = (await readSetting(env, 'channel_state')) || {};
  return json({
    ...t, marginCents: t.commissionCents - t.userCents, topStores, sources, newsOptOut: optOut,
    lastBroadcast: await readSetting(env, 'last_broadcast'),
    channel: env.NEWS_CHANNEL ? { name: env.NEWS_CHANNEL, posted: (ch.posted || []).length, lastAt: ch.lastAt || null } : null,
  });
}

async function ensureNewsTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS news_optout (user_id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
}

// Messaggio a tutti gli utenti (escluso chi ha scritto /stop), a gruppi di BROADCAST_BATCH.
// La Mini App richiama l'indirizzo con "after" finche' "next" non e' null.
async function handleAdminBroadcast(request, env) {
  const { body, user } = await requireAdmin(request, env);
  const text = String(body.text || '').trim();
  if (text.length < 5 || text.length > 1500) throw new HttpError(400, 'invalid_text');
  await ensureNewsTable(env);
  const full = `${text}\n\nNon vuoi ricevere questi avvisi? Scrivi /stop`;
  const extra = env.MINI_APP_URL
    ? { reply_markup: { inline_keyboard: [[{ text: 'Apri Cashback Italia', web_app: { url: env.MINI_APP_URL } }]] } }
    : {};
  if (body.test === true) {
    const ok = await tgSend(env, user.id, full, extra);
    return json({ ok, test: true });
  }
  const after = Number.isInteger(body.after) && body.after > 0 ? body.after : 0;
  const total = (await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM users WHERE id NOT IN (SELECT user_id FROM news_optout)'
  ).first()).n;
  const { results } = await env.DB.prepare(
    `SELECT rowid AS rid, id FROM users WHERE rowid > ? AND id NOT IN (SELECT user_id FROM news_optout)
      ORDER BY rowid LIMIT ?`
  ).bind(after, BROADCAST_BATCH).all();
  let sent = 0;
  let failed = 0;
  for (const r of results) {
    if (await tgSend(env, r.id, full, extra)) sent++; else failed++;
  }
  if (after === 0) await saveSetting(env, 'last_broadcast', { at: new Date().toISOString(), text: text.slice(0, 200), total });
  const next = results.length === BROADCAST_BATCH ? results[results.length - 1].rid : null;
  return json({ ok: true, sent, failed, total, next });
}

// "Aggiorna ora": stesso giro del cron, al massimo una volta ogni 2 minuti (limiti dell'API Awin).
async function handleAdminSync(request, env) {
  await requireAdmin(request, env);
  const last = await readSetting(env, 'last_programs_sync');
  if (last && last.at && Date.now() - Date.parse(last.at) < 120 * 1000) throw new HttpError(429, 'too_soon');
  const out = await runSync(env, { forceOffers: true });
  const p = out.last_programs_sync || {};
  return json({
    ok: !p.error && !(out.last_sync || {}).error,
    error: p.error || (out.last_sync || {}).error || null,
    synced: (out.last_sync || {}).synced ?? null,
    joined: p.joined ?? null,
    added: p.added || [],
    turnedOn: p.turnedOn || [],
    refreshed: p.refreshed || [],
    activeStores: (await env.DB.prepare('SELECT COUNT(*) AS n FROM stores WHERE active = 1').first()).n,
    visibleStores: (await listStores(env)).length,
  });
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
  // Comandi suggeriti da Telegram quando l'utente scrive "/" nella chat del bot.
  const commands = await tgCall(env, 'setMyCommands', { commands: BOT_COMMANDS });
  // Canale delle offerte: il bot deve esserne amministratore con il permesso di pubblicare.
  let channel = null;
  if (env.NEWS_CHANNEL) {
    const botId = Number(String(env.TELEGRAM_BOT_TOKEN || '').split(':')[0]);
    const member = await tgCall(env, 'getChatMember', { chat_id: env.NEWS_CHANNEL, user_id: botId });
    const m = member.result || {};
    const ok = !!member.ok && (m.status === 'creator' || (m.status === 'administrator' && m.can_post_messages !== false));
    channel = { ok, name: env.NEWS_CHANNEL, description: ok ? null : member.description || 'il bot non è amministratore del canale con il permesso di pubblicare' };
  }

  return json({
    awinNotifyUrl: notifySecret ? `${origin}/awin/notify/${notifySecret}` : null,
    telegram: {
      webhook: { ok: !!webhook.ok, description: webhook.description || null },
      menuButton: { ok: !!menuButton.ok, description: menuButton.description || null },
      commands: { ok: !!commands.ok, description: commands.description || null },
      channel,
    },
    checks: {
      awinApiToken: !!env.AWIN_API_TOKEN,
      email: env.RESEND_API_KEY && env.NOTIFY_EMAIL
        ? await sendEmail(env, 'Cashback Bot: email di prova', 'Funziona: le segnalazioni dei negozi da aggiungere arriveranno a questo indirizzo.')
        : { ok: false, skipped: true },
      botUsername: env.BOT_USERNAME || null,
      activeStores: (await env.DB.prepare('SELECT COUNT(*) AS n FROM stores WHERE active = 1').first()).n,
      programmes: Object.fromEntries((await env.DB.prepare(
        "SELECT COALESCE(awin_status, 'pending') AS status, COUNT(*) AS n FROM stores GROUP BY 1"
      ).all()).results.map((r) => [r.status, r.n])),
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
        `Abbiamo registrato il tuo acquisto da ${row.store_name || 'un negozio partner'}: ${formatEuro(row.user_amount_cents)} di cashback in attesa. Diventa prelevabile quando il negozio conferma l'ordine e ci arriva la commissione.`));
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
  const seeded = await seedCatalog(env);

  const joined = await awinGet(env, `/publishers/${pub}/programmes`, { relationship: 'joined' });
  const joinedIds = new Set(joined.map((p) => Number(p.id)).filter(Boolean));
  // Rifiuti: se la chiamata non riesce si va avanti senza aggiornarli.
  const rejectedList = await awinGet(env, `/publishers/${pub}/programmes`, { relationship: 'rejected' }).catch(() => null);
  const rejectedIds = new Set((rejectedList || []).map((p) => Number(p.id)).filter(Boolean));
  let { results: stores } = await env.DB.prepare('SELECT id, name, awin_mid, domains, active, awin_info_at, awin_status FROM stores').all();

  // Programmi approvati che non sono ancora nel catalogo (per esempio iscrizioni fatte a mano
  // dal sito Awin): vengono aggiunti da soli con nome, domini e categoria presi da Awin.
  const known = new Set(stores.map((s) => Number(s.awin_mid)));
  const added = [];
  const addedHidden = [];
  if (String(env.AUTO_ACTIVATE_STORES || 'true') !== 'false') {
    for (const p of joined) {
      if (!p || !p.id || known.has(Number(p.id))) continue;
      const row = catalogRowFromProgramme(p, stores);
      if (!row) continue;
      // Un negozio che non e' italiano parte nascosto: spesso non spedisce in Italia o vende in
      // un'altra lingua. L'admin puo' mostrarlo dalla Mini App.
      const foreign = row.region && row.region !== 'IT';
      const details = { autoAdded: true, region: row.region, ...(foreign ? { hidden: true } : {}) };
      await env.DB.prepare(
        "INSERT OR IGNORE INTO stores (id, name, awin_mid, domains, category, rate_type, rate_max, active, sort, details) VALUES (?, ?, ?, ?, ?, 'percent', 0, 0, 200, ?)"
      ).bind(row.id, row.name, Number(p.id), row.domains, row.category, JSON.stringify(details)).run();
      stores.push({ id: row.id, name: row.name, awin_mid: Number(p.id), domains: row.domains, active: 0, awin_info_at: null, awin_status: null });
      known.add(Number(p.id));
      (foreign ? addedHidden : added).push(foreign ? `${row.name} (${row.region})` : row.name);
    }
  }

  const turnedOn = [];
  const activated = [];
  const turnedOff = [];
  if (String(env.AUTO_ACTIVATE_STORES || 'true') !== 'false') {
    for (const s of stores) {
      const want = joinedIds.has(Number(s.awin_mid)) ? 1 : 0;
      if (want === s.active) continue;
      await env.DB.prepare('UPDATE stores SET active = ? WHERE id = ?').bind(want, s.id).run();
      s.active = want;
      (want ? turnedOn : turnedOff).push(s.name);
      if (want) activated.push(s);
    }
  }
  // Stato della richiesta su Awin per ogni negozio del catalogo (approvato, in attesa, rifiutato).
  const newlyRejected = [];
  const statusUpdates = [];
  for (const s of stores) {
    const mid = Number(s.awin_mid);
    let status = joinedIds.has(mid) ? 'joined'
      : rejectedIds.has(mid) ? 'rejected'
      : s.awin_status === 'joined' ? 'left'
      : s.awin_status === 'rejected' && rejectedList === null ? 'rejected'
      : 'pending';
    if (status === (s.awin_status || 'pending') && s.awin_status) continue;
    if (status === 'rejected' && s.awin_status !== 'rejected') newlyRejected.push(s.name);
    statusUpdates.push(env.DB.prepare('UPDATE stores SET awin_status = ? WHERE id = ?').bind(status, s.id));
    s.awin_status = status;
  }
  for (let i = 0; i < statusUpdates.length; i += 50) await env.DB.batch(statusUpdates.slice(i, i + 50));
  if (newlyRejected.length) {
    await notifyAdmins(env, `Richiesta rifiutata su Awin da: ${newlyRejected.join(', ')}. Il motivo arriva per email; se lo correggi puoi riprovare dal profilo del negozio su Awin (icona +), meglio dopo aver scritto al negozio.`);
  }
  if (turnedOn.length) await notifyAdmins(env, `Awin ti ha approvato: ${turnedOn.join(', ')}. ${turnedOn.length === 1 ? 'Compare' : 'Compaiono'} nella Mini App appena il server legge le commissioni (di solito entro un'ora).${added.length ? `\nAggiunti da soli al catalogo: ${added.join(', ')}.` : ''}${addedHidden.length ? `\nAggiunti ma nascosti perché non sono negozi italiani: ${addedHidden.join(', ')}. Se vuoi mostrarli usa la sezione Admin della Mini App.` : ''}`);
  if (turnedOff.length) await notifyAdmins(env, `Iscrizione non più attiva su Awin: ${turnedOff.join(', ')}. ${turnedOff.length === 1 ? 'Il negozio è stato nascosto' : 'I negozi sono stati nascosti'} dalla Mini App.`);
  const resolvedRequests = activated.length ? await resolveRequestsForStores(env, activated) : 0;

  const cutoff = Date.now() - STORE_REFRESH_HOURS * 3600 * 1000;
  // Prima i negozi appena approvati (mai letti), poi quelli con i dati piu' vecchi.
  const due = stores
    .filter((s) => s.active && (!s.awin_info_at || Date.parse(String(s.awin_info_at).replace(' ', 'T') + 'Z') < cutoff))
    .sort((a, b) => (a.awin_info_at ? 1 : 0) - (b.awin_info_at ? 1 : 0) || String(a.awin_info_at || '').localeCompare(String(b.awin_info_at || '')))
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
        logoUrl: typeof p.logoUrl === 'string' && /^https:\/\//.test(p.logoUrl) ? p.logoUrl : null,
      };
      await env.DB.prepare("UPDATE stores SET awin_info = ?, awin_info_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(info), s.id).run();
      refreshed.push(s.id);
    } catch (err) {
      failed.push(`${s.id}: ${String(err && err.message ? err.message : err)}`);
    }
  }
  return { joined: joinedIds.size, rejected: rejectedIds.size, seeded, added, addedHidden, turnedOn, turnedOff, newlyRejected, resolvedRequests, refreshed, failed };
}

// Negozi a cui hai chiesto l'iscrizione (src/catalog.json): a ogni giro il server aggiunge al
// database quelli che mancano e la loro scheda, senza toccare le schede gia' presenti.
export async function seedCatalog(env, catalog = CATALOG) {
  if (!Array.isArray(catalog) || !catalog.length) return 0;
  const { results } = await env.DB.prepare('SELECT awin_mid, details IS NOT NULL AS has_details FROM stores').all();
  const have = new Map(results.map((r) => [Number(r.awin_mid), !!r.has_details]));
  const stmts = [];
  for (const c of catalog) {
    const details = JSON.stringify(c.details || {});
    if (!have.has(Number(c.mid))) {
      stmts.push(env.DB.prepare(
        "INSERT OR IGNORE INTO stores (id, name, awin_mid, domains, category, rate_type, rate_max, active, sort, details) VALUES (?, ?, ?, ?, ?, 'percent', 0, 0, ?, ?)"
      ).bind(c.id, c.name, Number(c.mid), c.domains, c.category || null, Number(c.sort) || 100, details));
    } else if (!have.get(Number(c.mid)) && c.details) {
      stmts.push(env.DB.prepare('UPDATE stores SET details = ? WHERE awin_mid = ? AND details IS NULL').bind(details, Number(c.mid)));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

// Settori Awin -> categorie della Mini App.
const SECTOR_IT = [
  [/cloth|fashion|apparel|shoe|footwear|accessor/i, 'Moda'],
  [/jewel|watch/i, 'Gioielli e accessori'],
  [/beauty|cosmetic|fragrance|perfume/i, 'Bellezza'],
  [/health|pharma|vitamin|nutrition|wellness/i, 'Salute'],
  [/travel|holiday|hotel|flight|car rental|airline|tour/i, 'Viaggi'],
  [/electronic|computer|technology|software|appliance|gaming/i, 'Elettronica'],
  [/home|garden|furniture|diy|house/i, 'Casa'],
  [/sport|outdoor|fitness/i, 'Sport'],
  [/pet/i, 'Animali'],
  [/food|drink|wine|grocer/i, 'Cibo e vino'],
  [/book|ticket|entertainment|media|music|event/i, 'Libri e biglietti'],
  [/telecom|mobile|broadband|utilit|energy/i, 'Telefonia ed energia'],
  [/auto|motor|car|tyre/i, 'Auto e moto'],
  [/toy|baby|kid/i, 'Bambini'],
];

export function cleanProgrammeName(name) {
  return String(name || '')
    .replace(/\s*\((IT|ITA|Italia|Italy)\)\s*$/i, '')
    .replace(/[\s_-]+(IT|ITA|EUR|EU|Global|Italia|Italy)(\s+New)?$/i, '')
    .replace(/\s+(19|20)\d\d(\s+Campaign)?$/i, '')
    .replace(/\s+Campaign$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function catalogRowFromProgramme(p, stores) {
  const regionCode = String((p.primaryRegion && p.primaryRegion.countryCode) || '').toUpperCase();
  let name = cleanProgrammeName(p.name) || String(p.name || '').trim();
  // "Lapert CZ" -> "Lapert": la sigla del paese finisce gia' nella regione.
  if (regionCode && new RegExp(`[\\s_-]+${regionCode}$`, 'i').test(name)) name = name.replace(new RegExp(`[\\s_-]+${regionCode}$`, 'i'), '');
  if (!name) return null;
  const base = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `awin-${p.id}`;
  const taken = new Set(stores.map((s) => s.id));
  const id = taken.has(base) ? `${base}-${p.id}` : base;
  const domains = new Set();
  for (const d of Array.isArray(p.validDomains) ? p.validDomains : []) {
    const host = String(d && d.domain || '').toLowerCase().replace(/^\*\./, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) domains.add(host);
  }
  const display = hostFromInput(p.displayUrl || '');
  if (display) domains.add(display);
  if (!domains.size) return null;
  const sector = String(p.primarySector || '');
  const category = (SECTOR_IT.find(([re]) => re.test(sector)) || [null, 'Altro'])[1];
  return { id, name, domains: [...domains].slice(0, 6).join(','), category, region: regionCode || null };
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

// Restituisce true se Telegram ha consegnato il messaggio.
async function tgSend(env, chatId, text, extra = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  try {
    const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    return !!data.ok;
  } catch (err) {
    // L'utente potrebbe non aver mai avviato il bot o averlo bloccato: non e' un errore grave.
    console.log('Invio Telegram non riuscito', String(err));
    return false;
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

// ------------------------------------------------------ canale delle offerte

// Canale pubblico (NEWS_CHANNEL, es. "@CashbackItaliaOfferte") dove il bot pubblica da solo le offerte:
// una ogni CHANNEL_POST_HOURS ore, solo nelle ore di CHANNEL_HOURS (ora italiana), mai due volte la
// stessa. Il pulsante porta al bot (start=o_ID__canale): ognuno riceve il suo link personale.
function romeHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: 'numeric', hourCycle: 'h23' }).format(date));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function numberSetting(value, fallback) {
  return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function offerPost(o) {
  const lines = [`<b>${escapeHtml(o.storeName)}: ${escapeHtml(o.title)}</b>`];
  const desc = o.description && o.description.toLowerCase() !== o.title.toLowerCase()
    ? (o.description.length > 220 ? `${o.description.slice(0, 217)}...` : o.description) : '';
  if (desc) lines.push(escapeHtml(desc));
  lines.push('');
  if (o.code) lines.push(`Codice sconto: <code>${escapeHtml(o.code)}</code>`);
  if (o.endDate) lines.push(`Valida fino al ${o.endDate.split('-').reverse().join('/')}`);
  lines.push(`In più il cashback: ${escapeHtml(o.cashbackLabel)}, se apri il negozio dal pulsante qui sotto.`);
  if (SEASONAL.test(o.title) && /black|cyber/i.test(o.title)) lines.push('', '#BlackFriday');
  return lines.join('\n');
}

function channelIntro(env) {
  const share = Math.round(userShare(env) * 100);
  return `<b>Come funziona Cashback Italia</b>\n\nQui trovi le offerte dei nostri negozi partner. Sotto ogni offerta tocca «Apri con cashback»: il bot ti dà il tuo link personale, compri allo stesso prezzo e il ${share}% della commissione che il negozio ci paga torna a te.\n\nIl cashback diventa prelevabile quando il negozio conferma l'ordine e ci paga, di solito dopo qualche mese. Prelievo da ${escapeHtml(formatEuro(eurosToCents(env.MIN_PAYOUT_EUR, 1000)))} con PayPal o buono regalo. Percentuali, tempi e regole di ogni negozio sono nella Mini App del bot.`;
}

export async function postToChannel(env, { force = false } = {}) {
  const channel = String(env.NEWS_CHANNEL || '').trim();
  if (!channel || !env.TELEGRAM_BOT_TOKEN || !env.BOT_USERNAME) return { skipped: 'canale non impostato' };
  const state = (await readSetting(env, 'channel_state')) || {};
  if (state.channel !== channel) Object.assign(state, { channel, posted: [], lastAt: null, lastStore: null, introId: null });
  const out = {};
  const startLink = (payload) => `https://t.me/${env.BOT_USERNAME}?start=${payload}`;

  // Prima volta: presentazione fissata in alto.
  if (!state.introId) {
    const res = await tgCall(env, 'sendMessage', {
      chat_id: channel, text: channelIntro(env), parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: 'Apri Cashback Italia', url: startLink('canale') }]] },
    });
    if (!res.ok) throw new Error(`Canale Telegram: ${res.description || 'invio non riuscito'}`);
    state.introId = (res.result && res.result.message_id) || -1;
    if (state.introId > 0) await tgCall(env, 'pinChatMessage', { chat_id: channel, message_id: state.introId, disable_notification: true });
    await saveSetting(env, 'channel_state', state);
    out.intro = true;
  }

  const [from, to] = String(env.CHANNEL_HOURS || '8-21').split('-').map((x) => numberSetting(x, NaN));
  const every = numberSetting(env.CHANNEL_POST_HOURS, 3);
  if (!force) {
    const h = romeHour();
    if (Number.isFinite(from) && Number.isFinite(to) && (h < from || h > to)) return { ...out, skipped: 'fuori orario' };
    if (state.lastAt && Date.now() - Date.parse(state.lastAt) < (every * 3600 - 300) * 1000) return { ...out, skipped: 'troppo presto' };
  }
  const exclude = new Set(String(env.CHANNEL_EXCLUDE || '').split(',').map((x) => x.trim()).filter(Boolean));
  const posted = new Set(state.posted || []);
  const offers = (await listOffers(env, await listStores(env))).filter((o) => !exclude.has(o.storeId) && !posted.has(o.id));
  const next = offers.find((o) => o.storeId !== state.lastStore) || offers[0];
  if (!next) return { ...out, skipped: 'nessuna offerta nuova' };
  const res = await tgCall(env, 'sendMessage', {
    chat_id: channel, text: offerPost(next), parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: 'Apri con cashback', url: startLink(`o_${next.id}__canale`) }]] },
  });
  if (!res.ok) throw new Error(`Canale Telegram: ${res.description || 'invio non riuscito'}`);
  state.posted = [...(state.posted || []), next.id].slice(-300);
  state.lastAt = new Date().toISOString();
  state.lastStore = next.storeId;
  await saveSetting(env, 'channel_state', state);
  return { ...out, posted: next.id, store: next.storeName };
}

async function ensureSourcesTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS user_sources (user_id TEXT PRIMARY KEY, source TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
}

async function recordSource(env, userId, source) {
  await ensureSourcesTable(env);
  await env.DB.prepare('INSERT OR IGNORE INTO user_sources (user_id, source) VALUES (?, ?)').bind(String(userId), source).run();
}

const BOT_COMMANDS = [
  { command: 'negozi', description: 'Negozi con cashback e offerte del momento' },
  { command: 'aiuto', description: 'Come funziona il cashback' },
  { command: 'stop', description: 'Non ricevere più avvisi sulle offerte' },
  { command: 'avvisi', description: 'Ricevi di nuovo gli avvisi sulle offerte' },
];

const SHORTENERS = /(^|\.)(bit\.ly|tinyurl\.com|t\.co|goo\.gl|shorturl\.at|rebrand\.ly|cutt\.ly|is\.gd|ow\.ly|tidd\.ly|clk\.tradedoubler\.com|s\.click\.aliexpress\.com)$/i;
const AMAZON = /(^|\.)(amazon\.[a-z.]+|amzn\.(to|eu|com))$/i;
const NOT_SHOPS = /(^|\.)(t\.me|telegram\.(org|me)|youtube\.com|youtu\.be|google\.[a-z.]+|facebook\.com|instagram\.com|tiktok\.com|whatsapp\.com|wikipedia\.org|github\.io)$/i;

function appButton(env, text = 'Apri Cashback Italia') {
  return env.MINI_APP_URL ? [{ text, web_app: { url: env.MINI_APP_URL } }] : null;
}

function keyboard(rows) {
  const clean = rows.filter(Boolean);
  return clean.length ? { reply_markup: { inline_keyboard: clean } } : {};
}

// Webhook del bot: /start con il pulsante della Mini App (e gli inviti t.me/NomeBot?start=ref_CODICE),
// comandi, e "manda un link, ricevi il link con cashback" in chat privata.
async function handleTelegramWebhook(request, env, ctx) {
  const secret = await secretFor(env, 'TELEGRAM_WEBHOOK_SECRET');
  if (!secret || request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('Not found', { status: 404 });
  }
  const update = await request.json().catch(() => ({}));
  const msg = update.message;
  if (!msg || !msg.from || !msg.chat || typeof (msg.text ?? msg.caption) !== 'string') return new Response('OK');
  // Nei gruppi il bot non risponde: niente messaggi indesiderati.
  if (msg.chat.type && msg.chat.type !== 'private') return new Response('OK');
  const text = String(msg.text ?? msg.caption).trim();
  try {
    await handleChatMessage(env, ctx, msg, text);
  } catch (err) {
    console.error('Messaggio del bot non gestito', err && err.stack ? err.stack : err);
    if (err instanceof HttpError && err.code === 'rate_limited') {
      await tgSend(env, msg.chat.id, 'Troppe richieste ravvicinate: riprova tra un minuto.');
    }
  }
  return new Response('OK');
}

async function handleChatMessage(env, ctx, msg, text) {
  const chatId = msg.chat.id;
  const command = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(text);
  const name = command ? command[1].toLowerCase() : null;

  if (name === 'start') {
    // Il parametro puo' contenere l'invito (ref_CODICE) e un negozio o un'offerta da aprire
    // (s_IDNEGOZIO, o_IDOFFERTA), separati da "__": t.me/NomeBot?start=o_502__ref_abcd1234.
    const parts = ((command[2] || '').split(/\s+/)[0] || '').split('__');
    const refPart = parts.find((p) => /^ref_/.test(p)) || null;
    const target = parts.find((p) => /^[so]_[a-z0-9-]{1,40}$/i.test(p)) || null;
    const isNew = !(await env.DB.prepare('SELECT 1 AS x FROM users WHERE id = ?').bind(String(msg.from.id)).first());
    const user = await upsertUser(env, msg.from, refPart);
    if (isNew) {
      const via = parts.find((p) => /^(canale|via_[a-z0-9]{1,20})$/i.test(p));
      const source = via ? via.replace(/^via_/, '') : target ? (target.startsWith('o_') ? 'offerta' : 'negozio') : refPart ? 'invito' : 'diretto';
      await recordSource(env, user.id, refPart && source !== 'invito' ? `${source}+invito` : source);
    }
    if (target && await replyWithTarget(env, chatId, user, target)) return;
    const share = Math.round(userShare(env) * 100);
    await tgSend(env, chatId,
      `Ciao! Fai la spesa online che faresti comunque, allo stesso prezzo, ma partendo da qui: così una parte dei soldi ti torna indietro.\n\nOgni negozio ci paga una commissione: il ${share}% è tuo, noi teniamo il ${100 - share}%. I tempi sono lunghi (spesso qualche mese, perché il negozio paga solo dopo aver confermato l'ordine), ma nella Mini App vedi sempre percentuali, tempi medi e regole di ogni negozio. Prelievo da ${formatEuro(eurosToCents(env.MIN_PAYOUT_EUR, 1000))} con PayPal o buono regalo.\n\nScorciatoia: mandami il link di un prodotto o il nome di un negozio e ti rispondo con il link che attiva il cashback.`,
      keyboard([appButton(env)]));
    return;
  }

  const user = await upsertUser(env, msg.from, null);

  if (name === 'stop') {
    await ensureNewsTable(env);
    await env.DB.prepare('INSERT OR IGNORE INTO news_optout (user_id) VALUES (?)').bind(user.id).run();
    await tgSend(env, chatId, 'Fatto: non ti mandiamo più avvisi sulle offerte. Riceverai solo i messaggi sui tuoi acquisti e prelievi. Per riattivarli scrivi /avvisi.');
    return;
  }
  if (name === 'avvisi') {
    await ensureNewsTable(env);
    await env.DB.prepare('DELETE FROM news_optout WHERE user_id = ?').bind(user.id).run();
    await tgSend(env, chatId, 'Avvisi riattivati: ti scriviamo quando ci sono offerte interessanti nei negozi partner.');
    return;
  }

  const stores = await listStores(env);
  if (name === 'negozi' || name === 'offerte') {
    const offers = await listOffers(env, stores);
    const lines = [`Oggi hai il cashback in ${stores.length} negozi${stores.length ? ', per esempio:' : '.'}`];
    for (const s of stores.slice(0, 8)) lines.push(`- ${s.name}: ${s.cashbackLabel}`);
    if (offers.length) {
      lines.push('', `Offerte del momento (${offers.length}):`);
      for (const o of offers.slice(0, 5)) lines.push(`- ${o.storeName}: ${o.title}`);
    }
    lines.push('', 'Tutti i negozi, le regole e le offerte sono nella Mini App.');
    await tgSend(env, chatId, lines.join('\n'), keyboard([appButton(env, 'Vedi negozi e offerte')]));
    return;
  }
  if (name) {
    await tgSend(env, chatId, helpText(env), keyboard([appButton(env)]));
    return;
  }

  // Un link: se e' di un negozio partner rispondiamo con il link che attiva il cashback.
  const found = findLinkInText(text);
  if (found) {
    const target = await storeForLink(env, stores, found);
    if (target) {
      await replyWithStoreLink(env, chatId, user, target.view, target.destination, !!found.url);
      return;
    }
    if (SHORTENERS.test(found.host)) {
      await tgSend(env, chatId, 'Da un link accorciato non riesco a capire il negozio. Aprilo, copia l\'indirizzo completo della pagina del prodotto e mandamelo qui.');
      return;
    }
    if (AMAZON.test(found.host)) {
      await tgSend(env, chatId, 'Amazon non è tra i nostri negozi partner: sui suoi acquisti non possiamo darti cashback. Nella Mini App trovi i negozi dove il cashback c\'è, per esempio di elettronica, casa e moda.', keyboard([appButton(env, 'Vedi i negozi partner')]));
      return;
    }
    const label = domainBase(found.host);
    if (NOT_SHOPS.test(found.host)) {
      await tgSend(env, chatId, helpText(env), keyboard([appButton(env)]));
      return;
    }
    await tgSend(env, chatId,
      `${found.host} non è ancora tra i nostri negozi partner, quindi su questo acquisto non possiamo darti cashback. L'abbiamo segnalato: se riusciamo ad aggiungerlo ti scriviamo qui.\n\nNella Mini App trovi i negozi con cashback e le offerte del momento.`,
      keyboard([appButton(env, 'Vedi i negozi partner')]));
    if (label && label.length >= 2) {
      try {
        await createStoreRequest(env, ctx, user, { storeName: label.charAt(0).toUpperCase() + label.slice(1), website: found.host, note: 'Link mandato in chat al bot' });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err; // gia' segnalato, troppe segnalazioni...: va bene cosi'
      }
    }
    return;
  }

  // Il nome di un negozio.
  const key = storeKey(text);
  if (key.length >= 3 && text.length <= 60) {
    const matches = stores.filter((s) => {
      const k = storeKey(s.name);
      const first = storeKey(String(s.name).split(/\s+/)[0]);
      return k === key || first === key || (key.length >= 4 && k.startsWith(key)) || (first.length >= 4 && key.includes(first));
    });
    if (matches.length === 1) {
      await replyWithStoreLink(env, chatId, user, matches[0], null, false);
      return;
    }
    if (matches.length > 1) {
      const rows = [];
      for (const s of matches.slice(0, 4)) {
        const row = await env.DB.prepare('SELECT * FROM stores WHERE id = ?').bind(s.id).first();
        rows.push([{ text: `${s.name}: ${s.cashbackLabel}`, url: await createTrackedLink(env, user.id, row, null) }]);
      }
      await tgSend(env, chatId, 'Ho trovato più negozi. Tocca quello che ti interessa e completa l\'acquisto nella pagina che si apre.', keyboard(rows));
      return;
    }
  }
  await tgSend(env, chatId, helpText(env), keyboard([appButton(env)]));
}

// Link condivisi (s_negozio, o_offerta): il bot risponde subito con il link personale.
async function replyWithTarget(env, chatId, user, target) {
  const stores = await listStores(env);
  const id = target.slice(2);
  if (target.startsWith('s_')) {
    const view = stores.find((s) => s.id === id);
    if (!view) return false;
    await replyWithStoreLink(env, chatId, user, view, null, false);
    return true;
  }
  const offer = (await listOffers(env, stores)).find((o) => o.id === id);
  if (!offer) {
    await tgSend(env, chatId, 'Questa offerta è scaduta o non è più disponibile. Nella Mini App trovi quelle del momento.', keyboard([appButton(env, 'Vedi le offerte')]));
    return true;
  }
  const full = await findOffer(env, id);
  const view = stores.find((s) => s.id === offer.storeId);
  const store = await env.DB.prepare('SELECT * FROM stores WHERE id = ?').bind(view.id).first();
  const link = await createTrackedLink(env, user.id, store, view.productLinks && full && full.url ? full.url : null);
  const lines = [`${offer.storeName}: ${offer.title}`, `In più ricevi il cashback: ${offer.cashbackLabel}.`];
  if (offer.code) lines.push(`Codice sconto da usare al pagamento: ${offer.code}`);
  if (offer.endDate) lines.push(`Valida fino al ${offer.endDate.split('-').reverse().join('/')}.`);
  lines.push('', 'Tocca il pulsante e completa l\'acquisto nella pagina che si apre, senza passare da altri siti di sconti o cashback.');
  await tgSend(env, chatId, lines.join('\n'), keyboard([[{ text: `Apri l'offerta di ${offer.storeName}`, url: link }], appButton(env, 'Altre offerte e regole')]));
  return true;
}

function helpText(env) {
  const share = Math.round(userShare(env) * 100);
  return `Come funziona: apri il negozio da qui, compri come sempre e il ${share}% della commissione che il negozio ci paga torna a te.\n\nPuoi:\n- mandarmi il link di un prodotto (anche copiato da un canale di offerte): ti rispondo con lo stesso link con il cashback attivo;\n- scrivermi il nome di un negozio, per esempio "Thun";\n- aprire la Mini App per vedere negozi, offerte e il tuo saldo.\n\n/negozi elenco rapido, /stop niente avvisi sulle offerte.`;
}

// Primo link nel messaggio: indirizzo completo o dominio scritto a mano ("zalando.it").
export function findLinkInText(text) {
  const full = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (full) {
    const url = full[0].replace(/[).,;!?]+$/, '');
    const host = hostFromInput(url);
    if (host) return { url, host };
  }
  for (const word of String(text).split(/\s+/)) {
    const w = word.replace(/^[(<"']+|[).,;!?>"']+$/g, '');
    if (!/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(w)) continue;
    const host = hostFromInput(w);
    if (host) return { url: null, host };
  }
  return null;
}

// Negozio e pagina di destinazione per un link. I link Awin di altri siti (awin1.com/cread.php)
// contengono il negozio (awinmid) e la pagina (ued): li rifacciamo con il nostro clickref.
async function storeForLink(env, stores, found) {
  let host = found.host;
  let url = found.url;
  if (url && hostMatches(host, ['awin1.com'])) {
    try {
      const u = new URL(url);
      const mid = Number(u.searchParams.get('awinmid') || u.searchParams.get('mid'));
      const ued = httpUrlOrNull(u.searchParams.get('ued') || u.searchParams.get('p'));
      const view = stores.find((s) => s.awinMid === mid);
      if (view) return { view, destination: view.productLinks ? ued : null };
      if (ued) { url = ued; host = hostFromInput(ued) || host; }
    } catch { /* link non valido: si prova con il dominio */ }
  }
  const view = stores.find((s) => hostMatches(host, s.domains));
  if (!view) return null;
  const destination = url && view.productLinks ? httpUrlOrNull(url) : null;
  return { view, destination };
}

async function replyWithStoreLink(env, chatId, user, view, destination, hadUrl) {
  const store = await env.DB.prepare('SELECT * FROM stores WHERE id = ?').bind(view.id).first();
  const link = await createTrackedLink(env, user.id, store, destination);
  const lines = [`${view.name}: cashback ${view.cashbackLabel}.`];
  if (hadUrl && !destination) lines.push('Questo negozio non accetta link a una pagina precisa: si apre la pagina principale, da lì cerca il prodotto.');
  lines.push('Tocca il pulsante e completa l\'acquisto nella pagina che si apre, senza passare da altri siti di sconti o cashback.');
  if (view.rules && view.rules.appTracking === false) lines.push('Paga nel browser, non nell\'app del negozio: gli acquisti dall\'app non vengono registrati.');
  lines.push('', 'Il link è personale: se vuoi far risparmiare un amico, mandagli il tuo invito dalla Mini App.');
  await tgSend(env, chatId, lines.join('\n'), keyboard([[{ text: `Apri ${view.name}`, url: link }], appButton(env, 'Scheda del negozio e regole')]));
}

// ---------------------------------------------------- pagine pubbliche per Google
// Home con le offerte, una pagina per ogni negozio, la pagina delle offerte, sitemap e robots.
// I dati arrivano dal database a ogni richiesta, quindi le pagine sono sempre aggiornate.
// I pulsanti portano al bot con start=..._via_web: i nuovi utenti vengono contati con fonte "web".

const SITE = 'https://alelimpo.github.io/cashback-bot-app';
const LOGO_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#f3b63c"/><path d="M21.5 11.2A7 7 0 1 0 23 16" fill="none" stroke="#3a2a05" stroke-width="2.6" stroke-linecap="round"/><path d="M18.6 10.2l3.3 1.1-1.1 3.3" fill="none" stroke="#3a2a05" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function attr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function itDate(isoDay) {
  return isoDay ? String(isoDay).slice(0, 10).split('-').reverse().join('/') : '';
}

function botStart(env, payload) {
  return `https://t.me/${env.BOT_USERNAME || 'MioCashback_bot'}?start=${payload}`;
}

function htmlPage(env, origin, { path, title, description, body, current, status = 200 }) {
  const links = [['/', 'Offerte', 'home'], ['/negozi', 'Negozi', 'negozi'], [`${SITE}/chi-siamo.html`, 'Chi siamo', ''], [botStart(env, 'via_web'), 'Apri il bot', '']];
  const nav = links.map(([href, label, key]) => `<a href="${attr(href)}"${key && key === current ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const html = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${attr(description)}">
<link rel="canonical" href="${attr(origin + path)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="it_IT">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(description)}">
<meta property="og:url" content="${attr(origin + path)}">
${env.GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${attr(env.GOOGLE_SITE_VERIFICATION)}">\n` : ''}<meta name="theme-color" content="#0e5a45">
<link rel="stylesheet" href="${SITE}/site.css">
<style>.offer-code{display:inline-block;border:1.5px dashed var(--coin);border-radius:10px;padding:1px 10px;font-weight:800;letter-spacing:.04em}.store-link{color:var(--ink);text-decoration:none}.store-list{list-style:none;padding:0}.store-list li{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line);margin:0}.store-list li:first-child{border-top:0}</style>
</head>
<body>
<header class="site-header"><div class="inner"><a class="brand" href="/">${LOGO_SVG}Cashback Italia</a><nav class="site-nav" aria-label="Sezioni del sito">${nav}</nav></div></header>
<main class="page">
${body}
</main>
<footer class="site-footer"><div class="inner">
<p>Cashback Italia è un servizio gestito da Alessandro Darida. I link verso i negozi sono link di affiliazione: il negozio ci paga una commissione sui tuoi acquisti e la parte più grande è tua.</p>
<p><a href="/">Offerte</a><a href="/negozi">Negozi</a><a href="${SITE}/chi-siamo.html">Chi siamo</a><a href="${SITE}/termini.html">Termini</a><a href="${SITE}/privacy.html">Privacy</a></p>
</div></footer>
</body>
</html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=900' } });
}

function logoHtml(name, logo) {
  return logo
    ? `<div class="logo"><img src="${attr(logo)}" alt="" loading="lazy" width="52" height="52"></div>`
    : `<div class="logo mono">${escapeHtml(String(name || '?').charAt(0).toUpperCase())}</div>`;
}

function howItWorksHtml(env) {
  const share = Math.round(userShare(env) * 100);
  return `<ol class="steps">
<li><span class="step-n">1</span><div><b>Apri il negozio dal bot Telegram</b><br>Nella Mini App di @${escapeHtml(env.BOT_USERNAME || 'MioCashback_bot')} scegli il negozio, oppure manda al bot il link del prodotto.</div></li>
<li><span class="step-n">2</span><div><b>Compra come sempre</b><br>Stesso sito, stessi prezzi, stesse offerte del negozio.</div></li>
<li><span class="step-n">3</span><div><b>Ricevi la tua parte</b><br>Il negozio ci paga una commissione: il ${share}% è tuo. Quando il negozio conferma l'ordine la prelevi da ${escapeHtml(formatEuro(eurosToCents(env.MIN_PAYOUT_EUR, 1000)))} con PayPal o buono regalo.</div></li>
</ol>`;
}

function offerCardHtml(env, o, withStore) {
  const desc = o.description && o.description.toLowerCase() !== o.title.toLowerCase() ? `<p class="muted small">${escapeHtml(o.description)}</p>` : '';
  const store = withStore
    ? `<p class="store-name"><a class="store-link" href="/negozi/${attr(o.storeId)}">${escapeHtml(o.storeName)}</a></p>`
    : `<p class="store-name">${escapeHtml(o.storeName)}</p>`;
  return `<section class="store">
<div class="store-head">${logoHtml(o.storeName, o.logo)}<div>${store}<p class="store-rate">+ cashback ${escapeHtml(o.cashbackLabel)}</p></div></div>
<h3>${escapeHtml(o.title)}</h3>
${desc}${o.code ? `<p>Codice sconto: <span class="offer-code">${escapeHtml(o.code)}</span></p>` : ''}${o.endDate ? `<p class="tiny">Valida fino al ${itDate(o.endDate)}</p>` : ''}
<div class="cta-row"><a class="btn btn-coin" href="${attr(botStart(env, `o_${o.id}__via_web`))}">Apri l'offerta con cashback</a></div>
</section>`;
}

function seasonalTitle(offers) {
  return offers.some((o) => /black|cyber/i.test(o.title)) ? 'Offerte Black Friday' : 'Offerte del momento';
}

async function handleWeb(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const origin = url.origin;
  // Verifica di Google Search Console con il metodo "file HTML" (GOOGLE_SITE_VERIFICATION_FILE).
  const gfile = String(env.GOOGLE_SITE_VERIFICATION_FILE || '');
  if (/^google[a-z0-9]+\.html$/.test(gfile) && path === `/${gfile}`) {
    return new Response(`google-site-verification: ${gfile}`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  // IndexNow (Bing, Yandex e altri): il file con la chiave dimostra che il sito e' nostro.
  const ink = String(env.INDEXNOW_KEY || '');
  if (/^[a-f0-9]{32}$/.test(ink) && path === `/${ink}.txt`) {
    return new Response(ink, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if (path === '/robots.txt') {
    return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if (!['/', '/negozi', '/offerte', '/sitemap.xml'].includes(path) && !/^\/negozi\/[a-z0-9-]{1,60}$/.test(path)) return null;

  const stores = await listStores(env);
  const offers = await listOffers(env, stores);
  const share = Math.round(userShare(env) * 100);

  if (path === '/sitemap.xml') {
    const day = new Date().toISOString().slice(0, 10);
    const urls = ['/', '/offerte', '/negozi', ...stores.map((s) => `/negozi/${s.id}`)];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${escapeHtml(origin + u)}</loc><lastmod>${day}</lastmod></url>`).join('\n')}\n</urlset>\n`;
    return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  }

  if (path === '/') {
    const top = offers.slice(0, 6);
    const body = `<h1>Una parte della spesa online ti torna indietro</h1>
<p class="lead">Compri nei negozi partner allo stesso prezzo e il ${share}% della commissione che il negozio ci paga torna a te. Funziona su Telegram ed è gratis.</p>
<div class="cta-row"><a class="btn btn-coin" href="${attr(botStart(env, 'via_web'))}">Apri il bot su Telegram</a><a class="btn btn-brand" href="/negozi">Vedi i ${stores.length} negozi</a></div>
${top.length ? `<h2>${seasonalTitle(offers)}</h2>${top.map((o) => offerCardHtml(env, o, true)).join('\n')}${offers.length > top.length ? `<p><a href="/offerte">Tutte le ${offers.length} offerte e i codici sconto</a></p>` : ''}` : ''}
<h2>Come funziona</h2>
${howItWorksHtml(env)}
<h2>Negozi con cashback</h2>
<div class="card"><ul class="store-list">${stores.map((s) => `<li><a href="/negozi/${attr(s.id)}">${escapeHtml(s.name)}</a><span class="muted">${escapeHtml(s.cashbackLabel)}</span></li>`).join('')}</ul></div>`;
    return htmlPage(env, origin, {
      path: '/', current: 'home', body,
      title: `Cashback Italia: cashback su ${stores.length} negozi online e offerte Black Friday`,
      description: `Cashback sui tuoi acquisti online, allo stesso prezzo: il ${share}% della commissione torna a te. ${stores.length} negozi partner, offerte e codici sconto aggiornati ogni giorno.`,
    });
  }

  if (path === '/offerte') {
    const codes = offers.filter((o) => o.code).length;
    const body = `<h1>${seasonalTitle(offers)} e codici sconto</h1>
<p class="lead">Le promozioni pubblicate dai nostri negozi partner${codes ? `, con ${codes} codici sconto` : ''}. Se apri l'offerta dal bot, oltre allo sconto ricevi anche il cashback.</p>
${offers.length ? offers.map((o) => offerCardHtml(env, o, true)).join('\n') : '<p class="card">In questo momento non ci sono offerte attive. Trovi comunque il cashback in tutti i <a href="/negozi">negozi partner</a>.</p>'}
<h2>Come funziona</h2>
${howItWorksHtml(env)}`;
    return htmlPage(env, origin, {
      path: '/offerte', current: 'home', body,
      title: `${seasonalTitle(offers)} e codici sconto con cashback | Cashback Italia`,
      description: `${offers.length} offerte e codici sconto dei negozi partner, aggiornati ogni giorno. Aprili dal bot Telegram: oltre allo sconto ti torna una parte della spesa.`,
    });
  }

  if (path === '/negozi') {
    const cats = [...new Set(stores.map((s) => s.category || 'Altro'))].sort();
    const body = `<h1>Negozi con cashback</h1>
<p class="lead">${stores.length} negozi partner. Per ognuno trovi quanto cashback ricevi, i tempi medi di pagamento e le regole del suo programma di affiliazione.</p>
${cats.map((c) => `<h2>${escapeHtml(c)}</h2><div class="card"><ul class="store-list">${stores.filter((s) => (s.category || 'Altro') === c).map((s) => `<li><a href="/negozi/${attr(s.id)}">${escapeHtml(s.name)}</a><span class="muted">${escapeHtml(s.cashbackLabel)}</span></li>`).join('')}</ul></div>`).join('\n')}
<div class="cta-row"><a class="btn btn-coin" href="${attr(botStart(env, 'via_web'))}">Apri il bot su Telegram</a></div>`;
    return htmlPage(env, origin, {
      path: '/negozi', current: 'negozi', body,
      title: `Negozi con cashback: ${stores.length} negozi online | Cashback Italia`,
      description: `I ${stores.length} negozi online con cashback di Cashback Italia, per categoria: quanto ricevi, tempi di pagamento e regole di ognuno.`,
    });
  }

  // Pagina di un negozio.
  const id = path.slice('/negozi/'.length);
  const s = stores.find((x) => x.id === id);
  if (!s) {
    return htmlPage(env, origin, {
      path, status: 404, title: 'Negozio non trovato | Cashback Italia', description: 'Questo negozio non è tra i partner di Cashback Italia.',
      body: `<h1>Negozio non trovato</h1><p class="lead">Questo negozio non è tra i nostri partner, oppure non lo è più.</p><p><a href="/negozi">Vedi i negozi con cashback</a></p>`,
    });
  }
  const storeOffers = offers.filter((o) => o.storeId === s.id);
  const hasCodes = storeOffers.some((o) => o.code);
  const t = s.timing || {};
  const r = s.rules || {};
  const when = [];
  if (t.validationDays) when.push(`${escapeHtml(s.name)} conferma gli ordini in media in ${t.validationDays} giorni, il tempo per eventuali resi.`);
  if (t.avgPaymentDays) when.push(`In media il cashback diventa prelevabile ${t.avgPaymentDays} giorni dopo l'acquisto (circa ${Math.max(1, Math.round(t.avgPaymentDays / 30))} mesi).`);
  if (t.approvalPercent !== null && t.approvalPercent !== undefined) when.push(`In media il negozio conferma il ${String(t.approvalPercent).replace('.', ',')}% degli ordini.`);
  const rules = ['Apri il negozio dal bot subito prima di comprare: conta l\'ultimo clic.'];
  if (r.cookieDays) rules.push(`Completa l'acquisto entro ${r.cookieDays === 1 ? '24 ore' : `${r.cookieDays} giorni`} dal clic.`);
  if (r.appTracking === false) rules.push('Paga nel browser, non nell\'app del negozio: gli acquisti dall\'app non vengono registrati.');
  rules.push('Accetta i cookie sul sito del negozio e non usare codici sconto trovati su altri siti.');
  const decline = (r.declineReasons || []).length ? `<h2>Quando il cashback può essere annullato</h2><ul>${r.declineReasons.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '';
  const related = stores.filter((x) => x.id !== s.id && x.category === s.category).slice(0, 6);
  const body = `<div class="store-head">${logoHtml(s.name, s.logo)}<div><h1>Cashback ${escapeHtml(s.name)}</h1><p class="store-rate">${escapeHtml(s.cashbackLabel)}${s.category ? ` · ${escapeHtml(s.category)}` : ''}</p></div></div>
<p class="lead">Con Cashback Italia ricevi ${escapeHtml(s.cashbackLabel)} di cashback sugli acquisti da ${escapeHtml(s.name)}, allo stesso prezzo di sempre. Basta aprire il negozio dal nostro bot Telegram prima di comprare.</p>
<div class="cta-row"><a class="btn btn-coin" href="${attr(botStart(env, `s_${s.id}__via_web`))}">Apri ${escapeHtml(s.name)} con cashback</a></div>
${storeOffers.length ? `<h2>Offerte${hasCodes ? ' e codici sconto' : ''} ${escapeHtml(s.name)}</h2>${storeOffers.map((o) => offerCardHtml(env, o, false)).join('\n')}` : ''}
<h2>Quanto ricevi</h2>
<div class="card"><table class="rates"><tr><th>Categoria</th><th>Commissione</th><th>A te</th></tr>${(s.rates || []).map((x) => `<tr><td>${escapeHtml(x.label)}</td><td class="muted">${escapeHtml(x.storePays)}</td><td class="you">${escapeHtml(x.youGet)}</td></tr>`).join('')}</table>
<p class="tiny">La commissione è quello che ${escapeHtml(s.name)} paga a noi: a te ne va il ${share}%.</p></div>
${when.length ? `<h2>Quando arriva</h2><ul>${when.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
<h2>Regole per non perdere il cashback</h2>
<ul>${rules.map((x) => `<li>${x}</li>`).join('')}</ul>
${decline}
<h2>Come funziona</h2>
${howItWorksHtml(env)}
${related.length ? `<h2>Altri negozi: ${escapeHtml(s.category)}</h2><div class="card"><ul class="store-list">${related.map((x) => `<li><a href="/negozi/${attr(x.id)}">${escapeHtml(x.name)}</a><span class="muted">${escapeHtml(x.cashbackLabel)}</span></li>`).join('')}</ul></div>` : ''}
<p class="tiny">Fonte: programma di affiliazione del negozio${s.updatedAt ? `, dati aggiornati al ${itDate(String(s.updatedAt).replace(' ', 'T'))}` : ''}. Le medie descrivono il passato e non sono una garanzia.</p>`;
  return htmlPage(env, origin, {
    path, current: 'negozi', body,
    title: `${hasCodes ? `Codici sconto e cashback ${s.name}` : `Cashback ${s.name}`}: ${s.cashbackLabel} | Cashback Italia`,
    description: `Cashback ${s.name}: ${s.cashbackLabel} sui tuoi acquisti, allo stesso prezzo.${storeOffers.length ? ` ${storeOffers.length} offerte${hasCodes ? ' e codici sconto' : ''} attive.` : ''} Tempi di pagamento, regole e come attivarlo dal bot Telegram.`,
  });
}
