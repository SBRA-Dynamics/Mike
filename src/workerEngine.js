// The worker seam.
//
// PRD 2 owns the tool surface, not the workers. A worker is a real Claude Code
// session — `claude --session-id --model --resume` driven by the server — and
// building that is PRD 3. This file is to PRD 2 what handler.js is to PRD 1:
// a stub with a documented contract, so the tools can be written, tested and
// exercised end to end against something that genuinely changes state, and
// PRD 3 swaps the implementation without touching workers.js, tools.js, mcp.js
// or server.js.
//
// The contract a real engine must honor:
//
//   async start(worker, { prompt })  -> { engineSessionId }
//        Bring the worker's session into existence. Called once, from
//        spawn_worker, before the tool answers. Must be quick or must not
//        block: the user is waiting on a lens. `prompt` is optional first work.
//
//   async send(worker, text)         -> { text }
//        One turn. May be long-running. The caller marks the worker busy
//        around it.
//
//   transcript(worker, turns)        -> [{ role, text, at }]
//        The last `turns` exchanges, newest last. `read_worker` quotes these
//        into Jarvis's context, so it must be cheap and bounded.
//
//   async stop(worker)               -> void
//        End the session. The transcript is kept (PRD 3 "end: explicit;
//        transcript is kept"); only the process goes away.
//
// Nothing in the contract knows about MCP, sessions, or the wire protocol. An
// engine that spawns processes and one that echoes are interchangeable, which
// is the whole point of the seam.

/** How much transcript any one engine keeps per worker. Bounded because
 *  read_worker's cost is paid out of Jarvis's context window. */
const TRANSCRIPT_DEPTH = 60;

/**
 * The stub. Keeps a per-worker transcript in memory and answers turns by
 * echoing, the same shape and for the same reason as PRD 1's echo handler.
 *
 * Deliberately in memory only: a transcript that survived a restart here would
 * be a second, competing store next to the one Claude Code already keeps on
 * disk, and PRD 3 has to reconcile it. Restart-survival is the registry's job
 * (names, ids, models) and it does that.
 */
export function createStubWorkerEngine({ log } = {}) {
	const threads = new Map();   // worker.id -> [{ role, text, at }]

	const thread = (worker) => {
		let t = threads.get(worker.id);
		if (!t) { t = []; threads.set(worker.id, t); }
		return t;
	};

	const append = (worker, role, text) => {
		const t = thread(worker);
		t.push({ role, text, at: Date.now() });
		if (t.length > TRANSCRIPT_DEPTH) t.splice(0, t.length - TRANSCRIPT_DEPTH);
	};

	return {
		name: "stub",

		async start(worker, { prompt } = {}) {
			log?.info(`worker start ${worker.name} model=${worker.model} cwd=${worker.cwd} (stub engine)`);
			// A real engine returns the Claude Code session id here; the registry
			// keeps it so a restart can --resume. The stub has none, and says so
			// rather than inventing one that would look resumable and not be.
			if (prompt) await this.send(worker, prompt);
			return { engineSessionId: null };
		},

		async send(worker, text) {
			append(worker, "user", text);
			const reply = `(stub ${worker.model}) ${text}`;
			append(worker, "assistant", reply);
			return { text: reply };
		},

		transcript(worker, turns = 6) {
			const t = threads.get(worker.id) ?? [];
			// A "turn" the user means is an exchange, not a message.
			return t.slice(-Math.max(1, turns) * 2);
		},

		async stop(worker) {
			log?.info(`worker stop ${worker.name} (stub engine)`);
			// Transcript intentionally kept: PRD 3 keeps it too.
		}
	};
}
