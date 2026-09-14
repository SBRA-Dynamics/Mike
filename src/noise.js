// Background-noise recordings — kept as WAV files for test/car-noise.mjs.
//
// The speech detector was tuned in a quiet room and misbehaves in a car, and
// a synthetic car is a guess. "Spela in brus" has the client send a few
// seconds of raw microphone audio, bypassing the detector, and this file puts
// it on disk next to the sessions, with the levels in the log line so a
// recording can be judged before anyone runs the test on it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIO_SAMPLE_RATE } from "./protocol.js";

/** 30 seconds of 16 kHz s16le, plus slack for a client that overshoots by a
 *  frame. The command clamps the length to 30 s (routing.js NOISE_MAX_S). */
export const NOISE_MAX_BYTES = 30 * AUDIO_SAMPLE_RATE * 2 + 64_000;

/** A 44-byte RIFF header in front of the samples: 16 kHz, 16-bit, mono. */
export const wav = (pcm) => {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVEfmt ", 8, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(AUDIO_SAMPLE_RATE, 24);
	header.writeUInt32LE(AUDIO_SAMPLE_RATE * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
};

/** Overall level, the quiet end (10th percentile of 20 ms frames — roughly
 *  what the detector's floor would settle on) and the loudest frame, in dBFS. */
export const noiseLevels = (pcm) => {
	const samples = pcm.length / 2;
	const frame = AUDIO_SAMPLE_RATE / 50;
	const db = (sum, n) => Math.max(-100, Math.round(10 * Math.log10(sum / Math.max(1, n) / 32768 ** 2 + 1e-12)));
	const frames = [];
	let total = 0;
	for (let at = 0; at + frame <= samples; at += frame) {
		let sum = 0;
		for (let i = at; i < at + frame; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
		total += sum;
		frames.push(db(sum, frame));
	}
	frames.sort((a, b) => a - b);
	return {
		levelDb: db(total, frames.length * frame),
		floorDb: frames[Math.floor(frames.length * 0.1)] ?? -100,
		peakDb: frames.at(-1) ?? -100
	};
};

/** Write one recording. `device` names the microphone ("glasses", "phone",
 *  "browser") and ends up in the file name, since the two sound different. */
export const saveNoise = (dir, pcm, { device = "unknown", now = new Date() } = {}) => {
	mkdirSync(dir, { recursive: true });
	const stamp = now.toISOString().slice(0, 19).replace(/:/g, "-");
	const name = `${stamp}-${String(device).replace(/[^a-z]/gi, "").slice(0, 16) || "unknown"}.wav`;
	const file = join(dir, name);
	writeFileSync(file, wav(pcm));
	return { file, name, durationMs: Math.round((pcm.length / 2 / AUDIO_SAMPLE_RATE) * 1000), ...noiseLevels(pcm) };
};
