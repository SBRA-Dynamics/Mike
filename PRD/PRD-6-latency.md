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
minut sedan aldrig kan ljuga om vad som är på gång.

## Mätpunkt

Innan något byggs: logga tiden till första token och total tid per tur, så
att 1 och 3 kan jämföras mot något annat än känsla.

Skriven 2026-09-12.
