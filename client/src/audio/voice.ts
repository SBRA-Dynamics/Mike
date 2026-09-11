// What the microphone does in each addressing mode — PRD 5a R5a.4.
//
// The mode table is about spoken input, and three of the four modes leave the
// microphone open and decide in software what to keep:
//
//   Ignore      open, and everything is dropped by the server — including the
//               overheard sentence, which is the point. The audio still has to
//               REACH the server, because the way out of Ignore is to say
//               "fortsätt input" and the mode commands are matched before the
//               gate. A client that stopped sending in Ignore would have built
//               a state the user cannot speak their way out of.
//   ByName      open.
//   Always      open.
//   PushToTalk  closed, until the control is held. This is the only mode where
//               the microphone is actually off, and that difference is the
//               whole reason it exists.
//
// The hold is unconditional. No page state, no active worker, no connection
// status may stop it opening the microphone (R5a.4) — so holdStart() does not
// consult anything, and the button that calls it is never disabled. In a mode
// where the microphone is already open a hold changes nothing, which is the
// right answer: the words are already getting through.
//
// PRD 5b adds a SECOND microphone and changes nothing else. There are now two
// things that can be a `MicSource` — the browser's (capture.ts) and the
// glasses' (glasses.ts) — and this file picks between them and then stops
// caring which it got. That is the whole of what 5b does to the mode policy:
// the glasses do not get their own modes, their own gate or their own path to
// the server, and if they did, acceptance criterion 7 would already be broken.

import { Microphone } from "./capture.ts";
import { GlassesMicrophone } from "./glasses.ts";
import type { MicSource, MicState } from "./capture.ts";
import type { Segment, SegmenterOptions } from "./segment.ts";
import type { GlassesAudioFrame } from "./glasses.ts";
import { MODES } from "../../../src/routing.js";

export type VoiceStatus = {
	/** The user's microphone switch. */
	enabled: boolean;
	/** Is the browser capturing right now? R5a.4 wants this visible on its own,
	 *  separately from the mode: "a hold-to-talk the user cannot confirm is
	 *  listening is a mode they will speak into and lose". */
	live: boolean;
	/** Is the control being held right now? */
	held: boolean;
	/** Is somebody talking into it right now (energy above the floor)? */
	speaking: boolean;
	mic: MicState;
	detail: string;
	/** Segments sent since the page loaded, for the diagnostics line. */
	sent: number;
	/** How long the last segment was. With a hold, this is what "captured only
	 *  while held" means as a number rather than as a claim. */
	lastSegmentMs: number;
	/** Which microphone the words are coming through — "browser", "glasses" or
	 *  "phone" (PRD 5b R5b.1). Shown rather than inferred: an always-on
	 *  microphone on someone's face and an always-on one on a desk are different
	 *  promises, and the user should not have to guess which they made. */
	device: string;
};

export type VoiceOptions = {
	/** Put one segment on the wire. Returns false when there was no socket —
	 *  the caller says so rather than queueing, for the same reason a typed line
	 *  is not queued: an utterance that arrives four minutes late lands in a
	 *  conversation that has moved on. */
	send: (pcm: Int16Array, info: { durationMs: number; reason: Segment["reason"] }) => boolean;
	onChange: (status: VoiceStatus) => void;
	/** A sentence for the user — a refused permission, a dropped segment. */
	onNote: (text: string) => void;
	segmenter?: Partial<SegmenterOptions>;
	mic?: MicSource;
	/** PRD 5b. Present = there is a bridge that could carry audio; absent = this
	 *  is a plain browser and capture.ts is the only microphone there is.
	 *  Exactly `bridge.audioControl(isOpen, source)`. */
	glassesControl?: (open: boolean, source: string) => Promise<boolean>;
	/** Is the glasses-side startup page up? Decides GLASSES vs PHONE inside the
	 *  glasses microphone (R5b.1); it never decides whether a hold happens. */
	pageReady?: () => boolean;
	/** Is there an Even App host at all? A plain browser tab has a Glasses
	 *  object too — it just never attached — and asking IT for a microphone
	 *  would mean a desktop that can no longer hear anything. */
	hostReady?: () => boolean;
	/** Seam for the tests: a stand-in glasses microphone. */
	glasses?: MicSource;
};

/** Base64 for the wire. Chunked, because `String.fromCharCode(...bytes)` on a
 *  480 kB segment overflows the argument stack — a bug that only appears on the
 *  longest utterances, which is the worst kind to find in the field. */
export const pcmToBase64 = (pcm: Int16Array): string => {
	const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	let binary = "";
	const CHUNK = 0x8000;
	for (let at = 0; at < bytes.length; at += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
	}
	return btoa(binary);
};

export class Voice {
	mode: string = MODES.BYNAME;
	enabled = false;
	held = false;
	sent = 0;
	lastSegmentMs = 0;
	/** The browser's microphone. Always exists — it is the fallback for a page
	 *  with no glasses behind it, and the only one on a desktop. */
	readonly mic: MicSource;
	/** The glasses', when there is a bridge. Null in a plain browser. */
	readonly glasses: MicSource | null;

	#opts: VoiceOptions;
	/** True when the current capture was opened by a hold, so the release knows
	 *  whether closing it is its business. */
	#openedByHold = false;
	/** Which microphone is open (or was last opened). A release must close the
	 *  one the press opened, not whichever one is preferred by the time the
	 *  finger comes up — the glasses can go away mid-hold. */
	#current: MicSource | null = null;
	#heldSource: MicSource | null = null;

	constructor(opts: VoiceOptions) {
		this.#opts = opts;
		// One set of callbacks for both, which is the point: a segment is a
		// segment, and nothing downstream of #segment() can tell where it came
		// from. Level updates are frequent; they only repaint when the speech
		// flag flips, so a meter never costs a repaint per frame.
		const wiring = {
			segmenter: opts.segmenter,
			onSegment: (s: Segment) => this.#segment(s),
			onState: () => this.#changed(),
			onLevel: (_db: number, speaking: boolean) => { if (speaking !== this.#speaking) { this.#speaking = speaking; this.#changed(); } }
		};
		this.mic = opts.mic ?? new Microphone(wiring);
		this.glasses = opts.glasses
			?? (opts.glassesControl
				? new GlassesMicrophone({
					...wiring,
					control: opts.glassesControl,
					pageReady: opts.pageReady,
					onNote: (text) => this.#opts.onNote(text),
					// Every thirty seconds of captured audio, so a microphone left
					// open in a silent room still reports that it is open and how
					// much it has carried (R5b.4). Nothing repaints per frame.
					onProgress: () => this.#changed()
				})
				: null);
	}

	#speaking = false;

	/** The glasses' microphone whenever there is a host behind it, because a
	 *  microphone on the user's face is the one they meant; the browser's
	 *  otherwise, which is every desktop and every phone browser. */
	#preferred(): MicSource {
		return this.glasses && this.#opts.hostReady?.() !== false ? this.glasses : this.mic;
	}

	/** The microphone in use. Read-only — see #pick() for the version that is
	 *  allowed to switch. */
	get source(): MicSource { return this.#current ?? this.#preferred(); }

	/** What to call the microphone the user is speaking into. */
	get device(): string {
		if (this.source !== this.glasses) return "browser";
		return (this.glasses as { source?: string }).source ?? "glasses";
	}

	get status(): VoiceStatus {
		const source = this.source;
		return {
			enabled: this.enabled,
			live: source.live,
			held: this.held,
			speaking: this.#speaking && source.live,
			mic: source.state,
			detail: source.detail,
			sent: this.sent,
			lastSegmentMs: this.lastSegmentMs,
			device: this.device
		};
	}

	/**
	 * Choose the microphone for what is about to happen, and put the other one
	 * away.
	 *
	 * Called from every operation that opens or closes something, and from
	 * nowhere that only reads: switching sources CLOSES the one being left, and
	 * a getter with that side effect is a microphone that turns itself off when
	 * a status line is painted.
	 */
	#pick(): MicSource {
		const want = this.#preferred();
		if (this.#current && this.#current !== want) {
			// Whatever is open belongs to a device we are no longer using — most
			// likely glasses that were just taken off. Leaving it running is the
			// trust problem R5b.1 says is the worse of the two.
			this.#current.close("close");
		}
		this.#current = want;
		return want;
	}

	/** One AudioEvent from the bridge (PRD 5b R5b.1). */
	glassesFrame(frame: GlassesAudioFrame): void {
		(this.glasses as GlassesMicrophone | null)?.frame?.(frame);
	}

	#changed(): void { this.#opts.onChange(this.status); }

	/** True when this mode wants an open microphone at rest. */
	#wantsOpenMic(): boolean { return this.enabled && this.mode !== MODES.PUSHTOTALK; }

	/** The user's switch. Turning it on is the one place permission is asked
	 *  for (R5a.1), which is why it only ever happens from a control. */
	async setEnabled(on: boolean): Promise<void> {
		this.enabled = on;
		const source = this.#pick();
		if (!on) {
			this.held = false;
			this.#openedByHold = false;
			this.#heldSource = null;
			source.close("close");
		} else if (this.#wantsOpenMic()) {
			await source.open(false);
		}
		this.#changed();
	}

	/** The mode changed — from the companion's picker, or because the user said
	 *  so and the server told us. Switching INTO PushToTalk closes the
	 *  microphone immediately: that is the promise the mode makes, and making it
	 *  on the next utterance instead would be making it not at all. */
	async setMode(mode: string): Promise<void> {
		if (mode === this.mode) return;
		this.mode = mode;
		if (this.held) return;                      // a hold outranks the mode; the release will sort it out
		const source = this.#pick();
		if (this.#wantsOpenMic()) await source.open(false);
		else source.close("close");
		this.#changed();
	}

	/**
	 * Press. Unconditional, in every mode and on every device — see the header.
	 *
	 * PRD 5b routes the glasses touchpad here (R5b.3), and the requirement is
	 * the same one R5a.4 wrote for the button: nothing may gate it. Note what is
	 * NOT consulted below — not `enabled`, not the mode, not whether the lens
	 * page exists, not whether there is a socket. `#pick()` chooses a
	 * microphone, and the microphone chooses glasses-or-phone; neither can
	 * answer "no, not now".
	 */
	async holdStart(): Promise<void> {
		this.held = true;
		this.#changed();
		const source = this.#pick();
		if (source.live && !this.#openedByHold) return;   // already listening; the hold adds nothing
		this.#openedByHold = true;
		// Remembered, not looked up again at release: the glasses can be taken
		// off mid-hold, and the microphone that has to be closed is the one that
		// was opened.
		this.#heldSource = source;
		await source.open(true);
		this.#changed();
	}

	/** Release. The utterance ends here (R5a.3), which is what `close("release")`
	 *  flushes — the segment it returns is delivered through onSegment like any
	 *  other, so nothing downstream knows the difference. */
	holdEnd(): void {
		this.held = false;
		if (this.#openedByHold) {
			this.#openedByHold = false;
			(this.#heldSource ?? this.source).close("release");
			this.#heldSource = null;
		}
		this.#changed();
	}

	/**
	 * The app went to the background, or the glasses went away — PRD 5b R5b.1.
	 *
	 * "Audio must stop on exit, on backgrounding and on error. Leaving the
	 * microphone running on the hardware is both a battery problem and a trust
	 * problem, and the second one is worse." A held touchpad is released by
	 * this too: the user is not looking at it any more, and a hold that survived
	 * backgrounding would be an open microphone nobody is holding.
	 */
	suspend(reason: "release" | "close" = "close"): void {
		this.held = false;
		this.#openedByHold = false;
		const held = this.#heldSource;
		this.#heldSource = null;
		// Both, unconditionally, whatever this object believes is open. Belief is
		// exactly what a suspend cannot afford to rely on.
		held?.close(reason);
		this.mic.close(reason);
		this.glasses?.close(reason);
		this.#current = null;
		this.#changed();
	}

	/** Back to the front. Reopens only what the mode asks for, so coming back
	 *  in PushToTalk does not drop the user into an open microphone. */
	async resume(): Promise<void> {
		const source = this.#pick();
		if (this.#wantsOpenMic()) await source.open(false);
		this.#changed();
	}

	#segment(segment: Segment): void {
		this.lastSegmentMs = segment.durationMs;
		const ok = this.#opts.send(segment.pcm, { durationMs: segment.durationMs, reason: segment.reason });
		if (ok) this.sent++;
		else this.#opts.onNote("Heard you, but there was no connection to send it on.");
		this.#changed();
	}

	/** Everything down, for a page that is going away. */
	dispose(): void {
		this.enabled = false;
		this.suspend("close");
	}
}
