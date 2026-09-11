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
import type { AppState } from "../state.ts";

export type CompanionActions = {
	say: (text: string) => boolean;
	interrupt: () => void;
	setMode: (mode: string) => void;
	switchWorker: (name: string | null) => void;
	whoIs: () => void;
	reconnect: () => void;
	newSession: () => void;
	saveSettings: (patch: { token?: string; server?: string }) => void;
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

export class Companion {
	#actions: CompanionActions;
	#rows: HTMLDivElement[] = [];
	#nodes: Record<string, HTMLElement> = {};
	#input!: HTMLInputElement;
	#lensBox!: HTMLDivElement;
	/** What the transcript was last rendered from, so a state change that did
	 *  not touch it does not rebuild a few hundred nodes. */
	#renderedEntries = -1;
	#renderedLast = "";

	constructor(root: HTMLElement, actions: CompanionActions) {
		this.#actions = actions;
		root.replaceChildren(this.#buildBar(), this.#buildNotice(), this.#buildLens(), this.#buildTranscript(),
			this.#buildLastEvent(), this.#buildComposer(), this.#buildSettings());
	}

	// ------------------------------------------------------------------ build

	#buildBar(): HTMLElement {
		const bar = el("header", "bar");
		const dot = el("span", "dot");
		const title = el("h1", "", "Jarvis");
		const status = el("span", "chip");
		const worker = el("span", "chip worker");
		const glasses = el("span", "chip");
		bar.append(dot, title, el("span", "spacer"), worker, glasses, status);
		Object.assign(this.#nodes, { dot, status, worker, glasses });
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

	#buildSettings(): HTMLElement {
		const d = el("details", "settings");
		const summary = el("summary", "", "Settings");
		const body = el("div", "body");

		const modeRow = el("div", "row");
		modeRow.append(el("span", "note", "Input"));
		const mode = el("select");
		for (const m of Object.values(MODES)) {
			const o = el("option", "", `${m} — ${MODE_LABEL[m]}`);
			o.value = m;
			mode.append(o);
		}
		mode.addEventListener("change", () => this.#actions.setMode(mode.value));
		modeRow.append(mode);

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
		serverWrap.append(serverRow);

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
		body.append(modeRow, workerRow, serverWrap, actions, info);
		d.append(summary, body);

		Object.assign(this.#nodes, { mode, workerSelect: worker, server, token, info });
		return d;
	}

	// ----------------------------------------------------------------- render

	render(state: AppState, frame: LensFrame): void {
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

		this.#renderTranscript(state);

		n.lastEvent.textContent = state.lastEvent ? `Last: ${state.lastEvent}` : "";
		(n.mode as HTMLSelectElement).value = state.mode;
		this.#renderWorkers(state);

		(this.#nodes.send as HTMLButtonElement).disabled = state.connection !== "online";
		this.#input.disabled = state.connection === "fatal";

		n.info.textContent = state.sessionId
			? `session ${state.sessionId.slice(0, 8)} · ${state.connectionDetail}`
			: state.connectionDetail;
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
