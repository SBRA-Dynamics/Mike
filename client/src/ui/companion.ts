// The companion view — R4.4.
//
// Plain DOM, built once and updated in place. No framework: the view is four
// regions and a pairing screen, and a dependency here would be the largest
// thing in the bundle by an order of magnitude.
//
// There are no settings. The one thing the phone has to be told is where the
// server is and what the token is, and that is read off the QR code the server
// prints — so when there is no connection the only thing on screen is the
// button that reads it, and when there is one there is nothing to configure.
// The addressing mode and the worker are changed by talking or typing, which
// is how they are changed from the glasses too.
//
// The lens preview is the point of this file. It renders THE SAME LensFrame the
// glasses are sent, in a box that is exactly fifty columns by ten rows, so a
// layout problem is visible on a desktop without wearing anything.

import { fitToKeyboard } from "./keyboard.ts";
import { after, cancel } from "../timers.ts";
import type { Timer } from "../timers.ts";
import { LENS } from "../lens/render.ts";
import type { LensFrame } from "../lens/render.ts";
import { MODES } from "../../../src/routing.js";
import type { AppState, ListeningState } from "../state.ts";
import { thinkingText } from "../state.ts";

/** How long the first press on "Forget this server" waits for the second. */
const FORGET_ARM_MS = 4000;

export type CompanionActions = {
	say: (text: string) => boolean;
	interrupt: () => void;
	/** Read the server's link off a QR code. The view hands over the elements
	 *  a browser scanner needs; the camera and the decoding belong to qr.ts.
	 *  Pressed while a scan is running, it stops the scan. */
	scanQr: (ui: { video: HTMLVideoElement; canvas: HTMLCanvasElement; show: (on: boolean) => void }) => void;
	/** The same code, out of the photo library instead of the camera. A picture
	 *  of a screen is the hardest thing to hand a QR decoder — moire, focus,
	 *  glare, a code a few pixels a module wide — and a screenshot has none of
	 *  those problems. Only useful where a host picker exists. */
	pickQr: () => void;
	/** The microphone switch — PRD 5a R5a.1. The only thing that asks for
	 *  permission, because it is the only thing the user touched. */
	setMic: (on: boolean) => void;
	/** Press and release of the hold-to-talk control (R5a.4). */
	holdStart: () => void;
	holdEnd: () => void;
	/** Which server the phone is paired with, as a host for a human — or ""
	 *  when there is none. */
	pairedWith: () => string;
	/** Forget the server: token, address and session go, the connection is
	 *  closed, and the pairing screen comes back. The only way to leave a
	 *  server short of reinstalling the app, and therefore the only way to
	 *  move to another one. */
	forget: () => void;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text) n.textContent = text;
	return n;
};

/** Stamped in at build time (vite.config.ts), same as in main.ts: the bar says
 *  which build the phone is actually running, where it can be read out loud. */
declare const __MIKE_VERSION__: string;
const VERSION = typeof __MIKE_VERSION__ === "string" ? __MIKE_VERSION__ : "dev";

const STATUS_TEXT: Record<string, string> = {
	idle: "idle",
	connecting: "connecting…",
	online: "online",
	offline: "reconnecting…",
	fatal: "stopped"
};

/** R5a.8's four states, in the words the user reads. "heard" carries what was
 *  understood next to it, because seeing the words back is the whole point. */
const LISTENING_TEXT: Record<ListeningState, string> = {
	idle: "idle",
	listening: "listening",
	heard: "heard",
	holding: "still listening",
	queued: "queued",
	thinking: "thinking"
};

export class Companion {
	#actions: CompanionActions;
	#rows: HTMLDivElement[] = [];
	#nodes: Record<string, HTMLElement> = {};
	#input!: HTMLInputElement;
	#lensBox!: HTMLDivElement;
	/** Whether the microphone switch is currently on, so the button can toggle
	 *  it without the view reaching back into the store. */
	#micOn = false;
	/** What the transcript was last rendered from, so a state change that did
	 *  not touch it does not rebuild a few hundred nodes. */
	#renderedEntries = -1;
	#renderedLast = "";

	constructor(root: HTMLElement, actions: CompanionActions) {
		this.#actions = actions;
		// The pairing screen is first in the tree and covers the rest while it
		// is up: with no server there is nothing behind it worth showing.
		root.replaceChildren(this.#buildPairing(), this.#buildBar(), this.#buildServerRow(), this.#buildNotice(), this.#buildLens(), this.#buildTranscript(),
			this.#buildLastEvent(), this.#buildVoice(), this.#buildComposer());
		// The keyboard takes the bottom of the screen, where the composer is.
		// A transcript that was showing its newest line keeps showing it
		// across the shrink, the same rule render() applies to a new entry.
		let atEnd = false;
		fitToKeyboard(root, {
			before: () => { atEnd = this.#transcriptAtEnd(); },
			after: () => { if (atEnd) this.#nodes.transcript.scrollTop = this.#nodes.transcript.scrollHeight; }
		});
	}

	// ------------------------------------------------------------------ build

	#buildBar(): HTMLElement {
		const bar = el("header", "bar");
		const dot = el("span", "dot");
		const title = el("h1", "", "Mike");
		const status = el("span", "chip");
		const worker = el("span", "chip worker");
		const glasses = el("span", "chip");
		const version = el("span", "chip version", `v${VERSION}`);
		// Before the status chip, never after it: the transport status is the
		// last thing in the bar and one test reads it as ":last-child".
		const listening = el("span", "chip listening");
		bar.append(dot, title, el("span", "spacer"), worker, listening, glasses, version, status);
		// The transport chip is also the way to the server row: the one place
		// the server is named is the one place it can be left. A chip and not
		// a button, so the bar keeps its shape and the test its ":last-child".
		status.classList.add("tappable");
		status.setAttribute("role", "button");
		status.tabIndex = 0;
		status.title = "Server";
		status.addEventListener("click", () => this.#toggleServerRow());
		status.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.#toggleServerRow(); } });
		Object.assign(this.#nodes, { dot, status, worker, glasses, listening, version });
		return bar;
	}

	/** Under the bar, on request: which server this is, and the way to leave
	 *  it. Hidden by default and whenever the pairing screen is up, because
	 *  there is nothing to leave then. */
	#buildServerRow(): HTMLElement {
		const row = el("div", "serverrow");
		row.hidden = true;
		const text = el("span", "serverhost");
		const forget = el("button", "forget", "Forget this server");
		// Two presses, four seconds apart at most. The cost of a mistake is a
		// rescan, which is small, but a thumb on a phone in a pocket should not
		// be able to pay it; a second deliberate press is the right price.
		forget.addEventListener("click", () => {
			if (!this.#forgetArmed) {
				this.#forgetArmed = true;
				forget.textContent = "Tap again to forget";
				forget.classList.add("armed");
				cancel(this.#forgetTimer);
				this.#forgetTimer = after(() => this.#disarmForget(), FORGET_ARM_MS);
				return;
			}
			this.#disarmForget();
			row.hidden = true;
			this.#actions.forget();
		});
		row.append(text, el("span", "spacer"), forget);
		Object.assign(this.#nodes, { serverRow: row, serverHost: text, forget });
		return row;
	}

	#forgetArmed = false;
	#forgetTimer: Timer | null = null;

	#disarmForget(): void {
		cancel(this.#forgetTimer);
		this.#forgetTimer = null;
		this.#forgetArmed = false;
		const b = this.#nodes.forget;
		if (b) { b.textContent = "Forget this server"; b.classList.remove("armed"); }
	}

	#toggleServerRow(): void {
		const row = this.#nodes.serverRow;
		if (!row) return;
		if (!row.hidden) { row.hidden = true; this.#disarmForget(); return; }
		const host = this.#actions.pairedWith();
		if (!host) return;
		this.#nodes.serverHost.textContent = `Paired with ${host}.`;
		row.hidden = false;
	}

	/** Standing notices — "no glasses", "no token". Deliberately NOT part of the
	 *  transcript: a history read replaces that wholesale, and R4.6's "say so
	 *  once" would then be said once and immediately erased. */
	#buildNotice(): HTMLElement {
		const n = el("div", "notice");
		n.hidden = true;
		this.#nodes.notice = n;
		return n;
	}

	#buildLens(): HTMLElement {
		const wrap = el("section", "lenswrap");
		const caption = el("div", "caption");
		const left = el("span", "", "lens preview");
		const right = el("span", "");
		caption.append(left, right);

		const box = el("div", "lens");
		for (let i = 0; i < LENS.rows; i++) {
			const row = el("div", i === 0 ? "row header" : "row");
			// A non-breaking space keeps an empty row exactly one row tall, so the
			// box is always ten rows — which is half of acceptance criterion 2.
			row.textContent = " ";
			this.#rows.push(row);
			box.append(row);
		}
		this.#lensBox = box;
		this.#nodes.lensCaption = right;
		wrap.append(caption, box);
		return wrap;
	}

	#buildTranscript(): HTMLElement {
		const t = el("div", "transcript");
		this.#nodes.transcript = t;
		return t;
	}

	#buildLastEvent(): HTMLElement {
		const n = el("div", "lastevent");
		this.#nodes.lastEvent = n;
		return n;
	}

	#buildComposer(): HTMLElement {
		const form = el("form", "composer");
		const input = el("input");
		input.type = "text";
		input.placeholder = "Say something to Mike…";
		input.autocomplete = "off";
		// Dictation on a phone keyboard capitalises and punctuates; the server
		// folds that away (routing.js), so nothing is done to it here.
		input.autocapitalize = "sentences";
		const send = el("button", "primary", "Send");
		send.type = "submit";
		const stop = el("button", "", "Stop");
		stop.type = "button";
		stop.title = "Interrupt the current turn";

		form.addEventListener("submit", (e) => {
			e.preventDefault();
			const text = input.value.trim();
			if (!text) return;
			// The text stays in the box when the send fails. An utterance that is
			// silently dropped because the socket was down is the worst outcome
			// available, and a queue that fires four minutes later is the second.
			if (this.#actions.say(text)) input.value = "";
		});
		stop.addEventListener("click", () => this.#actions.interrupt());

		this.#input = input;
		this.#nodes.send = send;
		form.append(input, send, stop);
		return form;
	}

	/** The voice row — PRD 5a.
	 *
	 *  Two controls, because they are two different promises. The switch opens
	 *  the microphone and leaves it open, which is what the first three modes
	 *  mean; the hold opens it for exactly as long as it is held, which is what
	 *  PushToTalk means. The hold is NEVER disabled — not while offline, not
	 *  while a turn is running, not while the switch is off — because in
	 *  PushToTalk it is the only way to speak a mode command back out (R5a.4).
	 */
	#buildVoice(): HTMLElement {
		const row = el("div", "voice");

		const mic = el("button", "mic", "Microphone");
		mic.type = "button";
		mic.addEventListener("click", () => this.#actions.setMic(!this.#micOn));

		const talk = el("button", "talk", "Hold to talk");
		talk.type = "button";
		// Pointer events rather than mouse/touch: one code path for a finger, a
		// mouse and a stylus, and `setPointerCapture` means a press that drifts
		// off the button still releases here rather than sticking down forever.
		talk.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			try { talk.setPointerCapture((e as PointerEvent).pointerId); } catch { /* no capture available */ }
			this.#actions.holdStart();
		});
		const release = () => this.#actions.holdEnd();
		for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) talk.addEventListener(type, release);
		// A keyboard has to be able to hold too, or the control is unreachable
		// for anyone not using a pointer. `repeat` is the auto-repeat a held key
		// produces, which would otherwise open the microphone fifty times.
		talk.addEventListener("keydown", (e) => {
			const k = e as KeyboardEvent;
			if (k.repeat || (k.key !== " " && k.key !== "Enter")) return;
			k.preventDefault();
			this.#actions.holdStart();
		});
		talk.addEventListener("keyup", (e) => {
			const k = e as KeyboardEvent;
			if (k.key !== " " && k.key !== "Enter") return;
			release();
		});
		// The browser's own click-from-Space would fire a second time after the
		// keyup above; there is nothing for it to do.
		talk.addEventListener("click", (e) => e.preventDefault());

		const note = el("span", "note voicenote");
		row.append(mic, talk, note);
		Object.assign(this.#nodes, { mic, talk, voicenote: note });
		return row;
	}

	/**
	 * The only way in: a QR button, alone in the middle of the screen, shown
	 * whenever there is no server to talk to.
	 *
	 * Typing a host and a 64-character token on a phone was the worst input
	 * this app asked for — the field hid behind the keyboard, and one wrong
	 * character read as "unauthorized" with nothing to say which one — and it
	 * was the only thing the settings drawer was for. So the drawer is gone and
	 * this is what is left of it.
	 *
	 * In a plain browser the scanner needs a video element to read from; it is
	 * here, hidden until a scan is running, and the same button stops it. In
	 * the Even App the host's camera picker is used and none of that shows.
	 */
	#buildPairing(): HTMLElement {
		const screen = el("section", "pairing");
		screen.hidden = true;
		const card = el("div", "card");
		card.append(el("h2", "", "Mike"));
		// The build that is actually running, under the title where it cannot be
		// missed. The status bar already carries a version chip, but the pairing
		// screen covers the status bar — so the one moment the version matters
		// most, when a scan will not take and the question is whether the phone
		// is even running the build you just made, is the one moment it was
		// invisible.
		card.append(el("p", "build", `v${VERSION}`));
		const why = el("p", "why");
		const scan = el("button", "primary scan", "Scan QR");
		scan.type = "button";
		const hint = el("p", "hint", "Point the camera at the code the server printed.");
		const pick = el("button", "pick", "Choose a photo instead");
		pick.type = "button";
		pick.addEventListener("click", () => this.#actions.pickQr());
		const video = el("video", "scanvideo") as HTMLVideoElement;
		video.hidden = true;
		const canvas = el("canvas") as HTMLCanvasElement;
		canvas.hidden = true;
		scan.addEventListener("click", () => this.#actions.scanQr({
			video, canvas,
			show: (on) => { video.hidden = !on; scan.textContent = on ? "Stop scanning" : "Scan QR"; }
		}));
		// Where note() is actually readable while unpaired. The notice bar lives
		// in the normal flow and this screen is a fixed opaque overlay above it,
		// so every word the scan path writes — "No picture taken", "No QR code
		// in that picture", "Scanned … Connecting…" — was being written behind
		// this. Pressing the button looked like it did nothing whatever went
		// wrong, which is the one thing a diagnostic message must never do.
		const scanNote = el("p", "scannote");
		scanNote.hidden = true;
		card.append(why, scan, hint, pick, scanNote, video, canvas);
		screen.append(card);
		Object.assign(this.#nodes, { pairing: screen, pairingWhy: why, pairingNote: scanNote });
		return screen;
	}

	// ----------------------------------------------------------------- render

	render(state: AppState, frame: LensFrame, listening: ListeningState = "idle", pairing = false): void {
		const n = this.#nodes;
		// Over everything, or nowhere. The reason is said in one line, because
		// "no token" and "the server has been unreachable for a while" want
		// different things done about them even though the button is the same.
		n.pairing.hidden = !pairing;
		if (pairing && n.serverRow && !n.serverRow.hidden) { n.serverRow.hidden = true; this.#disarmForget(); }
		if (pairing) {
			n.pairingWhy.textContent = state.connection === "fatal"
				? (state.connectionDetail === "no token" ? "Not paired with a server yet." : `The server refused this phone: ${state.connectionDetail}.`)
				: `No connection to the server (${state.connectionDetail || "reconnecting"}).`;
		}

		n.dot.className = `dot ${state.connection}`;
		n.status.textContent = state.connection === "fatal"
			? `stopped: ${state.connectionDetail}`
			: STATUS_TEXT[state.connection] ?? state.connection;
		n.status.classList.toggle("warn", state.connection === "fatal" || state.connection === "offline");

		n.worker.textContent = state.worker ? `▸ ${state.worker}` : "▸ Mike";
		n.glasses.textContent = state.glasses === "attached" ? "glasses" : "companion only";
		n.glasses.classList.toggle("warn", state.glasses !== "attached");

		// The preview. Exactly the frame the glasses were sent — same wrapping,
		// same header, same page.
		for (let i = 0; i < this.#rows.length; i++) {
			const line = frame.lines[i] ?? "";
			this.#rows[i].textContent = line === "" ? " " : line;
		}
		this.#lensBox.classList.toggle("stale", state.connection !== "online");
		n.lensCaption.textContent = frame.pages > 1
			? `${frame.page + 1}/${frame.pages} — tap or swipe for more`
			: `${LENS.cols}×${LENS.rows}`;

		this.#renderVoice(state, listening);
		this.#renderTranscript(state);

		n.lastEvent.textContent = state.lastEvent ? `Last: ${state.lastEvent}` : "";
		(this.#nodes.send as HTMLButtonElement).disabled = state.connection !== "online";
		this.#input.disabled = state.connection === "fatal";
	}

	/** The microphone, said plainly — R5a.8's four states, and whether capture
	 *  is live RIGHT NOW, which R5a.4 asks for separately because a hold-to-talk
	 *  the user cannot confirm is listening is one they will speak into and
	 *  lose. */
	#renderVoice(state: AppState, listening: ListeningState): void {
		const n = this.#nodes;
		const v = state.voice;
		this.#micOn = !!v?.enabled;

		n.listening.textContent = listening === "heard" && state.heard
			? `heard: ${state.heard.text.slice(0, 40)}`
			: listening === "thinking"
				? thinkingText(state.busySince, Date.now(), state.progress?.tool ?? null)
				: LISTENING_TEXT[listening];
		n.listening.classList.toggle("live", listening === "listening" || listening === "heard" || listening === "holding");
		n.listening.classList.toggle("speaking", !!v?.speaking);

		const mic = n.mic as HTMLButtonElement;
		mic.textContent = v?.enabled ? "Microphone on" : "Microphone off";
		mic.classList.toggle("on", !!v?.enabled);
		// A refused permission is a state the user has to be able to see: the
		// button looking "off" after they pressed it would read as a bug.
		mic.classList.toggle("denied", v?.mic === "denied");

		const talk = n.talk as HTMLButtonElement;
		talk.classList.toggle("held", !!v?.held);
		// Never disabled. See #buildVoice.
		talk.disabled = false;

		// PRD 5b R5b.1: which microphone is open is part of what is being
		// promised. "Everything spoken in the room reaches a model" means
		// something different when the microphone is on the user's face, and a
		// user who cannot see which one is open cannot know which promise they
		// made.
		const where = !v || v.device === "browser" ? "" : ` — ${v.device} microphone`;
		n.voicenote.textContent = v?.mic === "denied"
			? (v.device === "browser"
				? "The browser refused the microphone. Allow it for this page and press again."
				: `The Even App refused the ${v.device} microphone. Check the app's permissions and press again.`)
			: v?.mic === "error"
				? `Microphone: ${v.detail}`
				: v?.live
					? (v.held ? `Capturing while held${where}.` : `Capturing${where}.`)
					: state.mode === MODES.PUSHTOTALK
						? "Microphone off — hold to talk."
						: "";
	}

	/** Showing its newest line, give or take a couple of rows — the reader's
	 *  position is theirs, and only a reader at the end is following along. */
	#transcriptAtEnd(): boolean {
		const box = this.#nodes.transcript;
		return box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
	}

	#renderTranscript(state: AppState): void {
		const last = state.transcript[state.transcript.length - 1];
		const signature = last ? `${last.seq}:${last.text.length}` : "";
		if (state.transcript.length === this.#renderedEntries && signature === this.#renderedLast) return;
		this.#renderedEntries = state.transcript.length;
		this.#renderedLast = signature;

		const box = this.#nodes.transcript;
		const atBottom = this.#transcriptAtEnd();
		box.replaceChildren(...state.transcript.map((e) => {
			const node = el("div", `entry ${e.kind}`);
			node.append(el("div", "who", e.from), el("div", "what", e.text));
			return node;
		}));
		// Only follow when the user was already at the bottom: yanking the view
		// down while they are reading something further up is the standard way
		// to make a transcript unusable.
		if (atBottom) box.scrollTop = box.scrollHeight;
	}

	/** Said once, and left standing until something replaces it — R4.6. */
	note(text: string): void {
		const n = this.#nodes.notice;
		n.textContent = text;
		n.hidden = !text;
		// And on the pairing screen, which covers the one above. Both, rather
		// than moving it: once paired the notice bar is the right place for
		// "no glasses", and the overlay is not there to be written to.
		const p = this.#nodes.pairingNote;
		if (p) { p.textContent = text; p.hidden = !text; }
	}

	focusInput(): void { try { this.#input.focus(); } catch { /* not focusable yet */ } }
}
