// The microphone — PRD 5a R5a.1.
//
// Everything that touches a browser API lives here, and nothing else does: the
// segmenter next door is deliberately free of them so PRD 5b can hand it
// glasses frames (R5a.3). This file's whole job is to turn a MediaStream into
// the frames that segmenter wants — 16 kHz, signed 16-bit, mono — and to be
// honest about whether the microphone is open.
//
// Two things here are promises to the user rather than implementation choices:
//
//   * Permission is asked for when the microphone is first turned on, never at
//     page load (R5a.1). So `open()` is the only thing that calls getUserMedia,
//     and it is only called from a control the user touched.
//   * `close()` really closes it. Every track is stopped and the AudioContext
//     is closed, so the browser's recording indicator goes out — which is what
//     makes PushToTalk's promise checkable rather than a claim (R5a.4, and
//     acceptance criterion 4).

import { floatToPcm16, resampleTo, Segmenter } from "./segment.ts";
import type { Segment, SegmenterOptions } from "./segment.ts";

export type MicState =
	/** Not running, and no permission being held. */
	| "off"
	/** getUserMedia is in flight — on a fresh permission this is a dialog. */
	| "starting"
	/** Open and feeding the segmenter. */
	| "listening"
	/** The user (or the platform) said no. Asking again on a loop is how a page
	 *  gets its microphone permission permanently blocked. */
	| "denied"
	| "error";

export type MicOptions = {
	/** A finished utterance. Called once per segment, in order. */
	onSegment: (segment: Segment) => void;
	/** Every state change, for the indicator R5a.8 asks for. */
	onState: (state: MicState, detail: string) => void;
	/** Level and speech flag, ~50 times a second, for a meter. Optional: the
	 *  lens has no room for one and the companion does. */
	onLevel?: (db: number, speaking: boolean) => void;
	/** Segmenter settings. `hold` is set by the caller per open(). */
	segmenter?: Partial<SegmenterOptions>;
	/** Seam for the tests: a stand-in for navigator.mediaDevices.getUserMedia. */
	getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	/** Seam for the tests: a stand-in AudioContext constructor. */
	audioContext?: (options: AudioContextOptions) => AudioContext;
};

/** The capture constraints. Echo cancellation and noise suppression are left
 *  ON deliberately (R5a.1): the browser's own are better than anything worth
 *  writing here, and this is a desk microphone in a room with a fan. Echo
 *  cancellation is also what stops a reply read aloud from being transcribed as
 *  a new utterance. */
export const CONSTRAINTS: MediaStreamConstraints = {
	audio: {
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true,
		channelCount: 1,
		// A request, not a guarantee: Firefox ignores it and Chrome honours it
		// only for some devices, which is why the AudioContext below asks for
		// the same rate and the resampler exists behind both.
		sampleRate: 16_000
	},
	video: false
};

/** The worklet, as source text.
 *
 * Inline, and turned into a Blob URL at runtime, because an AudioWorklet module
 * has to be a separate file fetched by URL — and a separate file means a build
 * step that knows about it, a path that survives `base: "./"`, and one more
 * thing to get wrong when the client is served from a subdirectory. It is
 * twelve lines; a Blob costs nothing and cannot go missing.
 *
 * It batches the 128-sample quanta into ~20 ms, so the main thread gets ~50
 * messages a second instead of 125, and copies out of the input buffer because
 * the runtime reuses it. */
const WORKLET_SOURCE = `
class JarvisCapture extends AudioWorkletProcessor {
	constructor() { super(); this.buffer = []; this.count = 0; this.target = Math.round(sampleRate * 0.02); }
	process(inputs) {
		const input = inputs[0];
		if (!input || !input[0]) return true;
		this.buffer.push(new Float32Array(input[0]));
		this.count += input[0].length;
		if (this.count >= this.target) {
			const out = new Float32Array(this.count);
			let at = 0;
			for (const b of this.buffer) { out.set(b, at); at += b.length; }
			this.buffer = []; this.count = 0;
			this.port.postMessage(out, [out.buffer]);
		}
		return true;
	}
}
registerProcessor("jarvis-capture", JarvisCapture);
`;

export class Microphone {
	state: MicState = "off";
	detail = "";
	/** Diagnostics the companion shows and the browser suite asserts on. */
	stats = { opens: 0, segments: 0, samples: 0, deniedAt: 0 };

	#opts: MicOptions;
	#stream: MediaStream | null = null;
	#ctx: AudioContext | null = null;
	#node: AudioNode | null = null;
	#source: MediaStreamAudioSourceNode | null = null;
	#sink: GainNode | null = null;
	#segmenter: Segmenter | null = null;
	#hold = false;
	/** An open() that has not finished yet, so a second press does not start a
	 *  second graph on the same stream. */
	#opening: Promise<boolean> | null = null;
	/** Bumped by every teardown. getUserMedia takes time — on a first permission,
	 *  a lot of it — and a push-to-talk user can easily press and release inside
	 *  that window. Without this the stream that arrives afterwards has nobody
	 *  left to own it and stays open: a microphone left live by a quick tap, in
	 *  the one mode whose whole promise is that it is not. */
	#generation = 0;

	constructor(opts: MicOptions) { this.#opts = opts; }

	/** True when the browser is actually capturing — the question a hold-to-talk
	 *  user needs answered (R5a.4's "whether capture is live right now"). */
	get live(): boolean { return this.liveTracks > 0 && this.state === "listening"; }

	/** How many microphone tracks this page is holding open. Zero is the whole
	 *  promise of PushToTalk, and it is a number rather than a claim so the
	 *  suite can check it. */
	get liveTracks(): number {
		return (this.#stream?.getAudioTracks() ?? []).filter((t) => t.readyState === "live").length;
	}

	get speaking(): boolean { return this.#segmenter?.speaking ?? false; }
	get levelDb(): number { return this.#segmenter?.levelDb ?? -100; }

	#setState(state: MicState, detail = ""): void {
		if (this.state === state && this.detail === detail) return;
		this.state = state;
		this.detail = detail;
		this.#opts.onState(state, detail);
	}

	/**
	 * Open the microphone. `hold` switches the segmenter into push-to-talk
	 * shape: silence no longer ends an utterance, the release does.
	 *
	 * Returns false when it could not be opened, and says why in `detail`
	 * rather than throwing — every caller here is a button handler.
	 */
	async open(hold = false): Promise<boolean> {
		if (this.#opening) return this.#opening;
		if (this.live && this.#hold === hold) return true;
		this.#opening = this.#open(hold).finally(() => { this.#opening = null; });
		return this.#opening;
	}

	async #open(hold: boolean): Promise<boolean> {
		this.#hold = hold;
		this.#setState("starting", hold ? "hold" : "continuous");
		const generation = this.#generation;
		const getUserMedia = this.#opts.getUserMedia
			?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));

		let stream: MediaStream;
		try {
			stream = await getUserMedia(CONSTRAINTS);
		} catch (e) {
			const name = (e as Error)?.name ?? "";
			// NotAllowedError is a decision, not a fault: the user said no, or the
			// page is not on a secure origin. Saying "error" there sends people
			// looking for a bug in the microphone.
			const denied = name === "NotAllowedError" || name === "SecurityError";
			this.#setState(denied ? "denied" : "error", (e as Error)?.message ?? String(e));
			if (denied) this.stats.deniedAt = Date.now();
			this.#teardown();
			return false;
		}

		if (generation !== this.#generation) {
			// Released (or switched off) while the browser was still thinking
			// about it. Stop what we were given and leave nothing behind.
			for (const t of stream.getTracks()) { try { t.stop(); } catch { /* already gone */ } }
			this.#setState("off", "closed while opening");
			return false;
		}
		this.#stream = stream;

		try {
			await this.#buildGraph();
		} catch (e) {
			this.#setState("error", (e as Error)?.message ?? String(e));
			this.#teardown();
			return false;
		}

		this.stats.opens++;
		this.#setState("listening", hold ? "hold" : "continuous");
		return true;
	}

	async #buildGraph(): Promise<void> {
		const make = this.#opts.audioContext ?? ((o: AudioContextOptions) => new AudioContext(o));
		// Ask for the pipeline's rate. Chrome gives it; anything that does not
		// falls through to the resampler below, which is R5a.1's "the client
		// resamples" either way.
		const ctx = make({ sampleRate: 16_000 });
		this.#ctx = ctx;
		if (ctx.state === "suspended") await ctx.resume();

		const rate = ctx.sampleRate;
		this.#segmenter = new Segmenter({ ...this.#opts.segmenter, sampleRate: 16_000, hold: this.#hold });
		this.#source = ctx.createMediaStreamSource(this.#stream!);

		const onAudio = (samples: Float32Array) => this.#audio(samples, rate);
		const generation = this.#generation;
		this.#node = await this.#makeProcessor(ctx, onAudio);
		if (generation !== this.#generation) throw new Error("closed while opening");

		// Through a silent gain into the destination. A processing node that
		// reaches no destination is not guaranteed to be pulled at all (and with
		// a ScriptProcessor it definitively is not), and routing the microphone
		// to the speakers at any audible gain is how a room starts howling.
		this.#sink = ctx.createGain();
		this.#sink.gain.value = 0;
		this.#source.connect(this.#node);
		this.#node.connect(this.#sink);
		this.#sink.connect(ctx.destination);
	}

	/** AudioWorklet where there is one, ScriptProcessor where there is not.
	 *  The worklet runs on the audio thread, so a busy main thread cannot drop
	 *  frames; the fallback is deprecated but universally present, and dropping
	 *  the microphone entirely on a browser that lacks worklets is worse. */
	async #makeProcessor(ctx: AudioContext, onAudio: (s: Float32Array) => void): Promise<AudioNode> {
		if (ctx.audioWorklet) {
			let url: string | null = null;
			try {
				url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
				await ctx.audioWorklet.addModule(url);
				const node = new AudioWorkletNode(ctx, "jarvis-capture");
				node.port.onmessage = (e: MessageEvent) => onAudio(new Float32Array(e.data as ArrayBufferLike));
				return node;
			} catch { /* fall through to the ScriptProcessor */ }
			finally { if (url) URL.revokeObjectURL(url); }
		}
		const node = ctx.createScriptProcessor(1024, 1, 1);
		node.onaudioprocess = (e: AudioProcessingEvent) => onAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
		return node;
	}

	/** One block of samples from the audio thread. */
	#audio(samples: Float32Array, rate: number): void {
		const s = this.#segmenter;
		if (!s) return;
		// R5a.1: resampling happens once, in the client, before anything else
		// sees the audio. When the context already runs at 16 kHz this is a
		// no-op and returns the same array.
		const at16k = rate === 16_000 ? samples : resampleTo(samples, rate, 16_000);
		this.stats.samples += at16k.length;
		for (const segment of s.push(floatToPcm16(at16k))) this.#emit(segment);
		this.#opts.onLevel?.(s.levelDb, s.speaking);
	}

	#emit(segment: Segment): void {
		this.stats.segments++;
		this.#opts.onSegment(segment);
	}

	/**
	 * Close the microphone and flush whatever was being said.
	 *
	 * The flush is the push-to-talk release (R5a.3: the release ends the
	 * utterance), and it is also what stops a sentence being lost when the user
	 * switches the microphone off mid-word.
	 */
	close(reason: "release" | "close" = "close"): void {
		const last = this.#segmenter?.flush(reason) ?? null;
		this.#teardown();
		this.#setState("off", reason);
		// After teardown, so a handler that reopens the microphone on the back of
		// a segment cannot race the close.
		if (last) this.#emit(last);
	}

	#teardown(): void {
		this.#generation++;
		for (const t of this.#stream?.getTracks() ?? []) { try { t.stop(); } catch { /* already gone */ } }
		this.#stream = null;
		// Disconnected explicitly rather than left to close(): a suspended
		// context in some browsers keeps pulling the graph for a while, and the
		// segmenter must not see samples after a release.
		try { this.#source?.disconnect(); } catch { /* not connected */ }
		try { this.#node?.disconnect(); } catch { /* not connected */ }
		try { this.#sink?.disconnect(); } catch { /* not connected */ }
		if (this.#node && "port" in this.#node) (this.#node as AudioWorkletNode).port.onmessage = null;
		if (this.#node && "onaudioprocess" in this.#node) (this.#node as ScriptProcessorNode).onaudioprocess = null;
		void this.#ctx?.close().catch(() => { /* already closing */ });
		this.#ctx = null;
		this.#node = null;
		this.#source = null;
		this.#sink = null;
		this.#segmenter = null;
	}
}
