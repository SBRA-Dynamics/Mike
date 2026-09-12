// PRD 5b — voice, from the glasses, without glasses.
//
//   node test/prd5b.mjs
//
// PRD 5b has exactly one job: turn glasses audio into the same segments PRD 5a
// already knows what to do with. So this suite spends almost all of its
// assertions on that one sentence — the SAME recording, delivered the way the
// Even Hub bridge delivers it, has to come out the other end byte for byte the
// way the browser's microphone delivers it, and take the identical path through
// the server afterwards. That is acceptance criterion 7, and everything else in
// the phase is downstream of it being true.
//
// What is driven here is the shipped code, not a model of it:
// client/src/audio/glasses.ts (the microphone), client/src/glasses.ts (the SDK
// layer, with a stand-in bridge, the same seam PRD 4's suite uses), and
// client/src/audio/voice.ts (the mode policy that now has two microphones
// behind it). The segmenter is imported unchanged and is not configured
// differently for the glasses, which is checkable and is checked.
//
// What is NOT here, and cannot be: a battery, a BLE link and a four-microphone
// array attributing a real room. The frames in this file are recorded speech
// with `speakerRole` written on them by the test, so every claim about the
// FILTER is a claim about what the client does with a tag — not about whether
// the tag is any good. R5b.2's accuracy, R5b.4's real byte rate and criteria 5
// and 6 need the hardware; the report says so and says what to measure.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { startServer, connect, check, failed, section, sleep, ROOT } from "./harness.mjs";
import { fixture, pcmBase64, startWhisperStub } from "./voice.mjs";
import { MODES } from "../src/routing.js";
import { segmentPcm, Segmenter, DEFAULTS } from "../client/src/audio/segment.ts";
import { GlassesMicrophone, SOURCE, SPEAKER, toSamples } from "../client/src/audio/glasses.ts";
import { Voice } from "../client/src/audio/voice.ts";
import { Glasses } from "../client/src/glasses.ts";
import { Store } from "../client/src/state.ts";

const servers = [];
const stubs = [];
const fakeDirs = [];
const newFakeDir = () => { const d = mkdtempSync(join(tmpdir(), "fake-claude-")); fakeDirs.push(d); return d; };

/** A segment, as a string that is cheap to compare and readable when it fails. */
const shape = (segments) => segments.map((s) => `${s.startMs}-${s.endMs}:${s.pcm.length}:${s.reason}`).join(" ");
/** And the bytes themselves, so "the same segments" means the same audio and
 *  not merely the same boundaries. */
const bytes = (segments) => segments.map((s) => pcmBase64(s.pcm)).join("|");

/** Samples to the bytes an AudioEvent actually carries. */
const toBytes = (pcm) => new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);

/**
 * A recording, chopped into AudioEvents the way the bridge delivers them.
 *
 * 3200 bytes is what the simulator's bridge was measured sending (100 ms at
 * 16 kHz), and `frameBytes` is a parameter because nothing promises the
 * hardware agrees — including promising it is even.
 */
const events = (pcm, { frameBytes = 3200, role = () => SPEAKER.UNKNOWN, as = "u8" } = {}) => {
	const all = toBytes(pcm);
	const out = [];
	for (let at = 0; at < all.length; at += frameBytes) {
		const slice = all.subarray(at, Math.min(all.length, at + frameBytes));
		const audioPcm = as === "numbers" ? [...slice]
			: as === "base64" ? Buffer.from(slice).toString("base64")
				// Copied, because a subarray of the recording shares its buffer and
				// the aligned fast path must not be handed a view it can read past.
				: Uint8Array.from(slice);
		out.push({ audioPcm, source: SOURCE.GLASSES, direction: null, speakerRole: role(out.length, at) });
	}
	return out;
};

/** A microphone with the bridge replaced by a list of calls. `answer` defaults
 *  to what the Even App actually answers — true to an open, FALSE to a close,
 *  which was measured through the simulator's own bridge. */
const makeMic = (over = {}) => {
	const calls = [];
	const segments = [];
	const states = [];
	const notes = [];
	const mic = new GlassesMicrophone({
		control: async (open, source) => {
			calls.push(`${open ? "on" : "off"}:${source}`);
			if (over.controlDelay) await sleep(over.controlDelay);
			return over.answer ? over.answer(open, source) : open;
		},
		pageReady: over.pageReady,
		segmenter: over.segmenter,
		now: over.now,
		onSegment: (s) => segments.push(s),
		onState: (st, detail) => states.push(`${st}:${detail}`),
		onNote: (t) => notes.push(t)
	});
	return { mic, calls, segments, states, notes };
};

/** Everything a recording produces through the glasses path, in one call. */
const throughGlasses = async (pcm, opts = {}, micOpts = {}) => {
	const rig = makeMic(micOpts);
	await rig.mic.open(opts.hold ?? false);
	for (const ev of events(pcm, opts)) rig.mic.frame(ev);
	rig.mic.close(opts.hold ? "release" : "close");
	return rig;
};

/** Room tone at about -60 dBFS — what a quiet room measures. Deterministic. */
const roomTone = (ms, amplitude = 30) => {
	const n = Math.round((16_000 * ms) / 1000);
	const out = new Int16Array(n);
	let seed = 7;
	for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = Math.round(((seed / 0x7fffffff) * 2 - 1) * amplitude); }
	return out;
};

const cat = (...parts) => {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	return out;
};

// A suite that waits forever exits with code 0 and no output at all, which is
// indistinguishable from passing — and that is exactly what a missing deadline
// inside the client looks like from out here. So nothing may wait forever: this
// holds the event loop open on purpose and turns a hang into a failure with a
// name on it.
const watchdog = setTimeout(() => {
	console.error("\ntestriggen fastnade — något väntade för evigt");
	check("testriggen blev aldrig hängande", false, "tidsgränsen för hela sviten gick ut");
	console.log(`\nFAIL (${failed()})`);
	process.exit(1);
}, 300_000);

/** Await something that is only allowed to take milliseconds. Returns the
 *  marker instead of hanging, so a missing deadline in the client fails here
 *  rather than stopping the run. */
const within = (promise, ms, marker = "__timeout__") =>
	Promise.race([promise.catch((e) => e), new Promise((r) => setTimeout(() => r(marker), ms))]);

try {
	const three = fixture("three-sv.wav");

	// ============================================ bytes in, samples out
	section("omramningen: värden skickar bytes, segmenteraren tar prov");
	{
		// The FORMAT needs no conversion — that is the whole point of PRD 5a
		// choosing 16 kHz s16le mono. The CONTAINER does: a packet is a byte
		// count, and half a sample dropped shifts everything after it.
		const src = three.pcm.subarray(0, 1000);
		const all = toBytes(src);
		const straight = toSamples(all);
		check("ett jämnt paket blir precis sina prov",
			straight.carry === null && pcmBase64(straight.pcm) === pcmBase64(src),
			`${straight.pcm.length} prov, rest ${straight.carry}`);

		const odd = toSamples(all.subarray(0, 7));
		check("ett udda paket lämnar en halv sampling kvar i stället för att tappa den",
			odd.pcm.length === 3 && odd.carry === all[6], JSON.stringify({ n: odd.pcm.length, carry: odd.carry, want: all[6] }));

		// The case that only appears on one input: a packet that ends on half a
		// sample, followed by the other half.
		const a = toSamples(all.subarray(0, 7));
		const b = toSamples(all.subarray(7, 1000), a.carry);
		check("och nästa paket sätter ihop den igen, prov för prov",
			pcmBase64(cat(a.pcm, b.pcm)) === pcmBase64(src.subarray(0, a.pcm.length + b.pcm.length)),
			`${a.pcm.length}+${b.pcm.length}`);

		// Every packet odd, all the way through a recording: the pathological
		// delivery, and the one where an off-by-one is invisible until whisper
		// hears static.
		let carry = null;
		const pieces = [];
		for (let at = 0; at < all.length; at += 333) {
			const r = toSamples(all.subarray(at, Math.min(all.length, at + 333)), carry);
			carry = r.carry;
			pieces.push(r.pcm);
		}
		check("en hel inspelning i udda paket blir samma prov som i jämna",
			pcmBase64(cat(...pieces)) === pcmBase64(src), `${cat(...pieces).length} mot ${src.length}`);

		const empty = toSamples(new Uint8Array(0), 7);
		check("ett tomt paket tappar inte den halva samplingen som väntar",
			empty.pcm.length === 0 && empty.carry === 7, JSON.stringify(empty.carry));

		// The host is documented to send audioPcm as bytes, as a number array or
		// as base64, depending on its version.
		const asU8 = toSamples(Uint8Array.from([0x01, 0x02, 0xff, 0x7f]));
		check("bytes tolkas som little-endian 16-bitars med tecken",
			asU8.pcm[0] === 0x0201 && asU8.pcm[1] === 32767, JSON.stringify([...asU8.pcm]));
		const negative = toSamples(Uint8Array.from([0x00, 0x80]));
		check("och det negativa ytterläget blir negativt, inte 32768",
			negative.pcm[0] === -32768, String(negative.pcm[0]));
	}

	// ===================================== krav 7: samma segment, samma bytes
	section("krav 7: glasögonljud blir exakt de segment webbläsarljud blir");
	{
		const browser = segmentPcm(three.pcm);
		check("referensen är de tre yttrandena PRD 5a redan mäter", browser.length === 3, shape(browser));

		const rig = await throughGlasses(three.pcm);
		check("glasögonvägen ger lika många segment", rig.segments.length === browser.length,
			`${rig.segments.length}: ${shape(rig.segments)}`);
		check("med samma gränser och samma anledningar (krav 7)",
			shape(rig.segments) === shape(browser), `${shape(rig.segments)}\n     mot ${shape(browser)}`);
		check("och samma ljud, byte för byte (krav 7)",
			bytes(rig.segments) === bytes(browser), "olika bytes i något segment");

		// The delivery shape is the bridge's business, not the pipeline's — and
		// the hardware need not agree with the simulator about packet size.
		for (const frameBytes of [3200, 320, 640, 1000, 4096, 333]) {
			const r = await throughGlasses(three.pcm, { frameBytes });
			check(`samma segment när värden skickar ${frameBytes} bytes åt gången`,
				shape(r.segments) === shape(browser) && bytes(r.segments) === bytes(browser),
				shape(r.segments));
		}
		for (const as of ["numbers", "base64"]) {
			const r = await throughGlasses(three.pcm, { frameBytes: 3200, as });
			check(`och när värden skickar dem som ${as}`,
				shape(r.segments) === shape(browser) && bytes(r.segments) === bytes(browser), shape(r.segments));
		}

		// The reason the above can be true: the glasses do not get their own
		// segmenter settings. A future edit that "tunes" one for the glasses
		// would break krav 7 quietly, so the source is checked as well.
		const micSource = readFileSync(join(ROOT, "client", "src", "audio", "glasses.ts"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
		const tuned = Object.keys(DEFAULTS).filter((k) => k !== "sampleRate" && k !== "hold" && new RegExp(`\\b${k}\\s*:`).test(micSource));
		check("glasögonmikrofonen ställer inte in segmenteraren annorlunda (krav 7)",
			tuned.length === 0, tuned.join(", "));
		check("den samplingstakt den ber om är pipelinens",
			/sampleRate:\s*16_000/.test(micSource));
	}

	section("krav 7: håll in-läget är också samma kod");
	{
		const held = new Segmenter({ hold: true });
		const wanted = held.push(three.pcm.subarray(0, 16_000 * 10));
		const wantedLast = held.flush("release");
		const rig = await throughGlasses(three.pcm.subarray(0, 16_000 * 10), { hold: true });
		check("ett håll genom glasögonen ger samma yttrande som ett håll i webbläsaren",
			shape(rig.segments) === shape([...wanted, wantedLast].filter(Boolean)),
			`${shape(rig.segments)}\n     mot ${shape([...wanted, wantedLast].filter(Boolean))}`);
		check("och det avslutas av släppet, inte av tystnad (R5a.3)",
			rig.segments.at(-1)?.reason === "release", JSON.stringify(rig.segments.map((s) => s.reason)));
	}

	// ================================================ R5b.2, talarfiltret
	section("R5b.2: den som inte är bäraren transkriberas inte (krav 2)");
	{
		const clean = await throughGlasses(three.pcm);

		const other = await throughGlasses(three.pcm, { role: () => SPEAKER.OTHER });
		check("en inspelning där allt är märkt \"någon annan\" ger inga segment alls (krav 2)",
			other.segments.length === 0, shape(other.segments));
		check("och inte ett enda prov når segmenteraren",
			other.mic.stats.samples === 0, String(other.mic.stats.samples));
		check("men ramarna räknas — det är ratiot R5b.2 vill se",
			other.mic.stats.other === other.mic.stats.frames && other.mic.stats.frames > 100,
			JSON.stringify(other.mic.roles));

		const self = await throughGlasses(three.pcm, { role: () => SPEAKER.SELF });
		check("bäraren själv ger precis samma segment som ofiltrerat",
			shape(self.segments) === shape(clean.segments) && bytes(self.segments) === bytes(clean.segments), shape(self.segments));

		// R5b.2: "Frames tagged Unknown are kept — losing the wearer's speech is
		// worse than transcribing a little noise."
		const unknown = await throughGlasses(three.pcm, { role: () => "UNKNOWN" });
		check("okänd talare behålls, och versaler från värden spelar ingen roll",
			shape(unknown.segments) === shape(clean.segments), shape(unknown.segments));
		// The counter, not the filter. `roles=self/other/unknown` is the number
		// Robin reads off the glasses to decide whether R5b.2 is worth anything
		// at all — if it books Unknown as Other he would conclude the filter
		// works when it never saw a tag it could use.
		check("okända ramar bokförs som okända, inte som någon annan",
			unknown.mic.stats.unknown === unknown.mic.stats.frames && unknown.mic.stats.other === 0,
			JSON.stringify(unknown.mic.roles));

		const missing = await throughGlasses(three.pcm, { role: () => undefined });
		check("en ram utan talarmärkning behålls också — annars tystar en gammal värd allt",
			shape(missing.segments) === shape(clean.segments), shape(missing.segments));
	}

	section("R5b.2: en inblandning mitt i ett yttrande stannar klockan inte");
	{
		// The trap. Frames tagged Other are not transcribed — but time must keep
		// running while somebody else talks, or the hangover never runs out and
		// an utterance the wearer finished stays open for as long as the other
		// person keeps going.
		const oneUtterance = three.pcm.subarray(0, 16_000 * 2.2);
		const interruption = three.pcm.subarray(16_000 * 3, 16_000 * 8);
		const mixed = cat(oneUtterance, interruption);
		const mine = oneUtterance.length;

		const rig = makeMic();
		await rig.mic.open(false);
		for (const ev of events(mixed, { frameBytes: 3200, role: (_i, at) => (at >= mine * 2 ? SPEAKER.OTHER : SPEAKER.SELF) })) rig.mic.frame(ev);
		check("yttrandet stängs av tystnaden medan den andra personen talar, inte först vid släppet",
			rig.segments.length === 1 && rig.segments[0].reason === "silence",
			JSON.stringify(rig.segments.map((s) => `${s.durationMs}:${s.reason}`)));
		check("och det innehåller bara bärarens ord",
			rig.segments[0] && rig.segments[0].endMs <= Math.round((mine / 16_000) * 1000) + DEFAULTS.hangoverMs + 100,
			`slutar ${rig.segments[0]?.endMs} ms, bäraren slutade ${Math.round((mine / 16_000) * 1000)} ms`);
		check("de inblandade ramarna tystades, inte kastades — det är det som låter klockan gå",
			rig.mic.stats.muted > 0, JSON.stringify({ muted: rig.mic.stats.muted, dropped: rig.mic.stats.dropped }));
		rig.mic.close("close");
		check("och släppet efteråt har ingenting kvar att skicka", rig.segments.length === 1, shape(rig.segments));
	}

	section("R5b.2: och mellan yttranden kastas de, så brusgolvet inte förgiftas");
	{
		// The other half of the same decision. Digital silence fed to a CLOSED
		// segmenter drags its noise floor to the clamp, and a floor below the
		// room plus the margin means the room itself reads as speech — a segment
		// of nothing, sent to the GPU, every time somebody walks past talking.
		const clean = await throughGlasses(three.pcm);
		const passerby = cat(three.pcm.subarray(16_000 * 3, 16_000 * 8), three.pcm);
		const at = 16_000 * 5 * 2;              // bytes of "somebody else"
		const rig = makeMic();
		await rig.mic.open(false);
		for (const ev of events(passerby, { frameBytes: 3200, role: (_i, byteAt) => (byteAt < at ? SPEAKER.OTHER : SPEAKER.UNKNOWN) })) rig.mic.frame(ev);
		rig.mic.close("close");
		check("fem sekunder av någon annan före inspelningen ändrar ingenting i segmenten",
			shape(rig.segments) === shape(clean.segments), `${shape(rig.segments)}\n     mot ${shape(clean.segments)}`);
		// 5 s at 3200 bytes a frame is 50 frames. Every one of them, and not one
		// muted: muting a CLOSED segmenter is the bug this asserts against.
		check("de ramarna kastades i stället för att tystas", rig.mic.stats.dropped === 50 && rig.mic.stats.muted === 0,
			JSON.stringify({ dropped: rig.mic.stats.dropped, muted: rig.mic.stats.muted }));
	}

	section("R5b.2: ratiot loggas, för om okänd dominerar är filtret värdelöst");
	{
		// Three times the recording: the report is deliberately rare (one line per
		// 30 s of audio), and a fixture shorter than that would make this assert
		// nothing at all.
		const rig = await throughGlasses(cat(three.pcm, three.pcm, three.pcm), { role: (i) => (i % 4 === 0 ? SPEAKER.OTHER : SPEAKER.SELF) });
		const roles = rig.mic.roles;
		check("varje ram räknas som exakt en av de tre",
			roles.self + roles.other + roles.unknown === roles.frames && roles.frames > 100, JSON.stringify(roles));
		check("och fördelningen är den som skickades", Math.abs(roles.other / roles.frames - 0.25) < 0.02, JSON.stringify(roles));
		check("en rad skrivs ut, med alla tre andelarna i sig",
			rig.notes.some((n) => /self \d+%.*other \d+%.*unknown \d+%/.test(n)), JSON.stringify(rig.notes.slice(0, 2)));
		check("men sällan — inte en rad per ram", rig.notes.length < roles.frames / 100,
			`${rig.notes.length} rader på ${roles.frames} ramar`);
	}

	// ==================================================== R5b.1, mikrofonen
	section("R5b.1: att öppna och stänga mikrofonen");
	{
		const rig = makeMic({ pageReady: () => true });
		check("innan något öppnats håller sidan ingen mikrofon", rig.mic.liveTracks === 0 && rig.mic.live === false);
		check("och den säger att den är av", rig.mic.state === "off", rig.mic.state);

		check("den öppnas", (await rig.mic.open(false)) === true, JSON.stringify(rig.states));
		check("genom att be värden om glasögonens egen array (R5b.1)",
			rig.calls.join(",") === `on:${SOURCE.GLASSES}`, rig.calls.join(","));
		check("nu håller sidan exakt en mikrofon", rig.mic.liveTracks === 1 && rig.mic.live === true);

		rig.mic.close("close");
		await sleep(20);
		check("och släppet ber värden stänga den", rig.calls.join(",") === `on:${SOURCE.GLASSES},off:${SOURCE.GLASSES}`, rig.calls.join(","));
		check("noll mikrofoner efteråt — det är hela löftet i PushToTalk",
			rig.mic.liveTracks === 0 && rig.mic.live === false, JSON.stringify(rig.mic.stats));

		// R5b.1: the glasses array needs the startup page; the phone's does not,
		// which is what makes it the fallback.
		const noPage = makeMic({ pageReady: () => false });
		await noPage.mic.open(true);
		check("utan lins-sida öppnas telefonens mikrofon i stället för att misslyckas (R5b.1)",
			noPage.calls.join(",") === `on:${SOURCE.PHONE}`, noPage.calls.join(","));
		check("och det syns vilken det blev", noPage.mic.source === SOURCE.PHONE, noPage.mic.source);
		noPage.mic.close("release");
	}

	section("R5b.1: när värden vägrar, och när den inte svarar");
	{
		const refused = makeMic({ answer: (open) => (open ? false : false) });
		check("en vägrad öppning är inte en öppen mikrofon", (await refused.mic.open(false)) === false);
		check("och den rapporteras som ett beslut, inte som ett fel i mikrofonen",
			refused.mic.state === "denied", `${refused.mic.state}: ${refused.mic.detail}`);
		check("noll mikrofoner efter en vägran", refused.mic.liveTracks === 0);
		refused.mic.frame(events(three.pcm)[0]);
		check("och ramar som ändå kommer in räknas inte som ljud",
			refused.mic.stats.frames === 0 && refused.mic.stats.samples === 0, JSON.stringify(refused.mic.stats.frames));

		const broken = makeMic({ answer: (open) => { if (open) throw new Error("bron är nere"); return false; } });
		check("ett kastat fel vid öppning blir ett fel, inte en krasch", (await broken.mic.open(false)) === false);
		check("med värdens egen förklaring i sig", /bron är nere/.test(broken.mic.detail), broken.mic.detail);
		check("och mikrofonen är av", broken.mic.liveTracks === 0 && broken.mic.state === "error", broken.mic.state);

		// Measured through the simulator's own bridge: the Even App answers
		// FALSE to audioControl(false) even when it really stopped, and not one
		// further frame arrived. Treating that as a failure would paint an error
		// on the lens every time the user let go of the touchpad.
		const curt = makeMic({ answer: (open) => (open ? true : false) });
		await curt.mic.open(true);
		curt.mic.close("release");
		await sleep(20);
		check("ett kort \"false\" på en stängning är inget fel — värden svarar så",
			curt.mic.state === "off" && curt.mic.stats.stopFailures === 0, `${curt.mic.state} ${curt.mic.detail}`);

		const stuck = makeMic({ answer: (open) => { if (!open) throw new Error("stängningen gick inte fram"); return true; } });
		await stuck.mic.open(true);
		stuck.mic.close("release");
		await sleep(20);
		check("en stängning som kastar räknas, men lämnar ingen falsk \"lyssnar\"",
			stuck.mic.stats.stopFailures === 1 && stuck.mic.state === "off" && stuck.mic.liveTracks === 0,
			JSON.stringify({ state: stuck.mic.state, fails: stuck.mic.stats.stopFailures }));
	}

	section("R5b.1: släpp mitt i en öppning lämnar ingen mikrofon igång");
	{
		// The race PRD 5a hit in the browser and fixed with a generation counter,
		// now over BLE, where it is easier to hit: audioControl is a round trip
		// of ~160-200 ms and a thumb is faster than that.
		const rig = makeMic({ controlDelay: 120 });
		const opening = rig.mic.open(true);
		await sleep(20);
		rig.mic.close("release");            // released before the link answered
		check("släppet gör mikrofonen av med en gång", rig.mic.liveTracks === 0 && rig.mic.live === false);
		check("öppningen ger upp i stället för att lyckas efteråt", (await opening) === false);
		await sleep(250);
		check("fortfarande ingen mikrofon när länken svarat",
			rig.mic.liveTracks === 0 && rig.mic.live === false, JSON.stringify({ state: rig.mic.state, detail: rig.mic.detail }));
		check("och värden fick en stängning EFTER att öppningen besvarats — inte bara före",
			rig.calls.filter((c) => c.startsWith("off")).length >= 1 && rig.calls.at(-1).startsWith("off"),
			rig.calls.join(","));
		rig.mic.frame(events(three.pcm)[0]);
		check("ramar som anländer efter släppet blir inte nästa yttrande",
			rig.segments.length === 0 && rig.mic.stats.frames === 0, shape(rig.segments));

		// The other side of the same boundary, and the reason the segmenter is
		// built BEFORE the round trip: the ~160-200 ms that audioControl takes to
		// answer is exactly when a push-to-talk user starts talking, and a frame
		// that arrives in it is the first syllable (R5b.3).
		const early = makeMic({ controlDelay: 120 });
		const earlyOpen = early.mic.open(true);
		await sleep(20);
		for (const ev of events(three.pcm.subarray(0, 16_000 * 2), { frameBytes: 3200 })) early.mic.frame(ev);
		check("men ramar som kommer medan länken fortfarande svarar tas emot",
			early.mic.stats.samples > 16_000, `${early.mic.stats.samples} prov`);
		await earlyOpen;
		early.mic.close("release");
		check("och de blir ett yttrande som vilket annat", early.segments.length === 1, shape(early.segments));
	}

	section("R5b.3: kostnaden att öppna mäts, den gissas inte");
	{
		// R5b.3: "Cost to measure before promising." A user who starts speaking
		// as they press loses the lead-in, and the only honest way to decide what
		// to do about it is to read the number off a running system.
		let clock = 1000;
		const rig = makeMic({ now: () => clock, answer: () => { clock += 170; return true; } });
		await rig.mic.open(true);
		check("hur länge värden tog på sig att öppna står i siffror", rig.mic.stats.openMs === 170, String(rig.mic.stats.openMs));
		clock += 30;
		rig.mic.frame(events(three.pcm)[0]);
		check("och hur länge det dröjde till första ramen — stavelsen som går förlorad",
			rig.mic.stats.leadInMs === 200, String(rig.mic.stats.leadInMs));
		rig.mic.close("release");

		clock = 5000;
		await rig.mic.open(true);
		clock += 55;
		rig.mic.frame(events(three.pcm)[0]);
		check("mätningen är per håll, inte per sidladdning", rig.mic.stats.leadInMs === 225, String(rig.mic.stats.leadInMs));
		rig.mic.close("release");
	}

	section("R5b.4: bandbredden är räknad ur det som faktiskt kom in");
	{
		const rig = await throughGlasses(three.pcm);
		check("varje byte värden skickade är räknad", rig.mic.stats.bytes === three.pcm.byteLength,
			`${rig.mic.stats.bytes} mot ${three.pcm.byteLength}`);
		// 16 kHz x 16 bit mono is 32 kB/s. That is arithmetic, and R5b.4 says to
		// measure the real rate rather than trust it — but the arithmetic has to
		// be right before the measurement means anything.
		const perSecond = rig.mic.stats.bytes / (three.durationMs / 1000);
		check("vilket är 32 kB per sekund ljud, som R5b.4 räknar med",
			Math.abs(perSecond - 32_000) < 100, `${Math.round(perSecond)} B/s`);
		check("och inget paket slutade på en halv sampling i den här leveransen",
			rig.mic.stats.odd === 0, String(rig.mic.stats.odd));
	}

	// ======================================= R5b.3, hållet genom hela klienten
	section("R5b.3: hållet är ovillkorligt (R5a.4)");
	{
		// R5a.4: "no page state, no active worker and no connection status may
		// stop a hold from opening the microphone", because in PushToTalk it is
		// the only way to speak a mode command back out again. PRD 5b routes the
		// touchpad into the same place, so the same thing has to be true there.
		const sent = [];
		const opens = [];
		const source = (name) => ({
			state: "off", detail: "", live: false, liveTracks: 0, speaking: false, levelDb: -100,
			stats: { opens: 0, segments: 0, samples: 0, deniedAt: 0 },
			async open(hold) { opens.push(`${name}:${hold ? "hold" : "open"}`); this.live = true; this.liveTracks = 1; this.state = "listening"; return true; },
			close(reason) { opens.push(`${name}:close:${reason}`); this.live = false; this.liveTracks = 0; this.state = "off"; }
		});

		for (const state of [
			{ what: "avstängd mikrofonbrytare", set: (v) => { v.enabled = false; } },
			{ what: "pausat läge", set: (v) => { v.mode = MODES.IGNORE; } },
			{ what: "håll in-läge", set: (v) => { v.mode = MODES.PUSHTOTALK; } },
			{ what: "alltid-läge", set: (v) => { v.mode = MODES.ALWAYS; } }
		]) {
			opens.length = 0;
			const glasses = source("glasses");
			const v = new Voice({ send: () => false, onChange: () => { }, onNote: () => { }, glasses, hostReady: () => true });
			state.set(v);
			await v.holdStart();
			check(`ett håll öppnar glasögonens mikrofon i ${state.what}`,
				opens.join(",") === "glasses:hold" && glasses.liveTracks === 1, opens.join(","));
			v.holdEnd();
			check(`och släppet stänger den i ${state.what}`,
				glasses.liveTracks === 0 && opens.at(-1) === "glasses:close:release", opens.join(","));
		}

		// The hold must not depend on there being a socket either — the segment
		// is dropped with a note, which is PRD 5a's behaviour, but the microphone
		// still opens.
		opens.length = 0;
		const glasses = source("glasses");
		const notes = [];
		const v = new Voice({ send: (pcm) => { sent.push(pcm); return false; }, onChange: () => { }, onNote: (t) => notes.push(t), glasses, hostReady: () => true });
		await v.holdStart();
		check("och utan anslutning öppnas den ändå", glasses.liveTracks === 1, opens.join(","));
		v.holdEnd();

		// A hold spans a period during which the glasses can be taken off. The
		// release must close the microphone the PRESS opened, not whichever one
		// is preferred by the time the finger comes up — otherwise a hold that
		// outlives the glasses leaves their microphone running on hardware, which
		// is the trust problem R5b.1 calls the worse of the two.
		opens.length = 0;
		const dropped = makeMic();
		const browserMic = source("browser");
		let stillThere = true;
		const v3 = new Voice({
			send: () => false, onChange: () => { }, onNote: () => { },
			mic: browserMic, glasses: dropped.mic, hostReady: () => stillThere
		});
		v3.mode = MODES.BYNAME;                   // a mode that wants an open microphone
		await v3.holdStart();
		check("hållet öppnade glasögonens mikrofon", dropped.mic.liveTracks === 1, dropped.calls.join(","));

		stillThere = false;                       // taken off, mid-hold
		await v3.setEnabled(true);                // ...and the switch flipped on
		check("de bortlagda glasögonens mikrofon stängs, och webbläsarens öppnas i stället",
			dropped.mic.liveTracks === 0 && browserMic.liveTracks === 1,
			`glasögon ${dropped.mic.liveTracks}, webbläsare ${browserMic.liveTracks}`);

		v3.holdEnd();
		await sleep(20);
		check("och släppet stänger inte den mikrofon hållet aldrig öppnade",
			browserMic.liveTracks === 1 && dropped.mic.liveTracks === 0,
			`glasögon ${dropped.mic.liveTracks}, webbläsare ${browserMic.liveTracks}`);

		// And it must not depend on the LENS page: that is what makes the phone
		// microphone the fallback rather than a failure (R5b.1).
		opens.length = 0;
		const rig = makeMic({ pageReady: () => false });
		const v2 = new Voice({ send: () => false, onChange: () => { }, onNote: () => { }, glasses: rig.mic, hostReady: () => true });
		await v2.holdStart();
		check("utan lins-sida öppnar hållet telefonens mikrofon i stället för ingenting",
			rig.mic.liveTracks === 1 && rig.calls.join(",") === `on:${SOURCE.PHONE}`, rig.calls.join(","));
		v2.holdEnd();
	}

	section("R5b.1: mikrofonen stannar vid bakgrund, avslut och byte av enhet");
	{
		const rig = makeMic({ pageReady: () => true });
		const v = new Voice({ send: () => true, onChange: () => { }, onNote: () => { }, glasses: rig.mic, hostReady: () => true });
		v.mode = MODES.ALWAYS;
		await v.setEnabled(true);
		check("i alltid-läge står mikrofonen öppen", rig.mic.liveTracks === 1, JSON.stringify(v.status));

		v.suspend("close");
		await sleep(20);
		check("bakgrunden stänger den (R5b.1)", rig.mic.liveTracks === 0 && rig.calls.at(-1).startsWith("off"), rig.calls.join(","));
		check("och klienten säger att den är av", v.status.live === false, JSON.stringify(v.status));

		await v.resume();
		check("förgrunden öppnar den igen, eftersom läget vill ha den öppen", rig.mic.liveTracks === 1);

		// Coming back in PushToTalk must NOT drop the user into an open mic.
		v.suspend("close");
		v.mode = MODES.PUSHTOTALK;
		await v.resume();
		check("men i håll in-läge öppnas ingenting av att komma tillbaka", rig.mic.liveTracks === 0, JSON.stringify(v.status));

		// A hold that is still down when the app goes away is released by the
		// suspend: an open microphone nobody is holding is the worst of both.
		await v.holdStart();
		check("ett håll öppnar den", rig.mic.liveTracks === 1);
		v.suspend("close");
		check("och bakgrunden mitt i ett håll stänger den ändå", rig.mic.liveTracks === 0 && v.status.held === false, JSON.stringify(v.status));

		v.dispose();
		check("och dispose lämnar ingenting öppet", rig.mic.liveTracks === 0);
	}

	section("R5b.1: de tre avstängningarna är verkligen inkopplade");
	{
		// A source check, and it says why it is one. R5b.1 names three moments
		// the microphone must stop at — exit, backgrounding and error — and two
		// of them cannot be produced anywhere this suite can reach: the simulator
		// never sends FOREGROUND_EXIT_EVENT, and `pagehide` needs a WebView being
		// torn down. The BEHAVIOUR of suspend() is driven for real above; what is
		// left to check is that the three events are actually wired to it, which
		// is a deletion away at any time.
		const main = readFileSync(join(ROOT, "client", "src", "main.ts"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
		const wired = [
			["bakgrunden", /onBackground:\s*\(\)\s*=>\s*\{[^}]*voice\.suspend\(/],
			["avslutet", /onExit:\s*\([^)]*\)\s*=>\s*\{[^}]*voice\.suspend\(/],
			["sidan som rivs ner", /addEventListener\?\.\("pagehide"[\s\S]{0,80}?voice\.suspend\(/]
		];
		for (const [what, re] of wired) {
			check(`${what} stänger mikrofonen (R5b.1)`, re.test(main), "ingen suspend() kopplad");
		}
		// The third moment, error, needs no source check: it is produced for real
		// above, where a bridge that throws leaves the microphone off.
	}

	section("R5b.1: när glasögonen försvinner följer mikrofonen med");
	{
		const rig = makeMic();
		let attached = true;
		const v = new Voice({ send: () => true, onChange: () => { }, onNote: () => { }, glasses: rig.mic, hostReady: () => attached });
		v.mode = MODES.ALWAYS;
		await v.setEnabled(true);
		check("glasögonens mikrofon används medan de finns", v.device === SOURCE.GLASSES && rig.mic.liveTracks === 1, v.device);

		attached = false;
		await v.setEnabled(true);
		check("när de tas av stängs deras mikrofon i stället för att lämnas igång",
			rig.mic.liveTracks === 0 && rig.calls.at(-1).startsWith("off"), rig.calls.join(","));
		check("och klienten talar om vilken mikrofon som gäller nu", v.device === "browser", v.device);
	}

	section("utan värd rör klienten inte SDK:ns mikrofon alls");
	{
		// A desktop browser has a Glasses object too — it just never attached.
		// Asking IT for a microphone would be a laptop that can no longer hear.
		const rig = makeMic();
		const browser = {
			state: "off", detail: "", live: false, liveTracks: 0, speaking: false, levelDb: -100,
			stats: { opens: 0, segments: 0, samples: 0, deniedAt: 0 },
			async open() { this.live = true; this.liveTracks = 1; this.state = "listening"; return true; },
			close() { this.live = false; this.liveTracks = 0; this.state = "off"; }
		};
		const v = new Voice({ send: () => true, onChange: () => { }, onNote: () => { }, mic: browser, glasses: rig.mic, hostReady: () => false });
		v.mode = MODES.ALWAYS;
		await v.setEnabled(true);
		check("webbläsarens mikrofon öppnas", browser.liveTracks === 1);
		check("och värden blir aldrig tillfrågad", rig.calls.length === 0, rig.calls.join(","));
		check("statusen säger vilken det var", v.status.device === "browser", v.status.device);
		v.dispose();
	}

	// ===================================================== SDK-lagret
	section("SDK-lagret: ljudet dirigeras, gesterna fortsätter att fungera (R5b.1, R5b.3)");
	{
		const calls = [];
		let emit = null;
		const bridge = {
			createStartUpPageContainer: async () => { calls.push("create"); return 0; },
			textContainerUpgrade: async () => true,
			shutDownPageContainer: async () => true,
			audioControl: async (open, source) => { calls.push(`audio:${open}:${source}`); return open; },
			onEvenHubEvent: (fn) => { emit = fn; return () => { }; }
		};
		globalThis.flutter_inappwebview = { callHandler: async () => ({}) };

		const gestures = [];
		const frames = [];
		let background = 0;
		const g = new Glasses(
			{ onGesture: (x) => gestures.push(x), onAudio: (f) => frames.push(f), onBackground: () => background++ },
			{ bridgeFactory: async () => bridge, callTimeoutMs: 300 });
		check("sidan byggs", (await g.attach("hej", 500)) === true, String(g.error));

		emit({ audioEvent: { audioPcm: new Uint8Array([1, 2, 3, 4]), source: "glasses", speakerRole: "self", direction: null } });
		check("en ljudram dirigeras till mikrofonlagret", frames.length === 1 && frames[0].audioPcm.length === 4, JSON.stringify(frames.length));
		check("och räknas inte som en gest", gestures.length === 0, gestures.join(","));

		// Protobuf drops zero values, so an EMPTY sysEvent reads as a tap — the
		// documented first mistake. An event that carries audio must therefore
		// stop at the audio, or a host that always attaches an empty sysEvent
		// would page the lens ten times a second for as long as the microphone
		// is open.
		frames.length = 0;
		emit({ audioEvent: { audioPcm: new Uint8Array([1, 2]) }, sysEvent: {} });
		check("en ljudram med ett tomt sysEvent bredvid sig är fortfarande bara ljud",
			frames.length === 1 && gestures.length === 0, `${frames.length} ramar, gester: ${gestures.join(",")}`);

		gestures.length = 0;
		emit({ sysEvent: { eventType: 9 } });
		emit({ sysEvent: { eventType: 10 } });
		check("långtryckets två halvor är fortfarande två gester (R5b.3)",
			gestures.join(",") === "holdStart,holdEnd", gestures.join(","));

		emit({ sysEvent: { eventType: 5 } });
		check("och bakgrunden rapporteras, så mikrofonen kan stängas (R5b.1)", background === 1, String(background));

		calls.length = 0;
		check("audioControl går genom bron med källan med sig", (await g.audioControl(true, SOURCE.GLASSES)) === true, calls.join(","));
		check("och stänger med samma anrop", (await g.audioControl(false, SOURCE.GLASSES)) === false, calls.join(","));
		check("båda syntes på bron", calls.join(",") === `audio:true:${SOURCE.GLASSES},audio:false:${SOURCE.GLASSES}`, calls.join(","));

		// A host that answers nothing at all is not a host that opened the
		// microphone. Only an explicit `true` is an open, because the alternative
		// is a client that says it is listening on the strength of a silence.
		const mute = new Glasses({}, {
			bridgeFactory: async () => ({
				createStartUpPageContainer: async () => 0,
				audioControl: async () => undefined,
				onEvenHubEvent: () => () => { }
			})
		});
		await mute.attach("start", 500);
		check("ett värdsvar som inte är ett ja är inte en öppen mikrofon",
			(await mute.audioControl(true, SOURCE.GLASSES)) === false);

		// Every bridge call gets a deadline — a hung audioControl would leave a
		// push-to-talk user holding a touchpad that never becomes live. Raced
		// here as well: without the deadline this line would hang the whole run,
		// and a run that hangs exits quietly, which reads as a pass.
		let release;
		const hung = new Glasses({}, {
			bridgeFactory: async () => ({
				createStartUpPageContainer: async () => 0,
				audioControl: () => new Promise((r) => { release = r; }),
				onEvenHubEvent: () => () => { }
			}),
			callTimeoutMs: 150
		});
		await hung.attach("start", 500);
		const outcome = await within(hung.audioControl(true, SOURCE.GLASSES), 3000);
		check("ett hängande audioControl ger upp i stället för att låsa ett håll",
			outcome instanceof Error && /timed out/.test(outcome.message), String(outcome?.message ?? outcome));
		release?.(true);

		delete globalThis.flutter_inappwebview;
	}

	// ================================================== statusraden på linsen
	section("R5b.3: hållet syns på linsen i samma ögonblick det börjar");
	{
		// "Do not ship a hold-to-talk whose start the user cannot see — there is
		// no speaker on the glasses, so the screen is the only feedback there
		// is." And the two words are not the same word: opening the microphone
		// costs a measured round trip, and saying it is live before it is loses
		// exactly the syllable the honesty was for.
		const s = new Store();
		s.apply({ type: "state", busy: false, worker: null, mode: MODES.PUSHTOTALK, seq: 1 });
		s.setConnection("online", "");
		const v = (over) => ({ enabled: true, live: false, held: false, speaking: false, mic: "off", detail: "", sent: 0, lastSegmentMs: 0, device: "glasses", ...over });

		s.setVoice(v({}));
		check("utan håll står läget där", s.lensStatus() === "hold to talk", String(s.lensStatus()));
		s.setVoice(v({ held: true, mic: "starting" }));
		check("i samma ögonblick knappen trycks ned syns det", s.lensStatus() === "opening", String(s.lensStatus()));
		s.setVoice(v({ held: true, live: true, mic: "listening" }));
		check("och när mikrofonen verkligen är öppen byter raden ord", s.lensStatus() === "held", String(s.lensStatus()));

		// It has to outrank a background notice: the user has a finger on the
		// touchpad right now.
		s.apply({ type: "event", kind: "workerNotice", data: { worker: "Bosse", kind: "question" } });
		check("och ett väntande meddelande tränger inte undan det", s.lensStatus() === "held", String(s.lensStatus()));
		s.setVoice(v({}));
		check("men när hållet släppts kommer meddelandet fram", /Bosse/.test(s.lensStatus() ?? ""), String(s.lensStatus()));

		// A dead socket still outranks everything: an answer that will never
		// arrive must not read as one that is on its way.
		s.setVoice(v({ held: true, live: true }));
		s.setConnection("connecting", "");
		check("men en död anslutning slår även ett håll", s.lensStatus() === "offline", String(s.lensStatus()));
	}

	// ===================================== krav 7, hela vägen genom servern
	section("krav 7: samma väg genom servern, utan en enda förgrening");
	{
		// The structural half. A branch on where the audio came from cannot exist
		// downstream of capture if the server has never heard of glasses.
		// Comments stripped first. The server's comments EXPLAIN that the glasses
		// and the keyboard arrive at the same place, and a search that counted
		// that explanation as a branch would be a check that can never go green.
		const serverSource = ["handler.js", "audio.js", "routing.js", "whisper.js", "protocol.js"]
			.map((f) => readFileSync(join(ROOT, "src", f), "utf8"))
			.join("\n")
			.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
		const leaks = ["glasses", "speakerRole", "audioInputSource", "audioEvent", "beamform", "wearer"]
			.filter((w) => new RegExp(w, "i").test(serverSource));
		check("servern har aldrig hört talas om glasögon (krav 7)", leaks.length === 0, leaks.join(", "));

		// And the client sends the same message either way: the send callback is
		// handed the PCM and the length, and nothing about the device.
		// Built the way main.ts builds it — from a control function, not from an
		// injected microphone — so the segment really does travel the path a
		// segment travels: bridge -> glasses microphone -> segmenter -> send.
		const seen = [];
		const v = new Voice({
			send: (pcm, info) => { seen.push(Object.keys(info).sort().join(",")); return true; },
			onChange: () => { }, onNote: () => { },
			glassesControl: async (open) => open, hostReady: () => true
		});
		await v.holdStart();
		for (const ev of events(three.pcm.subarray(0, 16_000 * 3), { frameBytes: 3200 })) v.glassesFrame(ev);
		v.holdEnd();
		check("ett glasögonsegment lämnar klienten med exakt samma uppgifter som ett webbläsarsegment",
			seen.length === 1 && seen[0] === "durationMs,floorDb,peakDb,reason", JSON.stringify(seen));

		// The behavioural half. Both segments on the same wire, to the same
		// server, and the answers compared message by message.
		const browserSeg = segmentPcm(three.pcm)[0];
		const glassesRig = await throughGlasses(three.pcm);
		const glassesSeg = glassesRig.segments[0];
		check("de två segmenten är samma bytes innan de skickas",
			pcmBase64(browserSeg.pcm) === pcmBase64(glassesSeg.pcm), "olika bytes");

		const stub = await startWhisperStub(["Mike, vad är klockan"]);
		stubs.push(stub);
		const server = await startServer(["--handler", "echo", "--whisper", stub.url]);
		servers.push(server);
		const c = await connect(server);

		const answers = [];
		for (const seg of [glassesSeg, browserSeg]) {
			const since = c.mark();
			c.send({ type: "audio", pcm: pcmBase64(seg.pcm), final: true, sampleRate: 16_000 });
			await c.waitFor((m) => m.type === "state" && m.busy === false, 10_000, "tyst efter yttrandet", since);
			// Sequence numbers and the session's own clock are the only things
			// allowed to differ between two identical utterances.
			answers.push(JSON.stringify(c.messages.slice(since).map((m) => ({ type: m.type, text: m.text, kind: m.kind, busy: m.busy }))));
		}
		check("glasögonyttrandet och webbläsaryttrandet ger identiska svar från servern (krav 7)",
			answers[0] === answers[1], `${answers[0]}\n     mot ${answers[1]}`);
		check("och tjänsten fick exakt samma bytes båda gångerna",
			stub.requests.length === 2 && stub.requests[0].pcm.equals(stub.requests[1].pcm),
			`${stub.requests[0]?.bytes} mot ${stub.requests[1]?.bytes}`);
		check("inga ouppfångade undantag i servern", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
		c.close();
	}

	section("krav 2 och 3: vad filtret klarar, och vad läget måste klara");
	{
		// Honest bookkeeping. Criterion 2 ("another person talking nearby does
		// not produce a turn") is the filter's, and is asserted above. Criterion
		// 3 ("the wearer talking to that person does not produce a turn") is NOT:
		// speakerRole says Self either way, because it is the wearer either way.
		// It is the addressing mode that has to carry it, which is R5a.4's job
		// and is why ByName is the default.
		const rig = await throughGlasses(three.pcm, { role: () => SPEAKER.SELF });
		check("bärarens ord når alltid fram till segmenteraren — filtret sorterar dem inte",
			rig.segments.length === 3, shape(rig.segments));
		const { route } = await import("../src/routing.js");
		check("så det som skiljer ett samtal med en annan människa från ett tilltal är läget (krav 3)",
			route("vad tycker du om det", { mode: MODES.BYNAME, worker: null, origin: "voice" }).kind === "dropped",
			JSON.stringify(route("vad tycker du om det", { mode: MODES.BYNAME, worker: null, origin: "voice" })));
		check("medan ett tilltal går fram",
			route("Mike, vad är klockan", { mode: MODES.BYNAME, worker: null, origin: "voice" }).kind === "mike");
	}

	section("tystnad genom glasögonen kostar ingenting (krav 5 i PRD 5a)");
	{
		const quiet = await throughGlasses(roomTone(6000));
		check("sex sekunder rumston blir inga segment och inget på tråden", quiet.segments.length === 0, shape(quiet.segments));
		const digital = await throughGlasses(new Int16Array(16_000 * 4));
		check("och digital tystnad inte heller", digital.segments.length === 0, shape(digital.segments));
	}

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	for (const s of servers) { try { s.stop(); } catch { /* already gone */ } }
	for (const s of stubs) { try { await s.stop(); } catch { /* already closed */ } }
	for (const d of fakeDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
	clearTimeout(watchdog);
}

section("linsen ljuger inte om att den lyssnar");
{
	const st = new Store();
	st.state.connection = "online";
	const voice = (over) => { st.state.voice = { enabled: false, live: false, held: false, speaking: false, mic: "closed", detail: "", sent: 0, lastSegmentMs: 0, device: "glasses", ...over }; };

	// Whether the microphone is open is the title bar's mark now (lensMic),
	// not this row's word: the word vanished behind "thinking 12s", which is
	// exactly when the user was looking for it.
	st.state.mode = "always"; voice({});
	check("always med mikrofonen av säger always — märket säger av", st.lensStatus() === "always" && st.lensMic() === "off", `${st.lensStatus()} ${st.lensMic()}`);
	voice({ enabled: true });
	check("always med mikrofonen på säger always", st.lensStatus() === "always", String(st.lensStatus()));

	st.state.mode = "byname"; voice({});
	check("standardläget med mikrofonen av säger ingenting — märket räcker", st.lensStatus() === null && st.lensMic() === "off", String(st.lensStatus()));
	voice({ enabled: true });
	check("och säger ingenting när den är på — det är det vanliga läget", st.lensStatus() === null, String(st.lensStatus()));

	st.state.mode = "pushtotalk"; voice({});
	check("håll-in-läget nämner inte en stängd mikrofon — det är hela läget",
		st.lensStatus() !== "mic off", String(st.lensStatus()));

	st.state.mode = "ignore"; voice({});
	check("pausat väger tyngre än mikrofonens läge", st.lensStatus() === "paused", String(st.lensStatus()));

	st.state.mode = "always"; voice({ held: true, live: true });
	check("ett pågående håll väger tyngst av allt", st.lensStatus() === "held", String(st.lensStatus()));
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
