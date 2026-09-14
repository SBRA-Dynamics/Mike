// The conversation seam — PRD 3.
//
// PRD 1 owns transport, not conversation, and shipped an echo handler so the
// transport could be exercised on its own. Both handlers live here now: the
// echo one is still what the PRD 1 suites pin the transport with (`--handler
// echo`), and the Mike one is the product.
//
// The contract, unchanged:
//   onMessage(session, msg, ctx)  — may be async and long-running
//   onOpen(session, ctx)          — optional
//   onClose(session, ctx)         — optional; must not cancel work in flight
//
// What this file is responsible for, and nothing else is:
//   * classifying every utterance (routing.js decides, this applies)
//   * turning an `audio` segment into words and saying what was heard (PRD 5a)
//   * keeping `busy`, `worker` and `mode` truthful in every `state` message
//   * making sure a failed turn is a sentence, not a stack trace

import { C2S, CONTROL, msg } from "./protocol.js";
import { MODES, MODE_LABEL, applyModeCommand, isMode, route, ORIGIN } from "./routing.js";
import { decodeSegment, DEFAULT_MAX_AUDIO_BYTES } from "./audio.js";
import { NOISE_MAX_BYTES, saveNoise } from "./noise.js";

/** Marks a line as the answer to a spoken command — "Input: Always.", "Mic
 *  off.", "Rewound: …" — rather than something said in the conversation. The
 *  client shows it for a moment in the title bar and leaves the conversation
 *  on the lens where it was; without the mark, every "display on" replaced the
 *  last answer until the next one arrived. */
const COMMAND = { command: true };

/**
 * The audio path, shared by both handlers — PRD 5a R5a.6 and R5a.8.
 *
 * One message is one segment (the client's segmenter decides where an utterance
 * ends), and the whole of this function is: are these bytes acceptable,
 * what do they say, and tell the user what was understood.
 *
 * What it does NOT do is emit `heard`: the caller does that, before it routes
 * anything (R5a.8 — "it heard me and decided I wasn't talking to it" must look
 * different from "it didn't hear me"), and the caller is also the only one that
 * knows whether the words belong in the durable transcript.
 *
 * Returns { text, confidence, language }, or null when there is nothing to say.
 */
function createAudioIntake({ transcriber, maxBytes = DEFAULT_MAX_AUDIO_BYTES, log }) {
	return async (session, m) => {
		const seg = decodeSegment(m, { maxBytes });
		if (!seg.ok) {
			// `ignore` is "there was nothing in there" — a segment below the
			// minimum length. R5a.5: silence mistaken for speech costs the user
			// nothing, and an error bubble is a cost.
			if (seg.ignore) { log?.info(`audio ignored: ${seg.error}`); return null; }
			log?.warn(`audio refused: ${seg.error} session=${session.id.slice(0, 8)}`);
			session.emit(msg.error(seg.error));
			return null;
		}

		let r;
		try {
			r = await transcriber.transcribe(seg.pcm);
		} catch (e) {
			// Honest degradation (R5a.5): the server keeps running, the typed
			// path keeps working, and the user is told which of the two problems
			// this is rather than being left to guess from silence.
			log?.error(`transcription failed: ${e.message}`);
			session.emit(msg.error(e.unavailable ? `Cannot hear you: ${e.message}.` : lens(e)));
			return null;
		}

		// The client's side of the story, when it tells it: why the segment
		// ended and what the detector took the room to be. "15000ms maximum
		// floor -70 peak -38" is a diagnosis; "15000ms" was a mystery.
		const why = [m.reason, m.floorDb !== undefined ? `floor ${m.floorDb}` : "", m.peakDb !== undefined ? `peak ${m.peakDb}` : ""].filter(Boolean).join(" ");
		log?.info(`heard ${seg.durationMs}ms${why ? ` ${why}` : ""} in ${r.ms}ms${r.modelMs !== null ? ` (model ${r.modelMs}ms)` : ""} ${r.language ?? "?"} ${JSON.stringify(r.text.slice(0, 60))}`);
		// R5a.5 again, one layer up: an empty transcription produces nothing at
		// all — no turn, no `heard`, and no "I didn't catch that".
		if (!r.text) return null;

		return r;
	};
}

/** One line, no stack, short enough for a lens — the same rule the tools
 *  answer errors by (PRD 2 R2.5). */
const lens = (e) => String(e?.message ?? e ?? "something went wrong").replace(/\s+/g, " ").trim().slice(0, 100);

export function createEchoHandler({ log, transcriber, audioMaxBytes }) {
	// The echo handler is PRD 1's transport pin, and it gets the audio path too:
	// a spoken segment reaching the wire, being transcribed and coming back as
	// `heard` is a transport property, and testing it without a model in the way
	// is exactly what this handler is for.
	const receiveAudio = transcriber ? createAudioIntake({ transcriber, maxBytes: audioMaxBytes, log }) : null;

	/** One turn, whether the words were typed or spoken. Spoken input taking the
	 *  same path as typed input is the property PRD 5b's acceptance 7 asks for,
	 *  one layer down. */
	const echoTurn = async (session, text) => {
		session.emit(msg.state({ busy: true, worker: session.worker, mode: session.mode }));
		// A deliberate pause: it makes "a turn survives a disconnect"
		// testable, and mirrors the shape of a real model call.
		await new Promise((r) => setTimeout(r, 150));
		session.emit(msg.text(`echo: ${text}`, "echo"));
		session.emit(msg.state({ busy: false, worker: session.worker, mode: session.mode }));
	};

	return {
		onOpen(session, { resumed }) {
			if (!resumed) session.emit(msg.text("Mike transport online (echo handler).", "system"));
		},

		async onMessage(session, m) {
			switch (m.type) {
				case C2S.SAY:
					await echoTurn(session, m.text);
					break;
				case C2S.INTERRUPT:
					session.emit(msg.event("interrupted"));
					session.emit(msg.state({ busy: false, worker: session.worker, mode: session.mode }));
					break;
				case C2S.CONTROL:
					// Transport-level controls only; conversation controls are PRD 3.
					if (m.action === "setTitle" && typeof m.args?.title === "string") {
						session.title = m.args.title.slice(0, 120);
						session.store.touch(session);
						session.emit(msg.event("titleChanged", { title: session.title }));
					} else {
						session.emit(msg.error(`unknown control "${m.action}"`));
					}
					break;
				case C2S.SPEAKING:
					break;   // a fact about the microphone; the echo has no window to pause
				case C2S.AUDIO: {
					if (!receiveAudio) { session.emit(msg.error("this server has no transcription")); break; }
					const heard = await receiveAudio(session, m);
					// null is "nothing was said" — silence, or a segment refused.
					// Either way there is no turn to run (R5a.5).
					if (!heard) break;
					session.emit(msg.heard(heard.text, heard.confidence));
					await echoTurn(session, heard.text);
					break;
				}
				default:
					log.warn(`handler ignored ${m.type}`);
			}
		}
	};
}

/** Kept short on purpose: it is the first thing on a fifty-column lens, and it
 *  is a fact about who is listening, not a welcome. */
const GREETING = "Mike here.";

/**
 * What Mike says when called by name and nothing else — "Mike", after a
 * silence. Answered here, at once, without a model: the model's "yes?" took as
 * long as any other turn to arrive, which is far too long for a word whose
 * whole purpose is to check that he is there. The book's Mike, to Man; the
 * second line now and then, because it was his.
 */
const CALLED = ["Hello, Man.", "Hello, Man.", "Hello, Man.", "Hello, Man, my only friend."];
const called = () => CALLED[Math.floor(Math.random() * CALLED.length)];

/** How long after being called Mike keeps listening for the sentence. Long
 *  enough to think of what to say; short enough that a call left hanging does
 *  not catch a remark to somebody else a minute later. */
export const SUMMON_MS = 15_000;

/**
 * How long an utterance waits for the rest of the sentence.
 *
 * The segmenter closes a segment after 700 ms of silence (client/src/audio/
 * segment.ts), which is the right length for "has this person stopped talking"
 * and the wrong one for "has this person finished the thought". Someone
 * dictating while they think — and choosing between two languages while they do
 * it — produces three segments of one sentence, and without this each of them
 * was a turn of its own: the first one started a long job on half an
 * instruction and the other two queued up behind it to be answered out of
 * context.
 *
 * So a routed utterance is held, and anything else arriving for the same
 * addressee inside the window joins it. The cost is real and is paid on every
 * spoken turn — this is latency added to the thing PRD 6 exists to remove — and
 * it is why the window is configurable and why the parts appear on the lens the
 * moment they are heard rather than when the turn starts. The user watches the
 * sentence assemble instead of watching nothing.
 *
 * The window is silence, not wall-clock time. The first version measured from
 * one transcript's arrival to the next, and the next can only arrive once its
 * fragment has been spoken to the end, gone quiet for the hangover and been
 * transcribed — so the length of the second half of the sentence counted
 * against the window, and anything past about a second of continuation missed
 * it. The log showed it: 3 merges in 40 turns, and the one that merged had 25
 * ms to spare. So the client now says when its detector opens a segment
 * (`speaking`, C2S), and a window with somebody talking into it stops counting
 * until their fragment has arrived. What is measured is the pause between the
 * user's words, which is the thing the window was always meant to be about.
 *
 * Two seconds by default: long enough to cross a thinking pause, short enough
 * not to feel like a hang. Typed input never waits — pressing Enter is the
 * boundary.
 */
export const DEFAULT_HOLD_MS = 2000;

/**
 * How long a window may stay open past the last words that actually arrived,
 * whatever the `speaking` signal says. The first version re-armed a 40 s cap
 * on every flip of the signal, and a detector that flipped every fifteen
 * seconds — open on room tone to its maximum, closed for a frame, open again —
 * kept "still listening" on the lens for as long as it liked. Measured from
 * the last real fragment instead, the cap is a promise: nothing said is held
 * longer than this. The client's own maximum segment is 15 s, so a genuine
 * long continuation still fits.
 */
export const SPEAKING_CAP_MS = 20_000;

/**
 * The real handler.
 *
 * `mike`, `registry` and `engine` are the three things a turn can be about;
 * everything else is plumbing this file borrows from the session.
 */
export function createMikeHandler({ log, mike, registry, engine, classifier, transcriber, audioMaxBytes, holdMs = DEFAULT_HOLD_MS, noiseDir = null }) {

	// PRD 5a. Null only when the server was started with no transcription at
	// all; every other case is the whisper client, which reports its own
	// unavailability in words (whisper.js).
	const receiveAudio = transcriber ? createAudioIntake({ transcriber, maxBytes: audioMaxBytes, log }) : null;

	/** Every state message carries all three fields, always. A client that gets
	 *  `{busy:false}` with no `worker` cannot tell "nobody" from "unchanged",
	 *  and R3.5 says the active worker is visible at all times. */
	const state = (session, busy) => msg.state({ busy, worker: session.worker, mode: session.mode });

	const setMode = (session, to) => {
		const before = session.mode;
		const applied = applyModeCommand(to, { mode: session.mode, previousMode: session.previousMode ?? null });
		session.mode = applied.mode;
		session.previousMode = applied.previousMode;
		session.store.touch(session);
		session.emit(msg.event("modeChanged", { mode: session.mode, previous: before }));
		// One short line, because this is the confirmation that the user is not
		// shouting into a paused microphone.
		session.emit(msg.text(`Input: ${MODE_LABEL[session.mode]}.`, "system", COMMAND));
		// R5a.4: the mode is part of the state message, and a client that only
		// watched `state` would otherwise never learn it changed.
		session.emit(state(session, false));
		log?.info(`mode ${before} -> ${session.mode} session=${session.id.slice(0, 8)}`);
	};

	// ------------------------------------------------------------------ turns
	//
	// A turn is now a thing with a name, because the user has to be able to see
	// one. It gathers words (`held`), goes to a model (`queued`), reaches a
	// process that is running it (`started`) and ends (`done`, or `dropped` when
	// it was stopped before it ever ran).
	//
	// The events are transient, all of them, and so is `progress` now. They are
	// facts about this moment on this screen — sessions.js's own rule for
	// choosing — and `alive` alone would otherwise write one line to disk every
	// five seconds for as long as a turn lasts.

	let turnSeq = 0;
	const holds = new Map();   // session.id -> the turn still gathering words
	/** Turns sent to a model's queue that no model has picked up yet, oldest
	 *  first. What "rewind" takes back once there is nothing held. */
	const queued = new Map();  // session.id -> [turn]
	/** Sessions where "Mike" was just said on its own, and until when the next
	 *  sentence is his. See utterance(). */
	const summons = new Map(); // session.id -> expiry (ms)
	/** Sessions whose microphone is hearing speech right now, by the client's
	 *  own detector (C2S.SPEAKING). Kept outside the turn because the signal
	 *  usually arrives BEFORE there is a turn to attach it to: the user starts
	 *  the second half of the sentence while the first is still in whisper. */
	const talking = new Set();

	/** Say where a turn has got to. `parts` is sent every time rather than just
	 *  the new one: it makes the message idempotent, a client that missed one
	 *  still draws the right thing, and three short sentences are not a payload
	 *  worth being clever about. */
	const announce = (session, turn, phase) => {
		turn.phase = phase;
		session.transient(msg.event("turn", { id: turn.id, to: turn.to, parts: [...turn.parts], phase }));
	};

	/** Once per turn, whichever way it ended, and before the answer is emitted:
	 *  the lens shows the turn while it runs, and it has to stop doing that
	 *  before the thing it was waiting for arrives, or the answer is hidden
	 *  behind the question. */
	const finishTurn = (session, turn, phase = "done") => {
		if (!turn || turn.phase === "done" || turn.phase === "dropped") return;
		unqueue(session, turn);
		announce(session, turn, phase);
	};

	const unqueue = (session, turn) => {
		const list = queued.get(session.id);
		if (!list) return;
		const i = list.indexOf(turn);
		if (i >= 0) list.splice(i, 1);
		if (!list.length) queued.delete(session.id);
	};

	/** Add an utterance to the turn being assembled, starting one if there is
	 *  none. A different addressee ends the old one where it stands: two
	 *  sentences to two different people are two thoughts, whatever the clock
	 *  says. */
	const hold = (session, to, name, text, origin) => {
		let turn = holds.get(session.id);
		if (turn && turn.to !== to) { void flush(session); turn = null; }
		if (!turn) {
			turn = { id: `t${++turnSeq}`, to, name, parts: [], at: Date.now(), phase: "held", timer: null, deadline: 0 };
			holds.set(session.id, turn);
		}
		turn.parts.push(text);
		turn.deadline = Date.now() + SPEAKING_CAP_MS;
		// Before the wait, not after it: this is the receipt for having been
		// heard, and it is the whole reason the wait is bearable.
		announce(session, turn, "held");

		// Typing is its own boundary — Enter already said the sentence is over —
		// and a window of zero turns the whole thing off.
		if (origin === ORIGIN.TYPED || !(holdMs > 0)) return flush(session);
		arm(session, turn);
		log?.info(`held ${turn.id} (${turn.parts.length}) for ${to}${talking.has(session.id) ? " — still speaking" : ""} session=${session.id.slice(0, 8)}`);
		return Promise.resolve();
	};

	/** Start, or restart, the window's clock — unless the user is talking, in
	 *  which case the clock waits for their fragment (see DEFAULT_HOLD_MS). The
	 *  cap is the one thing that runs in the meantime. */
	const arm = (session, turn) => {
		clearTimeout(turn.timer);
		const ms = talking.has(session.id) ? Math.max(0, turn.deadline - Date.now()) : holdMs;
		turn.timer = setTimeout(() => { void flush(session); }, ms);
	};

	/** The client's detector opened or closed a segment. Recorded whether or
	 *  not a window is open, because the signal comes first and the fragment it
	 *  belongs to comes a transcription later. */
	const speaking = (session, on) => {
		if (on) talking.add(session.id); else talking.delete(session.id);
		const turn = holds.get(session.id);
		if (!turn) return;
		arm(session, turn);
		log?.info(`held ${turn.id} ${on ? "paused: speaking" : `resumed: ${holdMs} ms`} session=${session.id.slice(0, 8)}`);
	};

	/** The window closed: the parts become one utterance and the turn runs.
	 *  Never throws — it is called from a timer, where a rejection has nobody to
	 *  catch it and takes the process with it. */
	const flush = (session) => {
		const turn = holds.get(session.id);
		if (!turn) return Promise.resolve();
		holds.delete(session.id);
		clearTimeout(turn.timer);

		// One space, and nothing cleverer. The fragments are separate because
		// the speaker paused, not because they are separate sentences, and
		// punctuation invented here would be punctuation the model reads as
		// meaning something.
		const text = turn.parts.join(" ");
		turn.ticket = { withdrawn: false, begun: false };
		if (!queued.has(session.id)) queued.set(session.id, []);
		queued.get(session.id).push(turn);
		announce(session, turn, "queued");
		log?.info(`turn ${turn.id} ${turn.parts.length > 1 ? `merged ${turn.parts.length} parts ` : ""}-> ${turn.to} session=${session.id.slice(0, 8)}`);

		return (async () => {
			if (!turn.name) return await toMike(session, text, turn);
			// Re-resolved here rather than at routing time: the window is two
			// seconds long, and a worker can be ended from another device inside it.
			const w = registry.get(turn.name);
			if (!w) {
				finishTurn(session, turn);
				return session.emit(msg.error(`no worker called "${turn.name}"`));
			}
			return await toWorker(session, w, text, turn);
		})().catch((e) => {
			finishTurn(session, turn);
			log?.error(`turn ${turn.id}: ${e.stack || e.message}`);
		});
	};

	/** Throw away a turn that never ran. Returns what it discarded, so the
	 *  caller can tell the user that something did stop. */
	const dropHold = (session) => {
		const turn = holds.get(session.id);
		if (!turn) return null;
		holds.delete(session.id);
		clearTimeout(turn.timer);
		announce(session, turn, "dropped");
		return turn;
	};

	/** Kill whatever is running, whether the user pressed the button or said the
	 *  word. Both, because they do not know which of the two is mid-turn and
	 *  should not have to: the worker they are talking to, and Mike.
	 *
	 *  Everything here is transient. Nothing happened in the conversation — a
	 *  turn stopped — and replaying "Stopped." on a reconnect hours later would
	 *  be a lie about something that is no longer running. */
	const stopTurns = (session, { nullProgram = false } = {}) => {
		// Words still being gathered count as something to stop. Saying "stopp"
		// two seconds after a sentence you did not mean is the commonest case
		// there is, and it would be a strange machine that answered "nothing
		// running" while it was holding your words to send.
		const held = dropHold(session);
		const w = activeWorker(session);
		const stoppedWorker = w ? engine.interrupt(w) : false;
		const stoppedMike = mike.interrupt();
		const stopped = stoppedWorker || stoppedMike || !!held;
		session.transient(msg.event("interrupted", { stopped }));
		// Said out loud as well as raised as an event: the lens is showing
		// progress text from the turn that just died, and without a word it goes
		// quiet in a way that looks like a hang rather than an obedience.
		// A null program is answered the way the book's Mike would: what was
		// dropped is not worth a word, and "standing by" is the whole state.
		session.transient(msg.text(nullProgram ? "Null program. Standing by, Man." : stopped ? "Stopped." : "Nothing running.", "system", COMMAND));
		session.transient(state(session, false));
		log?.info(`stopped worker=${stoppedWorker} mike=${stoppedMike} held=${held?.parts.length ?? 0} session=${session.id.slice(0, 8)}`);
		return stopped;
	};

	/** "Rewind": take back the newest words no model has read. Words still
	 *  being gathered are the newest there are, so they go first, one fragment
	 *  at a time; then whole turns waiting in a queue, newest first. A turn a
	 *  process has already picked up is read, and is not taken back — that is
	 *  what "stop" is for.
	 *
	 *  Transient, like stop: what is taken back never happened. */
	const rewind = (session) => {
		const clip = (s) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);
		let taken = null;

		const held = holds.get(session.id);
		if (held) {
			taken = held.parts.pop();
			if (held.parts.length) {
				announce(session, held, "held");
				// A fresh window for what is left: the user is plainly not done.
				arm(session, held);
			} else {
				dropHold(session);
			}
			log?.info(`rewind: held ${held.id} fragment dropped, ${held.parts.length} left session=${session.id.slice(0, 8)}`);
		} else {
			const list = queued.get(session.id) ?? [];
			const turn = [...list].reverse().find((t) => !t.ticket?.begun);
			if (turn) {
				turn.ticket.withdrawn = true;
				taken = turn.parts.join(" ");
				finishTurn(session, turn, "dropped");
				log?.info(`rewind: queued ${turn.id} withdrawn session=${session.id.slice(0, 8)}`);
			}
		}

		session.transient(msg.text(taken === null ? "Nothing to rewind." : `Rewound: ${clip(taken)}`, "system", COMMAND));
		return taken !== null;
	};

	/** A worker named on the session but gone from the registry — ended from
	 *  another device between one utterance and the next. Routing must not send
	 *  words to it, and the session must stop claiming it. */
	const activeWorker = (session) => {
		if (!session.worker) return null;
		const w = registry.get(session.worker);
		if (w) return w;
		log?.warn(`session ${session.id.slice(0, 8)} pointed at missing worker "${session.worker}"`);
		session.worker = null;
		session.store.touch(session);
		session.emit(state(session, false));
		return null;
	};

	/** What a turn is doing, while it is doing it (PRD 6). A turn is one CLI
	 *  process whose answer used to arrive only when it exited, so the lens
	 *  stood on "thinking" for the whole of it — long enough that a slow turn
	 *  and a hung one looked the same. The events are advisory: nothing is
	 *  recorded in the transcript from here, because the turn's real answer
	 *  still arrives at the end and would be said twice. */
	const progressTo = (session, from, turn) => (p) => {
		// The process is up and has the whole utterance. This is the moment the
		// user's words stop being a promise, and the only one worth marking them
		// with — "queued" is a fact about us, not about their instruction.
		if (p?.kind === "start") {
			if (!turn) return undefined;
			unqueue(session, turn);
			return announce(session, turn, "started");
		}

		const at = { from, turn: turn?.id ?? null };
		if (p?.kind === "tool" && p.tool) session.transient(msg.event("progress", { ...at, tool: p.tool, doing: p.doing ?? null }));
		else if (p?.kind === "text" && p.text) session.transient(msg.event("progress", { ...at, text: p.text }));
		else if (p?.kind === "alive") session.transient(msg.event("progress", { ...at, alive: true }));
	};

	const toMike = async (session, text, turn = null) => {
		session.emit(state(session, true));
		try {
			const r = await mike.say(session, text, { onProgress: progressTo(session, "mike", turn), ticket: turn?.ticket });
			// Before the reply, always: the lens carries the turn while it runs,
			// and an answer arriving underneath it would not be seen.
			finishTurn(session, turn);
			// After the turn, not before: a tool call inside it may have switched
			// the active worker, and the reply has to be tagged and the state
			// reported as they are now.
			if (r.text) session.emit(msg.text(r.text, "mike"));
		} catch (e) {
			finishTurn(session, turn);
			// An interrupted turn is not a failure to report: the user asked for
			// it and has already been told "Stopped."
			if (e.kind === "interrupted") log?.info("mike turn stopped");
			else {
				log?.error(`mike turn: ${e.stack || e.message}`);
				session.emit(msg.error(lens(e)));
			}
		} finally {
			session.emit(state(session, false));
		}
	};

	const toWorker = async (session, worker, text, turn = null) => {
		registry.touch(worker, { busy: true });
		session.emit(state(session, true));
		try {
			const r = await engine.send(worker, text, { onProgress: progressTo(session, worker.name, turn), ticket: turn?.ticket });
			finishTurn(session, turn);

			// A reply from somebody the user is no longer talking to must not take
			// over the lens — they switched away on purpose, and a long job
			// finishing is not a reason to interrupt the conversation they are in.
			// It goes to the transcript as always, and the lens gets a notice.
			//
			// The user may have switched away DURING this turn, so this is read
			// now rather than when the turn started.
			const background = session.worker !== worker.name;

			// Tagged with the worker's name, which is what `from` is for: the lens
			// has no room for a label unless it is short (PRD 1 R1.6).
			if (r.text) {
				// The transcript gets it now; `background` tells the client to keep
				// it off the lens.
				session.emit(msg.text(r.text, worker.name, background ? { background: true } : {}));

				if (background && classifier) {
					// The notice follows a few seconds later, once something has
					// read the sentence. Deliberately not awaited: the turn is over,
					// and nothing downstream may wait on a second model call. Late
					// is fine here — nobody is watching the lens for this.
					classifier.classify(r.text)
						.then((kind) => session.emit(msg.event("workerNotice", { worker: worker.name, kind })))
						.catch(() => { });
				}
			}
		} catch (e) {
			finishTurn(session, turn);
			// Interrupted is the user's own doing, same as for Mike above.
			if (e.kind === "interrupted") log?.info(`worker ${worker.name} turn stopped`);
			else {
				log?.error(`worker ${worker.name} turn: ${e.stack || e.message}`);
				session.emit(msg.error(`${worker.name}: ${lens(e)}`));
			}
		} finally {
			registry.touch(worker, { busy: false });
			session.emit(state(session, false));
		}
	};

	/**
	 * One utterance, whichever way it arrived.
	 *
	 * Typed words and transcribed words take exactly the same path from here —
	 * they differ only in `origin`, which is what the addressing gate acts on
	 * (PRD 3, R5a.6). PRD 5b's acceptance 7 asks for no branch anywhere
	 * downstream of capture, and this function is where that promise is kept:
	 * the glasses, the browser microphone and the keyboard all arrive here.
	 *
	 * `heard` is the recognised text when the words were spoken, and it is
	 * emitted here rather than by the audio intake for two reasons. It must come
	 * before anything the turn produces (R5a.8), and whether it belongs in the
	 * durable transcript depends on the routing decision: an utterance that
	 * reached a model is part of the conversation and is the only record of what
	 * the user said, while one the gate threw away is a fact about this moment
	 * and nothing more. An always-on microphone in Ignore mode would otherwise
	 * write every overheard sentence in the room to disk.
	 */
	const utterance = async (session, text, origin, heard = null) => {
		const worker = activeWorker(session);
		let decision = route(text, { mode: session.mode, worker: worker?.name ?? null, origin, workers: registry?.list().map((w) => w.name) ?? [] });

		// "Mike", alone, with no sentence open: a call. He answers at once and
		// the next thing said is his, whether or not it starts with his name —
		// so "Mike" … "start a worker on the docs" works as two sentences, the
		// way it is said, and not only as the one sentence the hold window can
		// join. A bare "Mike" INSIDE an open window is not a call; it joins the
		// sentence like any other fragment, as before.
		if (decision.kind === "mike" && decision.bare && !holds.has(session.id)) {
			if (heard) session.emit(msg.heard(heard.text, heard.confidence));
			summons.set(session.id, Date.now() + SUMMON_MS);
			session.emit(msg.text(called(), "mike"));
			// The client may have gone busy the moment the user spoke; nothing is
			// running, and the lens must not sit on "thinking".
			session.transient(state(session, false));
			log?.info(`called by name session=${session.id.slice(0, 8)}`);
			return;
		}
		const summonedUntil = summons.get(session.id) ?? 0;
		if (summonedUntil) {
			// One sentence, then the call is spent — whatever the sentence was.
			summons.delete(session.id);
			const unaddressed = (decision.kind === "dropped" && decision.reason === "unaddressed")
				|| (decision.kind === "worker" && !decision.addressed);
			if (Date.now() < summonedUntil && unaddressed) {
				decision = { kind: "mike", text: String(text ?? "").trim() };
				log?.info(`summoned: sentence goes to Mike session=${session.id.slice(0, 8)}`);
			}
		}

		// An unaddressed fragment with a window open is the rest of a sentence
		// that WAS addressed, and it is about to reach a model. That decides
		// which side of the durable line it falls on, so it is worked out here,
		// before anything is emitted.
		const joining = decision.kind === "dropped" && decision.reason === "unaddressed" && holds.has(session.id);

		if (heard) {
			const line = msg.heard(heard.text, heard.confidence);
			if (decision.kind === "dropped" && !joining) session.transient(line);
			else session.emit(line);
		}

		switch (decision.kind) {
			case "empty":
				return;

			case "mode":
				return setMode(session, decision.to);

			case "stop":
				return stopTurns(session, { nullProgram: decision.nullProgram });

			case "rewind":
				return rewind(session);

			case "dismiss":
				// The client owns the notices, like the lens; the server says
				// who to forget. Transient: a replayed "ignore" would wave away
				// somebody who spoke after it.
				session.transient(msg.event("noticesDismissed", { worker: decision.name }));
				session.transient(msg.text(decision.name ? `Ignoring ${decision.name}.` : "Ignoring them.", "system", COMMAND));
				log?.info(`dismissed ${decision.name ?? "all"} session=${session.id.slice(0, 8)}`);
				return;

			case "mic":
				// The switch lives in the client — the server has no microphone
				// and should not pretend to own one. It says what was asked for
				// and every attached device acts on it, which also keeps the
				// phone and the glasses from disagreeing about whether anyone is
				// listening.
				//
				// Transient: this is a device state, not something that happened
				// in the conversation, and replaying it on reconnect would turn
				// somebody's microphone on hours later.
				session.transient(msg.event("micRequested", { on: decision.on }));
				// Said out loud, because the user who just turned their own
				// microphone off needs to know it worked — and the lens status
				// they would otherwise read it from is about to say "mic off"
				// for a different reason.
				session.transient(msg.text(decision.on ? "Mic on." : "Mic off. Hold to talk.", "system", COMMAND));
				log?.info(`mic ${decision.on ? "on" : "off"} by voice session=${session.id.slice(0, 8)}`);
				return;

			case "display":
				// The lens is the client's, like the microphone. Transient for the
				// same reason: a device state, not the conversation, and a
				// replayed "display off" would darken somebody's glasses on a
				// reconnect a day later.
				session.transient(msg.event("displayRequested", { on: decision.on }));
				// The confirmation of "off" is read on the phone, not the lens —
				// the lens is dark, which is the confirmation.
				session.transient(msg.text(decision.on ? "Display on." : "Display off. Say display on to light it.", "system", COMMAND));
				log?.info(`display ${decision.on ? "on" : "off"} by voice session=${session.id.slice(0, 8)}`);
				return;

			case "noise":
				// The microphone is the client's, so the server asks and the
				// client records. Transient: a replayed request would start a
				// recording on a reconnect hours later.
				if (!noiseDir) return session.transient(msg.text("This server keeps no noise recordings.", "system", COMMAND));
				session.transient(msg.event("noiseRequested", { seconds: decision.seconds }));
				session.transient(msg.text(`Recording noise for ${decision.seconds} s. Stay quiet.`, "system", COMMAND));
				log?.info(`noise recording requested ${decision.seconds}s session=${session.id.slice(0, 8)}`);
				return;

			case "dropped":
				// The rest of a sentence whose beginning was addressed. In ByName
				// an unaddressed fragment is dropped, which is right for ambient
				// speech and wrong for the second half of an instruction the user
				// addressed two seconds ago — they said the name once, the way
				// people do. An open window is the evidence that they did: there
				// is no hold unless something got through the gate just now.
				if (joining) {
					const open = holds.get(session.id);
					return hold(session, open.to, open.name, text, origin);
				}
				// Reported, never silent. A user whose words are being dropped
				// needs to know which of the two reasons it is, or the system is
				// simply broken as far as they can tell.
				//
				// Transient, like the `heard` above: nothing happened, and in
				// Ignore mode with a microphone open this is two entries per
				// sentence somebody said to somebody else.
				session.transient(msg.event("notHeard", { reason: decision.reason, mode: session.mode, worker: session.worker }));
				// No turn began, but the client may have gone busy the moment the
				// user spoke. Close it, or the lens sits on "thinking" for an
				// utterance nobody is answering.
				session.transient(state(session, false));
				log?.info(`dropped (${decision.reason}) session=${session.id.slice(0, 8)} mode=${session.mode}`);
				return;

			case "mike":
				return await hold(session, "mike", null, decision.text, origin);

			case "worker":
				// The name is resolved when the window closes, not here: see flush.
				return await hold(session, decision.name, decision.name, decision.text, origin);

			default:
				log?.warn(`routing returned ${decision.kind}`);
				return;
		}
	};

	return {
		onOpen(session) {
			// Greet once, on a conversation that has not started yet. R3.1 says
			// starting a session puts the user in front of Mike; saying it again
			// on every reconnect would be noise on a device that reconnects
			// whenever the phone changes network.
			if (session.seq === 0) session.emit(msg.text(GREETING, "mike"));
			session.emit(state(session, false));
		},

		onClose(session) {
			// A microphone whose socket went away is not hearing anything we
			// will ever receive. Held words are kept — the phone reconnects
			// whenever it changes network — but the window stops waiting for a
			// fragment that cannot arrive.
			if (talking.has(session.id)) speaking(session, false);
		},

		async onMessage(session, m) {
			switch (m.type) {
				case C2S.SAY:
					// Absent means spoken. PRD 5a's audio path transcribes and
					// routes with `voice`; a keyboard client sends `typed`.
					return await utterance(session, m.text, m.origin === "typed" ? ORIGIN.TYPED : ORIGIN.VOICE);

				case C2S.AUDIO: {
					if (!receiveAudio) return session.emit(msg.error("this server has no transcription"));
					const heard = await receiveAudio(session, m);
					// null is silence, a refused segment, or a transcription that
					// came back empty. None of them is a turn (R5a.5) — but the
					// segment was the fragment a paused window was waiting for,
					// so the window's clock starts now, from nothing.
					if (!heard) {
						const open = holds.get(session.id);
						if (open) arm(session, open);
						return;
					}
					// Spoken, always: the microphone is the one input with an
					// ambient problem, which is the whole reason the gate exists.
					return await utterance(session, heard.text, ORIGIN.VOICE, heard);
				}

				case C2S.NOISE: {
					if (!noiseDir) return session.emit(msg.error("this server keeps no noise recordings"));
					const seg = decodeSegment(m, { maxBytes: NOISE_MAX_BYTES });
					if (!seg.ok) return session.transient(msg.text(`Noise not saved: ${seg.error}.`, "system", COMMAND));
					try {
						const r = saveNoise(noiseDir, seg.pcm, { device: m.device });
						log?.info(`noise saved ${r.file} ${r.durationMs}ms level ${r.levelDb} floor ${r.floorDb} peak ${r.peakDb} session=${session.id.slice(0, 8)}`);
						session.transient(msg.text(`Noise saved, ${Math.round(r.durationMs / 1000)} s: level ${r.levelDb}, floor ${r.floorDb}, peak ${r.peakDb} dBFS.`, "system", COMMAND));
					} catch (e) {
						log?.error(`noise not saved: ${e.message}`);
						session.transient(msg.text(`Noise not saved: ${lens(e)}`, "system", COMMAND));
					}
					return;
				}

				case C2S.SPEAKING:
					return speaking(session, m.on);

				case C2S.INTERRUPT:
					// The same thing the spoken word does. A button and a word must
					// not be able to stop different amounts of work.
					stopTurns(session);
					return;

				case C2S.CONTROL:
					return handleControl(session, m);

				default:
					log?.warn(`handler ignored ${m.type}`);
			}
		}
	};

	function handleControl(session, m) {
		switch (m.action) {
			case CONTROL.SET_TITLE:
				if (typeof m.args?.title !== "string") return session.emit(msg.error("setTitle needs a title"));
				session.title = m.args.title.slice(0, 120);
				session.store.touch(session);
				return session.emit(msg.event("titleChanged", { title: session.title }));

			case CONTROL.SET_MODE: {
				// The typed equivalent of the spoken command, so the desktop and
				// the glasses behave alike (R5a.4).
				const to = String(m.args?.mode ?? "").toLowerCase();
				if (!isMode(to)) return session.emit(msg.error(`mode must be ${Object.values(MODES).join(", ")}`));
				return setMode(session, to);
			}

			case CONTROL.SWITCH_WORKER: {
				// The client's own switch, next to Mike's `switch_worker` tool.
				// It exists because a phone has a list and a finger, and asking the
				// user to speak a sentence to tap a row would be silly.
				const name = m.args?.name;
				if (name === null) {
					session.worker = null;
					session.store.touch(session);
					session.emit(msg.event("workerSwitched", { active: null }));
					return session.emit(state(session, false));
				}
				const w = registry.get(name);
				if (!w) return session.emit(msg.error(`no worker called "${String(name ?? "").slice(0, 24)}"`));
				session.worker = w.name;
				session.store.touch(session);
				session.emit(msg.event("workerSwitched", { active: w.name, worker: { name: w.name, model: w.model, cwd: w.cwd } }));
				return session.emit(state(session, false));
			}

			case CONTROL.WHO_IS: {
				// "What is the id of the worker I am talking to" — the PC handoff
				// (`claude --resume <id>`) needs a way to ask that does not cost a
				// model turn. Mike can also be asked in words.
				const w = m.args?.name ? registry.get(m.args.name) : activeWorker(session);
				if (!w) return session.emit(msg.error("no such worker"));
				return session.emit(msg.event("workerIdentity", {
					name: w.name, model: w.model, cwd: w.cwd,
					sessionId: w.engineSessionId ?? null,
					resume: w.engineSessionId ? `claude --resume ${w.engineSessionId}` : null,
					started: !!w.engineSessionId
				}));
			}

			default:
				return session.emit(msg.error(`unknown control "${String(m.action).slice(0, 30)}"`));
		}
	}
}
