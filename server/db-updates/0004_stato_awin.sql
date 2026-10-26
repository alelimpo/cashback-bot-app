-- Migrazione per il database gia' in uso (26/10/2026): stato della richiesta su Awin per ogni negozio.
ALTER TABLE stores ADD COLUMN awin_status TEXT;
