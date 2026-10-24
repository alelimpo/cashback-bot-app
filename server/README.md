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

Facoltativi, per ricevere anche via email le segnalazioni dei negozi (su Telegram arrivano comunque):

| Nome | Dove si prende |
| --- | --- |
| `RESEND_API_KEY` | account gratuito su https://resend.com > API Keys (3000 email al mese) |
| `NOTIFY_EMAIL` | l'indirizzo email con cui hai creato l'account Resend |

Senza un dominio verificato Resend scrive solo all'indirizzo del tuo account: per le segnalazioni basta.
"Configura e verifica" nella Mini App manda un'email di prova.

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
durata del cookie, base di calcolo (IVA e spedizione), prodotti esclusi, motivi di annullamento,
approvazione automatica, stato dei pagamenti del negozio verso Awin (il "semaforo"), note.
Serve anche da riserva finché l'API non risponde. Queste voci vengono dal profilo e dai termini del
programma su Awin, non dall'API: il semaforo in particolare cambia nel tempo, quindi ricontrollalo
ogni mese circa e aggiorna la scheda (la Mini App mostra la data del controllo).

La seconda ondata (79 programmi in attesa di approvazione) è in `src/catalog.json`, con le regole lette
dai termini di ciascun programma: a ogni giro il server aggiunge al database i negozi che mancano, senza
toccare le schede già presenti. Se Awin ti approva un programma che non è in nessun elenco (per esempio
un'iscrizione fatta a mano dal sito Awin), il server lo aggiunge da solo con nome, domini e categoria
presi da Awin. Un negozio appena approvato compare nella Mini App quando il server ha letto le sue
commissioni (fino a 4 negozi all'ora).

Per aggiungere a mano un negozio nuovo (dashboard Cloudflare > Storage e database > D1 > `cashback-bot` > Console):

```sql
INSERT INTO stores (id, name, awin_mid, domains, category, rate_type, rate_max)
VALUES ('ovs', 'OVS', 37020, 'ovs.it', 'Moda', 'percent', 5.88);
```

Si accenderà da solo quando Awin ti approva nel programma 37020.

## Segnalazioni dei negozi

Dalla Mini App gli utenti segnalano i negozi che vorrebbero (massimo 5 al giorno a testa). Per ogni
segnalazione ricevi un messaggio sul bot (e un'email, se configurata) con il numero di utenti che lo
chiedono e, se esiste, il link al programma Awin italiano dello stesso negozio. Nella sezione Admin
della Mini App le segnalazioni sono raggruppate per negozio: con un tocco rispondi "Ci lavoro",
"Aggiunto", "Alternativa" o "Non possibile", e il bot scrive a tutti quelli che l'avevano chiesto.
Quando Awin approva un negozio, le segnalazioni che lo riguardano si chiudono da sole e gli utenti
ricevono il messaggio. Il database già in uso va aggiornato una volta con `db-updates/0003_segnalazioni.sql`.

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
