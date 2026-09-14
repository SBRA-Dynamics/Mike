// Hands-free in a car — a measurement, not a pass/fail suite.
//
// The segmenter (client/src/audio/segment.ts) was tuned against room tone at
// about -60 dBFS. A car is road rumble, an engine hum and wind, most of it
// below 300 Hz and loud, with thumps from joints in the road. This runs the
// real Segmenter, open-microphone mode, over the speech fixture mixed with such
// noise at a range of levels, for the current defaults and a few candidate
// settings, and prints what each would have done — so a change to the filter
// can be judged against a baseline instead of against a drive.
//
//   node test/car-noise.mjs                 synthetic car noise
//   node test/car-noise.mjs car.wav         a real recording as the noise bed
//                                           (16 kHz mono 16-bit, looped)
//   node test/car-noise.mjs latest          the newest "spela in brus" recording
//                                           the server kept (~/.local/share/mike/noise)
//
// A recording is also played at its own level, in the column marked "rec".
//
// Each cell reads `caught/expected`, then `+n` for segments that were noise
// alone, `m` for segments that swallowed more than one sentence, and `x` for
// cuts at the 15-second maximum. "6/6" is right; "0/6" is deaf; "0/6 m3x3" is
// the microphone that never closes, which is the car symptom.

import { Segmenter, DEFAULTS, frameLevelDb } from "../client/src/audio/segment.ts";
import { fixture, readWav } from "./voice.mjs";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RATE = 16_000;
const SPEECH_DB = -24;
const NOISE_LEVELS = [-55, -45, -40, -35, -30, -25, -20];
const NOISE_DIR = join(process.env.MIKE_DATA || join(homedir(), ".local", "share", "mike"), "noise");

// ------------------------------------------------------------------ signals

/** Deterministic, so two runs of the same settings give the same table. */
const prng = (seed) => () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 31 - 1;
};

const rmsDb = (x) => {
	let sum = 0;
	for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
	return 10 * Math.log10(sum / x.length + 1e-20);
};

/** Road rumble (brown noise), an engine hum with two harmonics that drifts,
 *  wind (low-passed white, about 12 dB under the rumble, so a high-pass has
 *  something left to hear), a slow surface change of ±3 dB, and a thump from
 *  a road joint every few seconds. Float, unit scale, not yet normalized. */
const carNoise = (samples) => {
	const rand = prng(7);
	const out = new Float32Array(samples);
	let brown = 0;
	let wind = 0;
	let phase = 0;
	let thump = 0;
	for (let i = 0; i < samples; i++) {
		const t = i / RATE;
		brown = 0.997 * brown + 0.03 * rand();
		wind += 0.5 * (rand() - wind);
		const f0 = 38 + 6 * Math.sin(2 * Math.PI * 0.05 * t);
		phase += (2 * Math.PI * f0) / RATE;
		const engine = 0.05 * Math.sin(phase) + 0.03 * Math.sin(2 * phase) + 0.015 * Math.sin(3 * phase);
		if (i % Math.round(RATE * 3.3) === 0) thump = 1;
		thump *= 0.9993;
		const road = brown + thump * 0.25 * Math.sin(2 * Math.PI * 80 * t);
		const surface = 10 ** ((3 * Math.sin(2 * Math.PI * t / 7)) / 20);
		out[i] = surface * (road + engine + 0.15 * wind);
	}
	return out;
};

const loop = (pcm, samples) => {
	const out = new Float32Array(samples);
	for (let i = 0; i < samples; i++) out[i] = pcm[i % pcm.length] / 32768;
	return out;
};

const scaleTo = (x, db) => {
	const gain = 10 ** ((db - rmsDb(x)) / 20);
	return x.map((v) => v * gain);
};

/** RBJ biquad high-pass, Q = 1/√2. The candidate front end: road noise lives
 *  under 200 Hz and speech intelligibility does not. */
const highPass = (x, cutoff) => {
	const w = (2 * Math.PI * cutoff) / RATE;
	const alpha = Math.sin(w) / Math.SQRT2;
	const cos = Math.cos(w);
	const a0 = 1 + alpha;
	const b0 = (1 + cos) / 2 / a0, b1 = -(1 + cos) / a0, b2 = b0;
	const a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
	const y = new Float32Array(x.length);
	let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
	for (let i = 0; i < x.length; i++) {
		const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
		x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
	}
	return y;
};

const toPcm = (x) => Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));

// ------------------------------------------------------------------- speech

// Four seconds of car before anyone speaks, then the three sentences twice.
const three = fixture("three-sv.wav").pcm;
const lead = RATE * 4;
const clean = new Int16Array(lead + three.length * 2);
clean.set(three, lead);
clean.set(three, lead + three.length);

// Normalize on the loudest 20 % of frames — the speech, not the silence around it.
const speechFloat = Float32Array.from(clean, (v) => v / 32768);
const frameDbs = [];
for (let i = 0; i + 320 <= clean.length; i += 320) frameDbs.push(frameLevelDb(clean.subarray(i, i + 320)));
const loud = frameDbs.toSorted((a, b) => b - a)[Math.floor(frameDbs.length * 0.2)];
const speechGain = 10 ** ((SPEECH_DB - loud) / 20);
const speech = speechFloat.map((v) => v * speechGain);

const run = (pcm, options) => {
	const s = new Segmenter({ ...options, hold: false });
	const out = [];
	for (let i = 0; i < pcm.length; i += 1600) out.push(...s.push(pcm.subarray(i, i + 1600)));
	const last = s.flush("close");
	if (last) out.push(last);
	return out;
};

const reference = run(toPcm(speech), DEFAULTS);

const score = (segments) => {
	const overlaps = (a, b) => a.startMs < b.endMs && b.startMs < a.endMs;
	let caught = 0;
	for (const ref of reference) {
		const hit = segments.filter((s) => overlaps(s, ref));
		if (hit.length === 1 && hit[0].durationMs <= ref.durationMs + 1500) caught++;
	}
	const extra = segments.filter((s) => !reference.some((r) => overlaps(s, r))).length;
	const merged = segments.filter((s) => reference.filter((r) => overlaps(s, r)).length > 1).length;
	const maxed = segments.filter((s) => s.reason === "maximum").length;
	return `${caught}/${reference.length}${extra ? `+${extra}` : ""}${merged ? `m${merged}` : ""}${maxed ? `x${maxed}` : ""}`;
};

// ----------------------------------------------------------------- the grid

const VARIANTS = [
	{ name: "nuvarande", options: {} },
	{ name: "maxFloor -10", options: { maxFloorDb: -10 } },
	{ name: "margin 6", options: { marginDb: 6 } },
	{ name: "margin 12", options: { marginDb: 12 } },
	{ name: "hp200", highPass: 200, options: {} },
	{ name: "hp200 maxFloor -10", highPass: 200, options: { maxFloorDb: -10 } },
	{ name: "hp300 maxFloor -10", highPass: 300, options: { maxFloorDb: -10 } }
];

let recording = process.argv[2];
if (recording === "latest") {
	const files = readdirSync(NOISE_DIR).filter((f) => f.endsWith(".wav")).sort();
	if (!files.length) throw new Error(`no recordings in ${NOISE_DIR}`);
	recording = join(NOISE_DIR, files.at(-1));
}
const bed = recording ? loop(readWav(recording).pcm, speech.length) : carNoise(speech.length);
// The recording's own level joins the columns, rounded, so the real car is on
// the grid next to the made-up ones.
const levels = recording ? [...NOISE_LEVELS, Math.round(rmsDb(bed))] : NOISE_LEVELS;
const label = (db, i) => (i === NOISE_LEVELS.length ? `rec ${db}` : String(db));

console.log(`Bilbrus: ${recording ?? "syntetiskt"}, tal ${SPEECH_DB} dBFS, ${reference.length} meningar`);
console.log(`${"brus dBFS".padEnd(20)}${levels.map((n, i) => label(n, i).padStart(11)).join("")}`);

const mixes = levels.map((db) => {
	const noise = scaleTo(bed, db);
	return speech.map((v, i) => v + noise[i]);
});

for (const variant of VARIANTS) {
	const cells = mixes.map((mix) => {
		const input = variant.highPass ? highPass(mix, variant.highPass) : mix;
		return score(run(toPcm(input), variant.options)).padStart(11);
	});
	console.log(`${variant.name.padEnd(20)}${cells.join("")}`);
}
