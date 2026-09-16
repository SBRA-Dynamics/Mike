// The worker seam.
//
// PRD 2 owns the tool surface, not the workers, so it shipped a stub here with
// a documented contract — the same thing handler.js was to PRD 1. PRD 3 filled
// it in: createClaudeWorkerEngine below drives real Claude Code sessions, and
// nothing in workers.js, tools.js or mcp.js changed to let it.
//
// Both live here on purpose. The stub is what `--engine stub` selects, and it
// is what PRD 2's suite is pinned to: a tool surface should be testable without
// a model in the path, and a seam that only has one implementation left has
// stopped being a seam.
//
// The contract either engine honors:
//
//   async start(worker, { prompt })  -> { engineSessionId }
//        Bring the worker's session into existence. Called once, from
//        spawn_worker, before the tool answers. Must be quick or must not
//        block: the user is waiting on a lens. `prompt` is optional first work.
//
//   async send(worker, text, { onProgress, ticket }) -> { text }
//        One turn. May be long-running. The caller marks the worker busy
//        around it. A `ticket` whose `withdrawn` is set before the turn
//        reaches the model fails as interrupted instead ("rewind"); the
//        engine sets `begun` at the point that is no longer possible.
//
//   transcript(worker, turns)        -> [{ role, text, at }]
//        The last `turns` exchanges, newest last. `read_worker` quotes these
//        into Mike's context, so it must be cheap and bounded.
//
//   async stop(worker)               -> void
//        End the session. The transcript is kept (PRD 3 "end: explicit;
//        transcript is kept"); only the process goes away.
//
//   async reset(worker)              -> { engineSessionId }
//        Start the worker over: whatever it is doing is stopped, its session
//        and its transcript are left behind, and it gets a fresh session id.
//        The caller keeps name, model, folder and system prompt — a reset
//        forgets the conversation, not the job.
//
//   interrupt(worker)                -> boolean
//        Stop a turn in flight, for PRD 1's `interrupt`. True when there was
//        one. Added by PRD 3: a turn that takes minutes has to be stoppable
//        from the lens, and the stub answers it honestly with false.
//
//   dispose()                        -> void
//        Reap everything. A server that exits leaving `claude` processes
//        behind is spending money nobody is reading.
//
// Nothing in the contract knows about MCP, sessions, or the wire protocol. An
// engine that spawns processes and one that echoes are interchangeable, which
// is the whole point of the seam.

/** How much transcript any one engine keeps per worker. Bounded because
 *  read_worker's cost is paid out of Mike's context window. */
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

		async send(worker, text, { onProgress, ticket } = {}) {
			// Nothing queues here, so a turn has begun the moment it is sent.
			if (ticket?.withdrawn) { const e = new Error("stopped"); e.kind = "interrupted"; throw e; }
			if (ticket) ticket.begun = true;
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
		},

		async reset(worker) {
			threads.delete(worker.id);
			log?.info(`worker reset ${worker.name} (stub engine)`);
			return { engineSessionId: null };
		},

		// The seam is only a seam if both sides answer the same calls. The stub
		// has nothing running, so both of these are honestly nothing.
		interrupt() { return false; },
		dispose() { }
	};
}

// ---------------------------------------------------------------------------
// The real engine: one Claude Code session per worker, one process per turn.
// ---------------------------------------------------------------------------
//
// Two things the stub could pretend about and this cannot:
//
//  * `engineSessionId`. It is generated here and handed back to the registry so
//    a restart can `--resume` it and so Mike can read it out for the PC
//    handoff. It is OUR uuid, passed to `--session-id` on the first turn — not
//    something parsed out of the CLI afterwards, because a worker must have an
//    id the moment it exists, before it has said anything.
//
//  * The transcript. Claude Code keeps its own under ~/.claude/projects, and
//    parsing it was the obvious idea and the wrong one: T1 measured an
//    interactive session writing nothing there at all, and the file is a tree
//    once anything has forked it. What `read_worker` and PRD 3's context
//    injection need is "the turns the server drove", which the server knows
//    first-hand. So the engine keeps its own JSONL per worker, keyed by the
//    worker's server-side uuid. A spoken name never becomes a filename.
//
// Turns are serialised per worker. That is the direct consequence of T1: two
// drivers of one session fork it and one of them is silently unsaid, so the
// server never becomes the second driver of its own worker.

import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync, readFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { PromptFile, fillTemplate } from "./promptFile.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeRunner, ChildTracker, DEFAULT_WORKER_TIMEOUT_MS } from "./claudeCli.js";
import { extraMcpServers, mcpWildcard } from "./mcpServers.js";

/** Kept in memory per worker; the file on disk is the authority across a
 *  restart. Bounded for the same reason TRANSCRIPT_DEPTH is. */
const MEMORY_DEPTH = TRANSCRIPT_DEPTH;

/** How much of a worker's turn we are willing to quote. A worker that answers
 *  with a 40 kB file listing must not blow out Mike's context when he is
 *  asked what it is doing. */
const MAX_QUOTED_CHARS = 4000;

const clip = (s, n = MAX_QUOTED_CHARS) => {
	const t = String(s ?? "");
	return t.length <= n ? t : t.slice(0, n) + ` …[${t.length - n} more characters]`;
};

/**
 * A real worker engine.
 *
 * `dataDir` is where transcripts live; `runner` is injectable so tests can
 * drive the real engine against a stand-in binary rather than the real CLI.
 */
export function createClaudeWorkerEngine({
	log, dataDir, bin = "claude", runner, tracker = new ChildTracker(),
	timeoutMs = DEFAULT_WORKER_TIMEOUT_MS, env, permissions = "readonly", promptFile, extraServers
} = {}) {
	if (!dataDir) throw new Error("createClaudeWorkerEngine needs a dataDir for transcripts");

	// The operator's own MCP servers (mcpServers.js). A worker gets those and
	// nothing else: Mike's tool server is his, a worker holds no grant for it
	// (R2.4), and there is no third source, because a config passed at all is
	// passed with --strict-mcp-config.
	//
	// With no such file there is no config and no --allowedTools, which is
	// exactly what a worker turn looked like before this existed. That is on
	// purpose: passing an empty config would quietly switch every worker on
	// every installation into strict mode, which is a different change from the
	// one this is.
	const extra = extraServers ?? extraMcpServers({ log });
	const extraNames = Object.keys(extra);
	const extraConfig = extraNames.length ? JSON.stringify({ mcpServers: extra }) : null;
	const extraTools = extraNames.map(mcpWildcard);

	// The template every worker's system prompt is built from. Re-read when it
	// changes, so an edit reaches the next turn of every worker at once — the
	// same contract Mike's own prompt has.
	//
	// It is applied on EVERY turn, not just the first, and always with
	// --system-prompt-snapshot off. Claude Code otherwise replays the prompt
	// recorded when the session was created, and editing the template would do
	// nothing until each worker was thrown away.
	const template = new PromptFile(
		promptFile ?? join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "worker.md"),
		log, "worker prompt");

	/** What this particular one is told about itself. PRD 3 says a worker is not
	 *  told it is a worker; a name, a directory and what it is for are facts
	 *  about its own job, not about the arrangement around it. */
	const promptFor = (worker) => fillTemplate(template.read(), {
		name: worker.name,
		model: worker.model,
		cwd: worker.cwd,
		systemPrompt: worker.systemPrompt ?? ""
	}) || undefined;

	const dir = join(dataDir, "transcripts");
	mkdirSync(dir, { recursive: true });

	const cli = runner ?? createClaudeRunner({ bin, log, tracker, timeoutMs, env });

	const threads = new Map();    // worker.id -> [{ role, text, at }]
	const queues = new Map();     // worker.id -> promise chain (one turn at a time)
	const inflight = new Map();   // worker.id -> child process, for interrupt
	// See mike.js: an interrupt bumps the worker's generation, and a queued
	// turn from an older generation fails as interrupted instead of running.
	const epochs = new Map();     // worker.id -> generation
	const waiting = new Map();    // worker.id -> turns queued but not started

	// A worker id is a server-generated uuid (workers.js), and this is the one
	// place it becomes a path. Checked anyway: the cost is a regex and the bug
	// it prevents once wrote a file called /ESCAPED.jsonl.
	const pathFor = (worker) => {
		if (!/^[0-9a-f-]{36}$/i.test(String(worker.id))) throw new Error(`unsafe worker id ${JSON.stringify(worker.id)}`);
		return join(dir, `${worker.id}.jsonl`);
	};

	const thread = (worker) => {
		let t = threads.get(worker.id);
		if (t) return t;
		t = [];
		const p = pathFor(worker);
		if (existsSync(p)) {
			for (const line of readFileSync(p, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const v = JSON.parse(line);
					if (v?.role && typeof v.text === "string") t.push(v);
				} catch { /* a torn last line from a crash; the rest is still good */ }
			}
			if (t.length > MEMORY_DEPTH) t.splice(0, t.length - MEMORY_DEPTH);
		}
		threads.set(worker.id, t);
		return t;
	};

	const append = (worker, role, text) => {
		const entry = { role, text: clip(text), at: Date.now() };
		const t = thread(worker);
		t.push(entry);
		if (t.length > MEMORY_DEPTH) t.splice(0, t.length - MEMORY_DEPTH);
		try { appendFileSync(pathFor(worker), JSON.stringify(entry) + "\n"); }
		catch (e) { log?.error(`worker transcript ${worker.name}: ${e.message}`); }
	};

	/** Run `fn` after whatever this worker is already doing. The chain is the
	 *  serialisation T1 requires; it is per worker, so two workers still run at
	 *  the same time. */
	const enqueue = (worker, fn) => {
		const prev = queues.get(worker.id) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		// The chain that the NEXT caller waits on must never be a rejected
		// promise: one failed turn would otherwise poison every turn after it
		// with the first one's error. The caller still gets `next` and its
		// rejection; the chain gets the swallowed copy.
		queues.set(worker.id, next.then(() => { }, () => { }));
		return next;
	};

	/** True once the CLI has actually created this worker's session, so a later
	 *  turn resumes instead of trying to create it again.
	 *
	 *  Kept as a field on the worker record itself (persisted by the registry's
	 *  `touch`, same as `engineSessionId`), not read off the transcript: the
	 *  transcript is capped at TRANSCRIPT_DEPTH, and a worker long-lived enough
	 *  to scroll its "session-created" meta entry out of that window would
	 *  otherwise look brand new again and retry `--session-id` on an id the CLI
	 *  already has — which fails with "already in use" instead of resuming.
	 *  The transcript scan is kept as a fallback for records written before
	 *  this flag existed. */
	const sessionExists = (worker) => worker.sessionCreated === true
		|| thread(worker).some((e) => e.role === "meta" && e.text === "session-created");

	const turn = async (worker, text, onProgress) => {
		const first = !sessionExists(worker);
		const id = worker.engineSessionId;
		if (!id) throw new Error(`worker ${worker.name} has no session id`);

		const opts = {
			prompt: text,
			cwd: worker.cwd,
			model: worker.modelId ?? worker.model,
			permissions,
			appendSystemPrompt: promptFor(worker),
			...(extraConfig ? { mcpConfig: extraConfig, allowedTools: extraTools } : {}),
			onSpawn: (child) => inflight.set(worker.id, child),
			// PRD 6: partial answers and tool names, while the turn is still
			// running. The caller decides whether anyone is listening.
			onProgress
		};

		let r = await cli.run({ ...opts, ...(first ? { sessionId: id } : { resume: id }) });

		// The CLI refused to create the id because it already has it: a first
		// turn that was stopped or timed out after the session existed, or a
		// process of ours that was killed and left the id behind. Resuming is
		// what we would have done had we known, and the retry is the difference
		// between that and a worker nobody can talk to again.
		if (first && r.sessionTaken) {
			log?.warn(`worker ${worker.name} session ${String(id).slice(0, 8)} already exists; resuming it instead of creating it`);
			worker.sessionCreated = true;
			append(worker, "meta", "session-created");
			r = await cli.run({ ...opts, resume: id });
		}
		inflight.delete(worker.id);

		// Recorded on the strength of the CLI having named the session, not of
		// the turn having worked. Both halves matter: a spawn that never got off
		// the ground must NOT be recorded, or every later turn resumes an id
		// that was never created; and every failure AFTER the session exists —
		// an API error (exit 0 with is_error), a turn the user stopped, a
		// timeout — must be, or every later turn tries to create it again and
		// fails with "already in use". The CLI names the session on the stream's
		// first event, which is what makes that knowable.
		if (first && (r.ok || r.sessionId) && !worker.sessionCreated) {
			worker.sessionCreated = true;
			append(worker, "meta", "session-created");
		}

		if (!r.ok) {
			log?.warn(`worker ${worker.name} turn failed (${r.kind}): ${r.error}`);
			const e = new Error(r.error || "the worker could not answer");
			e.kind = r.kind;
			// See mike.js: a turn cut at the cap still said something, and that
			// something is the answer as far as anyone is concerned.
			if (r.partial) e.partial = r.partial;
			throw e;
		}
		log?.info(`worker ${worker.name} turn ok in ${r.durationMs}ms cost=$${(r.costUsd ?? 0).toFixed(4)}`);
		return r;
	};

	return {
		name: "claude",
		cli,

		async start(worker, { prompt } = {}) {
			// The id is minted, not discovered. Nothing is spawned here: PRD 2
			// says start must be quick because the user is waiting on a lens, and
			// a warm-up turn would cost a model call per worker for nothing.
			//
			// The consequence is honest and worth knowing: `claude --resume <id>`
			// in a terminal only works once the worker has taken its first turn,
			// because that is when the CLI creates the session.
			const engineSessionId = worker.engineSessionId ?? randomUUID();
			worker.engineSessionId = engineSessionId;
			log?.info(`worker start ${worker.name} model=${worker.model} cwd=${worker.cwd} session=${engineSessionId.slice(0, 8)}`);
			if (prompt) {
				// Deliberately awaited: spawn_worker reports the worker as ready,
				// and a first instruction that fails should fail the spawn rather
				// than vanish.
				await this.send(worker, prompt);
			}
			return { engineSessionId };
		},

		async send(worker, text, { onProgress, ticket } = {}) {
			// A record written by the stub engine (or by a build before PRD 3)
			// has no session id. Minting one here rather than refusing means a
			// data directory survives the engine being switched; the registry
			// persists it on the next touch, which the caller does every turn.
			if (!worker.engineSessionId) {
				worker.engineSessionId = randomUUID();
				log?.info(`worker ${worker.name} had no session id; minted ${worker.engineSessionId.slice(0, 8)}`);
			}
			const at = epochs.get(worker.id) ?? 0;
			waiting.set(worker.id, (waiting.get(worker.id) ?? 0) + 1);
			return enqueue(worker, async () => {
				waiting.set(worker.id, waiting.get(worker.id) - 1);
				if (at !== (epochs.get(worker.id) ?? 0) || ticket?.withdrawn) {
					// Never delivered, so not in the transcript either: a worker
					// quoted these words later would be answering an instruction
					// the user withdrew.
					const e = new Error("stopped");
					e.kind = "interrupted";
					throw e;
				}
				if (ticket) ticket.begun = true;
				append(worker, "user", text);
				try {
					const r = await turn(worker, text, onProgress);
					append(worker, "assistant", r.text);
					return { text: r.text };
				} catch (e) {
					// The failure goes in the transcript too. A worker whose turn
					// died and left no trace reads, next time Mike quotes it, as
					// a worker that was never asked. An interrupt is recorded as
					// what it was: Mike reading "(no answer: stopped)" back would
					// have him apologising for something the user chose.
					// A cut-off turn goes in as what it said, with a note of the
					// cut — not as "(no answer)", which would be a lie the next
					// turn reads back as if the worker had sat there silent.
					if (e.partial) append(worker, "assistant", `${e.partial}\n(${e.message})`);
					else append(worker, "assistant", e.kind === "interrupted" ? "(stopped by the user)" : `(no answer: ${e.message})`);
					throw e;
				}
			});
		},

		transcript(worker, turns = 6) {
			// Bookkeeping entries are ours, not the conversation's: quoting
			// "session-created" back to Mike would be noise he has to reason
			// about, and read_worker's cost is paid in his context.
			const t = thread(worker).filter((e) => e.role !== "meta");
			return t.slice(-Math.max(1, turns) * 2);
		},

		/** Stop a turn in flight. Nothing else to stop: there is no resident
		 *  process between turns. */
		interrupt(worker) {
			const dropped = waiting.get(worker.id) ?? 0;
			epochs.set(worker.id, (epochs.get(worker.id) ?? 0) + 1);
			const child = inflight.get(worker.id);
			if (!child) {
				if (dropped) log?.info(`worker ${worker.name} interrupted: ${dropped} queued turn(s) dropped`);
				return dropped > 0;
			}
			// Flagged before the kill, so claudeCli reports "stopped" rather than
			// a crashed process: an interrupt is a thing the user did, not a
			// failure they have to read an error about.
			child.interrupted = true;
			try { child.kill("SIGKILL"); } catch { }
			inflight.delete(worker.id);
			log?.info(`worker ${worker.name} interrupted`);
			return true;
		},

		async stop(worker) {
			this.interrupt(worker);
			queues.delete(worker.id);
			threads.delete(worker.id);
			// The transcript file stays: PRD 3 says ending a worker keeps it, and
			// the Claude Code session on disk is untouched either way, so the id
			// is still resumable from a terminal afterwards.
			log?.info(`worker stop ${worker.name} (session ${String(worker.engineSessionId).slice(0, 8)} kept)`);
		},

		async reset(worker) {
			// The turn in flight is killed and the queue drained BEFORE anything
			// is cleared. A first turn dying late would otherwise mark the NEW
			// session as created, and every turn after it would --resume an id
			// the CLI has never seen.
			this.interrupt(worker);
			await (queues.get(worker.id) ?? Promise.resolve());
			queues.delete(worker.id);
			threads.delete(worker.id);
			waiting.delete(worker.id);

			// Moved aside, not deleted: the old conversation is still worth
			// reading afterwards, it just must not be quoted as this one.
			const before = worker.engineSessionId;
			try {
				const p = pathFor(worker);
				if (existsSync(p)) renameSync(p, p.replace(/\.jsonl$/, `.reset-${Date.now()}.jsonl`));
			} catch (e) { log?.error(`worker reset ${worker.name}: transcript not moved: ${e.message}`); }

			worker.engineSessionId = randomUUID();
			worker.sessionCreated = false;
			log?.info(`worker reset ${worker.name} session ${String(before).slice(0, 8)} -> ${worker.engineSessionId.slice(0, 8)}`);
			return { engineSessionId: worker.engineSessionId };
		},

		/** Forget a worker's transcript entirely. Not part of the engine
		 *  contract; used by tests so one run cannot see another's. */
		forget(worker) {
			threads.delete(worker.id);
			try { const p = pathFor(worker); if (existsSync(p)) unlinkSync(p); } catch { }
		},

		/** Reap everything on shutdown. A server that exits leaving `claude`
		 *  processes behind is spending money nobody is reading. */
		dispose() {
			for (const [, child] of inflight) { try { child.kill("SIGKILL"); } catch { } }
			inflight.clear();
			cli.killAll?.();
		}
	};
}
