// PRD 5b — the glasses half, on the real bridge.
//
//   node test/prd5b-lens.mjs [--no-build] [--keep]
//
// The Even Hub simulator runs the BUILT client behind a real Flutter channel,
// with the real SDK on top of it. That makes three things testable that a
// stand-in cannot argue about, because nothing in the path is ours:
//
//   * `long_press` and `long_press_release` really are events 9 and 10, and
//     really do arrive separately. The documentation lists only events 0-8 and
//     the simulator's own docs list only up/down/click/double_click; both are
//     stale, and the binary and the 0.0.15 typings agree with each other.
//   * `audioControl(true, glasses)` really is refused before the startup page
//     exists and accepted after it — R5b.1's sequencing constraint, observed
//     rather than assumed.
//   * AudioEvents really do arrive over `onEvenHubEvent`, as `Uint8Array` of
//     3200 bytes, and really do stop when the microphone is closed.
//
// It runs headless on Xvfb, like PRD 4's lens suite.
//
// WHAT IT IS NOT. The simulator's microphone is a desktop audio device read
// through ALSA, and it is not rate-limited: with a file behind it the frames
// arrive roughly eighty times faster than real time. So this suite asserts
// PLUMBING — that audio flows, is counted, and stops — and never timing or
// transcription, which are prd5b.mjs's (deterministic, frame-based) and
// prd5a-browser.mjs's. The simulator also reports `speakerRole: "unknown"` and
// `direction: null` for every frame, so it cannot say anything at all about
// R5b.2's filter; that needs the hardware, and the report says so.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

import { startServer, connect, check, failed, section, sleep, ROOT } from "./harness.mjs";
import { decodePng, differingPixels, litPixels } from "./png.mjs";
import { MODES } from "../src/routing.js";

const args = process.argv.slice(2);
const SHOTS = join(ROOT, "test", "out", "prd5b-lens");
const DISPLAY = ":99";

let sim = null;
let automationPort = 0;
const api = (path) => `http://127.0.0.1:${automationPort}${path}`;

const shot = async (name) => {
	const res = await fetch(api("/api/screenshot/glasses"));
	if (!res.ok) throw new Error(`skärmbilden svarade ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(join(SHOTS, `${name}.png`), buf);
	return decodePng(buf);
};

const input = async (action, settle = 700) => {
	const res = await fetch(api("/api/input"), {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action })
	});
	if (!res.ok) throw new Error(`input ${action} svarade ${res.status}`);
	await sleep(settle);
};

const consoleEntries = async (sinceId) => {
	const res = await fetch(api(`/api/console${sinceId === undefined ? "" : `?since_id=${sinceId}`}`));
	return res.ok ? (await res.json()).entries ?? [] : [];
};

/** The id to poll from next. Taken BEFORE an action, always: without it a wait
 *  matches the line the PREVIOUS action produced and returns instantly. */
const consoleMark = async () => Math.max(0, ...(await consoleEntries()).map((e) => e.id));

/**
 * The client's own microphone line, parsed.
 *
 * This is the only window into a WebView there is — the simulator's automation
 * API has ping, screenshot, console and input, and no way to evaluate anything.
 * main.ts prints one of these per change of microphone state for exactly this
 * reason, and because the same line is what makes a hardware session readable.
 */
const micLines = async (sinceId) => (await consoleEntries(sinceId))
	.filter((e) => e.message.includes("[jarvis] mic "))
	.map((e) => {
		const out = { id: e.id, raw: e.message };
		for (const [, k, v] of e.message.matchAll(/(\w+)=(\S+)/g)) out[k] = /^\d+$/.test(v) ? Number(v) : v;
		const head = e.message.match(/\[jarvis\] mic (\S+) (\S+)/);
		if (head) { out.state = head[1]; out.device = head[2]; }
		return out;
	});

const waitForMic = async (pred, ms, label, sinceId) => {
	const until = Date.now() + ms;
	let last = [];
	while (Date.now() < until) {
		last = await micLines(sinceId);
		const hit = last.find(pred);
		if (hit) return hit;
		await sleep(200);
	}
	throw new Error(`tiden gick ut medan vi väntade på ${label}; senaste raderna: ${JSON.stringify(last.slice(-3).map((l) => l.raw))}`);
};

/**
 * Send a gesture and wait for the client to react, retrying the SEND.
 *
 * The simulator's own documentation says input is silently ignored when there
 * is no active event container, and it was observed dropping roughly one
 * gesture in four here. That is the stand-in's delivery, not the client's
 * behaviour, so it is retried — but only the sending is: if the client never
 * reacts to any of the tries, this returns null and the caller fails, which is
 * the whole point of the assertion that follows.
 */
const gestureUntil = async (action, pred, label, { tries = 4, waitMs = 6000 } = {}) => {
	for (let i = 0; i < tries; i++) {
		const since = await consoleMark();
		await input(action, 400);
		const until = Date.now() + waitMs;
		while (Date.now() < until) {
			const hit = (await micLines(since)).find(pred);
			if (hit) return hit;
			await sleep(200);
		}
		console.log(`  --   ${label}: simulatorn tappade "${action}" (försök ${i + 1})`);
	}
	return null;
};

const waitUntil = async (fn, ms, label) => {
	const until = Date.now() + ms;
	let last = null;
	while (Date.now() < until) {
		last = await fn();
		if (last) return last;
		await sleep(250);
	}
	throw new Error(`tiden gick ut medan vi väntade på ${label}`);
};

/** A port the OS says is free, read back rather than picked. */
const freePort = async () => {
	const s = net.createServer();
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	const port = s.address().port;
	await new Promise((r) => s.close(r));
	return port;
};

const servers = [];

try {
	rmSync(SHOTS, { recursive: true, force: true });
	mkdirSync(SHOTS, { recursive: true });

	// ------------------------------------------------------------------ build
	if (!args.includes("--no-build")) {
		section("bygget");
		const built = spawnSync("npm", ["run", "build"], { cwd: join(ROOT, "client"), encoding: "utf8" });
		check("klienten byggs utan fel", built.status === 0, (built.stderr || built.stdout || "").slice(-500));
		if (built.status !== 0) throw new Error("bygget gick inte igenom");
	}
	check("bygget hamnade där servern letar", existsSync(join(ROOT, "public", "index.html")));

	// R5b.1: the permission has to be declared, or audioControl(true) is refused
	// on the hardware however right the code is.
	const app = JSON.parse(spawnSync("cat", [join(ROOT, "client", "app.json")], { encoding: "utf8" }).stdout);
	// A permission is `{ name, desc }` — it grew a sentence the Even App shows
	// the user when it asks. The bare-string form is still accepted here so the
	// check is about what is REQUESTED and not about how it is spelled.
	const asks = (name) => (app.permissions ?? []).some((p) => (typeof p === "string" ? p : p?.name) === name);
	check("app.json begär glasögonens mikrofon (R5b.1)", asks("g2-microphone"), JSON.stringify(app.permissions));
	check("och telefonens, som är reserven", asks("phone-microphone"), JSON.stringify(app.permissions));

	// ----------------------------------------------------------------- server
	const server = await startServer(["--handler", "echo", "--mode", MODES.PUSHTOTALK]);
	servers.push(server);
	const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;

	// -------------------------------------------------------------- simulator
	section("simulatorn: headless på Xvfb");
	if (spawnSync("pgrep", ["-x", "Xvfb"]).status !== 0) {
		spawn("Xvfb", [DISPLAY, "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
			{ detached: true, stdio: "ignore" }).unref();
		await sleep(2000);
	}
	automationPort = await freePort();
	// The NULL audio device on purpose: it generates zero samples, which is a
	// microphone in a silent room. That is what this suite wants — the claim
	// here is that audio flows and stops, and silence keeps the client's own
	// segmenter from filling the server with utterances nobody said while the
	// simulator feeds frames at eighty times real time.
	sim = spawn("evenhub-simulator", ["--automation-port", String(automationPort), "--aid", "alsa:null", url], {
		env: { ...process.env, DISPLAY },
		detached: true, stdio: ["ignore", "pipe", "pipe"]
	});
	let simLog = "";
	sim.stdout.on("data", (d) => { simLog += d; });
	sim.stderr.on("data", (d) => { simLog += d; });

	let pong = false;
	try {
		pong = await waitUntil(async () => {
			try { return (await (await fetch(api("/api/ping"))).text()) === "pong"; } catch { return false; }
		}, 40_000, "simulatorns automations-API");
	} catch (e) {
		throw new Error(`${e.message}\nsimulatorn sa:\n${simLog.slice(-800) || "(ingenting)"}`);
	}
	check("simulatorn svarar på sitt automations-API", pong === true);

	const ready = await waitUntil(async () => (await consoleEntries()).find((e) => e.message.includes("[jarvis] client up")), 40_000, "klientens startrad");
	check("klienten startar och ser att den har glasögon", /glasses attached/.test(ready.message), ready.message);

	// The session the simulator created is the one that is not ours.
	const lister = await connect(server);
	const sinceList = lister.mark();
	lister.send({ type: "control", action: "listSessions", args: { limit: 20 } });
	const listed = await lister.waitFor((m) => m.type === "event" && m.kind === "sessions", 5000, "sessionslista", sinceList);
	const target = listed.data.sessions.find((s) => s.id !== lister.readyMsg.sessionId);
	check("simulatorns klient har en session på servern", !!target, JSON.stringify(listed.data.sessions.map((s) => s.id.slice(0, 8))));
	lister.close();
	const driver = await connect(server, { sessionId: target.id });

	// ------------------------------------------------------- inget öppnas självt
	section("R5b.1: ingenting öppnas av sig självt");
	{
		// The client has been up for several seconds and the mode is PushToTalk.
		// Nothing has been touched, so nothing may be listening.
		const lines = await micLines();
		const live = lines.filter((l) => l.live === "true");
		check("sidan har inte öppnat någon mikrofon utan att bli ombedd (R5a.1, R5b.1)",
			live.length === 0, JSON.stringify(lines.slice(-3).map((l) => l.raw)));
		check("och inga fel i webbvyns konsol under uppstarten",
			(await consoleEntries()).filter((e) => e.level === "error" || e.message.startsWith("[uncaught]")).length === 0,
			JSON.stringify((await consoleEntries()).filter((e) => e.level === "error").slice(0, 2)));
	}

	const idle = await shot("01-vilande");
	check("något är tänt på linsen", litPixels(idle) > 0, String(litPixels(idle)));

	// ------------------------------------------------------------- långtrycket
	section("R5b.3: långtryckets två halvor, genom den riktiga bron");
	{
		const before = await consoleMark();
		// SDK 0.0.15 reports LONG_PRESS_EVENT (9) and LONG_PRESS_RELEASE_EVENT
		// (10) separately; the simulator's own documentation lists neither. If no
		// line ever appears, the gesture never reached the client at all.
		const held = await gestureUntil("long_press", (l) => l.held === "true", "långtrycket");
		check("ett långtryck på pekplattan når klienten (R5b.3)", !!held, "simulatorn tappade gesten fyra gånger");
		check("och det är glasögonens egen mikrofon som öppnas, inte webbläsarens (R5b.1)",
			held?.device === "glasses", held?.raw ?? "-");

		const live = await waitForMic((l) => l.live === "true", 15_000, "att mikrofonen blir öppen", before);
		check("mikrofonen blir verkligen öppen — värden svarade ja", live.tracks === 1, live.raw);
		check("och hur lång tid det tog står i raden, som R5b.3 ber om",
			typeof live.openMs === "number" && live.openMs >= 0 && live.openMs < 5000, `openMs=${live.openMs}`);

		// R5b.3: "Do not ship a hold-to-talk whose start the user cannot see."
		const heldShot = await shot("02-medan-hallet-pagar");
		check("och linsen ändrar sig medan hållet pågår, så användaren ser att den lyssnar (R5b.3)",
			differingPixels(idle, heldShot) > 50, `${differingPixels(idle, heldShot)} px`);

		// Audio really flows: AudioEvents over the real bridge, counted by the
		// shipped microphone. The simulator's null device is silence, so the
		// bytes are what is being asserted, not the words.
		const flowing = await waitForMic((l) => (l.frames ?? 0) > 0, 15_000, "ljudramar från bron", before);
		check("riktiga ljudramar kommer in över bron medan hållet pågår (R5b.1)",
			flowing.frames > 0 && flowing.bytes > 0, flowing.raw);
		check("och de räknas i bytes, vilket är måttet R5b.4 handlar om",
			flowing.bytes % 2 === 0 && flowing.bytes >= flowing.frames * 2, flowing.raw);

		const framesAtHold = flowing.frames;
		const released = await gestureUntil("long_press_release", (l) => l.held === "false" && l.live === "false", "släppet");
		check("släppet stänger mikrofonen igen (krav 4)", !!released && released.tracks === 0, released?.raw ?? "släppet nådde aldrig fram");

		// The control is not a one-off. Waited for, not assumed: opening takes a
		// measured ~190 ms over the bridge, and releasing inside that window is a
		// different test — the next one.
		await sleep(2000);
		const second = await gestureUntil("long_press", (l) => l.live === "true", "andra hållet");
		check("ett andra håll öppnar den igen — kontrollen är inte en engångssak",
			!!second && second.tracks === 1 && second.frames > framesAtHold, second?.raw ?? "andra hållet nådde aldrig fram");
		const closed = await gestureUntil("long_press_release", (l) => l.live === "false", "andra släppet");
		check("och stängs igen", !!closed && closed.tracks === 0, closed?.raw ?? "-");

		// A press and a release INSIDE the ~190 ms the link takes to answer. PRD
		// 5a hit this race in the browser; over BLE it is easier to hit, and the
		// microphone that arrives afterwards would have nobody left to own it.
		// This suite found it by accident before it asserted it.
		await sleep(1500);
		const pressed = await gestureUntil("long_press", (l) => l.held === "true", "snabbtryckningen");
		check("tryckningen når klienten", !!pressed, "simulatorn tappade den fyra gånger");
		// Waited for, not read off the tail: the console buffer is 2000 entries
		// and a wait that reads an old mark can find that its evidence has been
		// pushed out from under it.
		const quiet = await gestureUntil("long_press_release", (l) => l.live === "false" && l.held === "false", "snabbsläppet");
		await sleep(2500);
		check("en tryckning som släpps medan länken fortfarande svarar lämnar ingen mikrofon öppen",
			!!quiet && quiet.tracks === 0, quiet?.raw ?? "mikrofonen stängdes aldrig");
		const after = (await micLines(await consoleMark() - 1)).at(-1) ?? quiet;
		check("och den är fortfarande stängd ett par sekunder senare",
			!!after && after.live === "false" && after.tracks === 0, after?.raw ?? "-");

		const idleAgain = await shot("03-efter-slappet");
		check("linsen går tillbaka till att inte visa ett håll", differingPixels(idleAgain, heldShot) > 50,
			`${differingPixels(idleAgain, heldShot)} px`);
		// And back to exactly what it showed before — pixel for pixel. A status
		// line that changed and did not change back would leave the user reading
		// a microphone that is not open.
		check("och till precis samma bild som före hållet", differingPixels(idleAgain, idle) === 0,
			`${differingPixels(idleAgain, idle)} px skillnad`);
	}

	// --------------------------------------------------------------- tystnaden
	section("krav 5: tystnad genom glasögonen kostar ingenting");
	{
		// The whole of the above was a silent microphone. Not one segment may
		// have reached the server, and not one turn may have run.
		const lines = await micLines();
		const sent = Math.max(0, ...lines.map((l) => l.sent ?? 0));
		check("inte ett enda segment skickades under två håll i ett tyst rum (krav 5)",
			sent === 0, JSON.stringify(lines.slice(-3).map((l) => l.raw)));
		check("och servern körde ingen tur", !/heard \d+ms/.test(server.log()), (server.log().match(/heard [^\n]*/g) ?? []).join(" / "));
	}

	// ------------------------------------------------------------- avslutet
	section("R5b.1: ett håll som aldrig släpps lämnar ändå ingen mikrofon igång");
	{
		// Measured here, not assumed: the system exit dialog SWALLOWS the release
		// that should have followed the double tap. A hold whose release never
		// arrives would be a microphone left running on somebody's face — so any
		// other gesture ends the hold, and this is the case that proves it.
		const open = await gestureUntil("long_press", (l) => l.live === "true" && l.held === "true", "hållet som ska avbrytas");
		check("mikrofonen är öppen och hålls", !!open && open.tracks === 1, open?.raw ?? "hållet nådde aldrig fram");

		const dialogAt = await consoleMark();
		const shut = await gestureUntil("double_click", (l) => l.live === "false", "avslutsgesten");
		check("dubbeltappen avslutar hållet och stänger mikrofonen (R5b.1)",
			!!shut && shut.tracks === 0 && shut.held === "false", shut?.raw ?? "mikrofonen stängdes aldrig");

		// And the release that arrives afterwards, if it ever does, must not
		// reopen anything or leave the client believing it is held.
		const afterAt = await consoleMark();
		await input("long_press_release", 1500);
		const later = (await micLines(afterAt)).at(-1) ?? shut;
		check("och ett sent släpp öppnar ingenting igen", !!later && later.tracks === 0 && later.live === "false", later?.raw ?? "-");

		const afterExit = await consoleEntries(dialogAt);
		check("inga ouppfångade fel efter avslutsgesten",
			!afterExit.some((e) => e.message.startsWith("[uncaught]")), JSON.stringify(afterExit.slice(0, 3).map((e) => e.message)));
	}

	driver.close();
	check("inga ouppfångade undantag i servern", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
	console.log(`\nskärmbilder: ${SHOTS}`);

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	if (sim && !args.includes("--keep")) {
		// The whole group: the packaged binary spawns a webview child, and
		// killing only the parent leaves a window (and a port) behind.
		try { process.kill(-sim.pid, "SIGKILL"); } catch { try { sim.kill("SIGKILL"); } catch { /* gone */ } }
		await sleep(500);
	}
	for (const s of servers) { try { s.stop(); } catch { /* gone */ } }
	await sleep(200);
	const leaked = spawnSync("pgrep", ["-f", "bin/evenhub[-]simulator"], { encoding: "utf8" });
	const count = (leaked.stdout || "").trim().split("\n").filter(Boolean).length;
	check("inga simulatorer lämnade kvar", args.includes("--keep") || count === 0, `${count} kvar`);
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
