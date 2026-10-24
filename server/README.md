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

I negozi si accendono **da soli**: ogni ora il server chiede ad Awin a quali programmi sei iscritto.
Quando Awin ti approva, il negozio compare nella Mini App e ricevi un messaggio sul bot; se l'iscrizione
viene chiusa, sparisce. Una volta al giorno il server legge da Awin, per ogni negozio attivo, le
commissioni per categoria, il tempo medio di pagamento, i giorni di convalida e la percentuale di
ordini approvati: la Mini App mostra questi numeri, già moltiplicati per la quota utente.

Ogni negozio ha anche una scheda (`store-details.sql`) con le regole che Awin non fornisce via API:
durata del cookie, motivi di annullamento, note. Serve anche da riserva finché l'API non risponde.

Per aggiungere un negozio nuovo (dashboard Cloudflare > Storage e database > D1 > `cashback-bot` > Console):

```sql
INSERT INTO stores (id, name, awin_mid, domains, category, rate_type, rate_max)
VALUES ('ovs', 'OVS', 37020, 'ovs.it', 'Moda', 'percent', 5.88);
```

Si accenderà da solo quando Awin ti approva nel programma 37020.

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
