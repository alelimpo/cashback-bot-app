-- Migrazione facoltativa (23/11/2026): il server crea la tabella da solo al primo uso.
CREATE TABLE IF NOT EXISTS news_optout (
  user_id    TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
