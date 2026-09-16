// One model, two faces — PRD 4's opening line.
//
// The lens and the companion both render from this object and nothing else, so
// "they cannot disagree about what was said" is a structural property rather
// than a thing to remember. Pure, like the renderer: it takes protocol messages
// in and calls subscribers out, and knows nothing about sockets, the DOM or the
// SDK.

import { DEFAULT_MODE, MODE_LABEL, MODES } from "../../src/routing.js";
import { BODY_ROWS, wrapText } from "./lens/render.ts";
import type { LensCorners, LensMic } from "./lens/render.ts";
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

/**
 * A turn, while it is one.
 *
 * The server assembles an utterance out of however many fragments the speaker
 * produced and reports where it has got to; this is that report, plus whatever
 * the turn has since said about itself.
 *
 * `parts` is the user's own words, one entry per fragment, in the order they
 * were spoken. They are shown separately rather than joined because the
 * question the user is asking is "did it get all of that", and a merged
 * sentence cannot answer it.
 */
export type LiveTurn = {
	id: string;
	/** A worker's name, or "mike". */
	to: string;
	parts: string[];
	/** held: still gathering words. queued: sent, nothing running it yet.
	 *  started: a process has the whole utterance. done/dropped: over. */
	phase: "held" | "queued" | "started" | "done" | "dropped";
	/** The one line the model wrote before it started working. */
	plan: string | null;
	/** What it is doing right now — a tool call, or a later sentence. */
	doing: string | null;
	at: number;
	/** When the window closed and the words left for a model — the moment the
	 *  wait for an answer begins. Null while still gathering. Not `at`: the
	 *  window can stay open for as long as the user keeps talking, and a counter
	 *  that started then would read "thinking 12s" the instant the model got
	 *  the sentence. */
	sentAt: number | null;
	/** When `doing` last changed, and when the process was last known to be
	 *  producing anything at all. The second is the weaker claim and the one
	 *  that keeps the blink honest. */
	doingAt: number;
	aliveAt: number;
};

export type AppState = {
	connection: ConnectionStatus;
	connectionDetail: string;
	sessionId: string | null;
	worker: string | null;
	mode: string;
	busy: boolean;
	workers: WorkerInfo[];
	transcript: Entry[];
	/** What Mike last did — R4.4. The `event` stream in one sentence. */
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
	/** When the current turn started, so "thinking" can carry how long it has
	 *  been thinking. Null whenever nothing is running. */
	busySince: number | null;
	/** What the running turn is doing, as it does it (PRD 6). Cleared the
	 *  moment the turn ends: the finished answer arrives as a `text` message
	 *  and must be the last word, not a leftover half-sentence. */
	progress: { from: string; text: string | null; tool: string | null } | null;
	/** The last thing the user said or typed, whichever came last. Separate from
	 *  `heard`, which is about the microphone and expires on its own clock. */
	said: { text: string; at: number } | null;
	/** Every turn the server has told us about that is not finished and gone.
	 *  Oldest first — the order they were spoken in. */
	turns: LiveTurn[];
	/** When the lens last got something worth reading. Compared against the
	 *  turns so an answer is not covered up by the next question. */
	lensAt: number;
	/** "Display off", said out loud: the lens stays dark whatever happens
	 *  until "display on". Nothing lights it — not a reply, not speech, not a
	 *  turn — because the user asked for a dark lens and every one of those is
	 *  exactly the thing they asked not to be shown. */
	displayOff: boolean;
	/** The answer to the last spoken command, shown in the title bar for
	 *  COMMAND_NOTE_MS. Never the lens body: that belongs to the conversation. */
	commandNote: { text: string; at: number } | null;
	/** Workers that finished or want something while the lens was dark, oldest
	 *  first. Named in the corner of the dark lens, and cleared the moment the
	 *  lens lights, because by then the user is looking at what it was about. */
	beacon: string[];
	/** When the socket was last seen going away, or null while it is up. The
	 *  pairing screen waits on this: a blip while the phone was in a pocket is
	 *  not a reason to put a QR button over the conversation. */
	offlineSince: number | null;
};

export type Pending = {
	worker: string;
	/** `moved` is a terminal session that finished and was taken over while the
	 *  user was elsewhere. It stays until they switch to it, like a question:
	 *  it is waiting for them, and whoever put the job running went to do
	 *  something else precisely so they would not have to watch for it. */
	kind: "question" | "moved" | "said";
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

/** How long the answer to a command stays in the title bar. Long enough to
 *  read "Input: Always." once, and gone before it is mistaken for a state. */
export const COMMAND_NOTE_MS = 4000;
/** What of it fits in the title bar next to a name. */
const COMMAND_NOTE_COLS = 28;

/**
 * How long a turn may say nothing new before the lens starts blinking.
 *
 * Not a timeout and not an error: a job that reads twenty files says something
 * every second, and one that runs a build says nothing for minutes and is
 * perfectly well. What the blink carries is that the last line is still the
 * latest news — the alternative is a screen that has been identical for two
 * minutes, which reads as a hang whether or not it is one.
 *
 * Ten seconds on, ten seconds off, so the lens changes at least that often
 * while a turn is running, which is what it was asked for.
 */
export const STALE_MS = 10_000;

/**
 * How long the lens keeps showing the last thing said before it goes dark.
 *
 * A lens is a screen half a metre from the eye that nobody can look away from,
 * and an answer left on it stops being an answer after the first read: it
 * becomes something in the way. Ten seconds of nobody saying anything — no
 * utterance heard, no reply drawn — and the body is cleared.
 *
 * The whole frame, header included. A name and a status row left burning in
 * the eye is the same problem one row smaller, and the question the header
 * answers — is it listening (R5a.8) — is asked by looking, which is a gesture,
 * which lights the lens again.
 *
 * Nothing is lost: the transcript keeps it, and a tap repaints (setPage), which
 * is also what makes this safe to be aggressive about.
 *
 * Thirty seconds. Ten was the first guess and it was too short in use: an
 * answer worth reading twice was gone before the second read.
 */
export const LENS_IDLE_MS = 30_000;

/** How long the socket may be down before the companion stops showing the
 *  conversation and shows the QR button instead. Long enough to ride out the
 *  reconnect after the phone comes out of a pocket; short enough that a moved
 *  server is noticed. A refused token skips the wait — see needsPairing. */
export const PAIRING_GRACE_MS = 10_000;

/** How long a finished turn stays on the lens when nothing arrived to replace
 *  it. Normally the answer does that within a message or two; this is for the
 *  turns that end without one — an interrupted turn, a worker answering in the
 *  background — so that a lens is never left holding a question nobody is
 *  working on any more. */
export const DONE_LINGER_MS = 2500;

/** The three marks a spoken fragment can carry, one per thing the user needs
 *  to be able to tell apart at a glance:
 *
 *    »  the sentence is still open — keep talking and it joins this turn
 *    ›  sent, waiting for a process to take it (usually: behind another turn)
 *    √  a process has the whole utterance
 *
 *  Before the middle one existed, "held" and "queued" shared `»`, and a
 *  fragment queued behind a running turn looked exactly like one still being
 *  gathered — the user could not tell "it is waiting for me" from "it is
 *  waiting for Bosse", which are opposite instructions about what to do next.
 *
 *  `√` rather than `✓` on purpose: the firmware font has no tick, and
 *  @evenrealities/pretext measures the one everybody reaches for first at the
 *  same width as a missing glyph, which on glass is a box where the
 *  confirmation should be. All three are measured present in the font. */
export const MARK_WAITING = "»";
export const MARK_QUEUED = "›";
export const MARK_TAKEN = "√";
/** What a turn says about itself, which is not the user's words. */
export const MARK_THEIRS = "«";

/** What the user is told is happening, in the order that matters when two are
 *  true at once. Thinking outranks heard: once a turn has started, that the
 *  words were understood is settled.
 *
 *  `holding` and `queued` are PRD 6's: a sentence the server is still
 *  gathering, and one it has sent that nothing has picked up yet. Both used to
 *  read as "thinking", which is the exact word for what is NOT happening while
 *  the window is open — and the reason a lens that said it felt like a model
 *  that started before the user had finished. */
export type ListeningState = "idle" | "listening" | "heard" | "holding" | "queued" | "thinking";

/** "thinking", with the seconds it has been thinking for once there is a
 *  second to show. A turn that takes a while and a turn that has hung look
 *  identical without the count, and which of the two it is is the whole
 *  question the user is asking when they look at the lens. */
export const thinkingText = (since: number | null, now = Date.now(), doing: string | null = null): string => {
	const word = doing ?? "thinking";
	if (since === null) return word;
	const secs = Math.floor((now - since) / 1000);
	if (secs < 1) return word;
	return secs < 60 ? `${word} ${secs}s` : `${word} ${Math.floor(secs / 60)}m${secs % 60}s`;
};

/** How many lines of transcript the companion keeps. A phone that has been
 *  open all day should not hold a week of conversation in memory. */
const TRANSCRIPT_LIMIT = 400;

const MIKE = "Mike";

/** The server names Mike "mike" on the wire and "system" for its own lines;
 *  the lens names him once, capitalised, whichever it was. */
const speaker = (from: string): string => (from === "system" || from.toLowerCase() === "mike" ? MIKE : from);

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
		lens: { from: MIKE, text: "Connecting…", page: 0 },
		pending: [],
		glasses: "unknown",
		sessions: [],
		voice: null,
		busySince: null,
		progress: null,
		said: null,
		heard: null,
		turns: [],
		lensAt: 0,
		displayOff: false,
		commandNote: null,
		beacon: [],
		offlineSince: null
	};

	/** When the user last asked to see the lens — see #wake. */
	#wokeAt = 0;

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
		if (status === "online") this.state.offlineSince = null;
		else if (this.state.offlineSince === null) this.state.offlineSince = Date.now();
		this.notify();
	}

	/** Should the companion be showing the QR button instead of the
	 *  conversation? Yes when the connection is dead for good — no token, or
	 *  one the server refused — and yes when it has been down for longer than a
	 *  reconnect takes. Scanning the code is the one thing that fixes either. */
	needsPairing(now = Date.now()): boolean {
		const s = this.state;
		if (s.connection === "fatal") return true;
		if (s.connection === "online" || s.offlineSince === null) return false;
		return now - s.offlineSince >= PAIRING_GRACE_MS;
	}

	/** When the grace period runs out, so the caller can repaint exactly then. */
	nextPairingExpiry(now = Date.now()): number | null {
		const s = this.state;
		if (s.connection === "online" || s.connection === "fatal" || s.offlineSince === null) return null;
		const left = s.offlineSince + PAIRING_GRACE_MS - now;
		return left > 0 ? left : null;
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
	/**
	 * Is anything being worked on?
	 *
	 * Not `state.busy` on its own, and the difference is a bug this replaces.
	 * Two utterances in flight produce `busy:true, busy:true, busy:false,
	 * busy:false` — one pair per turn — so the lens went quiet the moment the
	 * FIRST of them finished, while the second was still running. The turns know
	 * better: while one of them is unfinished, something is being worked on.
	 */
	working(now = Date.now()): boolean {
		return this.state.busy || this.liveTurns(now).length > 0;
	}

	/** Is a model actually at work — as opposed to a sentence still being
	 *  gathered or sitting in a queue? `working` is the wider question (is
	 *  there anything on the lens to keep alive); this is the one the word
	 *  "thinking" is allowed to answer. A finished turn counts for the moment it
	 *  lingers: its answer is what is being waited for. */
	thinking(now = Date.now()): boolean {
		return this.state.busy || this.liveTurns(now).some((t) => t.phase !== "held" && t.phase !== "queued");
	}

	/** When the oldest thing still being waited on was sent, so the counter
	 *  measures the wait the user is actually having — from the words leaving
	 *  for a model, not from the first fragment being heard. */
	workingSince(now = Date.now()): number | null {
		const sent = this.liveTurns(now).map((t) => t.sentAt).filter((t): t is number => t !== null);
		const first = sent.length ? Math.min(...sent) : null;
		if (first === null) return this.state.busySince;
		return this.state.busySince === null ? first : Math.min(first, this.state.busySince);
	}

	listening(now = Date.now()): ListeningState {
		if (this.thinking(now)) return "thinking";
		const live = this.liveTurns(now);
		// Held outranks queued: a window still open is an invitation to keep
		// talking, and that is the more useful thing to say while it is true.
		if (live.some((t) => t.phase === "held")) return "holding";
		if (live.length) return "queued";
		if (this.state.heard && now - this.state.heard.at < HEARD_MS) return "heard";
		return this.state.voice?.live ? "listening" : "idle";
	}

	/** "thinking 7s", or the tool it is running instead of the word, because a
	 *  name the user recognises answers the question the counter only measures. */
	thinkingLabel(now = Date.now()): string {
		// The tool's name used to be spent here. It says more in the body now,
		// where it has room for what the tool is being pointed at, and this row
		// goes back to the one thing only it can say: how long.
		return thinkingText(this.workingSince(now), now);
	}

	/** The command answer while it is fresh, cut to what the title bar holds. */
	commandNoteText(now = Date.now()): string | null {
		const n = this.state.commandNote;
		if (!n || now - n.at >= COMMAND_NOTE_MS) return null;
		const t = n.text.trim();
		return t.length > COMMAND_NOTE_COLS ? `${t.slice(0, COMMAND_NOTE_COLS - 1)}…` : t;
	}

	/** When the command answer leaves the title bar, so it is repainted away. */
	nextCommandNoteExpiry(now = Date.now()): number | null {
		const n = this.state.commandNote;
		if (!n) return null;
		const left = n.at + COMMAND_NOTE_MS - now;
		return left > 0 ? left : null;
	}

	/** When the "heard" indicator stops being true, so the caller can repaint
	 *  exactly then instead of polling. Null when nothing is on a clock. */
	nextListeningExpiry(now = Date.now()): number | null {
		// While thinking, the next change is the next tick of the counter. That
		// tick is also what drives the blink, which is why neither needs a timer
		// of its own.
		if (this.working(now)) {
			const since = this.workingSince(now) ?? now;
			return 1000 - ((now - since) % 1000);
		}
		if (!this.state.heard) return null;
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
		// `ready` is the truth about NOW — who is active, what mode we are in —
		// and the transcript is a record of what was true at each line of it.
		// Replaying those `state` messages over the top put the client back in
		// whatever state the session was in when it was last written to: talking
		// to a worker that has since been ended from another device, in a mode
		// the user changed after. Kept and put back, so history writes the
		// conversation and nothing else.
		const live = { worker: this.state.worker, mode: this.state.mode, workers: this.state.workers };
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
		this.state.worker = live.worker;
		this.state.mode = live.mode;
		this.state.workers = live.workers;
		// Nothing was running when this client started, whatever the last line
		// of the transcript said. A `state` with busy true — the session was
		// written to mid-turn, or the server was restarted under one — left the
		// lens counting "thinking 3h" against a turn that died with the process.
		this.state.busy = false;
		this.state.busySince = null;
		this.state.progress = null;
		this.state.turns = [];
		this.state.heard = null;
		this.state.commandNote = null;
		// The conversation is worth seeing when the app opens, and it is old:
		// lit as a wake, which fades on the idle clock, rather than by dating it
		// to now. The lens itself is whatever the last thing said set it to.
		this.#wokeAt = Date.now();
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
		this.state.said = { text, at: Date.now() };
		this.state.transcript.push({ seq: -(++this.#localSeq), from: "you", text, kind: "said", at: Date.now() });
		this.notify();
	}

	// ----------------------------------------------------------------- lens

	/**
	 * What the lens shows — the one place that decides, so the glasses and the
	 * companion's preview cannot disagree.
	 *
	 * While a turn is running and before a word of the answer exists, the lens
	 * carries back what the turn is answering: "» bygg klart testerna". The
	 * status line alone was too quiet to be the confirmation that an utterance
	 * landed — a word that changes from "listening" to "thinking" in the corner
	 * is not something you notice on glass while you are doing something else —
	 * and the alternative is a lens still showing the PREVIOUS answer, which is
	 * the one thing that reads as "nothing happened".
	 *
	 * It is replaced the moment the answer starts arriving, and it is only ever
	 * shown for an utterance from this turn: an echo of something said a minute
	 * ago would be a lie about what is being worked on.
	 */
	lensView(now = Date.now()): LensItem {
		const work = this.workingView(now);
		return work ?? this.#addressed(this.state.lens);
	}

	/** Who the next sentence goes to — the name the title bar carries (R3.5). */
	addressee(): string {
		return this.state.worker ?? MIKE;
	}

	/**
	 * The title bar names who is being talked TO, which is not always who said
	 * the last thing. Mike answering an aside while the user is talking to
	 * Bosse used to put "Mike" on the name row and leave it there until Bosse
	 * spoke again — so the row said the next sentence would go to Mike while it
	 * was going to Bosse. Now the row keeps Bosse's name and the words say whose
	 * they are, so nothing is misattributed and the row stays true.
	 */
	#addressed(item: LensItem): LensItem {
		const who = this.addressee();
		if (speaker(item.from) === who) return item;
		return { ...item, from: who, text: item.text ? `${speaker(item.from)}: ${item.text}` : item.text };
	}

	/** Is the lens dark? Glass, not pixels: the whole frame goes, header and
	 *  status with it, so there is nothing left in the eye at all. Work outranks
	 *  the idle clock — a turn that says nothing for a minute is still a turn,
	 *  and the blink in #doingLine is what carries that. */
	lensDark(now = Date.now()): boolean {
		if (this.state.displayOff) return true;
		if (this.workingView(now)) return false;
		return this.idleFor(now) >= LENS_IDLE_MS;
	}

	/** The workers the dark lens names. Only while it is dark: a lit lens shows
	 *  the thing itself, so lighting it is what clears them — whether by
	 *  "display on", a tap, or a foreground reply that lit it on arrival. */
	lensBeacon(now = Date.now()): string[] {
		if (!this.state.beacon.length) return [];
		if (this.lensDark(now)) return [...this.state.beacon];
		this.state.beacon = [];
		return [];
	}

	/** The top row of a dark lens: who is waiting, on the left, and a ring on
	 *  the right while the microphone is hearing — held or always, whatever the
	 *  mode — because a dark lens has no title bar to carry the microphone
	 *  mark. Both at once when both are true. */
	lensCorners(now = Date.now()): LensCorners {
		const waiting = this.lensBeacon(now);
		if (!this.lensDark(now)) return {};
		return { waiting, hearing: !!this.state.voice?.live };
	}

	#beckon(worker: string): void {
		if (!this.lensDark()) return;
		this.state.beacon = [...this.state.beacon.filter((w) => w !== worker), worker];
	}

	/** The microphone as the title bar shows it: hearing, not hearing, or
	 *  there is no microphone to speak of yet. Live rather than enabled, so
	 *  that a hold shows as hearing and a switch left on with nothing open —
	 *  paused, or backgrounded — does not. */
	lensMic(): LensMic {
		const v = this.state.voice;
		if (!v) return null;
		return v.live ? "live" : "off";
	}

	/** The lens, switched off or on by voice. Switching it on counts as asking
	 *  to see it, so the last thing said comes back at once rather than after
	 *  the next reply. */
	setDisplay(on: boolean): void {
		this.state.displayOff = !on;
		this.state.lastEvent = on ? "display on" : "display off";
		if (on) this.#wokeAt = Date.now();
		this.notify();
	}

	/** How long nothing has been said, in either direction — the last reply
	 *  drawn, or the last utterance the server reported hearing. A held
	 *  microphone counts as being said something to: the words are on their way
	 *  and blanking under the user's own finger would read as a dropped hold. */
	idleFor(now = Date.now()): number {
		if (this.state.voice?.held) return 0;
		const last = Math.max(this.state.lensAt, this.state.heard?.at ?? 0, this.#wokeAt);
		return last ? now - last : 0;
	}

	/** When the lens goes dark, so the caller can repaint exactly then rather
	 *  than polling. Null once it already has — this arms once per utterance and
	 *  does not re-arm itself. */
	nextIdleExpiry(now = Date.now()): number | null {
		if (this.state.displayOff || this.workingView(now)) return null;
		const left = LENS_IDLE_MS - this.idleFor(now);
		return left > 0 ? left : null;
	}

	/** The turns still worth drawing. Finished ones are kept for a moment in
	 *  case nothing replaces them, then dropped. */
	liveTurns(now = Date.now()): LiveTurn[] {
		const over = (t: LiveTurn) => t.phase === "done" || t.phase === "dropped";
		return this.state.turns.filter((t) => !over(t) || now - t.doingAt < DONE_LINGER_MS);
	}

	/**
	 * The lens while something is being worked on.
	 *
	 * What it has to answer, in the order the user asks it: did you get all of
	 * what I said, have you started, and what are you doing now. Null when
	 * nothing is running, which is when the lens goes back to showing the last
	 * thing that was said.
	 *
	 * It loses to an answer that is newer than the work. A reply arriving while
	 * the next utterance is already being held would otherwise never be seen —
	 * it would be covered by the question that came after it — so an answer
	 * holds the lens until the next turn actually does something.
	 */
	workingView(now = Date.now()): LensItem | null {
		const live = this.liveTurns(now);
		if (!live.length) return null;

		const newsAt = Math.max(...live.map((t) => Math.max(t.at, t.doingAt)));
		if (this.state.lensAt > newsAt) return null;

		// The work shown is the newest turn that has any to report, which is not
		// the newest turn: saying a second sentence while the first is running
		// opens a held turn with nothing in it, and taking ITS empty plan and
		// doing would blank out what the worker is in the middle of — replacing
		// the only account of what is happening with the user's own words.
		const working = [...live].reverse().find((t) => t.doing || t.plan) ?? live[live.length - 1];

		// Bottom up, because the bottom is the part that must survive: one row
		// for what it is doing, up to two for what it said it would do, and
		// whatever is left for the user's own words.
		const doing = working.doing ? this.#doingLine(working, now) : null;
		const plan = working.plan ? wrapText(`${MARK_THEIRS} ${working.plan}`).slice(0, 2) : [];
		const budget = BODY_ROWS - (doing ? 1 : 0) - plan.length;

		// One group per fragment, so a fragment that is dropped for space is
		// dropped whole rather than by the line. A turn addressed to somebody
		// other than the one the title bar names says so on its first line —
		// an aside to Mike while talking to Bosse — because the name row does
		// not change for it (see #addressed).
		const who = this.addressee();
		const groups: string[][] = [];
		for (const t of live) {
			const mark = t.phase === "held" ? MARK_WAITING : t.phase === "queued" ? MARK_QUEUED : MARK_TAKEN;
			const to = t.to === "mike" ? MIKE : t.to;
			const aside = to !== who ? `(to ${to}) ` : "";
			t.parts.forEach((part, i) => groups.push(wrapText(`${mark} ${i === 0 ? aside : ""}${part}`)));
		}

		const said: string[] = [];
		let rows = 0;
		let hidden = 0;
		// Newest first while filling, oldest first when drawn: what is dropped
		// for space is what the user has already watched land.
		for (let i = groups.length - 1; i >= 0; i--) {
			const g = groups[i];
			// The last row of the budget is owed to "+N earlier" whenever
			// anything is going to be left out.
			const room = budget - rows - (i > 0 ? 1 : 0);
			if (g.length > Math.max(0, room)) { hidden = i + 1; break; }
			said.unshift(...g);
			rows += g.length;
		}
		if (hidden) said.unshift(`+${hidden} earlier`);

		return {
			from: who,
			text: [...said, ...plan, ...(doing ? [doing] : [])].join("\n"),
			page: 0
		};
	}

	/**
	 * What it is doing, on one row, with the blink.
	 *
	 * The mark appears only once the line has stopped being news, and then
	 * alternates: ten seconds with, ten without. It says nothing in words —
	 * there is no room to spend a row on "still" — and it is driven by when the
	 * PROCESS last produced anything, not by the client's own clock, so a blink
	 * is evidence rather than decoration.
	 */
	#doingLine(turn: LiveTurn, now: number): string {
		const quiet = now - Math.max(turn.doingAt, turn.aliveAt);
		const blink = quiet >= STALE_MS && Math.floor(quiet / STALE_MS) % 2 === 1 ? " *" : "";
		const line = `${MARK_THEIRS} ${turn.doing}${blink}`;
		return wrapText(line)[0] ?? line;
	}

	/** Paging through a long reply (R4.3). Returns true when the page moved, so
	 *  a gesture that changed nothing can be answered differently from one that
	 *  did — tapping past the last page repeats instead of sitting still. */
	turnPage(delta: number, pages: number): boolean {
		this.#wake();
		const next = this.state.lens.page + delta;
		if (next < 0 || next >= pages) return false;
		this.state.lens.page = next;
		this.notify();
		return true;
	}

	setPage(page: number): void {
		this.#wake();
		this.state.lens.page = Math.max(0, page);
		this.notify();
	}

	/** A gesture asking to see the lens is a reason to light it again, and it is
	 *  kept apart from `lensAt` on purpose: `lensAt` is when something was SAID,
	 *  and workingView compares against it to decide whether an answer is newer
	 *  than the work. Paging through a reply must not make the running turn look
	 *  stale.
	 *
	 *  Public, because the user starting to speak is the same request: the
	 *  detector flips before a word has been transcribed, and the lens should be
	 *  lit by the time the words come back. */
	wake(): void {
		this.#wake();
	}

	#wake(): void {
		this.#wokeAt = Date.now();
		// Always a notify, even when the page did not move: on a dark lens the
		// gesture that changes nothing is exactly the one that has to light it.
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
		const live = this.state.pending.filter((p) => p.kind !== "said" || now - p.at < NOTICE_MS);
		if (live.length !== this.state.pending.length) this.state.pending = live;
		if (!live.length) return null;

		// Most urgent first: a question, then a session that moved over, then a
		// remark. The first kind present is named; the rest are a count.
		const asking = live.filter((p) => p.kind === "question");
		const moved = live.filter((p) => p.kind === "moved");
		if (asking.length) {
			const rest = live.length - asking.length;
			const head = asking.length === 1 ? `${asking[0].worker} asks` : `${asking.length} ask`;
			return rest ? `${head} +${rest}` : head;
		}
		if (moved.length) {
			const rest = live.length - moved.length;
			const head = moved.length === 1 ? `${moved[0].worker} moved` : `${moved.length} moved`;
			return rest ? `${head} +${rest}` : head;
		}
		return live.length === 1 ? `${live[0].worker} spoke` : `${live.length} spoke`;
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
		// The user just said a command and is looking for whether it worked.
		const note = this.commandNoteText(now);
		if (note) return note;
		const waiting = this.notice(now);
		if (waiting) return waiting;
		const listening = this.listening(now);
		if (listening === "thinking") return this.thinkingLabel(now);
		// The sentence is open. Said in words the user can act on: the thing to
		// do while this is true is finish the thought, and the thing NOT to do is
		// wait for an answer — which "thinking" would have told them to.
		if (listening === "holding") return "still listening";
		if (listening === "queued") return "queued";
		if (listening === "heard") return "heard";
		// Paused is what the user most needs to know, and hold-to-talk explains
		// why nothing is happening when they speak.
		if (s.mode === MODES.IGNORE) return MODE_LABEL[MODES.IGNORE];
		if (listening === "listening") return "listening";

		// Whether the microphone is open is no longer this row's to say: the
		// title bar carries it as a mark of its own (lensMic), which is there
		// whatever word this row is spending itself on. "mic off" used to live
		// here and vanished behind "thinking 12s" — exactly when the user was
		// looking to see whether they had been heard.
		if (s.mode !== DEFAULT_MODE) return MODE_LABEL[s.mode] ?? s.mode;
		return null;
	}

	/** When the next notice expires, so the caller can repaint exactly then
	 *  rather than polling. Null when nothing is on a clock. */
	nextNoticeExpiry(now = Date.now()): number | null {
		const fading = this.state.pending.filter((p) => p.kind === "said").map((p) => p.at + NOTICE_MS - now);
		return fading.length ? Math.max(0, Math.min(...fading)) : null;
	}

	#say(from: string, text: string, kind: Entry["kind"], seq: number, at = Date.now()): void {
		this.state.transcript.push({ seq, from, text, kind, at });
		// The lens shows the latest thing said, not a scroll (R4.2), and a new
		// thing said starts at its first page — otherwise a short answer after a
		// long one would open on page three of nothing.
		this.state.lens = { from, text, page: 0 };
		// When it was SAID, not when we heard about it. A replayed transcript
		// would otherwise date yesterday's last answer to now, which is the lens
		// showing an old sentence as news and the idle clock starting over for
		// something nobody just said.
		this.state.lensAt = at;
		// The question this answers has been answered. Turns that ended without
		// one time out instead (DONE_LINGER_MS); this is the ordinary path, and
		// it is what keeps a finished turn from lingering under the reply.
		this.state.turns = this.state.turns.filter((t) => t.phase !== "done" && t.phase !== "dropped");
	}

	/** The last thing somebody actually said, out of the transcript. What the
	 *  lens goes back to when the conversation is switched to them: their own
	 *  words, or nothing, never somebody else's under their name. */
	#lastFrom(who: string): { from: string; text: string } | null {
		for (let i = this.state.transcript.length - 1; i >= 0; i--) {
			const e = this.state.transcript[i];
			if (e.kind !== "text" && e.kind !== "error") continue;
			if (speaker(e.from) !== who) continue;
			return { from: speaker(e.from), text: e.text };
		}
		return null;
	}

	/** The turn a progress event belongs to. Null for one we never heard of —
	 *  a reconnect mid-turn, where the `turn` events were transient and gone. */
	#turnFor(id: unknown): LiveTurn | null {
		if (typeof id !== "string" || !id) return null;
		return this.state.turns.find((t) => t.id === id) ?? null;
	}

	/** One turn's report about itself. Upserted by id: the server sends the
	 *  whole of `parts` every time, so a message that went missing costs a
	 *  redraw and not a wrong picture. */
	#turn(d: Record<string, unknown>): void {
		const id = String(d.id ?? "");
		if (!id) return;
		const now = Date.now();
		const phase = String(d.phase ?? "held") as LiveTurn["phase"];
		const parts = Array.isArray(d.parts) ? d.parts.map((v) => String(v)) : [];

		// A reconnect can miss the `queued` event and first hear of a turn as
		// `started`: anything past gathering has been sent.
		const sent = phase !== "held";
		const at = this.state.turns.find((t) => t.id === id);
		if (!at) {
			this.state.turns.push({
				id, to: String(d.to ?? MIKE), parts, phase,
				plan: null, doing: null, at: now, sentAt: sent ? now : null, doingAt: now, aliveAt: now
			});
			return;
		}
		at.parts = parts;
		at.phase = phase;
		if (sent && at.sentAt === null) at.sentAt = now;
		// A phase change is news: it is what moves the mark from » to √, and the
		// blink must not start counting from before it.
		at.doingAt = now;
		at.aliveAt = now;
	}

	#reduce(m: SeqMsg): void {
		switch (m.type) {
			case "text":
				if (m.command) {
					// In the transcript, for the phone; in the title bar, for the
					// lens. Not #say: that would put "Display on." where the
					// last answer was, and take the turns off the lens with it.
					this.state.transcript.push({ seq: m.seq, from: speaker(m.from), text: m.text, kind: "note", at: m.at ?? Date.now() });
					// The title bar's copy is about this moment, so a replayed one
					// is already expired — which is what keeps a command answer
					// from a week ago off a lens that has just started.
					this.state.commandNote = { text: m.text, at: m.at ?? Date.now() };
					return;
				}
				const at = m.at ?? Date.now();
				if ((m as { background?: boolean }).background) {
					// Transcript yes, lens no: the user switched away on purpose,
					// and a long job finishing is not a reason to interrupt the
					// conversation they are in. The notice arrives separately, as
					// `workerNotice`, once the server has read the sentence.
					this.state.transcript.push({ seq: m.seq, from: m.from, text: m.text, kind: "text", at });
				} else {
					this.#say(speaker(m.from), m.text, "text", m.seq, at);
				}
				// Any worker's answer is a worker done with its turn. Mike's are
				// not: he is the one being talked to, not someone to come back to.
				// Asked after the answer is in, so one that lit the lens on arrival
				// leaves no ring behind.
				if (speaker(m.from) !== MIKE) this.#beckon(speaker(m.from));
				return;

			case "error":
				// Errors reach the lens: a user waiting on an answer that failed
				// has to learn that from the device they are looking at.
				this.#say(this.state.worker ?? MIKE, m.message, "error", m.seq, m.at ?? Date.now());
				return;

			case "state": {
				const before = this.state.worker;
				if (m.busy !== this.state.busy) {
					this.state.busySince = m.busy ? Date.now() : null;
					this.state.progress = null;
				}
				this.state.busy = m.busy;
				this.state.worker = m.worker ?? null;
				this.state.mode = m.mode ?? this.state.mode;

				// R3.5: who is listening has to be visible the moment it changes,
				// not at the next reply. Spawning or switching a worker ends the
				// turn with a `state` carrying the new one, and until this the
				// header kept the previous name until somebody said something —
				// so the lens told you that you were still talking to Mike while
				// your next sentence was going to Bosse.
				//
				// Gated on an actual change, deliberately. Mike answering an
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
					// (R3.6) — theirs, and not the last thing on the lens wearing
					// their name. Relabelling was the bug: switching to Bosse put
					// "Bosse" over whatever Mike had just said, so a sentence of
					// his was read as the new worker's own, and a switch made from
					// another device left an unrelated old answer sitting under a
					// name that never said it.
					//
					// Three sources, in order: what the server named in the event,
					// what this person last said in the transcript, and — for
					// somebody who has never said anything — what is already on
					// the lens, kept under the name of whoever really said it.
					// The name row still follows the addressee; that is
					// #addressed's job, and it prefixes the speaker rather than
					// pretending they said it.
					const who = this.#pending?.from ?? this.state.worker ?? MIKE;
					const last = this.#pending?.text
						? { from: this.#pending.fromName ?? who, text: this.#pending.text }
						: this.#lastFrom(who) ?? { from: this.state.lens.from, text: this.state.lens.text };
					this.state.lens = { from: last.from, text: last.text, page: 0 };
					// A switch is a reason to look at the lens, and the words on
					// it are old by definition — so it is lit as a wake rather
					// than by dating somebody's last sentence to now.
					this.#wokeAt = Date.now();
				}
				this.#pending = null;
				return;
			}

			case "heard":
				// What was understood, shown as soon as it exists and before the
				// answer (R5a.8). It drives the status line through listening()
				// above, so "it heard me and decided I wasn't talking to it" and
				// "it didn't hear me" look different — and, through lensView, it
				// is what the lens carries back while the turn runs.
				this.state.heard = { text: m.text, confidence: m.confidence ?? null, at: m.at ?? Date.now() };
				this.state.said = { text: m.text, at: m.at ?? Date.now() };
				// A dropped utterance's `heard` arrives with no sequence number:
				// the server sends it per connection rather than writing every
				// overheard sentence into the transcript. Give it a local one, or
				// two of them in a row look like the same entry to the companion's
				// render memo.
				this.state.transcript.push({
					seq: typeof m.seq === "number" ? m.seq : -(++this.#localSeq),
					from: "you", text: m.text, kind: "said", at: m.at ?? Date.now()
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
		// ends the same turn, because Mike's own sentence about it arrives in
		// between and would otherwise be the last word on the lens.
		if ("active" in d) {
			this.#pending = {
				from: (d.active as string) ?? MIKE,
				text: d.last?.text ? String(d.last.text) : null,
				fromName: d.last?.from ? String(d.last.from) : null
			};
		}

		switch (m.kind) {
			case "progress": {
				// A turn saying what it is doing while it does it (PRD 6). Only
				// the conversation the user is actually in may touch the lens:
				// a background worker's half-sentence would take the screen away
				// from the one they are looking at, which is the same rule the
				// finished answer follows.
				const from = String(d.from ?? MIKE);
				const mine = from === (this.state.worker ?? "mike") || (from === "mike" && !this.state.worker);
				if (!mine) break;
				const text = d.text ? String(d.text) : null;
				const tool = d.tool ? String(d.tool) : null;
				const doing = d.doing ? String(d.doing) : null;
				this.state.progress = { from, text, tool: text ? null : tool };

				const turn = this.#turnFor(d.turn);
				const now = Date.now();
				if (turn) turn.aliveAt = now;
				// `alive` is the process saying it is producing something, and
				// nothing else. It refreshes the blink and changes no words.
				if (d.alive || !turn) break;

				// The first thing written is what it intends to do; everything
				// after it is what it is doing. Both are shown, in that order,
				// and neither is the answer — that arrives as its own `text`
				// message and would otherwise be said twice, once in halves.
				const line = doing ?? text;
				if (!line) break;
				if (turn.plan === null && text) turn.plan = text;
				else { turn.doing = line; turn.doingAt = now; }
				break;
			}

			case "turn":
				this.#turn(d as Record<string, unknown>);
				break;

			case "noticesDismissed": {
				// "Ignore": the names on the dark lens and the notice in the
				// title bar go together, for one worker or for all of them.
				const who = d.worker ? String(d.worker).toLowerCase() : null;
				const keep = (name: string) => who !== null && name.toLowerCase() !== who;
				this.state.beacon = this.state.beacon.filter(keep);
				this.state.pending = this.state.pending.filter((p) => keep(p.worker));
				break;
			}

			case "workerNotice":
				// Somebody the user is not talking to has spoken, and the server
				// has read it well enough to say whether they are asking.
				if (d.worker) this.#note(String(d.worker), d.kind === "question" ? "question" : "said");
				// A question arrives seconds after the answer it is part of, and
				// the lens may have gone dark in between.
				if (d.kind === "question" && d.worker) this.#beckon(String(d.worker));
				break;

			case "workerMoved":
				// A terminal session that finished while the user was elsewhere,
				// now a worker. Deliberately NOT the active one — the server sends
				// no `active` — so the title bar says so and the list offers it,
				// and switching is the user's word.
				if (d.worker?.name) {
					this.#rememberWorker(d.worker as WorkerInfo);
					this.#note(String(d.worker.name), "moved");
					this.#beckon(String(d.worker.name));
					this.state.lastEvent = `${d.worker.name} moved over`;
				}
				break;

			case "workerSpawned":
				// The mirror image of the bug `workerEnded` fixes. A worker that
				// has just been created IS the active one — `spawn_worker`
				// switches as part of itself — so without this the picker offers
				// every worker except the one being talked to, and shows "Mike"
				// while the words are going to Bosse. A list that disagrees with
				// reality is the same defect whichever way it leans.
				this.state.worker = d.active ?? this.state.worker;
				this.state.lastEvent = d.worker?.name ? `started ${d.worker.name}` : "started a worker";
				if (d.worker?.name) this.#rememberWorker(d.worker as WorkerInfo);
				break;

			case "workerSwitched":
				this.state.worker = d.active ?? null;
				this.#clearNotice(d.active ?? null);
				this.state.lastEvent = d.active ? `switched to ${d.active}` : "back to Mike";
				if (d.worker?.name) this.#rememberWorker(d.worker);
				// Where that conversation left off, sent by the server because it
				// owns the transcripts and this client may never have seen them.
				// Applied at the state change below, not here: Mike's own "now
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

			case "workerReset":
				// Same worker, same place in the list; only its memory is gone.
				this.state.lastEvent = d.worker?.name ? `${d.worker.name} reset` : m.kind;
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

			case "displayRequested":
				// The same shape: the lens is the client's, the words were the
				// server's to hear. Off stays off until on is said.
				this.setDisplay(d.on === true);
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
					: "Not heard — start with Mike or a worker's name.";
				this.#say(MIKE, why, "note", m.seq);
				this.state.lastEvent = "not heard";
				break;
			}

			case "toolFailed":
				// The one event that says Mike tried to act and could not.
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
