// Taking a terminal's Claude Code session over as a worker — now, or when it is
// done.
//
// `adopt` is the move itself, shared by `connect_terminal` and the watch below.
// It never decides who the user is talking to; the caller does. That split is
// the point of this file: asked for in words, a connection switches the
// conversation (the user just said so). Arriving on its own, minutes later, it
// must not — the user is washing up or talking to somebody else, and a lens
// that changed addressee by itself would send their next sentence to the wrong
// place. A session that finished while nobody was looking is moved over and
// announced in the title bar, and switching to it is the user's word.
//
// The watch polls `claude agents`, because nothing else says when a background
// session finishes. It runs only while something is waited on, every
// `pollMs`, and a session counts as finished only when it has been seen idle
// twice in a row: one listing between two API calls of a long turn must not
// cut the turn off.

import { ToolError } from "./workers.js";
import { modelLabelOf } from "./terminals.js";
import { msg } from "./protocol.js";

export const DEFAULT_POLL_MS = 5000;

/** Idle listings in a row before a waited-on session counts as done. */
const IDLE_CONFIRMATIONS = 2;

export function createHandoff({ registry, engine, terminals, log, present, lastSaid, pollMs = DEFAULT_POLL_MS }) {
	const labelOf = (s) => s.name ?? s.id ?? s.sessionId.slice(0, 8);

	/**
	 * Make `found` a worker. Returns { worker, created, stopped }, or throws a
	 * ToolError that leaves the terminal exactly as it was.
	 */
	const adopt = async (found, { name } = {}) => {
		const label = labelOf(found);
		const live = terminals.isLive(found);

		// Somebody already driving it outside the background service — a plain
		// `claude` in a window, or `claude -p`. Stopping that is killing a
		// terminal the user may be typing into.
		if (live && found.kind !== "background") {
			const own = registry.list().find((w) => w.engineSessionId === found.sessionId);
			if (own?.busy) throw new ToolError(`${own.name} is busy with a turn right now`);
			throw new ToolError(`${label} is open in a terminal window; close it there first`);
		}
		// Stopping a turn in flight would throw away work the user left running
		// on purpose. The caller decides whether to wait for it instead.
		if (live && found.status === "busy") {
			const e = new ToolError(`${label} is still working`);
			e.busy = true;
			throw e;
		}

		let worker = registry.get(registry.list().find((w) => w.engineSessionId === found.sessionId)?.name ?? "");
		let created = false;
		let history = [];
		if (!worker) {
			const wanted = name?.trim() || found.name || registry.freeName(await terminals.takenNames());
			if (registry.get(wanted)) throw new ToolError(`a worker is already called ${registry.get(wanted).name}; say what to call this one`);
			const tail = terminals.tail(found.sessionId);
			// Created before the terminal is stopped: a folder that no longer
			// exists must fail here, while the session is still running where the
			// user left it.
			worker = registry.create({ name: wanted, model: modelLabelOf(tail.model) ?? undefined, cwd: found.cwd, systemPrompt: "" });
			history = tail.entries;
			created = true;
		}

		if (live && !(await terminals.stop(found))) {
			if (created) registry.remove(worker.name);
			throw new ToolError(`could not take ${label} from the terminal`);
		}

		if (created) {
			try {
				const r = await engine.adopt(worker, { sessionId: found.sessionId, history });
				registry.touch(worker, { engineSessionId: r?.engineSessionId ?? found.sessionId, sessionCreated: true });
			} catch (e) {
				registry.remove(worker.name);
				log?.error(`connect ${label}: engine adopt failed: ${e.stack || e.message}`);
				throw new ToolError(`could not connect to ${label}`);
			}
		} else {
			registry.touch(worker);
		}
		log?.info(`terminal ${label} ${created ? "adopted as" : "taken back by"} worker ${worker.name} (session ${found.sessionId.slice(0, 8)}${live ? ", terminal process stopped" : ""})`);
		return { worker, created, stopped: live };
	};

	// ------------------------------------------------------------------ the watch

	const waits = new Map();     // sessionId -> { label, name, store, sessionId (ours), idle }
	let timer = null;
	let ticking = false;

	/** Tell the conversation that asked. Only that one: it is the user who
	 *  said "connect to Minnie" there who is waiting to hear about it. */
	const tell = (w, message) => {
		const session = w.store.get(w.conversation);
		if (session) session.emit(message);
	};

	const moved = (w, worker) => {
		const last = lastSaid(worker);
		// What it said when it finished, into the transcript as a background
		// line: the phone shows it at once, the lens does not take it, and
		// "switch to Minnie" puts it on the lens as where she left off.
		if (last?.text) tell(w, msg.text(last.text, worker.name, { background: true }));
		// No `active` in here, deliberately. The client treats an event that
		// names who is active as a change of addressee.
		tell(w, msg.event("workerMoved", { worker: present(worker), terminal: w.label, summary: `${worker.name} moved over` }));
	};

	const tick = async () => {
		if (ticking) return;
		ticking = true;
		try {
			const all = await terminals.sessions();
			for (const [sessionId, w] of [...waits]) {
				const s = all.find((x) => x.sessionId === sessionId);
				if (!s) {
					// Removed with `claude rm`, or the listing failed outright — which
					// returns nothing at all, so only give up when others are there.
					if (!all.length) continue;
					waits.delete(sessionId);
					log?.warn(`terminal ${w.label}: gone while waiting to take it over`);
					tell(w, msg.error(`${w.label} is gone from the terminal`));
					continue;
				}
				const ready = !terminals.isLive(s) || s.status !== "busy";
				w.idle = ready ? w.idle + 1 : 0;
				if (w.idle < IDLE_CONFIRMATIONS) continue;

				waits.delete(sessionId);
				try {
					const r = await adopt(s, { name: w.name });
					moved(w, r.worker);
				} catch (e) {
					if (e.busy) { waits.set(sessionId, { ...w, idle: 0 }); continue; }
					log?.warn(`terminal ${w.label}: done, but not moved over: ${e.message}`);
					tell(w, msg.error(`${w.label} is done but could not be moved over: ${e instanceof ToolError ? e.message : "that did not work"}`));
				}
			}
		} catch (e) {
			log?.error(`terminal watch: ${e.stack || e.message}`);
		} finally {
			ticking = false;
			if (!waits.size && timer) { clearInterval(timer); timer = null; }
		}
	};

	return {
		adopt,

		/** Take `found` over once it is done. True when it was already waited
		 *  on — the second ask is the same promise, not a second watch. */
		wait(found, { session, name }) {
			const already = waits.has(found.sessionId);
			waits.set(found.sessionId, {
				label: labelOf(found), name, idle: 0,
				store: session.store, conversation: session.id
			});
			if (!timer) {
				timer = setInterval(tick, pollMs);
				timer.unref?.();
			}
			log?.info(`terminal ${labelOf(found)}: busy; taking it over when it is done`);
			return already;
		},

		/** Names being waited on, for a list that should say so. */
		waiting: () => [...waits.values()].map((w) => w.label),

		dispose() {
			if (timer) clearInterval(timer);
			timer = null;
			waits.clear();
		}
	};
}
