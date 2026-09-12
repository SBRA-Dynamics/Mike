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

## Mätpunkt

Innan något byggs: logga tiden till första token och total tid per tur, så
att 1 och 3 kan jämföras mot något annat än känsla.

Skriven 2026-09-12.
