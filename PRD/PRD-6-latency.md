# PRD 6 — Väntan

Linsen står på "thinking" väldigt länge. Räknaren (048a77f) gjorde det
synligt; den här skrivelsen handlar om att göra det kortare, eller åtminstone
uthärdligt.

## Var tiden går

En tur är en `claude`-process (claudeCli.js, huvudkommentaren): ~5 s varm,
~8,7 s första gången, innan ett enda ord kommer ut. Ovanpå det ligger
modellens egen svarstid, som för en riktig fråga är den större delen. Inget
av svaret visas förrän processen stängt, för `--output-format json` ger ett
svar i ett stycke.

Det är två skilda problem och bara det ena är latens:

1. **Kallstarten** — ~5–9 s ren overhead per tur.
2. **Tystnaden** — även när modellen svarar bra står linsen tom hela tiden.
   En tur som tar 40 s och en tur som hängt ser likadana ut (räknaren till
   trots).

## Förslag, i ordningen de är värda att göra

**1. Strömma svaret (`--output-format stream-json`).** Första meningen når
linsen när den skrivs i stället för när processen dör. Ändrar ingenting i
turmodellen — fortfarande en process per tur, fortfarande session-id som enda
durabla tillstånd — bara parsningen i claudeCli.js och en delleverans genom
workerEngine till klienten. Detta är den enskilt största vinsten i upplevd
väntan och den minst riskabla ändringen.

**2. Säg vad den gör.** Samma ström bär verktygsanrop. "läser
workerEngine.js" på statusraden i stället för "thinking 18s" svarar på frågan
användaren faktiskt ställer när de tittar upp.

**3. Först då kallstarten.** `--input-format stream-json` med en resident
process per worker är vägen, men T1 avvisade långlivade processer av ett skäl
som står kvar: två drivare av samma session grenar transkriptet tyst. Tas
inte innan 1 och 2 är gjorda och mätta — de kan visa sig räcka.

## Vad som är gjort

**1 är byggd** (7c6984b). `--output-format stream-json`, samma en process per
tur, men strömmen läses medan den skrivs: verktygsnamnet och svarets första
mening går som `progress`-händelser genom jarvis.say och engine.send ut till
klienten. Mätt mot riktiga CLI:t: "Read" på linsen efter 2,3 s i en tur som
tog 4,5 s. Det partiella hamnar på linsen men inte i transkriptet — det
färdiga svaret kommer ändå och ska vara sista ordet.

**2 följde med samma ändring**: statusraden säger verktygets namn i stället
för "thinking" så fort den vet ett, och det gäller glasögonen lika mycket som
telefonen — det är samma statusrad.

**3. Konfirmationen är byggd.** Statusraden var för tyst för att vara
kvittot: ett ord som byts från "listening" till "thinking" i hörnet är inget
man ser på glas medan man håller på med annat, och linsen visade under tiden
kvar det FÖRRA svaret — vilket är det enda som läser som att ingenting hände.
Nu bär linsen tillbaka vad turen svarar på, `» bygg klart testerna`, från att
turen startar tills första ordet av svaret finns. Ekot gäller bara yttranden
från den här turen (ECHO_SLACK_MS), så ett eko av något som sades för en
minut sedan aldrig kan ljuga om vad som är på gång. Ekot är sedan 4 och 5
ersatt av turens egna delar, som svarar på samma fråga och dessutom på
"fick den med allt jag sa".

**4. Uppdelade meningar blir en tur** (bd43390). Segmenteraren stänger ett
segment efter 700 ms tystnad — rätt för "har personen slutat prata", fel för
"har personen tänkt färdigt". Ett yttrande hålls nu `--hold` millisekunder
(2000 som förval, 0 stänger av) och allt till samma mottagare inom fönstret
blir ett. Skrivna ord väntar aldrig. Ett oadresserat fragment får gå in i ett
öppet fönster: i ByName sa användaren namnet en gång, som folk gör.

Fönstret lägger till latens på varje talad tur, alltså precis det den här
skrivelsen finns för att ta bort. Det är uthärdligt bara för att fragmenten
syns när de hörs, inte när turen startar — och det är därför det är en
inställning och inte ett tal i koden.

**5. Turen är något med namn** (bd43390). `held`, `queued`, `started`, `done`,
`dropped` som transienta händelser, med användarens egna ord som separata
delar. Linsen visar `»` medan ord hålls och `√` när en process har hela
yttrandet — `started`, inte `queued`, för kön är ett faktum om servern och
inte om användarens instruktion. (`✓` finns inte i firmwarefonten; pretext
mäter den som en saknad glyf.)

Buggen som föll ut: två yttranden i luften gav `busy:true, busy:true,
busy:false, busy:false`, så linsen tystnade när det första blev klart medan
det andra kördes. Klienten härleder nu "något pågår" ur turerna.

**6. Vad den gör, inte bara att den gör något** (bd43390). `describeTool`
läser strömmens verktygsargument: "Reading workerEngine.js" i stället för
"Read". Första textblocket är planen och pinnas, allt därefter är vad den gör
nu, och ett `alive`-tecken per fem sekunder när processen skriver något låter
en asterisk blinka på raden efter tio sekunders tystnad — inget ord om saken.
Verktygsnamnet flyttade från statusraden ner i kroppen, där det har plats för
vad verktyget pekas på.

`prompts/worker.md` sa uttryckligen "Do not describe what you are about to do
and then do it". Den raden är utbytt.

## Kraschen i klienten: den var svarta lådan

Klienten dog när ett svar landade, ofta men inte alltid, och startade man om
låg svaret redan på linsen. Simulatorn reproducerade det inte. a34f517 la in
en svart låda — global felfälla plus `clientLog` genom transporten — och den
svarade på första försöket, om än inte på frågan den ställdes.

Loggen: 588 identiska rader på en sekund, `unhandled rejection at "painted":
The object does not support the operation or argument. @user-script:350:24:30`,
och sedan en död socket. Tre gånger, samma rad, samma position. Ingenting i
klienten producerar 588 av någonting i sekunden — en målning är en per sekund,
en puls en per femton — så det är inte många fel, det är ett fel som matar sig
självt. Den enda återkopplingen som finns är rapporteringen.

I Even-appen är konsolen bryggad: `flutter_inappwebview` byter ut
console.error mot en som skickar raden till värden genom `callHandler`, som
lämnar ifrån sig ett löfte som ingen äger. När det löftet avvisas är det en
unhandledrejection, som rapporteras med console.error, som bryggas, som
avvisas. `user-script:N` är det injicerade skriptet och inte vårt bygge —
därav den identiska positionen varje gång. N är konstant så länge sidan lever
och flyttar sig exakt femton steg varje gång den kommer upp igen (245, 275,
290, 305, 320, 335, 350, 365 under en kväll), för värden injicerar femton
skript per WebView. Det är också hur man skiljer ett avvisat brygglöfte från
ett fel i vår egen bunt.

Appen dör alltså inte, den snurrar, och det är därför det ser ut som att den
hänger sig. Fröet kan vara vad som helst; det spelar ingen roll, för det är
andra varvet som är felet.

Rättat: en rapport bestämmer sig för att tiga innan den säger något. En rad
identisk med den förra räknas i stället för att sägas, högst fem per två
sekunder går ut oavsett vad de säger, och hundra totalt är taket. Loopens
andra varv blir därmed dess sista. `test/prd4-browser.mjs` bygger samma brygga
i en riktig webbläsare — en console.error som avvisar ett löfte varje gång —
och släpper in ett enda fel; utan spärren återvänder det testet aldrig.

Två saker som föll ut på vägen och inte är avslutade:

**Pulsen förökar sig.** Samma logg visar `beat` en halv sekund isär, var och
en med `late=-15000ms`, alla med samma `beatAt` och samma bildräknare — alltså
en sida med många kedjor, inte många sidor. Den växer med ungefär hälften per
intervall. Varifrån de extra kedjorna kommer är inte utrett; att de inte kan
samlas på hög är det, för den väntande timern avbeställs innan nästa beställs.

**Räknaren i rubriken** byter fortfarande text varje sekund, och varje ändrad
ram är ett BLE-hopp. En tur på tre minuter är ~180 hopp. Ingen av dem är dyr
mätt en och en, och nu när kraschen har ett namn är det inte längre en
misstanke om den utan bara en kostnad.

## Mätpunkt

Innan något byggs: logga tiden till första token och total tid per tur, så
att 1 och 3 kan jämföras mot något annat än känsla.

Skriven 2026-09-12.
