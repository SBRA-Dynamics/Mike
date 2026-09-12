// The companion view — R4.4.
//
// Plain DOM, built once and updated in place. No framework: the view is four
// regions and a drawer, and a dependency here would be the largest thing in the
// bundle by an order of magnitude.
//
// The lens preview is the point of this file. It renders THE SAME LensFrame the
// glasses are sent, in a box that is exactly fifty columns by ten rows, so a
// layout problem is visible on a desktop without wearing anything.

import { LENS } from "../lens/render.ts";
import type { LensFrame } from "../lens/render.ts";
import { MODES, MODE_LABEL } from "../../../src/routing.js";
import type { AppState, ListeningState } from "../state.ts";
import { thinkingText } from "../state.ts";

export type CompanionActions = {
	say: (text: string) => boolean;
	interrupt: () => void;
	setMode: (mode: string) => void;
	switchWorker: (name: string | null) => void;
	whoIs: () => void;
	reconnect: () => void;
	newSession: () => void;
	saveSettings: (patch: { token?: string; server?: string }) => void;
	/** Read the server's link off a QR code instead of typing it. The view
	 *  hands over the elements; the camera and the decoding belong to qr.ts. */
	scanQr: (ui: { video: HTMLVideoElement; canvas: HTMLCanvasElement; show: (on: boolean) => void }) => void;
	cancelScan: () => void;
	/** The microphone switch — PRD 5a R5a.1. The only thing that asks for
	 *  permission, because it is the only thing the user touched. */
	setMic: (on: boolean) => void;
	/** Press and release of the hold-to-talk control (R5a.4). */
	holdStart: () => void;
	holdEnd: () => void;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text) n.textContent = text;
	return n;
};

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
	thinking: "thinking"
};

/** R5a.2, said rather than discovered: a laptop microphone cannot tell the
 *  wearer from the room, so the addressing mode carries the entire burden — and
 *  `Always` here means every word spoken in the room reaches a model. */
const MODE_NOTE: Record<string, string> = {
	[MODES.IGNORE]: "Listening, and dropping everything except the mode commands.",
	[MODES.BYNAME]: "Only what starts with “Jarvis” or the worker’s name is sent on.",
	[MODES.ALWAYS]: "Everything spoken in the room reaches a model. A desk microphone cannot tell you from the room.",
	[MODES.PUSHTOTALK]: "The microphone is off until you hold the button."
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
		root.replaceChildren(this.#buildBar(), this.#buildNotice(), this.#buildLens(), this.#buildTranscript(),
			this.#buildLastEvent(), this.#buildVoice(), this.#buildComposer(), this.#buildSettings());
	}

	// ------------------------------------------------------------------ build

	#buildBar(): HTMLElement {
		const bar = el("header", "bar");
		const dot = el("span", "dot");
		const title = el("h1", "", "Jarvis");
		const status = el("span", "chip");
		const worker = el("span", "chip worker");
		const glasses = el("span", "chip");
		// Before the status chip, never after it: the transport status is the
		// last thing in the bar and one test reads it as ":last-child".
		const listening = el("span", "chip listening");
		bar.append(dot, title, el("span", "spacer"), worker, listening, glasses, status);
		Object.assign(this.#nodes, { dot, status, worker, glasses, listening });
		return bar;
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
		input.placeholder = "Say something to Jarvis…";
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

	#buildSettings(): HTMLElement {
		const d = el("details", "settings");
		// A field the keyboard covers is a field nobody can check what they typed
		// in. The panel sits at the bottom of a column layout, so opening the
		// keyboard slides it out of view entirely — scrolling the focused row
		// into the middle of what is left is the whole fix.
		const keepVisible = (e: Event) => {
			const t = e.target as HTMLElement | null;
			setTimeout(() => t?.scrollIntoView({ block: "center", behavior: "smooth" }), 250);
		};
		d.addEventListener("focusin", keepVisible);
		d.addEventListener("toggle", () => { if (d.open) setTimeout(() => d.scrollIntoView({ block: "end", behavior: "smooth" }), 50); });
		const summary = el("summary", "", "Settings");
		const body = el("div", "body");

		const modeRow = el("div", "row");
		modeRow.append(el("span", "note", "Input"));
		// Its own class: the settings body grows selects, and "the first one" is
		// not a thing a test — or a future reader — should have to depend on.
		const mode = el("select", "modeselect");
		for (const m of Object.values(MODES)) {
			const o = el("option", "", `${m} — ${MODE_LABEL[m]}`);
			o.value = m;
			mode.append(o);
		}
		mode.addEventListener("change", () => this.#actions.setMode(mode.value));
		modeRow.append(mode);
		const modeNote = el("div", "note modenote");

		const workerRow = el("div", "row");
		workerRow.append(el("span", "note", "Talking to"));
		const worker = el("select");
		worker.addEventListener("change", () => this.#actions.switchWorker(worker.value || null));
		const whoIs = el("button", "", "id");
		whoIs.type = "button";
		whoIs.title = "Ask for the Claude Code resume command";
		whoIs.addEventListener("click", () => this.#actions.whoIs());
		workerRow.append(worker, whoIs);

		const serverWrap = el("div");
		serverWrap.append(el("label", "", "Server (blank = this one)"));
		const serverRow = el("div", "row");
		const server = el("input");
		server.type = "text";
		server.placeholder = "wss://host:3460/ws";
		const token = el("input");
		token.type = "password";
		token.placeholder = "token";
		const apply = el("button", "", "Apply");
		apply.type = "button";
		apply.addEventListener("click", () => this.#actions.saveSettings({ server: server.value.trim(), token: token.value.trim() }));
		serverRow.append(server, token, apply);

		// The way in that needs no keyboard. Typing a host and a 64-character
		// token on a phone is the worst input this app asks for — the field
		// hides behind the keyboard, and one wrong character reads as
		// "unauthorized" with nothing to say which one.
		const scanRow = el("div", "row scanrow");
		const scan = el("button", "", "Scan QR");
		scan.type = "button";
		const scanNote = el("div", "note", "Point it at the link the server printed.");
		scanRow.append(scan, scanNote);

		const shot = el("div", "scanner");
		shot.hidden = true;
		const video = el("video", "scanvideo") as HTMLVideoElement;
		const canvas = el("canvas") as HTMLCanvasElement;
		canvas.hidden = true;
		const cancel = el("button", "", "Cancel");
		cancel.type = "button";
		shot.append(video, canvas, cancel);

		scan.addEventListener("click", () => this.#actions.scanQr({ video, canvas, show: (on) => { shot.hidden = !on; } }));
		cancel.addEventListener("click", () => this.#actions.cancelScan());

		serverWrap.append(serverRow, scanRow, shot);

		const actions = el("div", "row");
		const reconnect = el("button", "", "Reconnect");
		reconnect.type = "button";
		reconnect.addEventListener("click", () => this.#actions.reconnect());
		const fresh = el("button", "", "New conversation");
		fresh.type = "button";
		fresh.addEventListener("click", () => this.#actions.newSession());
		actions.append(reconnect, fresh);

		// Its own class: the settings body has several `.note` labels, and "the
		// third span" is not a thing anything should depend on.
		const info = el("div", "note info");
		body.append(modeRow, modeNote, workerRow, serverWrap, actions, info);
		d.append(summary, body);

		Object.assign(this.#nodes, { mode, modeNote, workerSelect: worker, server, token, info });
		return d;
	}

	// ----------------------------------------------------------------- render

	render(state: AppState, frame: LensFrame, listening: ListeningState = "idle"): void {
		const n = this.#nodes;

		n.dot.className = `dot ${state.connection}`;
		n.status.textContent = state.connection === "fatal"
			? `stopped: ${state.connectionDetail}`
			: STATUS_TEXT[state.connection] ?? state.connection;
		n.status.classList.toggle("warn", state.connection === "fatal" || state.connection === "offline");

		n.worker.textContent = state.worker ? `▸ ${state.worker}` : "▸ Jarvis";
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
		(n.mode as HTMLSelectElement).value = state.mode;
		n.modeNote.textContent = MODE_NOTE[state.mode] ?? "";
		this.#renderWorkers(state);

		(this.#nodes.send as HTMLButtonElement).disabled = state.connection !== "online";
		this.#input.disabled = state.connection === "fatal";

		n.info.textContent = state.sessionId
			? `session ${state.sessionId.slice(0, 8)} · ${state.connectionDetail}`
			: state.connectionDetail;
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
		n.listening.classList.toggle("live", listening === "listening" || listening === "heard");
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

	#renderTranscript(state: AppState): void {
		const last = state.transcript[state.transcript.length - 1];
		const signature = last ? `${last.seq}:${last.text.length}` : "";
		if (state.transcript.length === this.#renderedEntries && signature === this.#renderedLast) return;
		this.#renderedEntries = state.transcript.length;
		this.#renderedLast = signature;

		const box = this.#nodes.transcript;
		const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
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

	#renderWorkers(state: AppState): void {
		const select = this.#nodes.workerSelect as HTMLSelectElement;
		const names = state.workers.map((w) => w.name);
		const wanted = ["", ...names].join(" ");
		if (select.dataset.names !== wanted) {
			select.dataset.names = wanted;
			select.replaceChildren();
			const jarvis = el("option", "", "Jarvis");
			jarvis.value = "";
			select.append(jarvis);
			for (const w of state.workers) {
				const o = el("option", "", w.model ? `${w.name} (${w.model})` : w.name);
				o.value = w.name;
				select.append(o);
			}
		}
		select.value = state.worker ?? "";
	}

	/** Said once, and left standing until something replaces it — R4.6. */
	note(text: string): void {
		const n = this.#nodes.notice;
		n.textContent = text;
		n.hidden = !text;
	}

	/** The settings panel is prefilled from storage, once, at startup. */
	fillSettings(server: string, token: string): void {
		(this.#nodes.server as HTMLInputElement).value = server;
		(this.#nodes.token as HTMLInputElement).value = token;
	}

	focusInput(): void { try { this.#input.focus(); } catch { /* not focusable yet */ } }
}
