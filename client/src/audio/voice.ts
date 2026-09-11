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

import { Microphone } from "./capture.ts";
import type { MicState } from "./capture.ts";
import type { Segment, SegmenterOptions } from "./segment.ts";
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
	mic?: Microphone;
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
	readonly mic: Microphone;

	#opts: VoiceOptions;
	/** True when the current capture was opened by a hold, so the release knows
	 *  whether closing it is its business. */
	#openedByHold = false;

	constructor(opts: VoiceOptions) {
		this.#opts = opts;
		this.mic = opts.mic ?? new Microphone({
			segmenter: opts.segmenter,
			onSegment: (s) => this.#segment(s),
			onState: () => this.#changed(),
			// Level updates are frequent; they only repaint when the speech flag
			// flips, so a meter never costs a repaint per 20 ms frame.
			onLevel: (_db, speaking) => { if (speaking !== this.#speaking) { this.#speaking = speaking; this.#changed(); } }
		});
	}

	#speaking = false;

	get status(): VoiceStatus {
		return {
			enabled: this.enabled,
			live: this.mic.live,
			held: this.held,
			speaking: this.#speaking && this.mic.live,
			mic: this.mic.state,
			detail: this.mic.detail,
			sent: this.sent,
			lastSegmentMs: this.lastSegmentMs
		};
	}

	#changed(): void { this.#opts.onChange(this.status); }

	/** True when this mode wants an open microphone at rest. */
	#wantsOpenMic(): boolean { return this.enabled && this.mode !== MODES.PUSHTOTALK; }

	/** The user's switch. Turning it on is the one place permission is asked
	 *  for (R5a.1), which is why it only ever happens from a control. */
	async setEnabled(on: boolean): Promise<void> {
		this.enabled = on;
		if (!on) {
			this.held = false;
			this.#openedByHold = false;
			this.mic.close("close");
		} else if (this.#wantsOpenMic()) {
			await this.mic.open(false);
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
		if (this.#wantsOpenMic()) await this.mic.open(false);
		else this.mic.close("close");
		this.#changed();
	}

	/** Press. Unconditional, in every mode — see the header. */
	async holdStart(): Promise<void> {
		this.held = true;
		this.#changed();
		if (this.mic.live && !this.#openedByHold) return;   // already listening; the hold adds nothing
		this.#openedByHold = true;
		await this.mic.open(true);
		this.#changed();
	}

	/** Release. The utterance ends here (R5a.3), which is what `close("release")`
	 *  flushes — the segment it returns is delivered through onSegment like any
	 *  other, so nothing downstream knows the difference. */
	holdEnd(): void {
		this.held = false;
		if (this.#openedByHold) {
			this.#openedByHold = false;
			this.mic.close("release");
		}
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
		this.held = false;
		this.mic.close("close");
	}
}
