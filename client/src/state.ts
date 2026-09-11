// One model, two faces — PRD 4's opening line.
//
// The lens and the companion both render from this object and nothing else, so
// "they cannot disagree about what was said" is a structural property rather
// than a thing to remember. Pure, like the renderer: it takes protocol messages
// in and calls subscribers out, and knows nothing about sockets, the DOM or the
// SDK.

import { MODE_LABEL, MODES } from "../../src/routing.js";
import type { ConnectionStatus } from "./connection.ts";
import type { EventMsg, ReadyMsg, SeqMsg, WorkerInfo } from "./protocol.ts";

/** A line of transcript. `kind` is what the companion styles by; `from` is what
 *  both faces label with, and is the server's `from` wherever there is one. */
export type Entry = {
	seq: number;
	from: string;
	text: string;
	kind: "said" | "text" | "error" | "note";
	at: number;
};

export type LensItem = { from: string; text: string; page: number };

export type AppState = {
	connection: ConnectionStatus;
	connectionDetail: string;
	sessionId: string | null;
	worker: string | null;
	mode: string;
	busy: boolean;
	workers: WorkerInfo[];
	transcript: Entry[];
	/** What Jarvis last did — R4.4. The `event` stream in one sentence. */
	lastEvent: string | null;
	lens: LensItem;
	/** Set once, by the SDK layer, so the companion can say "no glasses" honestly. */
	glasses: "unknown" | "attached" | "absent";
	/** Answers to the listSessions control, for the settings panel. */
	sessions: { id: string; title: string; updatedAt: number }[];
};

/** How many lines of transcript the companion keeps. A phone that has been
 *  open all day should not hold a week of conversation in memory. */
const TRANSCRIPT_LIMIT = 400;

const JARVIS = "Jarvis";

export class Store {
	state: AppState = {
		connection: "idle",
		connectionDetail: "",
		sessionId: null,
		worker: null,
		mode: MODES.BYNAME,
		busy: false,
		workers: [],
		transcript: [],
		lastEvent: null,
		lens: { from: JARVIS, text: "Connecting…", page: 0 },
		glasses: "unknown",
		sessions: []
	};

	#subs = new Set<(s: AppState) => void>();
	#localSeq = 0;

	subscribe(fn: (s: AppState) => void): () => void {
		this.#subs.add(fn);
		return () => this.#subs.delete(fn);
	}

	/** Every mutation ends here. One notify per message, not per field, so a
	 *  turn that changes worker and busy together repaints the lens once. */
	notify(): void { for (const fn of [...this.#subs]) fn(this.state); }

	// ------------------------------------------------------------ connection

	setConnection(status: ConnectionStatus, detail: string): void {
		this.state.connection = status;
		this.state.connectionDetail = detail;
		this.notify();
	}

	setGlasses(glasses: AppState["glasses"]): void {
		this.state.glasses = glasses;
		this.notify();
	}

	applyReady(ready: ReadyMsg): void {
		this.state.sessionId = ready.sessionId;
		this.state.worker = ready.worker ?? null;
		this.state.mode = ready.mode ?? this.state.mode;
		this.state.workers = ready.workers ?? [];
		this.notify();
	}

	/** A transcript read back from the server replaces ours wholesale. Merging
	 *  would mean guessing which of two orderings is true; the server's log is
	 *  the one that survived the restart. */
	applyHistory(messages: SeqMsg[]): void {
		this.state.transcript = [];
		for (const m of messages) this.#reduce(m);
		this.state.transcript = this.state.transcript.slice(-TRANSCRIPT_LIMIT);
		this.notify();
	}

	apply(m: SeqMsg): void {
		this.#reduce(m);
		this.state.transcript = this.state.transcript.slice(-TRANSCRIPT_LIMIT);
		this.notify();
	}

	/** The user's own typed line, shown immediately. It carries no seq — the
	 *  server does not echo `say` back, so this is the only record of it, and
	 *  giving it a fake sequence number would corrupt the cursor. */
	applyLocal(text: string): void {
		this.state.transcript.push({ seq: -(++this.#localSeq), from: "you", text, kind: "said", at: Date.now() });
		this.notify();
	}

	// ----------------------------------------------------------------- lens

	/** Paging through a long reply (R4.3). Returns true when the page moved, so
	 *  a gesture that changed nothing can be answered differently from one that
	 *  did — tapping past the last page repeats instead of sitting still. */
	turnPage(delta: number, pages: number): boolean {
		const next = this.state.lens.page + delta;
		if (next < 0 || next >= pages) return false;
		this.state.lens.page = next;
		this.notify();
		return true;
	}

	setPage(page: number): void {
		this.state.lens.page = Math.max(0, page);
		this.notify();
	}

	// -------------------------------------------------------------- reducer

	#say(from: string, text: string, kind: Entry["kind"], seq: number): void {
		this.state.transcript.push({ seq, from, text, kind, at: Date.now() });
		// The lens shows the latest thing said, not a scroll (R4.2), and a new
		// thing said starts at its first page — otherwise a short answer after a
		// long one would open on page three of nothing.
		this.state.lens = { from, text, page: 0 };
	}

	#reduce(m: SeqMsg): void {
		switch (m.type) {
			case "text":
				this.#say(m.from === "system" ? JARVIS : m.from, m.text, "text", m.seq);
				return;

			case "error":
				// Errors reach the lens: a user waiting on an answer that failed
				// has to learn that from the device they are looking at.
				this.#say(this.state.worker ?? JARVIS, m.message, "error", m.seq);
				return;

			case "state":
				this.state.busy = m.busy;
				this.state.worker = m.worker ?? null;
				this.state.mode = m.mode ?? this.state.mode;
				return;

			case "heard":
				// PRD 5 owns what the lens does with the user's own words (the
				// PRD's open question). Until then they are transcript only, so
				// they cannot cost a row that the answer needs.
				this.state.transcript.push({ seq: m.seq, from: "you", text: m.text, kind: "said", at: Date.now() });
				return;

			case "event":
				this.#event(m);
				return;
		}
	}

	/** `event` is where the client learns what happened that was not speech.
	 *  The kinds handled here are the ones the server actually emits (grep
	 *  `msg.event(` in src/); anything new falls through to the default, which
	 *  shows the kind rather than nothing — a server that grew an event should
	 *  read as something happening, not as silence. */
	#event(m: EventMsg): void {
		const d = m.data ?? {};
		switch (m.kind) {
			case "workerSwitched":
				this.state.worker = d.active ?? null;
				this.state.lastEvent = d.active ? `switched to ${d.active}` : "back to Jarvis";
				if (d.worker?.name) this.#rememberWorker(d.worker);
				break;

			case "modeChanged":
				this.state.mode = d.mode ?? this.state.mode;
				this.state.lastEvent = `input ${MODE_LABEL[this.state.mode] ?? this.state.mode}`;
				break;

			case "notHeard": {
				// R4.2 and PRD 3: dropped words are reported, never silent. On the
				// lens this is the difference between "it ignored me" and "I am
				// talking to a paused microphone".
				const why = this.state.mode === MODES.IGNORE
					? `Not heard — input is ${MODE_LABEL[MODES.IGNORE]}.`
					: "Not heard — start with Jarvis or a worker's name.";
				this.#say(JARVIS, why, "note", m.seq);
				this.state.lastEvent = "not heard";
				break;
			}

			case "toolFailed":
				// The one event that says Jarvis tried to act and could not.
				this.state.lastEvent = `${d.tool} failed: ${d.summary ?? ""}`.trim();
				break;

			case "interrupted":
				this.state.lastEvent = d.stopped ? "interrupted" : "nothing to interrupt";
				break;

			case "titleChanged":
				this.state.lastEvent = `titled "${d.title}"`;
				break;

			case "workerIdentity":
				// The PC handoff, in a form that can be copied out of the
				// companion: `claude --resume <id>` (PRD 3 R3.6).
				this.state.lastEvent = d.resume ?? `${d.name} has not started`;
				if (d.name) this.#rememberWorker(d as WorkerInfo);
				break;

			case "sessions":
				this.state.sessions = (d.sessions ?? []).map((s: any) => ({ id: s.id, title: s.title ?? "", updatedAt: s.updatedAt ?? 0 }));
				break;

			case "sessionDeleted":
				this.state.lastEvent = "session deleted";
				break;

			case "mcpGrant":
				// Never shown and never stored: it is a live credential, and the
				// client has no use for one (PRD 2 mints these for Claude Code).
				break;

			default:
				this.state.lastEvent = m.kind;
		}
	}

	/** The registry only reaches the client in `ready`, so a worker created
	 *  mid-session would otherwise be invisible to the companion's list until
	 *  the next reconnect. Names seen in events are folded in as they arrive. */
	#rememberWorker(w: WorkerInfo): void {
		const known = this.state.workers.find((x) => x.name === w.name);
		if (known) Object.assign(known, w);
		else this.state.workers = [...this.state.workers, w];
	}
}
