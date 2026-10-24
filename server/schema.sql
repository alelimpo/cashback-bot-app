-- Cashback Bot: schema del database (Cloudflare D1 / SQLite)
-- Tutti gli importi sono in centesimi di euro (interi), per evitare errori di arrotondamento.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,                -- ID Telegram dell'utente
  first_name  TEXT,
  username    TEXT,
  ref_code    TEXT UNIQUE NOT NULL,            -- codice invito personale
  referred_by TEXT,                            -- ID Telegram di chi lo ha invitato
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Catalogo negozi. Un negozio compare nella Mini App solo con active = 1,
-- da impostare quando Awin ti approva nel programma.
CREATE TABLE IF NOT EXISTS stores (
  id               TEXT PRIMARY KEY,           -- slug, es. 'douglas'
  name             TEXT NOT NULL,
  awin_mid         INTEGER NOT NULL UNIQUE,    -- ID del programma su Awin
  domains          TEXT NOT NULL,              -- domini ammessi, separati da virgola
  category         TEXT,
  rate_type        TEXT NOT NULL DEFAULT 'percent', -- 'percent' oppure 'fixed'
  rate_max         REAL NOT NULL,              -- % massima, oppure euro fissi per 'fixed'
  rate_note        TEXT,                       -- nota mostrata all'utente
  user_fixed_cents INTEGER,                    -- se valorizzato: importo fisso all'utente
  active           INTEGER NOT NULL DEFAULT 0, -- 1 quando Awin ti approva (lo imposta il server)
  sort             INTEGER NOT NULL DEFAULT 100,
  details          TEXT,                       -- scheda per l'utente: regole, note, tempi (vedi store-details.sql)
  awin_info        TEXT,                       -- commissioni e tempi letti ogni giorno dall'API Awin
  awin_info_at     TEXT
);

-- Ogni clic dalla Mini App: l'id e' il clickref che Awin restituisce nella transazione.
CREATE TABLE IF NOT EXISTS clicks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  store_id   TEXT NOT NULL,
  dest_url   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clicks_user ON clicks(user_id, created_at);

-- Transazioni Awin collegate agli utenti tramite il clickref.
CREATE TABLE IF NOT EXISTS transactions (
  id                TEXT PRIMARY KEY,          -- ID transazione Awin
  click_id          TEXT,
  user_id           TEXT,
  awin_mid          INTEGER,
  sale_amount_cents INTEGER,
  commission_cents  INTEGER NOT NULL DEFAULT 0,
  currency          TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | approved | declined | deleted
  paid_to_publisher INTEGER NOT NULL DEFAULT 0,      -- 1 quando Awin ti ha pagato
  user_share        REAL NOT NULL,             -- quota utente al momento della vendita
  user_fixed_cents  INTEGER,
  user_amount_cents INTEGER NOT NULL DEFAULT 0,
  transaction_date  TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status, paid_to_publisher);

-- Bonus (per ora: invito di un amico).
CREATE TABLE IF NOT EXISTS bonuses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  ref_user_id  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, reason, ref_user_id)
);

-- Richieste di prelievo: le paghi tu a mano, poi le segni come pagate.
CREATE TABLE IF NOT EXISTS withdrawals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method       TEXT NOT NULL,                  -- 'paypal' | 'buono_regalo'
  destination  TEXT NOT NULL,                  -- email
  status       TEXT NOT NULL DEFAULT 'requested', -- requested | paid | rejected
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals(user_id, status);

-- Segnalazioni degli utenti: negozi che vorrebbero trovare nella Mini App.
CREATE TABLE IF NOT EXISTS store_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  store_name   TEXT NOT NULL,                  -- come l'ha scritto l'utente
  store_key    TEXT NOT NULL,                  -- nome normalizzato, per raggruppare (es. 'zalando')
  website      TEXT,                           -- dominio, se indicato
  note         TEXT,
  store_id     TEXT,                           -- negozio del catalogo, se gia' presente
  awin_matches TEXT,                           -- programmi Awin trovati con lo stesso nome
  status       TEXT NOT NULL DEFAULT 'new',    -- new | working | added | alternative | not_possible
  reply        TEXT,                           -- risposta inviata all'utente
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  handled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_req_user ON store_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_req_key ON store_requests(store_key, status);

-- Impostazioni interne (es. esito dell'ultima sincronizzazione con Awin).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Prima ondata di negozi dal piano di lancio. Tutti spenti (active = 0): il server
-- li accende da solo quando Awin ti approva. Le schede sono in store-details.sql.
INSERT OR IGNORE INTO stores (id, name, awin_mid, domains, category, rate_type, rate_max, rate_note, user_fixed_cents, active, sort) VALUES
  ('temu',        'Temu',        118233, 'temu.com',                    'Marketplace', 'percent', 10,    'sul primo ordine; poi molto meno', NULL, 0, 10),
  ('shein',       'Shein',       20431,  'shein.com',                   'Moda',        'percent', 15,    'sul primo ordine; poi molto meno', NULL, 0, 20),
  ('unieuro',     'Unieuro',     10139,  'unieuro.it',                  'Elettronica', 'percent', 5,     'varia per categoria',              NULL, 0, 30),
  ('mediaworld',  'MediaWorld',  18529,  'mediaworld.it',               'Elettronica', 'percent', 4.04,  'varia per categoria',              NULL, 0, 40),
  ('adidas',      'adidas',      77014,  'adidas.it',                   'Sport',       'percent', 2,     NULL,                               NULL, 0, 50),
  ('italo',       'Italo Treno', 9685,   'italotreno.com,italotreno.it','Viaggi',      'percent', 4.2,   'varia per tariffa',                NULL, 0, 60),
  ('douglas',     'Douglas',     9449,   'douglas.it',                  'Bellezza',    'percent', 12,    NULL,                               NULL, 0, 70),
  ('kiko',        'Kiko',        9744,   'kikocosmetics.com',           'Bellezza',    'percent', 11.5,  NULL,                               NULL, 0, 80),
  ('calzedonia',  'Calzedonia',  73041,  'calzedonia.com',              'Moda',        'percent', 11.54, NULL,                               NULL, 0, 90),
  ('intimissimi', 'Intimissimi', 73037,  'intimissimi.com',             'Moda',        'percent', 11.54, NULL,                               NULL, 0, 91),
  ('tezenis',     'Tezenis',     73043,  'tezenis.com',                 'Moda',        'percent', 11.54, NULL,                               NULL, 0, 92),
  ('vodafone',    'Vodafone',    9418,   'vodafone.it',                 'Telefonia',   'fixed',   51,    'per attivazione fibra o ADSL online', NULL, 0, 100);
