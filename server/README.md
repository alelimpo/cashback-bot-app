# Server del Cashback Bot

Backend su Cloudflare Workers (piano gratuito) con database D1.

- Indirizzo: `https://cashback-bot.alelimpo.workers.dev`
- Database: `cashback-bot` (Europa occidentale)
- Pubblicazione: automatica a ogni modifica di questa cartella su GitHub (Cloudflare Workers Builds)

## Cosa fa

1. La Mini App chiede un link: il server verifica la firma di Telegram, crea un clickref e restituisce il link Awin.
2. Awin avvisa il server a ogni vendita (`/awin/notify/...`): nasce un cashback "in attesa".
3. Ogni ora il server legge le transazioni dall'API Awin. Il cashback diventa "disponibile" solo quando la vendita è approvata **e** pagata a te.
4. Da 10 € l'utente chiede il prelievo; tu ricevi un messaggio su Telegram e lo paghi a mano dalla sezione admin della Mini App.

## Segreti (dashboard Cloudflare > Worker cashback-bot > Impostazioni > Variabili e segreti)

| Nome | Dove si prende |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | @BotFather su Telegram |
| `AWIN_API_TOKEN` | https://ui.awin.com/awin-api |

Gli indirizzi segreti per Awin e Telegram vengono ricavati dal token del bot: non serve altro.

## Impostazioni (`wrangler.toml`)

`USER_SHARE` quota all'utente, `MIN_PAYOUT_EUR` soglia di prelievo, `REFERRAL_BONUS_EUR` bonus invito,
`FX_TO_EUR` cambio per i programmi in altre valute, `ADMIN_IDS` il tuo ID Telegram, `BOT_USERNAME` il nome del bot.
Modifica il file su GitHub: Cloudflare ripubblica da solo.

## Gestione negozi

Dashboard Cloudflare > Storage e database > D1 > `cashback-bot` > Console:

```sql
-- accendere un negozio quando Awin ti approva
UPDATE stores SET active = 1 WHERE id = 'douglas';

-- aggiungerne uno nuovo (ID Awin del programma, dominio, commissione massima per te)
INSERT INTO stores (id, name, awin_mid, domains, category, rate_type, rate_max, active)
VALUES ('ovs', 'OVS', 37020, 'ovs.it', 'Moda', 'percent', 5.88, 1);
```

## Test in locale

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:init:local
npx wrangler d1 execute cashback-bot --local --command "UPDATE stores SET active = 1 WHERE id IN ('douglas','temu','vodafone')"
node test/mock-services.mjs &
npx wrangler dev --ip 127.0.0.1 --test-scheduled &
npm test
```
