// One model, two faces — PRD 4's opening line.
//
// The lens and the companion both render from this object and nothing else, so
// "they cannot disagree about what was said" is a structural property rather
// than a thing to remember. Pure, like the renderer: it takes protocol messages
// in and calls subscribers out, and knows nothing about sockets, the DOM or the
// SDK.

import { DEFAULT_MODE, MODE_LABEL, MODES } from "../../src/routing.js";
import type { VoiceStatus } from "./audio/voice.ts";
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
	/** Workers that have spoken while the user was with somebody else. A reply
	 *  from one of them is a notice, not the conversation — see `notice()`. */
	pending: Pending[];
	/** The microphone, as the capture layer last reported it (PRD 5a). Null
	 *  before voice is wired up, which is also what a build with no microphone
	 *  support would look like. */
	voice: VoiceStatus | null;
	/** The last thing the server said it heard, and when. Kept out of the
	 *  transcript entry so the indicator can expire it without touching the
	 *  conversation (R5a.8). */
	heard: { text: string; confidence: number | null; at: number } | null;
};

export type Pending = {
	worker: string;
	kind: "question" | "said";
	at: number;
};

/** How long a "said something" notice stays before it fades. Long enough to
 *  look up from what you are doing, short enough not to become wallpaper. */
export const NOTICE_MS = 8000;

/** How long "heard" stays up before the indicator falls back to listening or
 *  idle — R5a.8's four states are idle, listening, heard, thinking, and `heard`
 *  is the only one of them that is a moment rather than a condition. Long
 *  enough to read a sentence back, short enough that it is gone before the
 *  answer needs the row. */
export const HEARD_MS = 3000;

/** What the user is told is happening, in the order that matters when two are
 *  true at once. Thinking outranks heard: once a turn has started, that the
 *  words were understood is settled. */
export type ListeningState = "idle" | "listening" | "heard" | "thinking";

/** How many lines of transcript the companion keeps. A phone that has been
 *  open all day should not hold a week of conversation in memory. */
const TRANSCRIPT_LIMIT = 400;

const JARVIS = "Jarvis";

export class Store {
	/**
	 * The server asking for the microphone to be turned on or off, because the
	 * user said so out loud.
	 *
	 * A one-shot callback rather than a field in `state`, deliberately. A field
	 * would have to be reconciled against `voice.enabled` on every notify, and
	 * the moment the user flicked the switch in the UI the two would disagree
	 * and the reconciler would flick it back. A request is an event: it happens
	 * once and then it is over.
	 */
	onMicRequest: ((on: boolean) => void) | null = null;

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
		pending: [],
		glasses: "unknown",
		sessions: [],
		voice: null,
		heard: null
	};

	#subs = new Set<(s: AppState) => void>();
	#localSeq = 0;
	/** False only while a transcript is being replayed — see applyHistory. The
	 *  registry follows live events and `ready`, never history. */
	#live = true;

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

	setVoice(voice: VoiceStatus): void {
		this.state.voice = voice;
		this.notify();
	}

	/**
	 * Which of R5a.8's four states is true — the one question the user must
	 * always be able to answer about a voice interface.
	 *
	 * `now` is a parameter so the answer is a function of the state rather than
	 * of when it happened to be asked, which is what makes it testable.
	 */
	listening(now = Date.now()): ListeningState {
		if (this.state.busy) return "thinking";
		if (this.state.heard && now - this.state.heard.at < HEARD_MS) return "heard";
		return this.state.voice?.live ? "listening" : "idle";
	}

	/** When the "heard" indicator stops being true, so the caller can repaint
	 *  exactly then instead of polling. Null when nothing is on a clock. */
	nextListeningExpiry(now = Date.now()): number | null {
		if (this.state.busy || !this.state.heard) return null;
		const left = this.state.heard.at + HEARD_MS - now;
		return left > 0 ? left : null;
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
		// Replaying a transcript rebuilds the CONVERSATION. It must not rebuild
		// the registry: `ready.workers` is the server's snapshot of who exists
		// right now, and a transcript is a record of what was said, which is not
		// the same question. Folding worker names in from history resurrects
		// every worker that has ever existed in this session — and handling
		// `workerEnded` is not enough to undo it, because a worker ended from
		// another device leaves no end event in THIS transcript and would linger
		// for ever. A reload made it worse rather than better, which is how it
		// was found.
		this.#live = false;
		try {
			for (const m of messages) this.#reduce(m);
		} finally {
			this.#live = true;
		}
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

	/** Who the conversation is about to be with, and what they last said,
	 *  carried from the event that announced it to the `state` that ends the same
	 *  turn. Cleared on every state, so it can never resurface on a later,
	 *  unrelated turn. */
	#pending: { from: string; text: string | null; fromName: string | null } | null = null;

	/** Record a notice about somebody the user is not talking to. One per
	 *  worker: the newest thing they said is the one worth going back for. */
	#note(worker: string, kind: Pending["kind"]): void {
		const now = Date.now();
		const at = this.state.pending.find((p) => p.worker === worker);
		if (at) { at.kind = kind; at.at = now; return; }
		this.state.pending.push({ worker, kind, at: now });
	}

	/** Being put in front of somebody answers whatever they were saying. */
	#clearNotice(worker: string | null): void {
		if (!worker) return;
		this.state.pending = this.state.pending.filter((p) => p.worker !== worker);
	}

	/**
	 * The header's middle slot: what is waiting, in the fewest words that still
	 * say who and how urgent.
	 *
	 * A question always outranks a statement — it is the one that cannot be
	 * allowed to fade — and a statement disappears on its own once it is final.
	 * Names are used when there is one of a kind, counts when there are several,
	 * because "Bosse" tells you where to go and "3" does not.
	 */
	notice(now = Date.now()): string | null {
		const live = this.state.pending.filter((p) => p.kind === "question" || now - p.at < NOTICE_MS);
		if (live.length !== this.state.pending.length) this.state.pending = live;
		if (!live.length) return null;

		const asking = live.filter((p) => p.kind === "question");
		const said = live.length - asking.length;
		if (asking.length === 1) return said ? `${asking[0].worker} asks +${said}` : `${asking[0].worker} asks`;
		if (asking.length > 1) return said ? `${asking.length} ask +${said}` : `${asking.length} ask`;
		return said === 1 ? `${live[0].worker} spoke` : `${said} spoke`;
	}

	/**
	 * The one line of status the lens can afford — R4.4, R5a.8, R5b.3.
	 *
	 * Derived state, so it lives with the state rather than in the wiring: it is
	 * a pure function of the model and the clock, both faces read the same
	 * answer, and the suite can ask it a question without starting a client.
	 *
	 * The order IS the specification, and every step of it is a decision:
	 *
	 *   1. A dead socket outranks everything. An answer that will never arrive
	 *      must not read as one that is on its way.
	 *   2. A hold outranks every notice (R5b.3). The user has a finger on the
	 *      touchpad right now; there is no speaker on the glasses, so this line
	 *      is the only feedback there is that the microphone opened — and
	 *      "opening" and "held" are two words rather than one because the round
	 *      trip that opens it costs roughly 160–200 ms, and saying it is live
	 *      before it is would lose exactly the syllable the honesty was meant to
	 *      save.
	 *   3. Somebody the user is NOT talking to waiting on them outranks
	 *      "thinking": thinking says something is happening that they already
	 *      know about, and a waiting worker carries a name worth acting on.
	 *   4. Then R5a.8's four states, then the mode — but only when it is not the
	 *      default one, which would spend the line on the ordinary case.
	 */
	lensStatus(now = Date.now()): string | null {
		const s = this.state;
		if (s.connection === "fatal") return "stopped";
		if (s.connection !== "online") return "offline";
		if (s.voice?.held) return s.voice.live ? "held" : "opening";
		const waiting = this.notice(now);
		if (waiting) return waiting;
		const listening = this.listening(now);
		if (listening === "thinking") return "thinking";
		if (listening === "heard") return "heard";
		// Paused is what the user most needs to know, and hold-to-talk explains
		// why nothing is happening when they speak.
		if (s.mode === MODES.IGNORE) return MODE_LABEL[MODES.IGNORE];
		if (listening === "listening") return "listening";

		// A mode that wants an open microphone, without one, is the one state
		// that actively lies. "always" reads as "I am hearing everything" while
		// the switch is off and nothing is being heard at all — and the hold
		// still works, being unconditional by design, so there is no symptom to
		// suspect the switch from. Say the actionable half.
		if (s.mode !== MODES.PUSHTOTALK && s.mode !== MODES.IGNORE && s.voice && !s.voice.enabled) {
			return s.mode === DEFAULT_MODE ? null : "mic off";
		}

		if (s.mode !== DEFAULT_MODE) return MODE_LABEL[s.mode] ?? s.mode;
		return null;
	}

	/** When the next notice expires, so the caller can repaint exactly then
	 *  rather than polling. Null when nothing is on a clock. */
	nextNoticeExpiry(now = Date.now()): number | null {
		const fading = this.state.pending.filter((p) => p.kind !== "question").map((p) => p.at + NOTICE_MS - now);
		return fading.length ? Math.max(0, Math.min(...fading)) : null;
	}

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
				if ((m as { background?: boolean }).background) {
					// Transcript yes, lens no: the user switched away on purpose,
					// and a long job finishing is not a reason to interrupt the
					// conversation they are in. The notice arrives separately, as
					// `workerNotice`, once the server has read the sentence.
					this.state.transcript.push({ seq: m.seq, from: m.from, text: m.text, kind: "text", at: Date.now() });
					return;
				}
				this.#say(m.from === "system" ? JARVIS : m.from, m.text, "text", m.seq);
				return;

			case "error":
				// Errors reach the lens: a user waiting on an answer that failed
				// has to learn that from the device they are looking at.
				this.#say(this.state.worker ?? JARVIS, m.message, "error", m.seq);
				return;

			case "state": {
				const before = this.state.worker;
				this.state.busy = m.busy;
				this.state.worker = m.worker ?? null;
				this.state.mode = m.mode ?? this.state.mode;

				// R3.5: who is listening has to be visible the moment it changes,
				// not at the next reply. Spawning or switching a worker ends the
				// turn with a `state` carrying the new one, and until this the
				// header kept the previous name until somebody said something —
				// so the lens told you that you were still talking to Jarvis while
				// your next sentence was going to Bosse.
				//
				// Gated on an actual change, deliberately. Jarvis answering an
				// aside mid-conversation ends with a `state` too, carrying the
				// SAME worker; updating on every state would then put his words
				// under the worker's name and misattribute them.
				// Two ways the addressee can change: an event announced it this
				// turn, or it simply differs from what we had (a reconnect, or
				// another device switching underneath us).
				this.#clearNotice(this.state.worker);
				const changed = this.#pending !== null || (this.state.worker ?? null) !== (before ?? null);
				if (changed) {
					// Switching back to somebody shows their conversation again
					// (R3.6). A worker with nothing to show — one that has just
					// been created — keeps the text on the lens, which is Jarvis
					// saying it exists.
					const who = this.#pending?.from ?? this.state.worker ?? JARVIS;
					this.state.lens = this.#pending?.text
						? { from: this.#pending.fromName ?? who, text: this.#pending.text, page: 0 }
						: { ...this.state.lens, from: who };
				}
				this.#pending = null;
				return;
			}

			case "heard":
				// What was understood, shown as soon as it exists and before the
				// answer (R5a.8). It stays out of the lens BODY on purpose — the
				// lens shows the reply, and the user already knows what they said
				// — but it drives the status line through listening() above, so
				// "it heard me and decided I wasn't talking to it" and "it didn't
				// hear me" look different.
				this.state.heard = { text: m.text, confidence: m.confidence ?? null, at: Date.now() };
				// A dropped utterance's `heard` arrives with no sequence number:
				// the server sends it per connection rather than writing every
				// overheard sentence into the transcript. Give it a local one, or
				// two of them in a row look like the same entry to the companion's
				// render memo.
				this.state.transcript.push({
					seq: typeof m.seq === "number" ? m.seq : -(++this.#localSeq),
					from: "you", text: m.text, kind: "said", at: Date.now()
				});
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

		// Any event that names who is active may have changed the addressee —
		// spawn, switch, end, rename. Armed here and applied at the `state` that
		// ends the same turn, because Jarvis's own sentence about it arrives in
		// between and would otherwise be the last word on the lens.
		if ("active" in d) {
			this.#pending = {
				from: (d.active as string) ?? JARVIS,
				text: d.last?.text ? String(d.last.text) : null,
				fromName: d.last?.from ? String(d.last.from) : null
			};
		}

		switch (m.kind) {
			case "workerNotice":
				// Somebody the user is not talking to has spoken, and the server
				// has read it well enough to say whether they are asking.
				if (d.worker) this.#note(String(d.worker), d.kind === "question" ? "question" : "said");
				break;

			case "workerSpawned":
				// The mirror image of the bug `workerEnded` fixes. A worker that
				// has just been created IS the active one — `spawn_worker`
				// switches as part of itself — so without this the picker offers
				// every worker except the one being talked to, and shows "Jarvis"
				// while the words are going to Bosse. A list that disagrees with
				// reality is the same defect whichever way it leans.
				this.state.worker = d.active ?? this.state.worker;
				this.state.lastEvent = d.worker?.name ? `started ${d.worker.name}` : "started a worker";
				if (d.worker?.name) this.#rememberWorker(d.worker as WorkerInfo);
				break;

			case "workerSwitched":
				this.state.worker = d.active ?? null;
				this.#clearNotice(d.active ?? null);
				this.state.lastEvent = d.active ? `switched to ${d.active}` : "back to Jarvis";
				if (d.worker?.name) this.#rememberWorker(d.worker);
				// Where that conversation left off, sent by the server because it
				// owns the transcripts and this client may never have seen them.
				// Applied at the state change below, not here: Jarvis's own "now
				// talking to Kalle" arrives AFTER this event and would overwrite
				// it, and that sentence is the one thing the user already knows.
				break;

			case "workerEnded":
				// A worker that has ended is gone, and the list has to say so.
				// `state.workers` is what the companion's "Talking to" picker
				// offers, and an entry there is a promise that switching to it
				// will work — but nothing ever took a name OFF it: names were
				// folded in from events and only ever corrected wholesale by
				// `ready.workers` on a reconnect. So an ended worker stayed on
				// offer for the rest of the session, long enough to be picked and
				// answered with "he does not exist any more, you ended him".
				if (d.worker?.name) this.#forgetWorker(String(d.worker.name));
				this.state.lastEvent = d.worker?.name ? `${d.worker.name} ended` : m.kind;
				break;

			case "workerRenamed":
				// The same bug in a different shape, and the easy one to leave
				// behind: folding the new name in without taking the old one out
				// leaves TWO entries for one worker, and picking the older of
				// them fails exactly the way an ended worker did. The event
				// carries `previousName` (src/tools.js) rather than leaving it to
				// be inferred, so the entry is replaced rather than added.
				if (d.previousName && d.worker?.name) this.#renameWorker(String(d.previousName), d.worker as WorkerInfo);
				else if (d.worker?.name) this.#rememberWorker(d.worker as WorkerInfo);
				this.state.lastEvent = d.previousName ? `${d.previousName} is now ${d.worker?.name}` : m.kind;
				break;

			case "micRequested":
				// Said out loud and acted on here. The server has no microphone;
				// it only relays what was asked for, so every attached device
				// agrees about whether anything is listening.
				this.state.lastEvent = d.on ? "mic on" : "mic off";
				this.onMicRequest?.(d.on === true);
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
		// Live events only. This mechanism exists so a worker created mid-session
		// appears without waiting for a reconnect; asked the same question by a
		// replayed transcript it answers "everyone who ever existed".
		if (!this.#live) return;
		const known = this.state.workers.find((x) => x.name === w.name);
		if (known) Object.assign(known, w);
		else this.state.workers = [...this.state.workers, w];
	}

	/** Take a name off the list, and the notices with it. A worker that is gone
	 *  cannot be gone back to, so "Bosse spoke" in the header would be an
	 *  invitation to somewhere that no longer exists. */
	#forgetWorker(name: string): void {
		// The registry half is live-only for the same reason as #rememberWorker:
		// `ready` already knows who is gone. The notice is not — it is
		// conversation state, and dropping a notice for somebody who has ended is
		// right whichever way the message arrived.
		if (this.#live) this.state.workers = this.state.workers.filter((w) => w.name !== name);
		this.#clearNotice(name);
	}

	/**
	 * Replace an entry rather than adding one.
	 *
	 * Position is kept, because the picker's order is the order the user learnt.
	 * Anything already standing under the NEW name is the same worker seen
	 * twice — a rename has to leave exactly one entry whichever order the events
	 * arrived in, and two entries for one worker is the bug this is fixing.
	 *
	 * Unlike an ending, the notice FOLLOWS: the worker is still there and may
	 * still be waiting on an answer, it is only called something else now. (The
	 * server does the same with its own addressee — `retarget` in src/tools.js.)
	 */
	#renameWorker(previous: string, w: WorkerInfo): void {
		if (this.#live) {
			let replaced = false;
			const next: WorkerInfo[] = [];
			for (const x of this.state.workers) {
				if (x.name === previous) { next.push({ ...x, ...w }); replaced = true; continue; }
				if (x.name === w.name) continue;
				next.push(x);
			}
			if (!replaced) next.push(w);
			this.state.workers = next;
		}
		for (const p of this.state.pending) if (p.worker === previous) p.worker = w.name;
	}
}
