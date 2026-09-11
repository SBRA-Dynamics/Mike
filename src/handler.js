// The conversation seam — PRD 3.
//
// PRD 1 owns transport, not conversation, and shipped an echo handler so the
// transport could be exercised on its own. Both handlers live here now: the
// echo one is still what the PRD 1 suites pin the transport with (`--handler
// echo`), and the Jarvis one is the product.
//
// The contract, unchanged:
//   onMessage(session, msg, ctx)  — may be async and long-running
//   onOpen(session, ctx)          — optional
//   onClose(session, ctx)         — optional; must not cancel work in flight
//
// What this file is responsible for, and nothing else is:
//   * classifying every utterance (routing.js decides, this applies)
//   * keeping `busy`, `worker` and `mode` truthful in every `state` message
//   * making sure a failed turn is a sentence, not a stack trace

import { C2S, CONTROL, msg } from "./protocol.js";
import { MODES, MODE_LABEL, applyModeCommand, isMode, route, ORIGIN } from "./routing.js";

export function createEchoHandler({ log }) {
	return {
		onOpen(session, { resumed }) {
			if (!resumed) session.emit(msg.text("Jarvis transport online (echo handler).", "system"));
		},

		async onMessage(session, m) {
			switch (m.type) {
				case C2S.SAY: {
					session.emit(msg.state({ busy: true, worker: session.worker, mode: session.mode }));
					// A deliberate pause: it makes "a turn survives a disconnect"
					// testable, and mirrors the shape of a real model call.
					await new Promise((r) => setTimeout(r, 150));
					session.emit(msg.text(`echo: ${m.text}`, "echo"));
					session.emit(msg.state({ busy: false, worker: session.worker, mode: session.mode }));
					break;
				}
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
				case C2S.AUDIO:
					session.emit(msg.error("audio is not implemented until PRD 5"));
					break;
				default:
					log.warn(`handler ignored ${m.type}`);
			}
		}
	};
}

/** Kept short on purpose: it is the first thing on a fifty-column lens, and it
 *  is a fact about who is listening, not a welcome. */
const GREETING = "Jarvis here.";

/**
 * The real handler.
 *
 * `jarvis`, `registry` and `engine` are the three things a turn can be about;
 * everything else is plumbing this file borrows from the session.
 */
export function createJarvisHandler({ log, jarvis, registry, engine }) {

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
		session.emit(msg.text(`Input: ${MODE_LABEL[session.mode]}.`, "system"));
		// R5.4: the mode is part of the state message, and a client that only
		// watched `state` would otherwise never learn it changed.
		session.emit(state(session, false));
		log?.info(`mode ${before} -> ${session.mode} session=${session.id.slice(0, 8)}`);
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

	const toJarvis = async (session, text) => {
		session.emit(state(session, true));
		try {
			const r = await jarvis.say(session, text);
			// After the turn, not before: a tool call inside it may have switched
			// the active worker, and the reply has to be tagged and the state
			// reported as they are now.
			if (r.text) session.emit(msg.text(r.text, "jarvis"));
		} catch (e) {
			log?.error(`jarvis turn: ${e.stack || e.message}`);
			session.emit(msg.error(lens(e)));
		} finally {
			session.emit(state(session, false));
		}
	};

	const toWorker = async (session, worker, text) => {
		registry.touch(worker, { busy: true });
		session.emit(state(session, true));
		try {
			const r = await engine.send(worker, text);
			// Tagged with the worker's name, which is what `from` is for: the lens
			// has no room for a label unless it is short (PRD 1 R1.6).
			if (r.text) session.emit(msg.text(r.text, worker.name));
		} catch (e) {
			log?.error(`worker ${worker.name} turn: ${e.stack || e.message}`);
			session.emit(msg.error(`${worker.name}: ${lens(e)}`));
		} finally {
			registry.touch(worker, { busy: false });
			session.emit(state(session, false));
		}
	};

	/** One line, no stack, short enough for a lens — the same rule the tools
	 *  answer errors by (PRD 2 R2.5). */
	const lens = (e) => String(e?.message ?? e ?? "something went wrong").replace(/\s+/g, " ").trim().slice(0, 100);

	return {
		onOpen(session) {
			// Greet once, on a conversation that has not started yet. R3.1 says
			// starting a session puts the user in front of Jarvis; saying it again
			// on every reconnect would be noise on a device that reconnects
			// whenever the phone changes network.
			if (session.seq === 0) session.emit(msg.text(GREETING, "jarvis"));
			session.emit(state(session, false));
		},

		async onMessage(session, m) {
			switch (m.type) {
				case C2S.SAY: {
					const worker = activeWorker(session);
					const decision = route(m.text, {
						mode: session.mode, worker: worker?.name ?? null,
						// Absent means spoken. PRD 5's audio path transcribes and
						// routes with `voice`; a keyboard client sends `typed`.
						origin: m.origin === "typed" ? ORIGIN.TYPED : ORIGIN.VOICE
					});

					switch (decision.kind) {
						case "empty":
							return;

						case "mode":
							return setMode(session, decision.to);

						case "dropped":
							// Reported, never silent. A user whose words are being
							// dropped needs to know which of the two reasons it is,
							// or the system is simply broken as far as they can tell.
							session.emit(msg.event("notHeard", { reason: decision.reason, mode: session.mode, worker: session.worker }));
							// No turn began, but the client may have gone busy the
							// moment the user spoke. Close it, or the lens sits on
							// "thinking" for an utterance nobody is answering.
							//
							// Both of these go through emit(), so they are durable
							// and replayed. That is right today, when `say` is a
							// deliberate act. Once PRD 5 puts an always-on mic in
							// front of this, `Ignore` mode would write two entries
							// per overheard sentence into the transcript, and these
							// two want a transient per-connection channel — the one
							// `heard` will need anyway.
							session.emit(state(session, false));
							log?.info(`dropped (${decision.reason}) session=${session.id.slice(0, 8)} mode=${session.mode}`);
							return;

						case "jarvis":
							return await toJarvis(session, decision.text);

						case "worker": {
							// Re-resolved rather than trusting the name routing came
							// back with: nothing has awaited in between, but this is
							// the one place a name becomes an action.
							const w = registry.get(decision.name);
							if (!w) return session.emit(msg.error(`no worker called "${decision.name}"`));
							return await toWorker(session, w, decision.text);
						}

						default:
							log?.warn(`routing returned ${decision.kind}`);
							return;
					}
				}

				case C2S.INTERRUPT: {
					// Both, because the user does not know which of the two is
					// mid-turn and should not have to.
					const w = activeWorker(session);
					const stoppedWorker = w ? engine.interrupt(w) : false;
					const stoppedJarvis = jarvis.interrupt();
					session.emit(msg.event("interrupted", { stopped: stoppedWorker || stoppedJarvis }));
					session.emit(state(session, false));
					return;
				}

				case C2S.CONTROL:
					return handleControl(session, m);

				case C2S.AUDIO:
					session.emit(msg.error("audio is not implemented until PRD 5"));
					return;

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
				// the glasses behave alike (R5.4).
				const to = String(m.args?.mode ?? "").toLowerCase();
				if (!isMode(to)) return session.emit(msg.error(`mode must be ${Object.values(MODES).join(", ")}`));
				return setMode(session, to);
			}

			case CONTROL.SWITCH_WORKER: {
				// The client's own switch, next to Jarvis's `switch_worker` tool.
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
				// model turn. Jarvis can also be asked in words.
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
