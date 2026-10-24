-- Migrazione per il database gia' in uso (24/10/2026): segnalazioni dei negozi da aggiungere.
CREATE TABLE IF NOT EXISTS store_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  store_name   TEXT NOT NULL,
  store_key    TEXT NOT NULL,
  website      TEXT,
  note         TEXT,
  store_id     TEXT,
  awin_matches TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  reply        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  handled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_req_user ON store_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_req_key ON store_requests(store_key, status);
