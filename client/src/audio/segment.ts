// Segmentation — PRD 5a R5a.3, and the one piece PRD 5b reuses unchanged.
//
// A function from PCM frames to utterances. There is no browser API in this
// file, nothing asks the clock, and nothing here knows where the samples came
// from: the microphone path (capture.ts) hands it resampled frames, the glasses
// will hand it `AudioEvent.audioPcm`, and a test hands it a recorded file. All
// three must produce the same segments, which is acceptance criterion 7 and the
// reason this is a class with a `push` method rather than something wired into
// a MediaStream.
//
// Everything is measured in samples and converted to milliseconds on the way
// out, so a run is bit-for-bit reproducible — a segmenter that consulted
// Date.now() would give a different answer on a slow machine, and the glasses
// deliver frames in bursts by design.
//
// The energy detector, in one paragraph. Each frame gets an RMS level in dBFS.
// A frame counts as speech when it is `marginDb` above the noise floor, and the
// floor follows the room whenever an utterance is NOT in progress — fast down,
// very slowly up — so a fan, a laptop keyboard or air conditioning raise it and
// stop triggering, while a long sentence cannot raise it at all. A segment
// opens after `startMs` of speech (a door closing is one frame, not five),
// carries `preRollMs` of audio from before that so the first syllable survives,
// and closes after `hangoverMs` of silence — long enough that an ordinary pause
// inside a sentence does not split it, which is acceptance criterion 6.

export type SegmentReason =
	/** Silence, long enough to mean the sentence ended. */
	| "silence"
	/** The maximum length — R5a.6's bound in the client. */
	| "maximum"
	/** The push-to-talk control was released. */
	| "release"
	/** The microphone was turned off mid-utterance. */
	| "close";

export type Segment = {
	/** 16 kHz signed 16-bit mono, trimmed to the speech plus its margins. */
	pcm: Int16Array;
	/** Where this segment starts and ends in the stream, in milliseconds from
	 *  the first sample ever pushed. Diagnostics, and what the file test asserts
	 *  boundaries with. */
	startMs: number;
	endMs: number;
	durationMs: number;
	/** How much of it was actually speech. A segment that is 3 seconds long and
	 *  0.3 seconds of speech is a cough with a hangover attached. */
	speechMs: number;
	reason: SegmentReason;
};

export type SegmenterOptions = {
	sampleRate: number;
	/** Frame size for the energy detector. 20 ms is the usual VAD frame: long
	 *  enough to measure, short enough that the boundary error is inaudible. */
	frameMs: number;
	/** Speech needed before a segment opens. */
	startMs: number;
	/** Silence that ends a segment. R5a.3's "hangover so an ordinary pause does
	 *  not split a sentence" — 700 ms is longer than the gap between clauses and
	 *  shorter than the gap between sentences. */
	hangoverMs: number;
	/** Audio kept from before the first speech frame. The detector needs a few
	 *  frames to be sure, and those frames contain the first consonant. */
	preRollMs: number;
	/** Audio kept after the last speech frame, so a trailing "…nu?" survives. */
	tailMs: number;
	/** Less speech than this is not an utterance, and is thrown away without
	 *  being sent anywhere (R5a.5: silence mistaken for speech costs nothing). */
	minSpeechMs: number;
	/** The client half of R5a.6. 15 s at 16 kHz is 480 kB, which is a third of
	 *  what the server accepts and more than anybody says in one breath. */
	maxSegmentMs: number;
	/** How far above the noise floor a frame has to be to count as speech. */
	marginDb: number;
	/** The floor is clamped into this range. The lower bound matters: a
	 *  digitally silent stream has a level of -100 dB here, and an unclamped
	 *  floor plus a margin would then call the first bit of dither speech. */
	minFloorDb: number;
	maxFloorDb: number;
	/** How fast the floor follows a quieter room, per frame (1 = instantly). */
	floorFallRate: number;
	/** And a louder one. Deliberately two orders of magnitude slower: a fan
	 *  starting should raise the bar over seconds, while a person talking for
	 *  ten seconds must not raise it at all. */
	floorRiseRate: number;
	/** Push-to-talk. Silence no longer closes a segment — the hold delimits the
	 *  utterance and `flush("release")` ends it — but the detector still runs,
	 *  so the silence at both ends is trimmed before whisper sees it (R5a.3). */
	hold: boolean;
};

export const DEFAULTS: SegmenterOptions = {
	sampleRate: 16_000,
	frameMs: 20,
	startMs: 100,
	hangoverMs: 700,
	preRollMs: 300,
	tailMs: 250,
	minSpeechMs: 250,
	maxSegmentMs: 15_000,
	marginDb: 9,
	minFloorDb: -70,
	maxFloorDb: -25,
	floorFallRate: 0.5,
	floorRiseRate: 0.004,
	hold: false
};

/** Level of one frame in dBFS, floored so digital silence is a number rather
 *  than -Infinity (which poisons every average it touches). */
export const frameLevelDb = (frame: Int16Array): number => {
	let sum = 0;
	for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
	const rms = Math.sqrt(sum / Math.max(1, frame.length)) / 32768;
	return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
};

const concat = (frames: Int16Array[], from: number, to: number): Int16Array => {
	let length = 0;
	for (let i = from; i < to; i++) length += frames[i].length;
	const out = new Int16Array(length);
	let at = 0;
	for (let i = from; i < to; i++) { out.set(frames[i], at); at += frames[i].length; }
	return out;
};

export class Segmenter {
	readonly opts: SegmenterOptions;
	readonly frameSamples: number;

	/** Frames of the segment being built, plus the pre-roll ring in front of it. */
	#frames: Int16Array[] = [];
	/** Per-frame verdict, parallel to #frames, so the trim at the end knows
	 *  where the speech actually was. */
	#speech: boolean[] = [];
	/** Samples not yet a whole frame. A caller may push any length — the glasses
	 *  send whatever the BLE packet held. */
	#tail: Int16Array = new Int16Array(0);

	#open = false;
	/** Index into #frames where the current segment starts (its pre-roll). */
	#startFrame = 0;
	#speechFrames = 0;
	#silenceFrames = 0;
	#pendingSpeechFrames = 0;
	/** Frames consumed since the beginning of time — the clock, in frames. */
	#consumed = 0;
	#floorDb: number;
	#lastDb = -100;

	constructor(options: Partial<SegmenterOptions> = {}) {
		this.opts = { ...DEFAULTS, ...options };
		this.frameSamples = Math.max(1, Math.round((this.opts.sampleRate * this.opts.frameMs) / 1000));
		// Start at the top of the range and fall. The first frames of any capture
		// are room tone, and falling is the fast direction (floorFallRate), so
		// the floor finds a quiet room inside ~150 ms — while the other way round
		// means treating that room tone as speech until the floor catches up,
		// which is a segment of nothing sent to the GPU every time the
		// microphone is opened.
		this.#floorDb = this.opts.maxFloorDb;
	}

	// ------------------------------------------------------------- accessors

	/** True while an utterance is being collected. Drives the "listening"
	 *  indicator, which is the difference between a user who waits and a user
	 *  who repeats themselves (R5a.8). */
	get speaking(): boolean { return this.#open; }
	/** Last frame's level, for a level meter. */
	get levelDb(): number { return this.#lastDb; }
	get noiseFloorDb(): number { return this.#floorDb; }
	/** Milliseconds of audio pushed so far. */
	get positionMs(): number { return this.#framesToMs(this.#consumed); }

	// ------------------------------------------------------------------ core

	#framesToMs(frames: number): number { return Math.round((frames * this.frameSamples * 1000) / this.opts.sampleRate); }
	#msToFrames(ms: number): number { return Math.max(1, Math.round(ms / this.opts.frameMs)); }

	/**
	 * Feed audio in. Returns the segments that ended inside this push — usually
	 * none, occasionally one, more than one only if the caller handed over
	 * several seconds at once (a file, in a test).
	 */
	push(samples: Int16Array): Segment[] {
		const out: Segment[] = [];

		// Join whatever was left over last time. Copying is cheap at these sizes
		// and the alternative is an index-arithmetic bug that only shows up on
		// the one input where a frame straddles two pushes.
		let input = samples;
		if (this.#tail.length) {
			const joined = new Int16Array(this.#tail.length + samples.length);
			joined.set(this.#tail, 0);
			joined.set(samples, this.#tail.length);
			input = joined;
			this.#tail = new Int16Array(0);
		}

		let at = 0;
		while (at + this.frameSamples <= input.length) {
			const frame = input.slice(at, at + this.frameSamples);
			at += this.frameSamples;
			const segment = this.#frame(frame);
			if (segment) out.push(segment);
		}
		if (at < input.length) this.#tail = input.slice(at);
		return out;
	}

	/** One frame, and the whole state machine. */
	#frame(frame: Int16Array): Segment | null {
		this.#consumed++;
		const db = frameLevelDb(frame);
		this.#lastDb = db;
		const isSpeech = db > this.#floorDb + this.opts.marginDb;

		// The floor is tracked between utterances, never during one: a long
		// sentence would otherwise raise the bar until the speaker fell off it.
		//
		// Crucially it is tracked whatever the verdict was, not only on frames
		// that looked quiet. The first version updated it only when `!isSpeech`,
		// which cannot recover from a floor that is too low: every frame then
		// looks like speech, so nothing ever updates the floor, and a room with
		// a fan in it is one continuous utterance.
		if (!this.#open) {
			const rate = db < this.#floorDb ? this.opts.floorFallRate : this.opts.floorRiseRate;
			this.#floorDb = Math.min(this.opts.maxFloorDb, Math.max(this.opts.minFloorDb, this.#floorDb + rate * (db - this.#floorDb)));
		}

		this.#frames.push(frame);
		this.#speech.push(isSpeech);

		if (!this.#open) {
			// Idle: keep only the pre-roll, so a microphone left on all afternoon
			// costs a fixed 300 ms of memory.
			const keep = this.#msToFrames(this.opts.preRollMs) + this.#msToFrames(this.opts.startMs);
			while (this.#frames.length > keep) { this.#frames.shift(); this.#speech.shift(); }

			if (!isSpeech) { this.#pendingSpeechFrames = 0; return null; }

			this.#pendingSpeechFrames++;
			if (this.#pendingSpeechFrames < this.#msToFrames(this.opts.startMs)) return null;

			// Open. The segment starts one pre-roll before the first of the
			// frames that convinced us, which is where the word began.
			this.#open = true;
			this.#startFrame = Math.max(0, this.#frames.length - this.#pendingSpeechFrames - this.#msToFrames(this.opts.preRollMs));
			this.#speechFrames = this.#pendingSpeechFrames;
			this.#silenceFrames = 0;
			this.#pendingSpeechFrames = 0;
			return null;
		}

		if (isSpeech) { this.#speechFrames++; this.#silenceFrames = 0; }
		else this.#silenceFrames++;

		// R5a.6: a segment has a maximum length in the client. Cut here and let
		// the next frame open a new one — a sentence split in two is a worse
		// answer than an unbounded buffer only until the buffer is the problem.
		if (this.#frames.length - this.#startFrame >= this.#msToFrames(this.opts.maxSegmentMs)) {
			return this.#close("maximum");
		}

		// In hold mode silence never ends the utterance: the release does
		// (R5a.3). The counting above still happens, because the trim at the end
		// uses it.
		if (!this.opts.hold && this.#silenceFrames >= this.#msToFrames(this.opts.hangoverMs)) {
			return this.#close("silence");
		}
		return null;
	}

	/**
	 * End the current segment now — the push-to-talk release, or the microphone
	 * being turned off. Returns the segment, or null when there was nothing in
	 * it worth sending.
	 */
	flush(reason: SegmentReason = "close"): Segment | null {
		if (!this.#open) {
			// Nothing was open, so there is nothing to send — and the pre-roll
			// ring is dropped rather than sent as an "utterance" of room tone.
			this.#reset();
			return null;
		}
		return this.#close(reason);
	}

	/** Forget everything, including the noise floor. Used when the microphone is
	 *  reopened, because it may be a different microphone in a different room. */
	reset(): void {
		this.#reset();
		this.#floorDb = this.opts.minFloorDb;
		this.#consumed = 0;
		this.#lastDb = -100;
	}

	#reset(): void {
		this.#frames = [];
		this.#speech = [];
		this.#tail = new Int16Array(0);
		this.#open = false;
		this.#startFrame = 0;
		this.#speechFrames = 0;
		this.#silenceFrames = 0;
		this.#pendingSpeechFrames = 0;
	}

	/** Cut the segment out of the buffered frames, trimmed at both ends. */
	#close(reason: SegmentReason): Segment | null {
		const speechMs = this.#framesToMs(this.#speechFrames);

		// First and last speech frame inside the segment, so the trim is the same
		// whether the silence at the front was pre-roll or (in hold mode) a user
		// who pressed the button and then thought about it.
		let first = -1;
		let last = -1;
		for (let i = this.#startFrame; i < this.#speech.length; i++) {
			if (!this.#speech[i]) continue;
			if (first < 0) first = i;
			last = i;
		}

		const enough = first >= 0 && speechMs >= this.opts.minSpeechMs;
		let segment: Segment | null = null;

		if (enough) {
			const from = Math.max(this.#startFrame, first - this.#msToFrames(this.opts.preRollMs));
			const to = Math.min(this.#speech.length, last + 1 + this.#msToFrames(this.opts.tailMs));
			const pcm = concat(this.#frames, from, to);
			// The stream clock is "frames consumed"; the segment's own frames are
			// the last (#frames.length) of them, so its position is that minus the
			// distance from the end.
			const endOfStream = this.#consumed;
			const startMs = this.#framesToMs(endOfStream - (this.#frames.length - from));
			const endMs = this.#framesToMs(endOfStream - (this.#frames.length - to));
			segment = { pcm, startMs, endMs, durationMs: endMs - startMs, speechMs, reason };
		}

		this.#reset();
		// A "maximum" cut means the speaker is still speaking, so the next frame
		// should be able to open a new segment immediately rather than waiting
		// out another startMs of silence. Nothing to do but note it: the state
		// machine already treats the next speech frame as a fresh start.
		return segment;
	}
}

/**
 * The whole of a recording, in one call.
 *
 * This is what acceptance criterion 7 is about: hand the same code a PCM file
 * in Node and it produces the same segments it produces in a browser, because
 * there is nothing else in here. It is also how the segmenter is tuned — run it
 * over a recording, count the segments, look at the boundaries.
 */
export const segmentPcm = (pcm: Int16Array, options: Partial<SegmenterOptions> = {}, chunkSamples = 0): Segment[] => {
	const s = new Segmenter(options);
	const out: Segment[] = [];
	if (chunkSamples > 0) {
		// Delivered in pieces, the way a microphone or a BLE link delivers it —
		// including pieces that do not line up with the frame size.
		for (let at = 0; at < pcm.length; at += chunkSamples) out.push(...s.push(pcm.subarray(at, Math.min(pcm.length, at + chunkSamples))));
	} else {
		out.push(...s.push(pcm));
	}
	const last = s.flush("close");
	if (last) out.push(last);
	return out;
};

/** 16-bit PCM from a WebAudio buffer. Its own function because it is the one
 *  place a sample can be silently mangled, and because the tests check it. */
export const floatToPcm16 = (input: Float32Array): Int16Array => {
	const out = new Int16Array(input.length);
	for (let i = 0; i < input.length; i++) {
		// Clamp before scaling: a value of 1.0 scaled by 32768 is 32768, which
		// wraps to -32768 and puts a click at the loudest moment of every phrase.
		const v = Math.max(-1, Math.min(1, input[i]));
		out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
	}
	return out;
};

/**
 * Linear resampling to the pipeline's rate.
 *
 * The browser is asked for a 16 kHz AudioContext and normally gives one, in
 * which case this is never called. It exists for the browser that refuses and
 * hands back 44.1 or 48 kHz anyway — R5a.1 says resampling happens once, in the
 * client, before anything else sees the audio, and "the browser would not" is
 * not an answer the rest of the pipeline can do anything with.
 *
 * Linear, not windowed-sinc: the input has already been low-passed by the
 * browser's own capture chain, the output goes to a model trained on telephone
 * audio among other things, and the difference is inaudible to it.
 */
export const resampleTo = (input: Float32Array, fromRate: number, toRate: number): Float32Array => {
	if (fromRate === toRate || input.length === 0) return input;
	const ratio = fromRate / toRate;
	const length = Math.floor(input.length / ratio);
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		const at = i * ratio;
		const i0 = Math.floor(at);
		const i1 = Math.min(input.length - 1, i0 + 1);
		const t = at - i0;
		out[i] = input[i0] * (1 - t) + input[i1] * t;
	}
	return out;
};
