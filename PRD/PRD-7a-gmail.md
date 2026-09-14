# PRD 7a — Gmail

Leverantören `gmail` enligt kontraktet i PRD 7. Allt som inte står här — tokens
på disk, omförsök, text, verktyg, karantän — står där och ändras inte här.

Uppgifter om Googles gränser och regler nedan är hämtade ur dokumentation, inte
mätta. De som styr designen är listade under *Att mäta* och ska verifieras
innan koden skrivs.

## Val av API

**Gmail API över REST**, med Nodes egen `fetch`. Inte IMAP: det kräver
XOAUTH2 ovanpå en IMAP-klient, ger Gmails etiketter som låtsasmappar och har
ingen motsvarighet till `q`. Inte `googleapis`-paketet: det är tiotals megabyte
för fyra anrop, och projektet har två beroenden.

## 1. Registrering

1. Google Cloud Console → nytt projekt `mike-mail`
2. *APIs & Services → Library* → aktivera **Gmail API**
3. *OAuth consent screen*:
   - användartyp **External** för ett vanligt Gmail-konto, **Internal** om
     kontot är Google Workspace och projektet ligger i samma organisation
   - appnamn, supportadress, utvecklaradress
   - lägg till scopet under 2
   - publiceringsstatus: se 3, det är det viktigaste valet här
4. *Credentials → Create OAuth client ID* → typ **Web application**
   - authorized redirect URI:
     `https://kontoret.onvo.se:3456/mail/oauth/callback`
5. Klient-id och hemlighet till `/etc/mike-mail.env`

Web application och inte Desktop, eftersom callbacken tas emot på den publika
servern (PRD 7, *Att lägga till ett konto*). Googles regler för redirect-URI
kräver https och ett riktigt domännamn; `kontoret.onvo.se` uppfyller båda.

## 2. Scopes

`https://www.googleapis.com/auth/gmail.readonly`

Det är det minsta som räcker. `gmail.metadata` ger rubriker men varken
brödtext eller `q`-sökning, och utan dem finns inget att läsa.

`gmail.readonly` är ett **begränsat** scope hos Google. För en app som ska ut
till allmänheten betyder det verifiering och en säkerhetsgranskning från
tredje part. För en app med en användare betyder det i praktiken en
varningsskärm *"Google har inte verifierat den här appen"* vid inloggning,
som klickas förbi. Mike ska aldrig ha fler användare än en.

`openid email` läggs till för att `identify` ska få adressen ur id-token
utan ett extra anrop — eller så används `users.getProfile`, som redan
omfattas av `gmail.readonly`. Det senare väljs: ett scope färre.

## 3. Tokens

Access-token: en timme. Refresh-token: roterar inte.

**Fällan.** En app med användartyp External i publiceringsstatus **Testing**
får refresh-tokens som slutar gälla efter **sju dagar**. Kontot hamnar då i
`needsLogin` varje vecka, utan att något gått fel. Tre vägar:

| | sju dagar | varning vid inloggning | granskning |
|---|---|---|---|
| External, Testing | ja | nej, men bara listade testanvändare | nej |
| External, In production, overifierad | nej | ja | nej, under 100 användare |
| Internal (Workspace) | nej | nej | nej |

Välj **Internal** om kontot är Workspace, annars **In production,
overifierad**. Testing bara under utvecklingen.

Andra sätt en token dör: Mannie ändrar lösenordet (för konton med
Gmail-scope), återkallar åtkomsten under *Säkerhet → Tredjepartsappar*, eller
kontot har inte använt token på sex månader. Alla ger `invalid_grant` vid
förnyelse och mappas till `needsLogin`.

Auktorisering med `access_type=offline` och `prompt=consent`; utan det
senare ger Google ingen ny refresh-token vid en andra inloggning.

## 4. Mappning

Bas: `https://gmail.googleapis.com/gmail/v1/users/me`

| kontrakt | anrop |
|---|---|
| `identify` | `GET /profile` → `emailAddress` |
| `list` | `GET /messages?q=…&maxResults=limit`, sedan per id `GET /messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date` |
| `get` | `GET /messages/{id}?format=full` |

`messages.list` ger bara id och tråd-id. Rubrikerna kräver ett anrop per
träff, som görs parallellt — med `limit` högst 20 är det högst 21 anrop.
Gmails batch-endpoint (multipart/mixed) sparar rundturer men är en egen parser
för ett problem som inte finns i den här skalan. Tas inte.

Fält i `MailSummary`:

| fält | källa |
|---|---|
| `id`, `threadId` | `id`, `threadId` |
| `from`, `to` | rubrikerna, parsade (namn + adress, RFC 5322-citat) |
| `subject` | rubriken `Subject`, MIME-avkodad (`=?UTF-8?B?…?=`) |
| `date` | `internalDate` (ms), inte `Date`-rubriken — den är avsändarens klocka |
| `snippet` | `snippet`, HTML-entiteter avkodade |
| `unread` | `labelIds` innehåller `UNREAD` |
| `hasAttachments` | någon del i `payload` har `filename` |
| `folder` | `INBOX`, `SENT` eller `all` ur `labelIds` |

`count` är `resultSizeEstimate`, vilket Google själv kallar en uppskattning:
`capabilities.count = "estimate"`. För *"hur många olästa"* i inkorgen ger
`GET /labels/INBOX` exakta `messagesUnread`; `list` använder det när frågan
är just `unread` + `folder: inbox` och inget annat.

## 5. Frågeöversättning

Varje fält blir en del av `q`, sammanfogade med mellanslag (AND):

| fält | `q` |
|---|---|
| `unread` | `is:unread` |
| `from` | `from:(…)` |
| `to` | `to:(…)` |
| `subject` | `subject:(…)` |
| `text` | `(…)` |
| `since` | `after:ÅÅÅÅ/MM/DD` |
| `until` | `before:ÅÅÅÅ/MM/DD` |
| `hasAttachment` | `has:attachment` |
| `folder: inbox` | `in:inbox` |
| `folder: sent` | `in:sent` |
| `folder: all` | ingenting — utan `in:` söker Gmail redan allt utom skräppost och papperskorg |

Allt stöds; ingen efterfiltrering behövs.

**Citering.** Värden kommer från en modell som hört en människa. Citattecken,
parenteser och operatorord (`OR`, `-`, `from:`) i värdet tas bort eller citeras
så att *"från Anna OR is:starred"* inte blir en annan fråga än den som ställdes.
Testas med fixtures.

**Datum.** `after:` och `before:` tolkas av Gmail i kontots tidszon och är
datumupplösta. `since` med klockslag avrundas nedåt till dagen och resten
efterfiltreras på `internalDate`.

## 6. Text

`format=full` ger `payload` som ett träd av MIME-delar. Brödtexten är den första
`text/plain` i en djupet-först-genomgång som inte är en bilaga; finns ingen,
den första `text/html` med `bodySource: "html"`. `multipart/alternative`
föredrar `text/plain`.

`body.data` är base64url. Stora delar kommer inte inline utan som
`body.attachmentId`, och hämtas med `GET /messages/{id}/attachments/{aid}` —
gäller även brödtext över ungefär en megabyte.

`newPartText`: Gmail ger ingen. `capabilities.newPart = false`; kärnans
citatborttagning gör jobbet.

## 7. Id

Gmails meddelande-id är stabilt över etikettändringar, eftersom en *mapp* i
Gmail är en etikett och meddelandet aldrig flyttas. `threadId` är Gmails tråd.

## 8. Kvoter

Gmail räknar i kvotenheter per användare: `messages.list` och `messages.get`
kostar 5 var. En `list` med `limit: 20` kostar alltså 105 enheter. Gränsen
per användare ligger flera storleksordningar över vad en röst hinner be om.
429 hanteras av kärnan.

## 9. Fel

| svar | `classifyError` |
|---|---|
| 401, eller `invalid_grant` vid förnyelse | `auth` |
| 403 med `reason` `rateLimitExceeded` / `userRateLimitExceeded` | `rate` |
| 403 med annan `reason` (API avstängt, scope saknas) | `other`, loggas med `reason` |
| 404 | `notFound` |
| 429 | `rate` |
| 500, 502, 503, 504 | `unavailable` |

403 kan alltså betyda två helt olika saker och måste läsas i kroppen, inte
bara statusen.

## 10. Fixtures

`test/fixtures/mail/gmail/`, inspelade från ett testkonto med skickade
testmejl, aldrig från Mannies brevlåda. Minst:

- `list` utan träffar, med en, med tjugo
- `get` för: ren text, bara HTML, `multipart/alternative`, en bilaga,
  brödtext via `attachmentId`, ISO-8859-1-kodad, MIME-kodat ämne
- 401, 403 med båda `reason`-varianterna, 404, 429 med `Retry-After`
- ett mejl vars brödtext innehåller en instruktion till Mike (PRD 7 AC 2)

Adresser och namn i inspelningarna ersätts innan de checkas in.

## 11. Drift

`/etc/mike-mail.env`:

```
MIKE_GMAIL_CLIENT_ID=…
MIKE_GMAIL_CLIENT_SECRET=…
```

Redirect-URI registrerad hos Google: `https://kontoret.onvo.se:3456/mail/oauth/callback`.
Ändras värdnamn eller port måste den ändras i Cloud Console samtidigt, annars
svarar Google `redirect_uri_mismatch` och ingenting på maskinen syns fel.

## 12. Att mäta

Innan koden skrivs:

1. **Sjudagarsgränsen och vägen runt den.** Lägg upp klienten som *External, In
   production* med `gmail.readonly`, logga in, och bekräfta att varningsskärmen
   går att klicka förbi och att förnyelse fortfarande fungerar efter åtta
   dagar. Om Google spärrar overifierade appar med begränsade scopes helt är
   Workspace-Internal eller ett applösenord över IMAP (en `custom`-leverantör)
   det som återstår — och då ändras den här PRD:n.
2. **Port i redirect-URI.** Bekräfta att Cloud Console accepterar `:3456`.
3. **Teckenkodning.** Är `body.data` för en ISO-8859-1-del de ursprungliga
   byten eller omkodad till UTF-8? Avgör om `text.js` behöver läsa `charset`.
4. **Lösenordsbyte.** Dör en refresh-token med `gmail.readonly` vid byte av
   lösenord, som dokumentationen antyder?
