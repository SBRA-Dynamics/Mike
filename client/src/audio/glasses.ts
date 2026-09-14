// The microphone on someone's face — PRD 5b R5b.1 and R5b.2.
//
// This file is the glasses' answer to capture.ts, and it is deliberately the
// same shape: it turns whatever the hardware hands over into the frames the
// segmenter next door already knows what to do with, and it is honest about
// whether the microphone is open. Everything downstream of a segment is
// PRD 5a's and is not touched here — that is the whole point of the split, and
// `segment.ts` is imported unchanged, with no options a browser would not also
// pass.
//
// Three things are genuinely different from a browser microphone.
//
//   * There is nothing to resample. `AudioEvent.audioPcm` is already 16 kHz,
//     signed 16-bit little-endian, mono, which is the format PRD 5a chose so
//     that this phase would need no conversion. What DOES need doing is
//     re-framing: the host hands over BYTES, the segmenter takes SAMPLES, and a
//     packet is free to end on half a sample. See #toSamples.
//
//   * Frames carry `speakerRole`, the Even App's own guess at whether the
//     wearer or somebody else is talking. R5b.2 drops `Other` and keeps
//     `Unknown`, because losing the wearer's speech is worse than transcribing
//     a little noise. The ratio is counted, because if `Unknown` dominates the
//     filter is useless and the design needs revisiting.
//
//   * Opening it is a BLE round trip, not a permission dialog. It costs
//     measured milliseconds (~194 ms through the simulator's bridge, against a
//     ~160 ms fixed per-SDK-call cost measured on the hardware), and the user
//     who pressed the touchpad is already speaking. So the cost is MEASURED
//     here, every time, rather than assumed — `stats.openMs` and
//     `stats.leadInMs` are what R5b.3 says to measure before promising
//     anything, and reading them off a running system is the cheapest way to
//     settle it.

import { Segmenter } from "./segment.ts";
import type { MicSource, MicState } from "./capture.ts";
import type { Segment, SegmenterOptions } from "./segment.ts";

/** `AudioInputSource` from the SDK, as strings. Not imported from the SDK: this
 *  file is loaded by the Node suite, which has no WebView to give the SDK, and
 *  the values are part of the wire format rather than an implementation
 *  detail. They are checked against the 0.0.15 typings. */
export const SOURCE = {
	/** The four-mic array. Needs `g2-microphone` AND a created startup page —
	 *  a sequencing constraint on the client, not a detail (R5b.1). */
	GLASSES: "glasses",
	/** The phone's own microphone. Needs `phone-microphone` and no page, which
	 *  is what makes it the fallback when the glasses are not there. */
	PHONE: "phone"
} as const;

/** `AudioSpeakerRole`, likewise. The SDK is explicit that this is "an app
 *  algorithm result; this is not a firmware identity assertion" — good enough
 *  to decide what to transcribe, not something to trust for anything that
 *  matters (PRD 5b, non-goals). */
export const SPEAKER = { SELF: "self", OTHER: "other", UNKNOWN: "unknown" } as const;

/** One `AudioEvent`, as loosely as it may actually arrive.
 *
 *  The SDK normalises the host's JSON into a real `AudioEvent` with a
 *  `Uint8Array`, but the host is documented to send `audioPcm` as a number
 *  array or a base64 string depending on version, and the enums as names or
 *  ordinals. Being tolerant here is the same decision `Glasses.#sysType` makes
 *  next door, for the same reason: a host that is one version out should cost a
 *  worse guess, not a crash. */
export type GlassesAudioFrame = {
	audioPcm?: Uint8Array | ArrayBuffer | number[] | string | null;
	source?: unknown;
	direction?: number | null;
	speakerRole?: unknown;
};

export type GlassesMicOptions = {
	/** Open and close the hardware. Exactly `bridge.audioControl(isOpen, source)`,
	 *  injected rather than imported so this class can be driven by the Node
	 *  suite with no WebView anywhere. */
	control: (open: boolean, source: string) => Promise<boolean>;
	/** Is the glasses-side startup page up? `audioControl(true, Glasses)` fails
	 *  without one (R5b.1), so when this says no we open the PHONE microphone
	 *  instead rather than failing — which is exactly the fallback R5b.1 asks
	 *  for, and keeps a hold unconditional (R5a.4). */
	pageReady?: () => boolean;
	onSegment: (segment: Segment) => void;
	onState: (state: MicState, detail: string) => void;
	onLevel?: (db: number, speaking: boolean) => void;
	/** R5b.2's "the ratio is logged". One line, rarely. */
	onNote?: (text: string) => void;
	/** Same cadence, no words: "another thirty seconds of audio has arrived".
	 *  Without it a microphone left open in a silent room notifies nobody for
	 *  half an hour, and the byte rate R5b.4 wants measured is invisible in
	 *  exactly the session it has to be measured in. */
	onProgress?: () => void;
	segmenter?: Partial<SegmenterOptions>;
	/** For the tests, so a run is not a function of the wall clock. */
	now?: () => number;
};

/** How much audio between reports. 30 s of frames is long enough that the
 *  speaker-role ratio means something and rare enough that a thirty-minute
 *  battery session is sixty lines rather than a hundred thousand. */
const REPORT_MS = 30_000;

/** Bytes, whatever the host called them. */
const toBytes = (pcm: GlassesAudioFrame["audioPcm"]): Uint8Array => {
	if (!pcm) return new Uint8Array(0);
	if (pcm instanceof Uint8Array) return pcm;
	if (pcm instanceof ArrayBuffer) return new Uint8Array(pcm);
	if (Array.isArray(pcm)) return Uint8Array.from(pcm);
	if (typeof pcm === "string") {
		// base64. `atob` is a browser API, and this file does run in a browser —
		// unlike segment.ts, which must not. Node 22 has it too, which is what
		// lets the suite drive this class directly.
		const binary = atob(pcm);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	}
	return new Uint8Array(0);
};

/** Is this machine little-endian? The wire is s16**LE** and every platform the
 *  G2 talks to is little-endian, so the typed-array view is right in practice —
 *  but "in practice" is not a reason to produce silently reversed samples on
 *  the machine where it is not, and the check costs one comparison at load. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Bytes to samples, carrying the odd one over.
 *
 * The format needs no conversion — it is already what the segmenter wants —
 * but the CONTAINER does: a BLE packet is a byte count, and nothing promises it
 * is even. Half a sample dropped shifts every sample after it by one byte,
 * which is noise that sounds like speech to no one; half a sample kept until
 * the next packet is the rest of that sample. The server refuses an odd-length
 * segment for the same reason (src/audio.js), so getting this wrong would show
 * up as a refused utterance rather than as bad audio, which is worse.
 */
export const toSamples = (bytes: Uint8Array, carry: number | null = null): { pcm: Int16Array; carry: number | null } => {
	const total = (carry === null ? 0 : 1) + bytes.length;
	const samples = total >> 1;
	const out = new Int16Array(samples);
	let at = 0;
	let i = 0;
	if (carry !== null && bytes.length) {
		out[at++] = ((carry | (bytes[0] << 8)) << 16) >> 16;
		i = 1;
	}
	if (LITTLE_ENDIAN && (bytes.byteOffset + i) % 2 === 0) {
		// The common case: aligned, so the bytes are already the samples.
		out.set(new Int16Array(bytes.buffer, bytes.byteOffset + i, samples - at), at);
	} else {
		for (; at < samples; at++, i += 2) out[at] = ((bytes[i] | (bytes[i + 1] << 8)) << 16) >> 16;
	}
	// One byte over, or none. When there is one it is the last byte handed in —
	// except in the degenerate case of an empty packet, where the carry is still
	// waiting for its other half.
	const left = total & 1 ? (bytes.length ? bytes[bytes.length - 1] : carry) : null;
	return { pcm: out, carry: left };
};

export class GlassesMicrophone implements MicSource {
	state: MicState = "off";
	detail = "";
	/** Which of the two microphones the last open() actually asked for. */
	source: string = SOURCE.GLASSES;

	/** Everything the risk table wants counted, and nothing that needs hardware
	 *  to read. `openMs` and `leadInMs` are R5b.3's measurement; `bytes` over
	 *  wall time is R5b.4's; the role counts are R5b.2's. */
	stats = {
		opens: 0, segments: 0, samples: 0, deniedAt: 0,
		/** AudioEvents seen since the page loaded. */
		frames: 0,
		/** Bytes of PCM the link delivered — the number R5b.4 asks for. */
		bytes: 0,
		self: 0, other: 0, unknown: 0,
		/** `Other` frames thrown away outright (no utterance was in progress). */
		dropped: 0,
		/** `Other` frames replaced by silence (one WAS) — see #frame. */
		muted: 0,
		/** Packets that ended on half a sample. Should be 0 on the G2; a number
		 *  here is the reason a segment would otherwise have been refused. */
		odd: 0,
		/** How long the last `audioControl(true)` took to answer. */
		openMs: 0,
		/** And how long until the first frame after it — the syllable a
		 *  push-to-talk user loses (R5b.3). */
		leadInMs: 0,
		/** Failed or refused opens, and failed closes. A close that ANSWERS
		 *  false is not one of these; see #stop. */
		openFailures: 0,
		stopFailures: 0
	};

	#opts: GlassesMicOptions;
	#segmenter: Segmenter | null = null;
	/** True when the hardware is ours right now. */
	#open = false;
	#hold = false;
	#opening: Promise<boolean> | null = null;
	/** Bumped by every teardown — the same guard capture.ts uses, and needed
	 *  for the same reason: `audioControl(true)` is a round trip, and a
	 *  push-to-talk user can press and release inside it. Without this the
	 *  microphone that arrives afterwards has nobody left to own it and stays
	 *  ON, on hardware, in the one mode whose whole promise is that it is not. */
	#generation = 0;
	#carry: number | null = null;
	#openedAt = 0;
	#framesThisOpen = 0;
	#framesSinceReport = 0;
	#now: () => number;

	constructor(opts: GlassesMicOptions) {
		this.#opts = opts;
		this.#now = opts.now ?? (() => Date.now());
	}

	get live(): boolean { return this.#open && this.state === "listening"; }

	/** Microphones this page is holding open on the hardware: one, or none.
	 *  Deliberately the same units as the browser's track count so one
	 *  assertion covers both sources — zero when not held is what PushToTalk
	 *  promises, whichever microphone is behind it. */
	get liveTracks(): number { return this.#open ? 1 : 0; }

	get speaking(): boolean { return this.#segmenter?.speaking ?? false; }
	get levelDb(): number { return this.#segmenter?.levelDb ?? -100; }

	/** Share of frames the Even App attributed to somebody else, and to nobody
	 *  in particular. R5b.2: if `Unknown` dominates, the filter is useless. */
	get roles(): { self: number; other: number; unknown: number; frames: number } {
		const { self, other, unknown, frames } = this.stats;
		return { self, other, unknown, frames };
	}

	#setState(state: MicState, detail = ""): void {
		if (this.state === state && this.detail === detail) return;
		this.state = state;
		this.detail = detail;
		this.#opts.onState(state, detail);
	}

	/**
	 * Open the microphone. `hold` puts the segmenter in push-to-talk shape, the
	 * same as the browser's.
	 *
	 * Which microphone is decided here rather than by the caller: the glasses'
	 * array when there is a page for it, the phone's when there is not (R5b.1).
	 * A caller that had to ask first could be told "no" and do nothing, and a
	 * hold that can be told "no" is not unconditional (R5a.4).
	 */
	async open(hold = false): Promise<boolean> {
		if (this.#opening) return this.#opening;
		if (this.live && this.#hold === hold) return true;
		this.#opening = this.#start(hold).finally(() => { this.#opening = null; });
		return this.#opening;
	}

	async #start(hold: boolean): Promise<boolean> {
		this.#hold = hold;
		const source = this.#opts.pageReady?.() === false ? SOURCE.PHONE : SOURCE.GLASSES;
		this.source = source;
		this.#setState("starting", hold ? "hold" : "continuous");

		const generation = this.#generation;
		// Built before the round trip, not after: a frame that arrives while
		// audioControl is still resolving is the first syllable, and the only
		// place to put it is a segmenter that already exists.
		this.#segmenter = new Segmenter({ ...this.#opts.segmenter, sampleRate: 16_000, hold });
		this.#carry = null;
		this.#openedAt = this.#now();
		this.#framesThisOpen = 0;

		let ok: boolean;
		try {
			ok = await this.#opts.control(true, source);
		} catch (e) {
			this.stats.openFailures++;
			this.#setState("error", (e as Error)?.message ?? String(e));
			this.#teardown();
			return false;
		}
		this.stats.openMs = this.#now() - this.#openedAt;

		if (generation !== this.#generation) {
			// Released (or switched off) while the link was still thinking about
			// it. This stop is the AUTHORITATIVE one: close() fires a best-effort
			// stop too, but that one races the open it is trying to undo, and the
			// host is free to apply them in the order they arrive. This one runs
			// strictly after the open was answered, so it cannot be reordered
			// behind it, and it is what actually guarantees the microphone is not
			// left running on somebody's face.
			await this.#stop(source);
			this.#setState("off", "closed while opening");
			return false;
		}

		if (!ok) {
			// The host refused. On the glasses that means the startup page is not
			// there; on the phone it means the permission is not granted. Either
			// way it is a decision, not a fault, so it reads like `denied` does in
			// the browser rather than like a bug in the microphone.
			this.stats.openFailures++;
			this.stats.deniedAt = this.#now();
			this.#setState("denied", `${source} microphone refused`);
			this.#teardown();
			return false;
		}

		this.#open = true;
		this.stats.opens++;
		this.#setState("listening", hold ? "hold" : "continuous");
		return true;
	}

	/**
	 * One `AudioEvent`, straight off the bridge.
	 *
	 * Nothing here is async and nothing here allocates more than the frame,
	 * because this runs fifty to five hundred times a second.
	 */
	frame(event: GlassesAudioFrame): void {
		const s = this.#segmenter;
		// The segmenter's lifetime IS the microphone's, and that is the whole
		// test. #teardown drops it, so a packet still in flight when the user let
		// go has nothing to land in and cannot become the front of the next
		// utterance — the host stops when it stops, not when we ask.
		//
		// A frame that arrives while `audioControl(true)` is still being ANSWERED
		// does land, which is why the segmenter is built before that round trip
		// rather than after it. That is the first syllable R5b.3 is about, and
		// throwing it away here would make the lead-in worse than it has to be.
		if (!s) return;

		// Per open, not per page load: R5b.3 wants the syllable THIS hold lost.
		if (!this.#framesThisOpen++) this.stats.leadInMs = this.#now() - this.#openedAt;
		this.stats.frames++;

		const bytes = toBytes(event.audioPcm);
		this.stats.bytes += bytes.length;
		const { pcm, carry } = toSamples(bytes, this.#carry);
		if (carry !== null) this.stats.odd++;
		this.#carry = carry;

		const role = typeof event.speakerRole === "string" ? event.speakerRole.toLowerCase() : SPEAKER.UNKNOWN;
		if (role === SPEAKER.SELF) this.stats.self++;
		else if (role === SPEAKER.OTHER) this.stats.other++;
		else this.stats.unknown++;

		let samples = pcm;
		if (role === SPEAKER.OTHER) {
			// R5b.2: somebody else. Never transcribed — but WHAT to do with the
			// time is not the same question, and getting it wrong is a real bug
			// either way.
			//
			// While no utterance is open, drop the frame outright. Feeding
			// digital silence to a closed segmenter would drag its noise floor
			// down to the clamp, and a floor below the room plus a 9 dB margin
			// means the room itself reads as speech for the next several seconds
			// — a segment of nothing, sent to the GPU, every time somebody walks
			// past talking.
			//
			// While one IS open, hand over silence of the same length instead.
			// The segmenter's clock is "frames consumed", so dropping would stop
			// time: the hangover could never run out, and an utterance the wearer
			// finished would stay open for as long as the other person kept
			// talking. Silence lets it close normally, and the trim throws the
			// silence away again. The floor is not tracked during an utterance,
			// so it cannot be polluted here.
			if (!s.speaking) { this.stats.dropped++; return; }
			samples = new Int16Array(pcm.length);
			this.stats.muted++;
		}

		this.stats.samples += samples.length;
		for (const segment of s.push(samples)) this.#emit(segment);
		this.#opts.onLevel?.(s.levelDb, s.speaking);
		this.#report();
	}

	/** R5b.2's log line: how the array is actually attributing the room. */
	#report(): void {
		this.#framesSinceReport++;
		const perReport = Math.max(1, Math.round(REPORT_MS / Math.max(1, this.#frameMs())));
		if (this.#framesSinceReport < perReport) return;
		this.#framesSinceReport = 0;
		const { self, other, unknown, frames } = this.stats;
		const pct = (n: number) => `${Math.round((n / Math.max(1, frames)) * 100)}%`;
		this.#opts.onNote?.(`speaker roles: self ${pct(self)}, other ${pct(other)}, unknown ${pct(unknown)} of ${frames} frames`);
		this.#opts.onProgress?.();
	}

	/** Average frame length so far, in ms. Measured rather than assumed: the
	 *  simulator sends 100 ms frames and the hardware need not. */
	#frameMs(): number {
		if (!this.stats.frames) return 100;
		return (this.stats.bytes / 2 / this.stats.frames / 16_000) * 1000;
	}

	#emit(segment: Segment): void {
		this.stats.segments++;
		this.#opts.onSegment(segment);
	}

	/**
	 * Close it, and flush whatever was being said.
	 *
	 * The flush is the push-to-talk release (R5a.3), and it is also what stops a
	 * sentence being lost when the app is backgrounded mid-word.
	 */
	close(reason: "release" | "close" = "close"): void {
		const wasSpeaking = this.#segmenter?.speaking ?? false;
		const last = this.#segmenter?.flush(reason) ?? null;
		this.#teardown();
		this.#setState("off", reason);
		// The detector only reports from a frame, and a closed microphone sends
		// none — so a release left `speaking` on at the server, which held the
		// sentence for the whole SPEAKING_CAP_MS waiting for words that were
		// never coming. Said here, before the last segment, so the hold window
		// counts from the release.
		if (wasSpeaking) this.#opts.onLevel?.(-100, false);
		// After the teardown, so a handler that reopens on the back of a segment
		// cannot race the close.
		if (last) this.#emit(last);
	}

	#teardown(): void {
		const wasOn = this.#open || this.#opening !== null;
		this.#generation++;
		this.#open = false;
		this.#segmenter = null;
		this.#carry = null;
		// Best effort, and deliberately not awaited: close() is called from a
		// touchpad release and from an exit handler, neither of which can wait
		// for BLE. The open path's generation check is what makes this correct
		// rather than hopeful — see #start.
		if (wasOn) void this.#stop(this.source);
	}

	async #stop(source: string): Promise<void> {
		try {
			// The answer is NOT checked. The Even App answers `false` to a close
			// even when it really stopped — measured through the simulator's
			// bridge: audioControl(false) returned false and not one further
			// frame arrived. Reporting that as a failure would put a red error on
			// the lens every single time the user let go of the touchpad.
			await this.#opts.control(false, source);
		} catch (e) {
			// Not swallowed into a null: it is counted, and the message is kept
			// where the companion and the suite can read it. What it must NOT do
			// is overwrite the "off" state — the microphone is off as far as this
			// client is concerned either way, and claiming otherwise is the
			// scarier lie.
			this.stats.stopFailures++;
			this.detail = `stop failed: ${(e as Error)?.message ?? String(e)}`;
		}
	}
}
