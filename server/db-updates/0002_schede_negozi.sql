-- Migrazione per il database gia' in uso (24/10/2026): aggiunge le schede dei negozi.
-- Dopo questa, eseguire store-details.sql.
ALTER TABLE stores ADD COLUMN details TEXT;
ALTER TABLE stores ADD COLUMN awin_info TEXT;
ALTER TABLE stores ADD COLUMN awin_info_at TEXT;
