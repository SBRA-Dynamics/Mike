// Test support for the voice phase — PRD 5a.
//
// Three things the suites share: reading the recorded fixtures, a stand-in
// transcription service, and starting the real one.
//
// The fixtures under test/fixtures/voice are Swedish speech from piper
// (sv_SE-nst-medium), 16 kHz signed-16-bit mono, with room tone at about
// -60 dBFS between the utterances rather than digital silence — a segmenter
// tested only against perfect silence is tested against a room nobody lives in.
// They were made with, roughly:
//
//   pip install piper-tts && python -m piper.download_voices sv_SE-nst-medium
//   echo "Mike, vad är klockan?" | python -m piper -m sv_SE-nst-medium.onnx -f u1.wav
//   ffmpeg -i u1.wav -ar 16000 -ac 1 -f s16le u1.raw
//   cat tone600 u1.raw tone1200 u2.raw tone1200 u3.raw tone8000 > three.raw
//   ffmpeg -f s16le -ar 16000 -ac 1 -i three.raw three-sv.wav
//
//   three-sv.wav   "Mike, vad är klockan?" / "Hey Mike, pausa input." /
//                  "Fortsätt input.", 1.2 s apart, then 8 s of room tone
//   pauses-sv.wav  two sentences, each spoken in pieces 350-450 ms apart —
//                  ordinary pauses, which must not split a sentence (krav 6)
//   talk-sv.wav    the same question over and over, 350 ms apart: continuous
//                  speech, so a microphone that is open at any moment has
//                  something to capture (the push-to-talk test)

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT, sleep } from "./harness.mjs";

export const VOICE_DIR = join(ROOT, "test", "fixtures", "voice");

/**
 * Read a RIFF/WAVE file into Int16Array samples.
 *
 * The chunks are walked rather than assuming a 44-byte header: ffmpeg writes a
 * LIST chunk in front of the data often enough that "skip 44" gives you 20 ms
 * of metadata interpreted as audio, which sounds exactly like a click.
 */
export function readWav(path) {
	const buf = readFileSync(path);
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error(`${path} is not a WAV file`);
	}
	let at = 12;
	let fmt = null;
	while (at + 8 <= buf.length) {
		const id = buf.toString("ascii", at, at + 4);
		const size = buf.readUInt32LE(at + 4);
		const body = at + 8;
		if (id === "fmt ") {
			fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
		} else if (id === "data") {
			if (!fmt) throw new Error(`${path}: data before fmt`);
			if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1) {
				throw new Error(`${path} must be 16-bit mono PCM, got ${JSON.stringify(fmt)}`);
			}
			const bytes = buf.subarray(body, body + size);
			// Copied, not viewed: a subarray of a Buffer can be misaligned for a
			// 16-bit view, and the failure is a RangeError deep in a test.
			const pcm = new Int16Array(size / 2);
			for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
			return { pcm, ...fmt, durationMs: Math.round((pcm.length / fmt.sampleRate) * 1000) };
		}
		at = body + size + (size % 2);
	}
	throw new Error(`${path} has no data chunk`);
}

/** The PCM of one fixture, by name. */
export const fixture = (name) => readWav(join(VOICE_DIR, name));

/** Base64 of Int16Array samples, the way the client sends them. */
export const pcmBase64 = (pcm) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");

/**
 * A stand-in for the whisper service.
 *
 * It speaks the same tiny contract (src/whisper.js) and answers from a script,
 * so the server's audio path can be driven through a hundred cases without a
 * GPU and without a model's opinion in the middle. What it does NOT stand in
 * for is transcription: that claim belongs to the browser suite, which runs the
 * real service against recorded speech.
 *
 * `script` is a list of answers; each request takes the next one, and the last
 * repeats. An entry may be a string (the text), an object (the whole body), or
 * a function of the received PCM.
 */
export async function startWhisperStub(script = [""], { status = 200, delayMs = 0 } = {}) {
	const requests = [];
	let index = 0;

	const server = createServer((req, res) => {
		if (req.url === "/healthz") {
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ ok: true, model: "stub", device: "none", warm: true }));
		}
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", async () => {
			const body = Buffer.concat(chunks);
			requests.push({ url: req.url, bytes: body.length, durationMs: Math.round((body.length / 2 / 16000) * 1000), pcm: body });
			if (delayMs) await sleep(delayMs);
			if (status !== 200) {
				res.writeHead(status, { "Content-Type": "text/plain" });
				return res.end("stub refused");
			}
			const entry = script[Math.min(index++, script.length - 1)];
			const answer = typeof entry === "function" ? entry(body, requests.length - 1) : entry;
			const payload = typeof answer === "string"
				? { text: answer, language: "sv", confidence: answer ? 0.9 : null, ms: 7, dropped: null }
				: answer;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(payload));
		});
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		requests,
		stop: () => new Promise((resolve) => server.close(resolve))
	};
}

/** Where the real service's interpreter lives, if it was installed the way
 *  services/whisper/serve.py documents. */
export const WHISPER_PYTHON = process.env.MIKE_WHISPER_PYTHON
	?? join(homedir(), ".local", "share", "mike", "venv", "bin", "python");

export const whisperInstalled = () => existsSync(WHISPER_PYTHON);

/**
 * Start the real transcription service on a port the OS picks.
 *
 * The port is read back out of the line the service prints, never guessed: at
 * ~15 s to load a model, a suite that talked to the wrong port would be a
 * fifteen-second way to learn nothing.
 */
export async function startWhisperService({ timeoutMs = 180_000, model = process.env.MIKE_WHISPER_MODEL } = {}) {
	const args = [join(ROOT, "services", "whisper", "serve.py"), "--port", "0", "--quiet"];
	if (model) args.push("--model", model);
	const proc = spawn(WHISPER_PYTHON, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

	let out = "";
	proc.stdout.on("data", (d) => { out += d.toString(); });
	proc.stderr.on("data", (d) => { out += d.toString(); });

	const until = Date.now() + timeoutMs;
	let port = 0;
	while (Date.now() < until && !port) {
		const m = out.match(/whisper-service listening on http:\/\/127\.0\.0\.1:(\d+)/);
		if (m) port = Number(m[1]);
		else if (proc.exitCode !== null) break;
		else await sleep(200);
	}
	if (!port) {
		try { proc.kill("SIGKILL"); } catch { /* already gone */ }
		throw new Error(`whisper-tjänsten startade aldrig:\n${out.slice(-800) || "(ingen utskrift)"}`);
	}
	return {
		url: `http://127.0.0.1:${port}`,
		port, proc,
		log: () => out,
		stop() { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }
	};
}
