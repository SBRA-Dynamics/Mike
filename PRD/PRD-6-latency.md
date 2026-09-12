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

**7. Fönstret är tystnad, inte klocka.** Punkt 4 mätte fel sak. Fönstret gick
från att transkript ett kom in tills transkript två kom in, och transkript två
kan inte komma förrän dess fragment är färdigsagt, har legat tyst i 700 ms och
gått genom whisper — så längden på andra halvan av meningen räknades mot
fönstret, och allt över ungefär en sekunds fortsättning missade det. Loggen
från glasögonen: 3 sammanslagningar på 40 turer, och den som slogs ihop hade
25 ms tillgodo. Det var därför Bosse började tänka mitt i meningen och resten
kom som en egen tur efteråt; att han gissade rätt ändå gjorde det inte mindre
obehagligt.

Servern visste inte att användaren börjat prata igen. Klienten visste —
segmenteraren sätter `speaking` efter 100 ms tal, och det drev redan
lyssningsindikatorn — men sa det aldrig. Nu går ett `speaking`-meddelande
(C2S, en boolean) i samma ögonblick detektorn öppnar eller stänger ett
segment, före själva ljudet. Ett fönster med någon som pratar in i det slutar
räkna tills fragmentet kommit; sedan börjar de 2000 ms om från transkriptets
ankomst, tomt eller inte. Signalen kommer oftast INNAN fönstret finns —
användaren börjar andra halvan medan första ligger i whisper — så den minns
per session, inte per tur. Ett tak (`SPEAKING_CAP_MS`, 40 s) skickar det som
hålls om fragmentet aldrig kommer, och en stängd socket släpper flaggan.

Linsen sa dessutom "thinking" från första fragmentet, för en hållen tur
räknades som arbete — precis det ord som beskriver vad som INTE händer medan
fönstret är öppet. Nu finns tre märken och två ord till: `»` och "still
listening" medan meningen är öppen, `›` och "queued" när den är skickad men
ingen process tagit den (i praktiken: bakom en tur som redan kör), `√` och
"thinking" när någon har hela yttrandet. Räknaren i "thinking 7s" räknar från
att orden skickades, inte från första fragmentet — annars hade den stått på
tolv sekunder i samma ögonblick modellen fick meningen.

**8. Golvet.** Första kvällen med 7 på huvudet: början av meningen saknades,
"Nu har det gått flera minuter" blev "Spära minuter", orden dök upp på linsen
5–6 sekunder efter att de sagts, och "still listening" stod kvar efter tjugo
sekunders tystnad. Loggen visade samma sak fyra gånger om: segment på exakt
15000 ms, ett efter ett, de flesta transkriberade till ingenting, och
`speaking` som slog om var femtonde sekund — detektorn var öppen hela tiden.

Orsaken satt i segmenterarens brusgolv. Det föll med halva avståndet till
VARJE tystare ram, så en enda ram av nollor — ett BLE-glapp som bryggan
fyllt ut — tog golvet till sitt minimum på -70 dB i ett steg. Rumstonet låg
över golvet plus marginalen, alltså var det tal, alltså öppnades ett segment,
och medan ett segment var öppet fick golvet inte röra sig alls. Så det låg
kvar där tills något råkade bli tystare, och segmenten gick till maxlängden
och klipptes på ett godtyckligt prov: mitt i "flera". Fördröjningen var
väntan på de 15 sekunderna, och fönstret fick aldrig tystnad eftersom nästa
segment öppnade på nästa ram.

Nu följer golvet den tystaste ramen i de senaste 1,5 sekunderna
(`floorWindowMs`) i stället för den senaste ramen: tal har luckor mellan
orden, så minimum av en och en halv sekund är rummet vad som än sägs i det,
och en ensam ram kan inte flytta golvet. Ramar under -90 dB (`gapDb`) är inte
rumston utan ingenting och ignoreras. Golvet får stiga även medan ett segment
är öppet (`floorRiseRateOpen`), vilket bara händer när segmentet är öppet på
rumston — en mening höjer det inte, dess minimum är luckan mellan orden — så
ett sådant segment stänger sig självt inom några sekunder. Ett maxlångt
segment klipps vid senaste paus på 200 ms (`cutGapMs`) i stället för vid
längden, och det som följer pausen är nästa segment från början, med sin
första stavelse. `reset()` börjar från toppen av intervallet som konstruktorn,
inte från botten.

Serverns tak omarmade sig på varje omslag av `speaking`, så en detektor som
slog om var femtonde sekund höll fönstret öppet hur länge som helst. Taket
räknas nu från de senaste orden som faktiskt kom (20 s), oavsett signalen.
Och varje segment bär med sig orsak, golv och toppnivå till serverloggen —
`15000ms maximum floor -70 peak -38` är en diagnos, `15000ms` var en gåta.

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

Två saker föll ut på vägen. Den första visade sig vara spåret till hängningen.

**Pulsen förökade sig.** Samma logg visar `beat` en halv sekund isär, var och
en med `late=-15000ms`, alla med samma `beatAt` och samma bildräknare — alltså
en sida med många kedjor, inte många sidor. Den växte med ungefär hälften per
intervall. Varifrån de extra kedjorna kom står i nästa avsnitt.

**Räknaren i rubriken** byter fortfarande text varje sekund, och varje ändrad
ram är ett BLE-hopp. En tur på tre minuter är ~180 hopp. Ingen av dem är dyr
mätt en och en, och nu när kraschen har ett namn är det inte längre en
misstanke om den utan bara en kostnad.

## Hängningen var SDK:ns timers

Rapportloopen var verklig och är stängd, men appen hängde sig ändå och
telefonen blev varm — alltid efter första meningen, när linsen visat `√`. I
serverloggen ser varje sida likadan ut: en avvisning från bryggan
(`postMessage: The object does not support the operation or argument`), en
halv sekund senare stängs socketen med 1001 (sidan går bort), och nästa sida
som startar bär ett `user-script`-nummer femton steg högre.

`@evenrealities/even_hub_sdk` 0.0.15 byter vid import ut `window.setTimeout`,
`clearTimeout`, `setInterval` och `clearInterval` mot "skuggtimers": varje
timer läggs i en Map bredvid en riktig, och värden kan driva kartan själv
genom `window.__tickShadowTimers(elapsedMs)` — för det fall där en
bakgrundslagd WebViews egna timers står stilla. Tre egenskaper hos det lagret,
mätta mot den levererade SDK:n i `test/prd6-timers.mjs`:

* En timer som ticket avfyrar tas bort ur kartan, men dess riktiga tvilling
  avbeställs inte. En engångstimer avfyras två gånger. Det är pulsens
  förökning: en kedja som armar om sig vid varje avfyrning fördubblas.
* Ticket itererar kartan medan callbacks körs, och en Map besöker poster som
  läggs till under iterationen. En callback som armar om sig själv med en
  fördröjning kortare än tickets `elapsedMs` besöks, avfyras, armas om, besöks
  igen — inuti ETT anrop, som aldrig återvänder. Linsen ritas om en gång i
  sekunden så länge en tur pågår (räknaren i rubriken, 048a77f), så kedjan
  finns från det ögonblick en mening hörts, och första värdticket därefter kom
  aldrig tillbaka. Det är därför det började i samma veva som PRD 6, därför
  telefonen blev varm, och därför socketen stängdes med 1001: sidan dödades.
* `clearTimeout(id)` för ett id som inte längre finns i kartan faller igenom
  till den riktiga `clearTimeout` med skugg-id:t — ett litet heltal räknat
  från 1, precis som riktiga id:n — och kan alltså avbeställa någon annans
  timer.

Rättat i 0.3.5: klienten rör inte `window.setTimeout` alls. `client/src/timers.ts`
tar de riktiga funktionerna vid modulutvärdering, före SDK:n importeras, och
allt i klienten går genom dem. Det som ges upp är tickets enda tjänst —
timers som går medan värden fryst sidan — och ingenting här vill ha den:
målningen har inget att måla medan appen är borta, och anslutningen petas när
den kommer tillbaka (R4.5). Testet håller SDK:n till beskrivningen (kedjan är
en loop på dess timers och tar ett anrop på klientens) och klienten till
löftet (ingen fil utom timers.ts anropar de globala).

Inte verifierat på glasögonen än. Raden `client up 0.3.5 … timers native` i
serverloggen är kvittot på att bygget som kör är det här.

## Mätpunkt

Innan något byggs: logga tiden till första token och total tid per tur, så
att 1 och 3 kan jämföras mot något annat än känsla.

Skriven 2026-09-12.
