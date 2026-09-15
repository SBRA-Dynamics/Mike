// PRD 5a — voice, without a browser in the way.
//
//   node test/prd5a.mjs
//
// Two halves. The first drives the SHIPPED segmenter (client/src/audio/segment.ts)
// in Node, against recorded PCM — which is acceptance criterion 7 itself, and
// the property PRD 5b depends on: the same code, given frames from anywhere,
// produces the same utterances. The second drives a real server over the wire
// with a stand-in transcription service, so every path the `audio` message can
// take is exercised without a GPU.
//
// What is NOT here: whether whisper understands Swedish. That is a claim about
// a model, and test/prd5a-browser.mjs makes it against the real service and
// recorded speech.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { startServer, connect, check, failed, section, sleep, ROOT } from "./harness.mjs";
import { fixture, pcmBase64, startWhisperStub } from "./voice.mjs";
import { validateC2S, MAX_AUDIO_BASE64 } from "../src/protocol.js";
import { decodeSegment, base64Bytes, DEFAULT_MAX_AUDIO_BYTES, MIN_SEGMENT_MS } from "../src/audio.js";
import { MODES, MODE_LABEL, applyModeCommand, isMode, matchModeCommand, route, ORIGIN } from "../src/routing.js";
import { DEFAULTS, Segmenter, segmentPcm, floatToPcm16, frameLevelDb, resampleTo } from "../client/src/audio/segment.ts";
import { pcmToBase64 } from "../client/src/audio/voice.ts";
import { HEARD_MS, Store } from "../client/src/state.ts";

const FAKE = join(ROOT, "test", "fixtures", "fake-claude.mjs");

const servers = [];
const stubs = [];
const fakeDirs = [];
const track = (s) => { servers.push(s); return s; };
const newFakeDir = () => { const d = mkdtempSync(join(tmpdir(), "fake-claude-")); fakeDirs.push(d); return d; };

/** A server whose Claude Code is the stand-in and whose ears are a stub. */
const startMike = async (stubUrl, extra = []) => {
	const fakeDir = newFakeDir();
	return track(await startServer(
		["--claude-bin", FAKE, "--worker-cwd", "/tmp", "--mike-cwd", "/tmp", "--whisper", stubUrl, ...extra],
		{ env: { FAKE_CLAUDE_DIR: fakeDir } }));
};

/** Send one segment and wait for the turn to settle. `since` is taken before
 *  the send, always: without it the wait matches the PREVIOUS turn's idle state
 *  and the loop races ahead, passing while measuring nothing. */
const speak = async (c, pcm, { settle = true, ms = 15_000 } = {}) => {
	const since = c.mark();
	c.send({ type: "audio", pcm: pcmBase64(pcm), final: true, sampleRate: 16_000 });
	if (settle) await c.waitFor((m) => m.type === "state" && m.busy === false, ms, "tyst efter ett yttrande", since);
	return c.messages.slice(since);
};

/** Room tone at about -60 dBFS — what a quiet room measures, not what a file
 *  full of zeroes does. Deterministic, so a run is reproducible. */
const roomTone = (ms, amplitude = 30) => {
	const n = Math.round((16_000 * ms) / 1000);
	const out = new Int16Array(n);
	let seed = 7;
	for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = Math.round(((seed / 0x7fffffff) * 2 - 1) * amplitude); }
	return out;
};

const tone = (ms, amplitude = 0.3, freq = 220) => {
	const n = Math.round((16_000 * ms) / 1000);
	const out = new Int16Array(n);
	for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / 16_000) * amplitude * 32767);
	return out;
};

const cat = (...parts) => {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	return out;
};

const shape = (segments) => segments.map((s) => `${s.startMs}-${s.endMs}:${s.pcm.length}:${s.reason}`).join(" ");

try {
	// ================================================== segmenteraren, i Node
	section("segmenteraren: PCM in, yttranden ut — utan webbläsare (R5a.3, krav 7)");

	const three = fixture("three-sv.wav");
	check("inspelningen är det formatet hela kedjan talar",
		three.sampleRate === 16_000 && three.bits === 16 && three.channels === 1,
		JSON.stringify({ rate: three.sampleRate, bits: three.bits, ch: three.channels }));

	const threeSegs = segmentPcm(three.pcm);
	check("tre yttranden i filen blir tre segment",
		threeSegs.length === 3, `${threeSegs.length}: ${shape(threeSegs)}`);
	check("segmenten ligger i tidsordning och överlappar inte",
		threeSegs.every((s, i) => s.startMs < s.endMs && (i === 0 || s.startMs >= threeSegs[i - 1].endMs)), shape(threeSegs));
	check("varje segment innehåller mest tal, inte tystnad",
		threeSegs.every((s) => s.speechMs >= 0.5 * s.durationMs), threeSegs.map((s) => `${s.speechMs}/${s.durationMs}`).join(" "));
	check("de åtta sekunderna rumston på slutet blir inget segment",
		threeSegs[2].endMs < three.durationMs - 5000, `${threeSegs[2].endMs} av ${three.durationMs}`);
	check("segmenten är trimmade — summan är kortare än inspelningen",
		threeSegs.reduce((n, s) => n + s.durationMs, 0) < three.durationMs * 0.6,
		`${threeSegs.reduce((n, s) => n + s.durationMs, 0)} mot ${three.durationMs}`);

	// Krav 6, och hela poängen med hangover.
	const pauses = fixture("pauses-sv.wav");
	const pauseSegs = segmentPcm(pauses.pcm);
	check("två meningar med vanliga pauser i blir två segment, inte fem (krav 6)",
		pauseSegs.length === 2, `${pauseSegs.length}: ${shape(pauseSegs)}`);
	check("och varje mening hålls ihop över sina pauser",
		pauseSegs.every((s) => s.durationMs > 3000), shape(pauseSegs));

	// Krav 5, klientens halva: tystnad når aldrig tråden.
	check("fyra sekunder rumston ger inga segment alls (krav 5)",
		segmentPcm(roomTone(4000)).length === 0);
	check("digital tystnad ger inte heller några segment",
		segmentPcm(new Int16Array(16_000 * 3)).length === 0);
	check("ett kort knäpp är inget yttrande",
		segmentPcm(cat(roomTone(500), tone(80), roomTone(1500))).length === 0);

	// Krav 7, uttryckligen: leveransformen spelar ingen roll. Glasögonen skickar
	// burar av BLE-paket, mikrofonen 20 ms-block, en fil allt på en gång.
	const chunked = [160, 1024, 173, 4096].map((n) => segmentPcm(three.pcm, {}, n));
	check("samma segment oavsett hur ljudet levereras (krav 7)",
		chunked.every((c) => shape(c) === shape(threeSegs)),
		chunked.map(shape).join("\n  "));
	check("samma körning två gånger ger exakt samma bytes",
		shape(segmentPcm(three.pcm)) === shape(threeSegs));

	// Och att den verkligen är fri från webbläsaren: den kördes just i Node,
	// vilket är beviset — men en framtida redigering kan smyga in ett
	// `window.` som bara märks på en telefon, så källan kollas också.
	const segmentSource = readFileSync(join(ROOT, "client", "src", "audio", "segment.ts"), "utf8")
		// Kommentarerna bort först: filen FÖRKLARAR varför den inte rör en
		// webbläsare, och en sökning som räknar den förklaringen som ett brott
		// är en kontroll som aldrig kan bli grön.
		.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
	const browserApis = ["window", "document", "navigator", "AudioContext", "MediaStream", "globalThis", "localStorage", "fetch("]
		.filter((api) => new RegExp(`\\b${api.replace("(", "\\(")}`).test(segmentSource));
	check("segmenteraren rör inte en enda webbläsar-API (krav 7)",
		browserApis.length === 0, browserApis.join(", "));

	section("segmenteraren: håll in-läget (R5a.3)");
	// De tio första sekunderna: alla tre yttrandena, och kortare än maxlängden,
	// som testas för sig nedan.
	const heldInput = three.pcm.subarray(0, 16_000 * 10);
	const held = new Segmenter({ hold: true });
	const duringHold = held.push(heldInput);
	const atRelease = held.flush("release");
	check("tystnad delar inte ett yttrande när knappen hålls nere", duringHold.length === 0, String(duringHold.length));
	check("släppet avslutar yttrandet", atRelease?.reason === "release", JSON.stringify(atRelease?.reason));
	check("och tystnaden i båda ändar är bortklippt (R5a.3)",
		!!atRelease && atRelease.durationMs < 10_000 - 1000, `${atRelease?.durationMs} av 10000`);
	check("men allt tal är kvar",
		!!atRelease && atRelease.speechMs > threeSegs.reduce((n, s) => n + s.speechMs, 0) * 0.9,
		`${atRelease?.speechMs} mot ${threeSegs.reduce((n, s) => n + s.speechMs, 0)}`);

	// Även ett håll är begränsat: knappen kan fastna, och en oändlig buffert i
	// klienten är samma sjukdom som ett obegränsat meddelande på tråden (R5a.6).
	const longHold = new Segmenter({ hold: true });
	const cutWhileHeld = longHold.push(cat(three.pcm, three.pcm));
	check("ett håll som aldrig släpps kapas ändå vid maxlängden",
		cutWhileHeld.length >= 1 && cutWhileHeld[0].reason === "maximum",
		JSON.stringify(cutWhileHeld.map((s) => `${s.durationMs}:${s.reason}`)));
	longHold.flush("release");

	const quietHold = new Segmenter({ hold: true });
	quietHold.push(roomTone(3000));
	check("ett håll utan ord skickar ingenting", quietHold.flush("release") === null);

	section("segmenteraren: gränsen i klienten (R5a.6)");
	const long = segmentPcm(cat(roomTone(400), tone(20_000)));
	check("ett yttrande kapas vid maxlängden",
		long[0]?.reason === "maximum" && Math.abs(long[0].durationMs - DEFAULTS.maxSegmentMs) < 400,
		JSON.stringify(long.map((s) => `${s.durationMs}:${s.reason}`)));
	check("maxlängden är mindre än vad servern släpper in",
		(DEFAULTS.maxSegmentMs / 1000) * 16_000 * 2 < DEFAULT_MAX_AUDIO_BYTES * 1.1,
		`${(DEFAULTS.maxSegmentMs / 1000) * 32_000} bytes mot ${DEFAULT_MAX_AUDIO_BYTES}`);

	section("segmenteraren: golvet följer rummet, inte en enstaka ram (PRD 6)");
	{
		// One frame of zeros — a BLE gap the bridge padded — used to drag the
		// floor to its minimum in a single step, after which room tone was
		// speech and the microphone was one continuous utterance in
		// fifteen-second pieces. Nine hours on the glasses said so.
		const gapThenRoom = segmentPcm(cat(roomTone(500), new Int16Array(320), roomTone(3000)));
		check("en ram av nollor gör inte rumstonet till tal", gapThenRoom.length === 0, shape(gapThenRoom));

		// A room that gets louder and stays there — a fan, or the microphone's
		// own gain ramping — opens a segment, and used to keep it open to the
		// maximum because the floor froze while open. Now the floor follows the
		// quietest recent frame even then, and the segment closes on its own.
		const louder = segmentPcm(cat(roomTone(1000, 30), roomTone(8000, 400)));
		check("ett rum som blir högre stänger sitt eget segment inom några sekunder",
			louder.length === 1 && louder[0].reason === "silence" && louder[0].durationMs < 5000,
			shape(louder));
		check("och öppnar inget nytt på det nya rumstonet", louder.length === 1, shape(louder));

		// A maximum-length cut lands at the last pause, not inside a syllable.
		const twoBreaths = segmentPcm(cat(roomTone(400), tone(9000), roomTone(300), tone(7000)));
		check("ett maxlångt yttrande klipps vid senaste pausen",
			twoBreaths[0]?.reason === "maximum" && twoBreaths[0].durationMs >= 9000 && twoBreaths[0].durationMs < 9800,
			shape(twoBreaths));
		check("och resten blir nästa segment utan att tappa sin första stavelse",
			twoBreaths.length === 2 && Math.abs(twoBreaths[1].startMs - 9400) < 400,
			shape(twoBreaths));
		check("ett segment bär golv och toppnivå",
			Number.isFinite(twoBreaths[0]?.floorDb) && Number.isFinite(twoBreaths[0]?.peakDb) && twoBreaths[0].peakDb > twoBreaths[0].floorDb,
			JSON.stringify([twoBreaths[0]?.floorDb, twoBreaths[0]?.peakDb]));
	}

	section("segmenteraren: mätningen och omsamplingen");
	check("en ren ton mäts högre än rumstonet",
		frameLevelDb(tone(20)) > frameLevelDb(roomTone(20)) + 20,
		`${frameLevelDb(tone(20)).toFixed(1)} mot ${frameLevelDb(roomTone(20)).toFixed(1)}`);
	check("digital tystnad ger ett tal, inte -oändligheten", frameLevelDb(new Int16Array(320)) === -100);
	check("flyttal klipps innan de skalas, så 1.0 inte blir -32768",
		JSON.stringify([...floatToPcm16(new Float32Array([1, -1, 2, -2]))]) === JSON.stringify([32767, -32768, 32767, -32768]));
	check("48 kHz omsamplas till 16 kHz med en tredjedel så många prov",
		resampleTo(new Float32Array(4800), 48_000, 16_000).length === 1600);
	check("omsampling till samma takt rör inte ljudet",
		resampleTo(three.pcm.length ? new Float32Array([0.5, -0.5]) : new Float32Array(0), 16_000, 16_000).length === 2);
	// En sinus omsamplad från 48 kHz ska fortfarande vara en sinus med samma nivå.
	const at48 = new Float32Array(4800);
	for (let i = 0; i < at48.length; i++) at48[i] = Math.sin((2 * Math.PI * 220 * i) / 48_000) * 0.5;
	const at16 = resampleTo(at48, 48_000, 16_000);
	check("och omsamplat ljud behåller sin nivå",
		Math.abs(frameLevelDb(floatToPcm16(at16)) - frameLevelDb(floatToPcm16(at48))) < 1.0,
		`${frameLevelDb(floatToPcm16(at16)).toFixed(2)} mot ${frameLevelDb(floatToPcm16(at48)).toFixed(2)}`);

	check("base64 i klienten och base64 på servern är samma bytes",
		pcmToBase64(threeSegs[0].pcm) === pcmBase64(threeSegs[0].pcm));

	// ============================================================ indikatorn
	section("indikatorn: vilken av de fyra sakerna som är sann (R5a.8)");
	const store = new Store();
	const voiceStatus = (over = {}) => ({ enabled: true, live: true, held: false, speaking: false, mic: "listening", detail: "", sent: 0, lastSegmentMs: 0, ...over });
	check("utan mikrofon är svaret overksam", store.listening() === "idle", store.listening());
	store.setVoice(voiceStatus({ live: false }));
	check("en stängd mikrofon är också overksam", store.listening() === "idle", store.listening());
	store.setVoice(voiceStatus());
	check("en öppen mikrofon lyssnar", store.listening() === "listening", store.listening());

	const at = Date.now();
	store.apply({ type: "heard", text: "vad är klockan", confidence: 0.9, seq: 1 });
	check("nyss hört är hört", store.listening(at) === "heard", store.listening(at));
	check("och det bleknar av sig själv", store.listening(at + HEARD_MS + 10) === "listening", store.listening(at + HEARD_MS + 10));
	check("klienten vet när det bleknar, i stället för att fråga om och om igen",
		(store.nextListeningExpiry(at) ?? 0) > 0 && store.nextListeningExpiry(at + HEARD_MS + 10) === null);
	store.apply({ type: "state", busy: true, worker: null, mode: MODES.BYNAME, seq: 2 });
	check("en tur som körs slår allt annat", store.listening(at) === "thinking", store.listening(at));

	// Det flyktiga `heard` (ett yttrande grinden släppte) saknar sekvensnummer.
	// Två sådana i rad måste ändå bli två rader, inte en.
	const t = new Store();
	t.apply({ type: "heard", text: "en mening", confidence: null });
	t.apply({ type: "heard", text: "en mening", confidence: null });
	check("ett yttrande utan sekvensnummer syns ändå, och två blir två",
		t.state.transcript.length === 2 && t.state.transcript[0].seq !== t.state.transcript[1].seq,
		JSON.stringify(t.state.transcript.map((e) => e.seq)));

	// ============================================ meddelandet och dess gränser
	section("ljudmeddelandet är begränsat i båda ändar (R5a.6)");
	const okMsg = { type: "audio", pcm: pcmBase64(roomTone(500)), final: true, sampleRate: 16_000 };
	check("ett vanligt segment godtas", validateC2S(okMsg).ok === true, JSON.stringify(validateC2S(okMsg)));
	check("ett orimligt långt segment avvisas redan i protokollet",
		validateC2S({ type: "audio", pcm: "A".repeat(MAX_AUDIO_BASE64 + 4) }).error === "audio segment too long");
	check("fel samplingsfrekvens avvisas hellre än transkriberas i fel takt",
		validateC2S({ type: "audio", pcm: "AAAA", sampleRate: 44_100 }).ok === false);
	check("final måste vara en boolean om den finns",
		validateC2S({ type: "audio", pcm: "AAAA", final: "ja" }).ok === false);
	check("pcm måste finnas", validateC2S({ type: "audio" }).ok === false);

	check("storleken räknas ut ur base64-längden, före avkodningen",
		base64Bytes(pcmBase64(roomTone(1000))) === 32_000, String(base64Bytes(pcmBase64(roomTone(1000)))));
	const big = decodeSegment({ pcm: pcmBase64(roomTone(40_000)) }, { maxBytes: DEFAULT_MAX_AUDIO_BYTES });
	// Detaljen utan bytesen: ett misslyckande här skulle annars skriva ut en
	// megabyte ljud i loggen.
	check("servern vägrar ett segment över sin gräns", big.ok === false && !big.ignore,
		JSON.stringify({ ok: big.ok, ignore: big.ignore, error: big.error, bytes: big.pcm?.length }));
	check("och säger hur stort det var och vad gränsen är", /\d+ kB, limit is \d+ kB/.test(big.error ?? ""), big.error);
	check("skräp som inte är base64 avvisas i stället för att bli brus",
		decodeSegment({ pcm: "detta är inte base64!!" }).ok === false);
	check("halva prov avvisas — annars förskjuts allt efter snittet",
		decodeSegment({ pcm: Buffer.from([1, 2, 3]).toString("base64") }).ok === false);
	const tiny = decodeSegment({ pcm: pcmBase64(roomTone(40)) });
	check("ett segment kortare än minimum tigs ihjäl, inte rapporteras (krav 5)",
		tiny.ok === false && tiny.ignore === true, JSON.stringify(tiny));
	check(`minimum är ${MIN_SEGMENT_MS} ms`, MIN_SEGMENT_MS >= 100 && MIN_SEGMENT_MS <= 500);
	const good = decodeSegment({ pcm: pcmBase64(roomTone(1500)) });
	check("ett giltigt segment ger rätt längd i millisekunder",
		good.ok === true && good.durationMs === 1500, JSON.stringify({ ok: good.ok, ms: good.durationMs }));

	// ====================================================== lägena, nu fyra
	section("PushToTalk är ett fjärde läge (R5a.4)");
	check("läget finns och är ett giltigt läge", isMode(MODES.PUSHTOTALK) && MODES.PUSHTOTALK === "pushtotalk");
	check("det har ett namn att läsa på en lins", (MODE_LABEL[MODES.PUSHTOTALK] ?? "").length > 0 && MODE_LABEL[MODES.PUSHTOTALK].length <= 14, MODE_LABEL[MODES.PUSHTOTALK]);
	check("under ett håll släpps orden fram ordagrant, som i always",
		JSON.stringify(route("vad är klockan", { mode: MODES.PUSHTOTALK, worker: "Bosse" })) ===
		JSON.stringify({ kind: "worker", name: "Bosse", text: "vad är klockan", addressed: false }));
	check("men ett tilltal slår fortfarande igenom till Mike",
		route("Mike, vad är klockan", { mode: MODES.PUSHTOTALK, worker: "Bosse" }).kind === "mike");
	check("utan arbetare går hållet till Mike",
		route("vad är klockan", { mode: MODES.PUSHTOTALK, worker: null }).kind === "mike");
	check("tangentbordet är ogrindat även här",
		route("lista filerna", { mode: MODES.PUSHTOTALK, worker: "Bosse", origin: ORIGIN.TYPED }).kind === "worker");

	for (const text of ["ändra input till håll in", "change input to push to talk", "Hey Mike, change input to push-to-talk.", "byt input till pushtotalk"]) {
		check(`"${text}" byter till håll in`, matchModeCommand(text)?.to === MODES.PUSHTOTALK, JSON.stringify(matchModeCommand(text)));
	}

	// Säkerhetsegenskapen, nu med fyra lägen: det finns inget läge man inte kan
	// prata sig ur. I PushToTalk gäller det under hållet, vilket är hela
	// anledningen till att kommandona matchas före grinden.
	const commands = [
		["pausa input", MODES.IGNORE], ["Hey Mike, pause the input.", MODES.IGNORE],
		["fortsätt input", "previous"], ["continue input", "previous"],
		["ändra input till alltid", MODES.ALWAYS], ["ändra input till via namn", MODES.BYNAME],
		["ändra input till håll in", MODES.PUSHTOTALK]
	];
	for (const [text, to] of commands) {
		for (const mode of Object.values(MODES)) {
			const r = route(text, { worker: "Bosse", mode });
			check(`"${text}" i läge ${mode}`, r.kind === "mode" && r.to === to, JSON.stringify(r));
		}
	}

	check("en paus från håll in kommer tillbaka till håll in, inte till en öppen mikrofon",
		JSON.stringify(applyModeCommand("previous", applyModeCommand(MODES.IGNORE, { mode: MODES.PUSHTOTALK, previousMode: null }))) ===
		JSON.stringify({ mode: MODES.PUSHTOTALK, previousMode: null }));
	check("standardläget är fortfarande via namn", MODE_LABEL[MODES.BYNAME] === "by name");

	// ====================================================== tråden, echo-sidan
	section("tråden: ett segment blir ett yttrande (R5a.6)");
	const stub = await startWhisperStub(["vad är klockan"]);
	stubs.push(stub);
	const echo = track(await startServer(["--handler", "echo", "--whisper", stub.url]));
	const c1 = await connect(echo);

	const said = fixture("three-sv.wav").pcm.subarray(0, 16_000 * 2);
	const turn = await speak(c1, said);
	const heard = turn.find((m) => m.type === "heard");
	check("servern svarar med vad den hörde", heard?.text === "vad är klockan", JSON.stringify(heard));
	check("och med hur säker den var", typeof heard?.confidence === "number", JSON.stringify(heard?.confidence));
	check("yttrandet blir en tur", turn.some((m) => m.type === "text" && m.text === "echo: vad är klockan"),
		JSON.stringify(turn.map((m) => m.type)));
	check("hörseln kommer före svaret (R5a.8)",
		turn.findIndex((m) => m.type === "heard") < turn.findIndex((m) => m.type === "text"),
		JSON.stringify(turn.map((m) => m.type)));
	check("tjänsten fick exakt de bytes klienten skickade",
		stub.requests[0]?.bytes === said.byteLength, `${stub.requests[0]?.bytes} mot ${said.byteLength}`);
	check("och de nådde /transcribe", stub.requests[0]?.url === "/transcribe", stub.requests[0]?.url);

	// Krav 5, serverns halva: tystnad kostar ingenting.
	const stubQuiet = await startWhisperStub([""]);
	stubs.push(stubQuiet);
	const quiet = track(await startServer(["--handler", "echo", "--whisper", stubQuiet.url]));
	const c2 = await connect(quiet);
	const before = c2.mark();
	c2.send({ type: "audio", pcm: pcmBase64(roomTone(1500)), final: true });
	await sleep(600);
	const after = c2.messages.slice(before);
	check("ett segment som transkriberas till ingenting ger ingen tur alls (krav 5)",
		after.length === 0, JSON.stringify(after.map((m) => `${m.type}:${m.text ?? m.kind ?? ""}`)));
	check("tjänsten blev ändå tillfrågad — det är svaret som var tomt", stubQuiet.requests.length === 1);

	const tooBig = c2.mark();
	c2.send({ type: "audio", pcm: pcmBase64(roomTone(40_000)), final: true });
	const refused = await c2.waitFor((m) => m.type === "error", 4000, "avvisat segment", tooBig);
	check("ett segment över gränsen avvisas med ett besked", /limit is/.test(refused?.message ?? ""), refused?.message);
	check("och skickas aldrig vidare till tjänsten", stubQuiet.requests.length === 1, String(stubQuiet.requests.length));
	c1.close(); c2.close();

	// ================================================= tråden, Mike-sidan
	section("tråden: talet bär med sig att det är tal (R5a.6, PRD 3)");
	const stubJ = await startWhisperStub([
		"vad är klockan",                    // utan tilltal, i byname
		"Mike, vad är klockan",            // med tilltal
		"Hey Mike, pausa input.",          // lägeskommando
		"vad är klockan",                    // i pausat läge
		"Fortsätt input."                    // tillbaka
	]);
	stubs.push(stubJ);
	const mike = await startMike(stubJ.url, ["--mode", MODES.BYNAME]);
	const c3 = await connect(mike);

	const dropped = await speak(c3, said, { settle: false });
	const droppedHeard = await c3.waitFor((m) => m.type === "heard", 8000, "heard trots grinden", c3.mark() - dropped.length);
	const notHeard = await c3.waitFor((m) => m.type === "event" && m.kind === "notHeard", 8000, "notHeard");
	check("ett otilltalat yttrande hörs ändå, och sägs ha hörts (R5a.8)",
		droppedHeard?.text === "vad är klockan", JSON.stringify(droppedHeard));
	check("men det släpps av grinden, och det sägs också",
		notHeard?.data?.reason === "unaddressed", JSON.stringify(notHeard?.data));
	check("ingen tur kördes", !c3.messages.some((m) => m.type === "text" && /mike turn/.test(m.text)),
		JSON.stringify(c3.messages.filter((m) => m.type === "text").map((m) => m.text)));
	check("det som grinden släppte är flyktigt: det har inget sekvensnummer",
		droppedHeard?.seq === undefined && notHeard?.seq === undefined,
		JSON.stringify({ heard: droppedHeard?.seq, notHeard: notHeard?.seq }));

	const addressed = await speak(c3, said);
	check("med tilltal går samma väg vidare till Mike",
		addressed.some((m) => m.type === "text" && /mike turn/.test(m.text)),
		JSON.stringify(addressed.map((m) => `${m.type}:${(m.text ?? "").slice(0, 30)}`)));
	const keptHeard = addressed.find((m) => m.type === "heard");
	check("och det som sades hamnar i samtalet, med sekvensnummer",
		typeof keptHeard?.seq === "number", JSON.stringify(keptHeard));

	// Transkriptet är den hårda kontrollen: det flyktiga får aldrig hamna där.
	const sinceHist = c3.mark();
	c3.send({ type: "control", action: "history", args: { limit: 500 } });
	const hist = await c3.waitFor((m) => m.type === "event" && m.kind === "history", 5000, "historik", sinceHist);
	const heardInHistory = (hist.data.messages ?? []).filter((m) => m.type === "heard").map((m) => m.text);
	check("ett överhört yttrande skrivs aldrig till transkriptet",
		!heardInHistory.includes("vad är klockan"), JSON.stringify(heardInHistory));
	check("men det som var till systemet står där",
		heardInHistory.includes("Mike, vad är klockan"), JSON.stringify(heardInHistory));

	section("talade lägeskommandon (krav 3)");
	const paused = await speak(c3, said, { settle: false });
	const modeChanged = await c3.waitFor((m) => m.type === "event" && m.kind === "modeChanged", 8000, "modeChanged", c3.mark() - paused.length);
	check("ett talat kommando pausar input", modeChanged?.data?.mode === MODES.IGNORE, JSON.stringify(modeChanged?.data));
	const stateNow = await c3.waitFor((m) => m.type === "state" && m.mode === MODES.IGNORE, 5000, "state med pausat läge");
	check("och läget syns i state", stateNow?.mode === MODES.IGNORE);

	const whilePaused = c3.mark();
	c3.send({ type: "audio", pcm: pcmBase64(said), final: true });
	const pausedHeard = await c3.waitFor((m) => m.type === "heard", 8000, "heard i pausat läge", whilePaused);
	const pausedDrop = await c3.waitFor((m) => m.type === "event" && m.kind === "notHeard", 8000, "notHeard i pausat läge", whilePaused);
	check("i pausat läge hörs orden fortfarande (R5a.8)", pausedHeard?.text === "vad är klockan", JSON.stringify(pausedHeard));
	check("men ingenting släpps fram", pausedDrop?.data?.reason === "paused", JSON.stringify(pausedDrop?.data));

	const resumeAt = c3.mark();
	c3.send({ type: "audio", pcm: pcmBase64(said), final: true });
	const resumed = await c3.waitFor((m) => m.type === "event" && m.kind === "modeChanged", 8000, "modeChanged tillbaka", resumeAt);
	check("och \"fortsätt input\" tar tillbaka läget som gällde före pausen (krav 3)",
		resumed?.data?.mode === MODES.BYNAME, JSON.stringify(resumed?.data));
	c3.close();

	// ============================================== när tjänsten inte finns
	section("när tjänsten inte är igång säger servern det (R5a.5)");
	const dead = track(await startServer(["--handler", "echo", "--whisper", "http://127.0.0.1:1"]));
	const c4 = await connect(dead);
	const deadAt = c4.mark();
	c4.send({ type: "audio", pcm: pcmBase64(roomTone(1500)), final: true });
	const deadErr = await c4.waitFor((m) => m.type === "error", 8000, "besked om att den inte hör", deadAt);
	check("ett yttrande mot en död tjänst ger ett begripligt besked",
		/cannot hear you/i.test(deadErr?.message ?? ""), deadErr?.message);
	check("och servern lever vidare", (await (await fetch(`${dead.base}/healthz`)).json()).ok === true);
	const stillTyping = c4.mark();
	c4.send({ type: "say", text: "hej", origin: "typed" });
	const echoed = await c4.waitFor((m) => m.type === "text" && m.text.startsWith("echo:"), 5000, "skriven tur", stillTyping);
	check("det skrivna fungerar fortfarande", echoed?.text === "echo: hej", echoed?.text);
	check("inga ouppfångade undantag", !dead.log().includes("UNCAUGHT"), dead.log().slice(-200));
	c4.close();

	const off = track(await startServer(["--handler", "echo", "--whisper", "off"]));
	const c5 = await connect(off);
	const offAt = c5.mark();
	c5.send({ type: "audio", pcm: pcmBase64(roomTone(1500)), final: true });
	const offErr = await c5.waitFor((m) => m.type === "error", 5000, "besked om avstängd transkribering", offAt);
	check("--whisper off är en riktig inställning, inte en krasch",
		/turned off/.test(offErr?.message ?? ""), offErr?.message);
	check("healthz säger vad servern hör med",
		(await (await fetch(`${off.base}/healthz`)).json()).transcription?.service === "none");
	c5.close();

	section("när tjänsten svarar med ett fel");
	const broken = await startWhisperStub(["x"], { status: 500 });
	stubs.push(broken);
	const brokenServer = track(await startServer(["--handler", "echo", "--whisper", broken.url]));
	const c6 = await connect(brokenServer);
	const brokenAt = c6.mark();
	c6.send({ type: "audio", pcm: pcmBase64(roomTone(1500)), final: true });
	const brokenErr = await c6.waitFor((m) => m.type === "error", 6000, "fel från tjänsten", brokenAt);
	check("ett fel från modellen rapporteras som sig självt",
		/transcription failed \(500\)/.test(brokenErr?.message ?? ""), brokenErr?.message);
	check("och inte som att tjänsten är nere", !/not running/.test(brokenErr?.message ?? ""), brokenErr?.message);
	c6.close();

	// ============================================ latens mot riktig tjänst
	section("latens (R5a.7)");
	if (process.env.MIKE_WHISPER_URL) {
		const url = process.env.MIKE_WHISPER_URL.replace(/\/+$/, "");
		const five = fixture("pauses-sv.wav").pcm.subarray(16_000 * 0, 16_000 * 5);
		const body = Buffer.from(five.buffer, five.byteOffset, five.byteLength);
		const times = [];
		let text = "";
		for (let i = 0; i < 3; i++) {
			const t0 = Date.now();
			const r = await (await fetch(`${url}/transcribe`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body })).json();
			times.push(Date.now() - t0);
			text = r.text;
		}
		const median = times.sort((a, b) => a - b)[1];
		check(`fem sekunder svenska transkriberas under 800 ms (${times.join("/")} ms)`, median < 800, JSON.stringify({ times, text }));

		// Och hela vägen: från att segmentet lämnar klienten till att servern
		// säger vad den hörde. Det är den halva av R5a.7 som användaren märker,
		// och baren är "under två sekunder till att den hörde mig".
		const real = track(await startServer(["--handler", "echo", "--whisper", url]));
		const rc = await connect(real);
		const wireTimes = [];
		for (let i = 0; i < 3; i++) {
			const since = rc.mark();
			const t0 = Date.now();
			rc.send({ type: "audio", pcm: pcmBase64(five), final: true, sampleRate: 16_000 });
			await rc.waitFor((m) => m.type === "heard", 10_000, "heard", since);
			wireTimes.push(Date.now() - t0);
			await rc.waitFor((m) => m.type === "state" && m.busy === false, 10_000, "tyst", since);
		}
		const wireMedian = wireTimes.sort((a, b) => a - b)[1];
		check(`hela vägen till "jag hörde dig" under två sekunder (${wireTimes.join("/")} ms)`, wireMedian < 2000, JSON.stringify(wireTimes));
		rc.close();
	} else {
		console.log("  --   hoppar över latensmätningen: sätt MIKE_WHISPER_URL till en igång tjänst");
	}

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	for (const s of servers) { try { s.stop(); } catch { /* already gone */ } }
	for (const s of stubs) { try { await s.stop(); } catch { /* already closed */ } }
	for (const d of fakeDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
}

section("mikrofonen går att slå på och av med rösten");
{
	// The switch is not the mode, but it needs the same guarantee: saying "mic
	// off" leaves the user unable to be heard at all, so the way back must be
	// reachable — a hold, in every mode, matched before the gate.
	const said = (text, mode = MODES.BYNAME) => route(text, { mode, worker: "Bosse" });
	for (const [text, on] of [["slå på mikrofonen", true], ["Hey Mike, turn on the mic", true],
		["stäng av micken", false], ["turn the microphone off", false], ["mic off", false]]) {
		const r = said(text);
		check(`"${text}" styr mikrofonen`, r.kind === "mic" && r.on === on, JSON.stringify(r));
	}
	for (const mode of Object.values(MODES)) {
		const r = said("stäng av mikrofonen", mode);
		check(`och gäller i läge ${mode}`, r.kind === "mic" && r.on === false, JSON.stringify(r));
	}
}

section("linsen går att släcka och tända med rösten: display off, display on");
{
	const said = (text, mode = MODES.BYNAME) => route(text, { mode, worker: "Bosse" });
	for (const [text, on] of [["display off", false], ["Display off.", false], ["Display of.", false], ["Playoff.", false], ["Displayoff", false], ["Stay on.", true], ["Splay on.", true], ["Play on.", true], ["This pay off.", false], ["This play on.", true], ["The splay off", false], ["Dis play of.", false], ["Mike, display off", false],
		["turn the display off", false], ["släck skärmen", false], ["stäng av displayen", false], ["släck linsen", false],
		["display on", true], ["Display on.", true], ["turn on the display", true], ["tänd skärmen", true],
		["slå på displayen", true], ["tänd linsen", true], ["screen on", true]]) {
		const r = said(text);
		check(`"${text}" styr linsen`, r.kind === "display" && r.on === on, JSON.stringify(r));
	}
	for (const mode of Object.values(MODES)) {
		const r = said("display on", mode);
		check(`och tillbaka går det i läge ${mode}`, r.kind === "display" && r.on === true, JSON.stringify(r));
	}
	check("pay off ensamt är ingen displaykommando", said("Pay off.", MODES.ALWAYS).kind !== "display");
	check("stay on i en mening är en mening", said("Mike, should the heater stay on", MODES.ALWAYS).kind === "mike");
	check("en mening om slutspelet är en mening", said("Mike, who won the playoff", MODES.ALWAYS).kind === "mike");
	check("en mening om displayen är en mening", said("Mike, what does display off do", MODES.ALWAYS).kind === "mike");
	check("ett skrivet display off räknas också", route("display off", { mode: MODES.BYNAME, worker: null, origin: ORIGIN.TYPED }).kind === "display");
	check("men kapar inte vanligt tal",
		route("kan du slå på micken i mötesrummet sen", { worker: "Bosse", origin: ORIGIN.TYPED }).kind === "worker");
	check("och inte heller ett ord som bara liknar",
		route("slå på ljudet i filmen", { worker: "Bosse", origin: ORIGIN.TYPED }).kind === "worker");

	// Over the wire: the server relays, the client acts. It must be transient —
	// replaying it on a reconnect would open somebody's microphone hours later.
	// No transcription needed: the command arrives as text either way.
	const server = await startMike("off");
	const c = await connect(server);
	const since = c.mark();
	c.send({ type: "say", text: "stäng av mikrofonen", origin: "typed" });
	const ev = await c.waitFor((m) => m.type === "event" && m.kind === "micRequested", 20_000, "micRequested", since);
	check("servern vidarebefordrar begäran", ev.data.on === false, JSON.stringify(ev.data));
	check("och den är transient, inte en del av samtalet", ev.seq === undefined, JSON.stringify(ev));
	check("användaren får veta att det gick igenom",
		c.messages.slice(since).some((m) => m.type === "text" && /Mic off/.test(m.text)));

	const st = new Store();
	let asked = null;
	st.onMicRequest = (on) => { asked = on; };
	st.apply({ ...ev, seq: 1 });
	check("klienten agerar på begäran", asked === false, String(asked));

	c.close(); server.stop();
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
