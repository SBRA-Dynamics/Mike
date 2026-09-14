// "Spela in brus" — the voice command, the wire message and the file on disk.
//
// The recording itself happens in the client and is exercised by hand in the
// car; what can break quietly is the rest: a command dictation writes a
// little differently, a message the server refuses, or a WAV the car test
// cannot read back.

import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, failed, section } from "./harness.mjs";
import { readWav } from "./voice.mjs";
import { route, NOISE_DEFAULT_S, NOISE_MAX_S } from "../src/routing.js";
import { validateC2S } from "../src/protocol.js";
import { saveNoise, noiseLevels } from "../src/noise.js";
import { createMikeHandler } from "../src/handler.js";

section("talkommandot");
{
	const cases = [
		["Mike, spela in brus.", NOISE_DEFAULT_S],
		["Spela in bakgrundsljud i 30 sekunder", 30],
		["spela in brus i tio sekunder", 10],
		["Record background noise for 15 seconds.", 15],
		["spela in brus i 90 sekunder", NOISE_MAX_S]
	];
	for (const [text, seconds] of cases) {
		const r = route(text, { mode: "byname" });
		check(`"${text}" -> ${seconds} s`, r.kind === "noise" && r.seconds === seconds, JSON.stringify(r));
	}
	check("fungerar även pausad", route("spela in brus", { mode: "ignore" }).kind === "noise");
	check("en mening om brus är ingen inspelning", route("Mike, varför brusar det i bilen", { mode: "byname" }).kind === "mike");
}

section("meddelandet");
{
	check("noise godtas", validateC2S({ type: "noise", pcm: "AAAA", sampleRate: 16_000, device: "glasses" }).ok);
	check("fel samplingsfrekvens nekas", !validateC2S({ type: "noise", pcm: "AAAA", sampleRate: 48_000 }).ok);
	check("konstigt enhetsnamn nekas", !validateC2S({ type: "noise", pcm: "AAAA", device: "../x" }).ok);
}

const dir = mkdtempSync(join(tmpdir(), "mike-noise-"));
try {
	section("filen");
	{
		// One second of a -20 dBFS square wave: every sample ±3277.
		const pcm = Buffer.alloc(32_000);
		for (let i = 0; i < 16_000; i++) pcm.writeInt16LE(i % 32 < 16 ? 3277 : -3277, i * 2);
		const r = saveNoise(dir, pcm, { device: "glasses", now: new Date("2026-09-14T08:30:00Z") });
		check("namnet bär tid och enhet", r.name === "2026-09-14T08-30-00-glasses.wav", r.name);
		const back = readWav(r.file);
		check("läses tillbaka som 16 kHz mono", back.sampleRate === 16_000 && back.pcm.length === 16_000);
		check("nivån är -20 dBFS", r.levelDb === -20 && noiseLevels(pcm).floorDb === -20, JSON.stringify(r));
	}

	section("servern tar emot en inspelning");
	{
		const emitted = [];
		const session = { id: "00000000-0000-4000-8000-000000000000", mode: "byname", worker: null, transient: (m) => emitted.push(m), emit: (m) => emitted.push(m) };
		const handler = createMikeHandler({ log: null, noiseDir: join(dir, "server") });
		await handler.onMessage(session, { type: "say", text: "Mike, spela in brus i 10 sekunder", origin: "voice" });
		check("ber klienten spela in", emitted.some((m) => m.kind === "noiseRequested" && m.data.seconds === 10), JSON.stringify(emitted));

		const pcm = Buffer.alloc(16_000 * 2 * 2);
		await handler.onMessage(session, { type: "noise", pcm: pcm.toString("base64"), sampleRate: 16_000, device: "phone" });
		const files = readdirSync(join(dir, "server"));
		check("sparas som wav", files.length === 1 && files[0].endsWith("-phone.wav"), files.join(","));
		check("och säger det", emitted.some((m) => m.type === "text" && /^Noise saved, 2 s/.test(m.text)), JSON.stringify(emitted.at(-1)));
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

process.exit(failed() ? 1 : 0);
