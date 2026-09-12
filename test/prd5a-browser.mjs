// PRD 5a — the whole pipeline, spoken, in a real browser.
//
//   node test/prd5a-browser.mjs            [--keep-service]
//
// Acceptance criteria 1, 2, 3, 4 and 5 are about a person talking into a page,
// so this suite does exactly that: headless Chrome with a WAV file wired to
// getUserMedia in place of a microphone (--use-file-for-fake-audio-capture),
// the client's own capture and segmentation, the real whisper service on the
// GPU, and a Mike server with the Claude Code stand-in behind it. Nothing in
// the speech path is mocked; the only stand-in is the model that answers.
//
// It runs headless. A browser window on the developer's desktop steals focus
// every run, and everything read here comes over the DevTools protocol.
//
// The service takes about fifteen seconds to load a model, so this is not part
// of `npm test`. Set MIKE_WHISPER_URL to a service that is already running
// and it will use that one instead.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { startServer, check, failed, section, sleep, ROOT } from "./harness.mjs";
import { launchChrome } from "./chrome.mjs";
import { startWhisperService, whisperInstalled, WHISPER_PYTHON, VOICE_DIR } from "./voice.mjs";
import { MODES } from "../src/routing.js";

const FAKE = join(ROOT, "test", "fixtures", "fake-claude.mjs");

const servers = [];
const browsers = [];
const fakeDirs = [];
let service = null;

const newFakeDir = () => { const d = mkdtempSync(join(tmpdir(), "fake-claude-")); fakeDirs.push(d); return d; };

/** Chrome with a file where the microphone should be. `--use-fake-ui-for-media-stream`
 *  answers the permission prompt, which is the one thing about the real flow
 *  that cannot be automated — and is a decision the user has already made by
 *  the time any of this matters. */
const audioFlags = (wav, { loop = true } = {}) => [
	// The flag is --use-fake-device-for-media-STREAM. The capture spelling is a
	// plausible name Chrome silently ignores, and the page then opens the real
	// default device, which on a headless machine is a microphone that hears
	// nothing — a suite that waits thirty seconds for a sentence nobody said.
	"--use-fake-device-for-media-stream",
	"--use-fake-ui-for-media-stream",
	// `%noloop` plays the file once and then feeds silence, which is what a
	// person does after a sentence. Without it Chrome starts the recording over
	// and the same words arrive again thirty seconds later.
	`--use-file-for-fake-audio-capture=${wav}${loop ? "" : "%noloop"}`,
	"--autoplay-policy=no-user-gesture-required"
];

/** Transcript entries, in order, as "kind|text". The order is half of what is
 *  being asserted: R5a.8 says what was heard is shown BEFORE the answer. */
const transcript = (b) => b.evaluate(`[...document.querySelectorAll(".transcript .entry")]
	.map((e) => e.className.replace("entry ", "") + "|" + (e.querySelector(".what")?.textContent ?? ""))`);

const openClient = async (server, wav, opts) => {
	const b = await launchChrome(`http://127.0.0.1:${server.port}/?token=${server.token}`, { args: audioFlags(wav, opts) });
	browsers.push(b);
	await b.waitFor(`document.querySelector(".dot")?.className.includes("online")`, 20_000, "anslutning");
	return b;
};

try {
	check("klienten är byggd", existsSync(join(ROOT, "public", "index.html")), "kör npm run build:client först");

	// ------------------------------------------------------------- tjänsten
	section("transkriberingstjänsten");
	if (process.env.MIKE_WHISPER_URL) {
		service = { url: process.env.MIKE_WHISPER_URL.replace(/\/+$/, ""), stop() { }, log: () => "(extern)" };
		console.log(`  --   använder tjänsten som redan kör: ${service.url}`);
	} else {
		check("tjänstens python finns", whisperInstalled(), `${WHISPER_PYTHON} — se services/whisper/serve.py`);
		if (!whisperInstalled()) throw new Error("ingen whisper-tjänst installerad");
		service = await startWhisperService();
	}
	const health = await (await fetch(`${service.url}/healthz`)).json();
	check("den är igång och varm", health.ok === true && health.warm === true, JSON.stringify(health));
	check("den lyssnar bara på loopback", /^http:\/\/127\.0\.0\.1:/.test(service.url), service.url);

	const server = await startServer(
		["--claude-bin", FAKE, "--worker-cwd", "/tmp", "--mike-cwd", "/tmp", "--whisper", service.url, "--mode", MODES.BYNAME],
		{ env: { FAKE_CLAUDE_DIR: newFakeDir() } });
	servers.push(server);

	// ======================================================== krav 1, 2 och 3
	section("skrivbordet: tala, bli förstådd, få svar (krav 1 och 2)");
	const talker = await openClient(server, join(VOICE_DIR, "three-sv.wav"), { loop: false });

	// R5a.1: ingen mikrofon innan användaren ber om den. Sidan har varit uppe i
	// flera sekunder vid det här laget.
	check("sidan öppnar ingen mikrofon av sig själv (R5a.1)",
		(await talker.evaluate(`mike.tracks()`)) === 0 && (await talker.evaluate(`mike.mic().opens`)) === 0,
		JSON.stringify(await talker.evaluate(`mike.mic()`)));
	check("och säger att den är av", (await talker.evaluate(`document.querySelector(".voice button.mic").textContent`)) === "Microphone off");

	await talker.click(".voice button.mic");
	await talker.waitFor(`mike.voice().live === true`, 10_000, "att mikrofonen öppnas");
	check("ett klick på knappen öppnar den", (await talker.evaluate(`mike.tracks()`)) === 1, String(await talker.evaluate(`mike.tracks()`)));
	check("och indikatorn säger att den lyssnar (R5a.8)",
		/listening|heard/.test(await talker.evaluate(`document.querySelector(".chip.listening").textContent`)),
		await talker.evaluate(`document.querySelector(".chip.listening").textContent`));

	// "Mike, vad är klockan?" — inspelat tal, genom segmenteraren, tråden och
	// whisper. Inget rörs medan det händer.
	await talker.waitFor(`document.querySelector(".transcript").textContent.toLowerCase().includes("klockan")`, 30_000, "att den hör frågan");
	const heardText = await talker.evaluate(`[...document.querySelectorAll(".transcript .entry.said .what")].map((e) => e.textContent).join(" | ")`);
	check("det som sades hörs och visas (krav 2)", /klockan/i.test(heardText), heardText);
	check("och det tilltalet plockades upp", /mike/i.test(heardText), heardText);

	await talker.waitFor(`document.querySelector(".transcript").textContent.includes("mike turn")`, 30_000, "svaret");
	const order = await transcript(talker);
	const heardAt = order.findIndex((e) => e.startsWith("said|") && /klockan/i.test(e));
	const replyAt = order.findIndex((e) => e.includes("mike turn"));
	check("frågan får ett svar på skärmen, utan att något rörts (krav 1)", replyAt >= 0, JSON.stringify(order));
	check("och det som hördes stod där före svaret (krav 2, R5a.8)", heardAt >= 0 && heardAt < replyAt, JSON.stringify(order));
	check("svaret bär vad Mike faktiskt fick — tilltalet bortklippt",
		/vad är klockan/i.test(order[replyAt] ?? ""), order[replyAt]);

	// Krav 3: "Hey Mike, pausa input" och sedan "Fortsätt input", båda talade.
	section("skrivbordet: talade lägeskommandon (krav 3)");
	await talker.waitFor(`mike.state().mode === ${JSON.stringify(MODES.IGNORE)}`, 30_000, "att input pausas av ett talat kommando");
	check("ett talat \"pausa input\" pausar allt som når samtalet (krav 3)",
		(await talker.evaluate(`mike.state().mode`)) === MODES.IGNORE);
	check("och telefonen visar det som det senaste som hände",
		/paused/.test(await talker.evaluate(`document.querySelector(".lastevent").textContent`)),
		await talker.evaluate(`document.querySelector(".lastevent").textContent`));
	check("mikrofonen är fortfarande öppen i pausat läge — annars går det inte att prata sig ur",
		(await talker.evaluate(`mike.tracks()`)) === 1);

	await talker.waitFor(`mike.state().mode === ${JSON.stringify(MODES.BYNAME)}`, 30_000, "att \"fortsätt input\" tar tillbaka läget");
	check("och ett talat \"fortsätt input\" tar tillbaka läget som gällde innan (krav 3)",
		(await talker.evaluate(`mike.state().mode`)) === MODES.BYNAME);

	// Krav 5: när filen är slut matar Chrome tystnad. Ingenting mer får hända.
	section("tystnad kostar ingenting (krav 5)");
	const sentAfterSpeech = await talker.evaluate(`mike.voice().sent`);
	const entriesAfterSpeech = (await transcript(talker)).length;
	await sleep(6000);
	check("tystnad ger inga fler segment på tråden",
		(await talker.evaluate(`mike.voice().sent`)) === sentAfterSpeech,
		`${sentAfterSpeech} -> ${await talker.evaluate(`mike.voice().sent`)}`);
	check("och ingen ny rad i samtalet", (await transcript(talker)).length === entriesAfterSpeech);
	check("tre yttranden i filen blev tre segment på tråden", sentAfterSpeech === 3, String(sentAfterSpeech));
	check("inga fel i konsolen under hela varvet", talker.consoleErrors.length === 0, JSON.stringify(talker.consoleErrors.slice(0, 3)));

	// ================================================================== krav 4
	section("håll in för att tala: mikrofonen är av när knappen inte hålls (krav 4)");
	// En fil som talar oavbrutet: om mikrofonen vore öppen skulle det synas
	// omedelbart, vilket är hela poängen med kontrollen nedan.
	const holder = await openClient(server, join(VOICE_DIR, "talk-sv.wav"));
	// There is no mode picker on the phone any more: the mode is changed by
	// saying or typing it, and typed is what a test can do.
	await holder.waitFor(`document.querySelector(".dot")?.className.includes("online")`, 20_000, "anslutning");
	await holder.evaluate(`(() => {
		const i = document.querySelector(".composer input");
		i.value = "switch to push to talk";
		document.querySelector(".composer").dispatchEvent(new Event("submit", { cancelable: true }));
		return true;
	})()`);
	await holder.waitFor(`mike.state().mode === ${JSON.stringify(MODES.PUSHTOTALK)}`, 10_000, "läget håll in");

	// Och mikrofonbrytaren PÅ: i det här läget ska den ändå inte öppna något.
	await holder.click(".voice button.mic");
	await sleep(4000);
	check("med läget håll in är mikrofonen av trots att brytaren är på (krav 4)",
		(await holder.evaluate(`mike.tracks()`)) === 0, JSON.stringify(await holder.evaluate(`mike.voice()`)));
	check("ingenting har skickats medan någon talat rakt in i den",
		(await holder.evaluate(`mike.voice().sent`)) === 0);
	check("och klienten säger varför", /hold to talk/i.test(await holder.evaluate(`document.querySelector(".voicenote").textContent`)),
		await holder.evaluate(`document.querySelector(".voicenote").textContent`));

	const heldFrom = Date.now();
	await holder.mouse(".voice button.talk", "mousePressed");
	await holder.waitFor(`mike.tracks() === 1`, 8000, "att hållet öppnar mikrofonen");
	check("ett håll öppnar den (krav 4)", (await holder.evaluate(`mike.voice().held`)) === true);
	check("och det syns att den spelar in just nu (R5a.4)",
		/capturing while held/i.test(await holder.evaluate(`document.querySelector(".voicenote").textContent`)),
		await holder.evaluate(`document.querySelector(".voicenote").textContent`));
	await sleep(3000);
	await holder.mouse(".voice button.talk", "mouseReleased");
	const heldMs = Date.now() - heldFrom;

	await holder.waitFor(`mike.tracks() === 0`, 5000, "att släppet stänger mikrofonen");
	check("släppet stänger den igen — noll spår, inte en paus (krav 4)",
		(await holder.evaluate(`mike.tracks()`)) === 0 && (await holder.evaluate(`mike.voice().live`)) === false);

	await holder.waitFor(`mike.voice().sent > 0`, 8000, "segmentet från hållet");
	const lastMs = await holder.evaluate(`mike.voice().lastSegmentMs`);
	check("hållet gav exakt ett yttrande", (await holder.evaluate(`mike.voice().sent`)) === 1, String(await holder.evaluate(`mike.voice().sent`)));
	check("och det är inte längre än hållet varade (krav 4)", lastMs <= heldMs, `${lastMs} ms mot ${heldMs} ms hållet`);
	check("men det innehåller det som sades under hållet", lastMs > 500, `${lastMs} ms`);

	await holder.waitFor(`document.querySelector(".transcript").textContent.toLowerCase().includes("klockan")`, 25_000, "vad som hördes under hållet");
	const holdHeard = await holder.evaluate(`[...document.querySelectorAll(".transcript .entry.said .what")].map((e) => e.textContent).join(" | ")`);
	check("och det transkriberas som det som faktiskt sades", /klockan/i.test(holdHeard), holdHeard);

	// En snabb tryckning: den som släpper innan webbläsaren hunnit svara på
	// getUserMedia får inte lämna en öppen mikrofon efter sig. Det är precis det
	// läget lovar att inte göra, och racet är lätt att träffa med en tumme.
	await holder.mouse(".voice button.talk", "mousePressed");
	await sleep(120);
	await holder.mouse(".voice button.talk", "mouseReleased");
	await sleep(2500);
	check("en snabb tryckning lämnar ingen mikrofon öppen (krav 4)",
		(await holder.evaluate(`mike.tracks()`)) === 0 && (await holder.evaluate(`mike.voice().live`)) === false,
		JSON.stringify(await holder.evaluate(`mike.voice()`)));

	const sentAfterHold = await holder.evaluate(`mike.voice().sent`);
	await sleep(4000);
	check("efter släppet skickas ingenting mer, hur mycket som än sägs i rummet (krav 4)",
		(await holder.evaluate(`mike.voice().sent`)) === sentAfterHold,
		`${sentAfterHold} -> ${await holder.evaluate(`mike.voice().sent`)}`);
	check("inga fel i konsolen", holder.consoleErrors.length === 0, JSON.stringify(holder.consoleErrors.slice(0, 3)));

	section("servern");
	check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-400));
	check("serverns logg visar att den hörde och hur lång tid det tog",
		/heard \d+ms[^\n]* in \d+ms/.test(server.log()), (server.log().match(/heard [^\n]*/g) ?? []).slice(0, 3).join(" / "));

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	for (const b of browsers) { try { b.close(); } catch { /* already gone */ } }
	await sleep(300);
	for (const s of servers) { try { s.stop(); } catch { /* already gone */ } }
	if (service && !process.argv.includes("--keep-service")) { try { service.stop(); } catch { /* already gone */ } }
	for (const d of fakeDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
