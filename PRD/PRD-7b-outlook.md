# PRD 7b — Outlook

Leverantören `outlook` enligt kontraktet i PRD 7: Microsoft 365-konton
(jobb, skola) och personliga konton (outlook.com, hotmail.com, live.com).
Allt som inte står här står i PRD 7.

Uppgifter om Microsofts gränser och regler nedan är hämtade ur dokumentation,
inte mätta. De som styr designen är listade under *Att mäta*.

## Val av API

**Microsoft Graph**, `https://graph.microsoft.com/v1.0`, med Nodes egen
`fetch`. Inte EWS: Microsoft avvecklar det för Exchange Online. Inte IMAP:
samma skäl som i PRD 7a, och i många organisationer är IMAP avstängt. Inte
MSAL: ett auktoriseringsbibliotek för två POST-anrop som kärnan redan gör.

Exchange on-premises nås inte av Graph och är utanför den här PRD:n. Behövs
det blir det en egen leverantör.

## 1. Registrering

1. Microsoft Entra admin center → *App registrations → New registration*
   - namn `mike-mail`
   - kontotyper: **Accounts in any organizational directory and personal
     Microsoft accounts** — det täcker både `onvo.se` och ett outlook.com-konto
     med en registrering
   - redirect URI, plattform **Web**:
     `https://kontoret.onvo.se:3456/mail/oauth/callback`
2. *Certificates & secrets → New client secret*. Välj längsta giltighet och
   skriv utgångsdatumet i `/etc/mike-mail.env` som en kommentar (se 3)
3. *API permissions → Microsoft Graph → Delegated*: `Mail.Read`,
   `offline_access`, `User.Read`
4. Om kontot tillhör en organisation där användare inte får ge samtycke:
   *Grant admin consent*
5. Klient-id och hemlighet till `/etc/mike-mail.env`

Plattform **Web** och inte *SPA*: SPA-plattformen ger refresh-tokens som
gäller i 24 timmar och kräver att växlingen görs från en webbläsare. Inte
heller *Mobile and desktop* — det skulle fungera som publik klient utan
hemlighet, men då är redirect-URI:n och klient-id:t allt som skiljer Mike från
vem som helst som kopierat dem.

Authority är `https://login.microsoftonline.com/common/oauth2/v2.0`, eftersom
båda kontotyperna ska fungera. PKCE används trots att klienten har en
hemlighet; det kostar ingenting och är vad Microsoft rekommenderar.

## 2. Scopes

`offline_access Mail.Read User.Read`

`Mail.Read` är det minsta som ger brödtext. `Mail.ReadBasic` ger rubriker men
inte `body`, `bodyPreview` eller `uniqueBody` — ingenting att läsa.
`offline_access` ger refresh-token. `User.Read` ger adressen till `identify`.

`Mail.Read` är delegerad och kräver i standardfallet inte administratörens
samtycke. Organisationer kan ändå ha stängt av användarsamtycke helt; då är
steg 4 under registreringen nödvändigt.

## 3. Tokens

Access-token: runt en timme, varierar. Refresh-token: **roterar**. Varje
förnyelse ger en ny refresh-token och den nya måste sparas innan den gamla
glöms, annars är kontot förlorat vid nästa förnyelse:
`auth.rotatesRefreshToken = true`, och kärnan skriver den nya till disk
atomärt (skriv till temporär fil, `rename`) innan access-token används.

Refresh-token gäller i 90 dagar och förlängs varje gång den används. Ett konto
som frågas minst en gång i kvartalet loggas alltså aldrig ut av sig själv.

Sätt kontot hamnar i `needsLogin`:

- lösenordsbyte eller återkallade sessioner i organisationen
- **klienthemligheten gått ut** — det här drabbar *alla* Outlook-konton på en
  gång, med `invalid_client` och inte `invalid_grant`. mike-mail loggar en
  varning 30 dagar före utgångsdatumet om det står i miljön
  (`MIKE_OUTLOOK_SECRET_EXPIRES=ÅÅÅÅ-MM-DD`)
- villkorsstyrd åtkomst i organisationen (plats, enhet, MFA-intervall) —
  går inte att förutse härifrån; syns som `interaction_required`

## 4. Mappning

| kontrakt | anrop |
|---|---|
| `identify` | `GET /me?$select=mail,userPrincipalName,displayName` |
| `list` | `GET /me/mailFolders/{mapp}/messages?$select=…&$top=limit` med `$filter` eller `$search` enligt 5 |
| `get` | `GET /me/messages/{id}?$select=…,body,uniqueBody` |

Alla anrop skickar:

```
Prefer: IdType="ImmutableId", outlook.body-content-type="text"
```

`$select` för `list`: `id,conversationId,from,toRecipients,subject,
receivedDateTime,bodyPreview,isRead,hasAttachments,parentFolderId`.

Till skillnad från Gmail ger Graph rubrikerna i listan. En `list` är ett anrop.

`{mapp}` är de välkända namnen `inbox` och `sentitems`. `folder: all` använder
`/me/messages` utan mapp, som också omfattar skräppost och borttaget; de
filtreras bort på `parentFolderId` mot id:n hämtade en gång per konto.

Fält i `MailSummary`:

| fält | källa |
|---|---|
| `id`, `threadId` | `id`, `conversationId` |
| `from`, `to` | `from.emailAddress`, `toRecipients[].emailAddress` |
| `subject` | `subject` |
| `date` | `receivedDateTime` |
| `snippet` | `bodyPreview` |
| `unread` | `!isRead` |
| `hasAttachments` | `hasAttachments` (falskt för bara inbäddade bilder) |
| `folder` | `parentFolderId` mot kontots mapp-id:n |

`count`: `GET /me/mailFolders/inbox?$select=unreadItemCount,totalItemCount`
ger exakta tal för mappen; en sökning ger inga. `capabilities.count =
"exact"` gäller därför bara frågor som är `unread` + mapp och inget annat,
och annars finns inget antal.

## 5. Frågeöversättning

Graph har två frågevägar och **de går inte att kombinera**. `$search`
(KQL, fritext) kan inte användas tillsammans med `$filter` eller `$orderby`
på meddelanden. Översättningen måste därför välja väg per fråga:

**Väg A, `$filter`** — när frågan saknar fritext:

| fält | `$filter` |
|---|---|
| `unread` | `isRead eq false` |
| `since` | `receivedDateTime ge 2026-09-14T00:00:00Z` |
| `until` | `receivedDateTime lt …` |
| `hasAttachment` | `hasAttachments eq true` |
| `from` som hel adress | `from/emailAddress/address eq '…'` |

med `$orderby=receivedDateTime desc`. Graph kräver att en egenskap i
`$orderby` också står **först** i `$filter`, i samma ordning, annars
svarar den `InefficientFilter`. Varje filter börjar därför med
`receivedDateTime ge 1900-01-01T00:00:00Z` när inget `since` finns.

**Väg B, `$search`** — när frågan har `text`, `subject`, `to` eller ett
`from` som inte är en hel adress:

| fält | KQL |
|---|---|
| `from` | `from:…` |
| `to` | `to:…` |
| `subject` | `subject:…` |
| `text` | `…` |
| `since` / `until` | `received>=ÅÅÅÅ-MM-DD` / `received<ÅÅÅÅ-MM-DD` |
| `hasAttachment` | `hasattachments:true` |

`unread` efterfiltreras på `isRead` i väg B. Eftersom efterfiltrering kan
lämna färre än `limit` hämtas i väg B `limit × 3`, högst 50, och svaret
kapas. Räcker det inte säger svaret att sökningen var ungefärlig.

`$search` sorteras av Graph efter datum; ingen egen sortering behövs, men
kärnan sorterar ändå sammanslagna resultat från flera konton.

**Citering.** Hela `$search`-värdet står inom dubbla citattecken i URL:en.
Citattecken och KQL-operatorer (`AND`, `OR`, `NOT`, `:`) i ett värde från Mike
tas bort. Enkla citattecken i `$filter`-strängar dubbleras. Testas med
fixtures.

## 6. Text

Med `outlook.body-content-type="text"` konverterar Exchange HTML till text på
sin sida: `bodySource: "text"`, och kärnans HTML-konvertering behövs inte.
Det är Microsofts konvertering, inte kärnans, så resultatet skiljer sig från
Gmails i detaljer — acceptabelt, eftersom en modell läser det.

`uniqueBody` är den del av meddelandet som är ny i tråden, utan citerad
historik. Den blir `newPartText`, och `capabilities.newPart = true`.
Karantänläsaren får `newPartText` när den finns och hela `bodyText` bara om
frågan kräver det — kortare text, snabbare läsare.

Teckenkodning är inget problem: Graph svarar alltid i JSON, UTF-8.

## 7. Id

Utan `Prefer: IdType="ImmutableId"` byter ett meddelande id när det flyttas
mellan mappar, vilket gör en referens från `mail_list` ogiltig om Mannie
arkiverar mejlet i telefonen innan *"läs det andra"*. Med headern är id:t
stabilt så länge meddelandet ligger i samma brevlåda.

`conversationId` är Outlooks tråd.

## 8. Kvoter

Graph begränsar per app och brevlåda: i storleksordningen 10 000 anrop per
tio minuter och fyra samtidiga anrop. Fyra samtidiga är den gräns som faktiskt
kan nås — en fråga över flera Outlook-konton går till olika brevlådor och
räknas separat, men leverantören får aldrig göra mer än fyra parallella anrop
mot samma konto. 429 med `Retry-After` hanteras av kärnan.

## 9. Fel

| svar | `classifyError` |
|---|---|
| 401, `invalid_grant`, `interaction_required` | `auth` |
| `invalid_client` vid förnyelse | `auth`, och loggas som *klienthemligheten* |
| 403 `ErrorAccessDenied` | `auth` — samtycke saknas eller togs bort |
| 404 `ErrorItemNotFound` | `notFound` |
| 400 `InefficientFilter` | `other` — en bugg i översättningen, loggas i sin helhet |
| 429 | `rate` |
| 500, 502, 503, 504 | `unavailable` |

Graph-fel har formen `{ error: { code, message } }`; det är `code` som
avgör, inte statusen.

## 10. Fixtures

`test/fixtures/mail/outlook/`, inspelade från ett testkonto, aldrig från
Mannies brevlåda. Minst:

- `list` väg A och väg B, utan träffar, med en, med tjugo
- `list` väg B med `unread`, där efterfiltreringen lämnar färre än `limit`
- `get` med och utan `uniqueBody`, med bilaga, med bara inbäddad bild
- förnyelse som returnerar ny refresh-token
- 401, 403 `ErrorAccessDenied`, 404, 429 med `Retry-After`, 400
  `InefficientFilter`, `invalid_client`
- ett mejl vars brödtext innehåller en instruktion till Mike (PRD 7 AC 2)

Plus ett test som bara finns här: förnyelsen skriver den nya refresh-token till
disk *innan* access-token används, och en krasch mellan växling och skrivning
lämnar den gamla intakt.

## 11. Drift

`/etc/mike-mail.env`:

```
MIKE_OUTLOOK_CLIENT_ID=…
MIKE_OUTLOOK_CLIENT_SECRET=…
MIKE_OUTLOOK_SECRET_EXPIRES=ÅÅÅÅ-MM-DD
```

Redirect-URI registrerad i Entra: `https://kontoret.onvo.se:3456/mail/oauth/callback`.

Klienthemligheten har ett utgångsdatum som inte går att ta bort. Att förnya den
är en rutin, inte en incident — och det är den enda rutinen i hela mejlstödet
som slutar fungera för alla konton samtidigt om den glöms.

## 12. Att mäta

Innan koden skrivs:

1. **Organisationens samtycke.** Logga in med `onvo.se`-kontot utan
   administratörens samtycke. Går det, eller måste steg 4 göras?
2. **Villkorsstyrd åtkomst.** Förnyar en token från serverns IP när
   inloggningen gjordes i telefonen på ett annat nät? Policyer som binder till
   plats eller enhet syns först här.
3. **`$search` med datum.** Bekräfta att `received>=` fungerar i `$search` mot
   meddelanden, och vad `$search` gör med svenska tecken i `from:`.
4. **`InefficientFilter`.** Bekräfta att regeln om `receivedDateTime` först
   räcker för alla kombinationer i väg A.
5. **Personligt konto.** Samma registrering mot ett outlook.com-konto:
   fungerar `uniqueBody`, `ImmutableId` och `$search` likadant som i
   Microsoft 365?
