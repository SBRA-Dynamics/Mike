// Mike — PRD 3.
//
// One Claude Code session, one stable id, never replaced, never forked, alive
// across restarts. He is not a session per client: every connected device talks
// to the same conversation, which is the whole of requirement 4 ("a main agent
// who is always the same conversation").
//
// Three things live here and nowhere else:
//
//  * His identity on disk — a small JSON file holding the session id, so a
//    restart resumes him instead of meeting him (R3.7).
//  * His system prompt — a file, re-read on every turn, so it can be edited
//    without a rebuild (PRD 3, "The prompt ships as a file, versioned").
//  * Worker context injection — the bracketed block that makes "the folder we
//    are talking about" resolve without the user naming it (R3.4).
//
// His turns are serialised for the same reason a worker's are: T1 measured two
// drivers of one session forking it and losing a turn with no error anywhere.
// Two devices asking Mike something at the same moment is the ordinary case,
// not the exotic one, so the queue is load-bearing.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { PromptFile } from "./promptFile.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeRunner, ChildTracker } from "./claudeCli.js";

/** Turns of worker conversation quoted to him when he is addressed. PRD 3 says
 *  start at 6; it is a flag because the right number depends on how chatty the
 *  workers are, which is not knowable from here. */
export const DEFAULT_CONTEXT_TURNS = 6;

/** …truncated to a token budget. Characters over four is the usual rough
 *  estimate and is deliberately rough: this is a cap to stop a worker's 40 kB
 *  file dump reaching him, not an accounting of his context window. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 1200;
const CHARS_PER_TOKEN = 4;

/** The built-in tools Mike is allowed, on top of the MCP tools. PRD 2 is
 *  explicit that shell is not a tool of ours — he is a Claude Code session and
 *  already has Bash, and a second path to the same capability only creates
 *  ambiguity about which one he should reach for. R3.4 needs this one. */
export const MIKE_BUILTIN_TOOLS = ["Bash", "Read", "Glob", "Grep"];

/** A worker's answer can be arbitrarily long; the quote of it must not be. */
const QUOTE_LIMIT = 600;

const oneLine = (s, n = QUOTE_LIMIT) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length <= n ? t : t.slice(0, n) + " …";
};

/**
 * Build the block PRD 3 shows, or null when there is no active worker.
 *
 * Oldest turns are dropped first when the budget is tight: the exchange the
 * user is asking about is the most recent one, and a block that leads with
 * ancient history and elides the sentence he just heard is worse than a short
 * block.
 */
export function buildWorkerContext(worker, lines, {
	turns = DEFAULT_CONTEXT_TURNS,
	budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS
} = {}) {
	if (!worker) return null;
	const head = `[The user is currently talking to worker "${worker.name}" (${worker.model}, ${worker.cwd}).`;
	if (!lines?.length) return `${head}\n Nothing has been said to it yet.]`;

	const quoted = lines
		.slice(-Math.max(1, turns) * 2)
		.map((l) => `   ${l.role === "user" ? "user" : worker.name}: ${oneLine(l.text)}`);

	const budget = Math.max(200, budgetTokens * CHARS_PER_TOKEN);
	let elided = 0;
	let size = quoted.reduce((n, l) => n + l.length + 1, 0);
	while (quoted.length > 1 && size > budget) {
		size -= quoted[0].length + 1;
		quoted.shift();
		elided++;
	}
	const note = elided ? `   …${elided} earlier line${elided === 1 ? "" : "s"} omitted\n` : "";
	return `${head}\n Recent exchange:\n${note}${quoted.join("\n")}]`;
}

/** What actually goes to the model: the block, then his words, in the shape
 *  PRD 3 specifies. Without a worker it is just what the user said — a block
 *  saying "there is no worker" would be one more thing for him to explain. */
export function composePrompt(text, context) {
	return context ? `${context}\n\nThe user says: ${text}` : text;
}

// ------------------------------------------------------------------ identity

/** His id on disk. One small file, rewritten whole through a temp file, the
 *  same shape and reasoning as SessionStore's meta. */
class MikeIdentity {
	constructor(file, log) {
		this.file = file;
		this.log = log;
		this.state = { version: 1, sessionId: null, createdAt: 0, turns: 0, started: false };
		this.#load();
		if (!this.state.sessionId) {
			this.state.sessionId = randomUUID();
			this.state.createdAt = Date.now();
			this.#save();
			log?.info(`mike: new session ${this.state.sessionId}`);
		} else {
			log?.info(`mike: resuming session ${this.state.sessionId} (${this.state.turns} turns)`);
		}
	}
	get sessionId() { return this.state.sessionId; }
	get started() { return this.state.started === true; }
	markStarted() { this.state.started = true; this.#save(); }
	countTurn() { this.state.turns++; this.#save(); }

	#load() {
		if (!existsSync(this.file)) return;
		try {
			const p = JSON.parse(readFileSync(this.file, "utf8"));
			// A session id becomes a `--session-id` argument and a filename inside
			// Claude Code's own store. It is ours and it is a uuid; anything else
			// on disk is a corrupt file, and starting fresh is the safe reading.
			if (typeof p?.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(p.sessionId)) this.state = { ...this.state, ...p };
			else this.log?.warn(`mike: ${this.file} has no usable session id; starting a new conversation`);
		} catch (e) {
			this.log?.error(`mike: could not read ${this.file}: ${e.message}; starting a new conversation`);
		}
	}
	#save() {
		const tmp = `${this.file}.tmp`;
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			writeFileSync(tmp, JSON.stringify(this.state));
			renameSync(tmp, this.file);
		} catch (e) { this.log?.error(`mike: could not persist identity: ${e.message}`); }
	}
}

// -------------------------------------------------------------------- prompt

/** The prompt file, re-read when it changes on disk. Cached on mtime so an
 *  edit lands on the next turn without a restart, and a busy hour does not
 *  become a stat-and-read per turn for nothing. */

// --------------------------------------------------------------------- agent

/**
 * Build Mike.
 *
 * `mcp` is the PRD 2 tool server: a grant is minted per turn and bound to the
 * session the utterance came from, which is what lets `spawn_worker` switch
 * "the active conversation" and not some global. The grant is passed on the
 * command line of a child process we spawn ourselves and never reaches a
 * client.
 */
export function createMike({
	log, dataDir, mcp, registry, engine,
	bin = "claude", runner, tracker = new ChildTracker(),
	model = "opus", cwd = process.cwd(), promptFile,
	contextTurns = DEFAULT_CONTEXT_TURNS,
	contextBudgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS,
	timeoutMs, env
} = {}) {
	if (!dataDir) throw new Error("createMike needs a dataDir");
	const identity = new MikeIdentity(join(dataDir, "mike.json"), log);
	const prompt = new PromptFile(promptFile ?? join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "mike.md"), log, "mike prompt");
	const cli = runner ?? createClaudeRunner({ bin, log, tracker, timeoutMs, env });

	let queue = Promise.resolve();
	let child = null;
	// A stop is a stop for everything said before it, not only for the turn
	// that happened to be running: the turns queued behind that one were also
	// "what he was about to do". They are dropped by generation — an interrupt
	// bumps it, and a queued turn from an older generation fails as interrupted
	// the moment its go comes, before any process is spawned.
	let epoch = 0;
	let waiting = 0;

	/** The context block for the worker this session is talking to. Read through
	 *  the registry so a stale name on the session — a worker ended from another
	 *  device — produces no block rather than a lie. */
	const contextFor = (session) => {
		const worker = session.worker ? registry.get(session.worker) : null;
		if (!worker) return null;
		return buildWorkerContext(worker, engine.transcript(worker, contextTurns), {
			turns: contextTurns, budgetTokens: contextBudgetTokens
		});
	};

	const runTurn = async (session, text, onProgress) => {
		// A grant only has to outlive the turn it was minted for. The default
		// hour would be fine except that the grant table evicts the oldest when
		// it fills, and an hour of busy use is more turns than it holds — which
		// would evict a grant out from under a turn still running on it.
		const grant = mcp.mintGrant({ sessionId: session.id, role: "mike", ttlMs: (timeoutMs ?? 600_000) + 60_000 });
		const first = !identity.started;
		const context = contextFor(session);

		const r = await cli.run({
			prompt: composePrompt(text, context),
			cwd,
			model,
			...(first ? { sessionId: identity.sessionId } : { resume: identity.sessionId }),
			appendSystemPrompt: prompt.read() || undefined,
			// sessionConfig, not config: this process is spawned here, on this
			// machine, so it is the one that may hold the operator's extra
			// servers and their credentials (mcp.js, mintGrant).
			mcpConfig: grant.sessionConfig,
			allowedTools: [
				...MIKE_BUILTIN_TOOLS,
				...mcp.allowedToolNames("mike")
			],
			onSpawn: (c) => { child = c; },
			// PRD 6: the turn is read as it is written, so the lens can stop
			// saying "thinking" and start saying what he is doing.
			onProgress
		});
		child = null;

		// Marked before the failure is raised, and on the strength of the CLI
		// having named the session rather than of the turn having worked. An API
		// error arrives as exit 0 with is_error set, and by then the session
		// exists — so retrying the next turn with --session-id would fail
		// forever with "already exists", and Mike would be unreachable because
		// of one bad minute at Anthropic.
		if (first && (r.ok || r.sessionId)) identity.markStarted();

		if (!r.ok) {
			log?.warn(`mike turn failed (${r.kind}): ${r.error}`);
			const e = new Error(r.error || "I could not answer that");
			e.kind = r.kind;
			throw e;
		}
		identity.countTurn();
		log?.info(`mike turn ok in ${r.durationMs}ms cost=$${(r.costUsd ?? 0).toFixed(4)} context=${context ? "worker" : "none"} session=${session.id.slice(0, 8)}`);
		return { text: r.text, durationMs: r.durationMs, costUsd: r.costUsd, hadContext: !!context };
	};

	return {
		get sessionId() { return identity.sessionId; },
		get model() { return model; },
		get cwd() { return cwd; },
		get turns() { return identity.state.turns; },
		get promptPath() { return prompt.file; },
		/** Exposed so a test can assert the block without paying for a turn. */
		contextFor,

		/** One turn, queued behind whatever he is already answering.
		 *
		 *  `ticket` is the caller's handle on a turn still in the queue: set
		 *  `withdrawn` before it runs and it never does ("rewind"), and read
		 *  `begun` to know whether that is still possible. */
		say(session, text, { onProgress, ticket } = {}) {
			const at = epoch;
			waiting++;
			const run = () => {
				waiting--;
				if (at !== epoch || ticket?.withdrawn) {
					const e = new Error("stopped");
					e.kind = "interrupted";
					throw e;
				}
				if (ticket) ticket.begun = true;
				return runTurn(session, text, onProgress);
			};
			const next = queue.then(run, run);
			queue = next.then(() => { }, () => { });
			return next;
		},

		interrupt() {
			const dropped = waiting;
			epoch++;
			if (!child) {
				if (dropped) log?.info(`mike interrupted: ${dropped} queued turn(s) dropped`);
				return dropped > 0;
			}
			// See workerEngine.interrupt: the flag is what turns a killed process
			// into "stopped" instead of an error about exit code null.
			child.interrupted = true;
			try { child.kill("SIGKILL"); } catch { }
			child = null;
			log?.info(`mike interrupted${dropped ? `, ${dropped} queued turn(s) dropped` : ""}`);
			return true;
		},

		dispose() {
			this.interrupt();
			cli.killAll?.();
		}
	};
}
