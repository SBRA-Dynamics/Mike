// Driving Claude Code from the server — the one place that knows what the CLI
// looks like from outside.
//
// PRD 1 left this as an open question and defaulted to the CLI over the Agent
// SDK; PRD 3 is where it is settled. The CLI stays: it needs no dependency, it
// gives `--session-id`/`--resume` for free, and a worker id is then the same
// thing a terminal takes, which is the whole of the PC handoff.
//
// One process per turn, not one process per worker. T1 measured why: two
// drivers of one session do not corrupt anything and do not error — they fork
// the transcript and the next resume follows exactly one branch, so the other
// turn is silently unsaid. A long-lived process per worker would be a second
// driver sitting there for hours waiting to collide with a terminal. A turn is
// a process, the session id is the only durable state, and nothing of ours is
// alive between turns to be collided with.
//
// The price is a cold start per turn: ~5 s warm, ~8.7 s on the first call
// (measured, haiku, trivial prompt). That is the number to beat if this is ever
// revisited — and the way to beat it is `--input-format stream-json`, not a
// resident process per worker.
//
// The OUTPUT is stream-json (PRD 6): the same one process per turn, but its
// answer is read as it is written rather than when it exits. Nothing here gets
// faster; what changes is that the lens can say the first sentence, and the
// tool the turn is running, instead of standing on "thinking" for the whole
// turn. The last event of the stream is the same `result` object that
// `--output-format json` used to print in one piece, so everything downstream
// of `run` sees exactly what it saw before.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** A turn that never comes back must not wedge the caller forever. Ten minutes
 *  is longer than any answer someone is waiting on and shorter than a lost
 *  afternoon. It is what Mike and the classifier run on: a turn a person is
 *  listening to has gone wrong long before ten minutes are up. */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** What a WORKER gets instead. Nobody is waiting on a lens for it — the point
 *  of a worker is that it is given a build, a migration, a long read and left
 *  to it — so the cap is not "how long before the user gives up" but "how long
 *  before a wedged process is certainly wedged". Ten minutes cut real work in
 *  half; three hours is longer than any job it is sane to hand one and still
 *  short enough that a hung child is reaped the same day. */
export const DEFAULT_WORKER_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/** How often a turn that is producing nothing readable still says it is alive.
 *  The stream writes a line per event — a tool call, a tool's answer — and
 *  between two of them there can be minutes of a command running. One tick per
 *  five seconds is enough for a lens to tell "working" from "wedged" and few
 *  enough to be free. */
export const ALIVE_MS = 5000;

/** How long before the cap a turn says it is about to be cut off. A ten-minute
 *  turn that dies in silence is indistinguishable from a hang, and the minute
 *  is enough for the user to decide whether to say something about it. */
export const CUTOFF_WARN_MS = 60 * 1000;

/** How much of a cut-off turn's own words are kept to hand back. The point is
 *  that nothing it managed to say is lost, not that a lens can read all of it —
 *  the transcript is where the rest of it is read. */
const PARTIAL_KEEP = 4000;

/** The cap as a person says it. A worker's cap is hours, a test's is seconds,
 *  and "cut off after 180 min" is a number the reader has to divide. */
const humanMs = (ms) => {
	if (ms >= 60 * 60 * 1000) {
		const h = ms / (60 * 60 * 1000);
		return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
	}
	return Math.round(ms / 60000) >= 1 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)}s`;
};

/** What we keep of a run that failed, for the log. Full stderr from a crashed
 *  CLI can be megabytes of stack. */
const errTail = (s) => String(s ?? "").trim().split("\n").slice(-4).join(" ").slice(0, 400);

/** The lines of a stream that a person could read. A `--output-format
 *  stream-json` turn writes JSON objects, one per line, and the tail of that is
 *  the WORST thing to hand a caller as an error: it ends up on a fifty-column
 *  lens as `{"type":"system","subtype":"init","cwd":"/home…`, which says
 *  nothing and hides the one line that did. */
const prose = (s) => String(s ?? "").split("\n")
	.map((l) => l.trim())
	.filter((l) => l && !l.startsWith("{") && !l.startsWith("["))
	.slice(-2).join(" ").replace(/\s+/g, " ").slice(0, 200);

/**
 * Why a run failed, as a sentence.
 *
 * In order of preference: what the CLI said in plain words (stderr first, then
 * stdout), then the message carried INSIDE a stream event, and nothing at all
 * rather than a raw event. The caller has no way to tell a sentence from a
 * stream line once it is in an Error, so the choice is made here — this is the
 * one file that knows what the CLI's output looks like.
 */
export function readableError(err, out) {
	const said = prose(err) || prose(out);
	if (said) return said;
	for (const line of String(out ?? "").split("\n").reverse()) {
		const t = line.trim();
		if (!t.startsWith("{")) continue;
		try {
			const v = JSON.parse(t);
			const m = v?.error?.message ?? v?.message ?? (typeof v?.result === "string" ? v.result : null);
			if (typeof m === "string" && m.trim()) return m.replace(/\s+/g, " ").trim().slice(0, 200);
		} catch { /* a torn line; the next one up may be whole */ }
	}
	return "";
}

/** The CLI refusing a session id because something else has it: another process
 *  still holding it, or one that was killed and left it behind. It is a
 *  recoverable state — the session exists, so it can be resumed — and the
 *  callers act on it, so it is detected here in the one place that reads the
 *  CLI's words. */
const SESSION_TAKEN = /session id\b[^.]*\b(?:is already in use|already exists)|already in use|already exists/i;

/** How much of the raw stream is kept. Only the tail is ever used — for an
 *  error message, or for a CLI that printed one object instead of a stream —
 *  and a turn that calls tools writes far more than anyone wants in memory. */
const OUT_KEEP = 64 * 1024;

/**
 * The set of live child processes, so a shutdown (or a test suite that throws)
 * can reap them. Leaked `claude` processes are expensive in a way leaked
 * servers are not: they hold model sessions and, at worst, spend money.
 */
export class ChildTracker {
	constructor() { this.children = new Set(); }
	add(child) {
		this.children.add(child);
		child.once("exit", () => this.children.delete(child));
	}
	get size() { return this.children.size; }
	killAll(signal = "SIGKILL") {
		for (const c of [...this.children]) { try { c.kill(signal); } catch { } }
	}
}

/** The last path segment, so a lens shows "handler.js" and not forty
 *  characters of directory the user already knows they are in. */
const base = (p) => {
	const s = String(p ?? "").trim();
	if (!s) return "";
	return s.split(/[\\/]/).filter(Boolean).pop() ?? s;
};

/** One line of a fifty-column lens, minus the two characters of prefix it is
 *  shown behind. Cut on a word where there is one. */
const short = (s, n = 40) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	if (t.length <= n) return t;
	const cut = t.slice(0, n);
	const space = cut.lastIndexOf(" ");
	return (space > n * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
};

/** "spawn_worker" -> "Spawn worker", "mcp__mike__read_worker" -> "Read
 *  worker". The fallback for every tool this does not know by name, which is
 *  most of them and all of the future ones. */
const humanize = (name) => {
	const bare = String(name ?? "").replace(/^mcp__[^_]+__/, "").replace(/[_-]+/g, " ").trim();
	if (!bare) return "Working";
	return bare[0].toUpperCase() + bare.slice(1);
};

/**
 * What a tool call looks like on a lens, in the words the user would use.
 *
 * PRD 6 step 2 put the tool's NAME on the status line, which answered "is it
 * stuck" but not "on what". The stream carries the arguments too, and a file
 * name is the difference between "Read" and "Reading workerEngine.js" — the
 * second is the answer to the question the user actually looked up to ask.
 *
 * Pure and exported so the suite can assert the shapes without a model: the
 * inputs are exactly the ones Claude Code's own tools take.
 */
export function describeTool(name, input) {
	const i = input && typeof input === "object" && !Array.isArray(input) ? input : {};
	const file = base(i.file_path ?? i.path ?? i.notebook_path);

	switch (String(name ?? "")) {
		case "Read": case "NotebookRead": if (file) return `Reading ${short(file)}`; break;
		case "Edit": case "MultiEdit": case "NotebookEdit": if (file) return `Editing ${short(file)}`; break;
		case "Write": if (file) return `Writing ${short(file)}`; break;
		// The CLI's own Bash tool carries a one-line description written for a
		// human to read, which is better than any summary of the command.
		case "Bash": { const w = short(i.description || i.command, 38); if (w) return `Running ${w}`; break; }
		case "Grep": { const w = short(i.pattern, 34); if (w) return `Searching ${w}`; break; }
		case "Glob": { const w = short(i.pattern, 32); if (w) return `Looking for ${w}`; break; }
		case "WebSearch": { const w = short(i.query, 32); return w ? `Searching the web for ${w}` : "Searching the web"; }
		case "WebFetch": {
			let host = "";
			try { host = new URL(String(i.url)).host; } catch { host = ""; }
			return host ? `Fetching ${short(host)}` : "Fetching a page";
		}
		case "Task": { const w = short(i.description, 40); if (w) return w[0].toUpperCase() + w.slice(1); break; }
		case "TodoWrite": return "Planning";
	}
	return humanize(name);
}

/**
 * Run one Claude Code turn.
 *
 * `sessionId` starts a named session, `resume` continues one — exactly one of
 * the two, because passing both means asking the CLI to do two different things
 * with one id and the failure is a confusing one.
 *
 * Returns { ok, text, sessionId, costUsd, durationMs } or
 * { ok: false, error, kind } where `kind` is one of "spawn", "timeout",
 * "exit", "parse", "model" — the caller turns that into something a lens can
 * read, because nothing here knows how much room it has.
 */
export function createClaudeRunner({
	bin = "claude",
	log,
	tracker = new ChildTracker(),
	timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
	env = process.env
} = {}) {

	const spawnTurn = ({
		prompt, cwd, model, sessionId, resume,
		appendSystemPrompt, systemPrompt, mcpConfig, allowedTools = [], permissions = "readonly", effort,
		extraArgs = [], timeoutMs: perCall, onSpawn, onProgress
	}) => new Promise((resolve) => {
		// --verbose is not optional here: the CLI refuses stream-json in -p
		// without it, and refuses it before a single line is printed.
		const args = ["-p", "--output-format", "stream-json", "--verbose"];

		if (sessionId && resume) throw new Error("claudeCli: pass sessionId or resume, not both");
		if (sessionId) args.push("--session-id", sessionId);
		if (resume) args.push("--resume", resume);
		if (model) args.push("--model", model);

		// A prompt file the user edits between turns is only honoured when the
		// CLI is told not to snapshot: `--system-prompt-snapshot` defaults to
		// `on`, which records the prompt on the conversation's first request and
		// replays that recording on every later resume. Mike's prompt is a
		// product surface that ships as an editable file (PRD 3), so a recording
		// made at his first ever turn would outlive every edit until someone
		// deleted his session.
		if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt, "--system-prompt-snapshot", "off");
		if (systemPrompt) args.push("--system-prompt", systemPrompt, "--system-prompt-snapshot", "off");

		if (mcpConfig) args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
		if (allowedTools.length) args.push("--allowedTools", ...allowedTools);

		// Nothing may block on a permission prompt: there is no human at this
		// end of the pipe, and "host" leaves the turn hanging until the timeout.
		// Denied-by-default plus an explicit --allowedTools is the honest shape.
		args.push("--permission-prompts", "none");

		// What the turn may do beyond that, as a deliberate setting rather than
		// a property of how the CLI happens to be invoked.
		//
		//   readonly  nothing that needs approval. A worker can read and reason
		//             and cannot change anything. Measured: Read works, Write is
		//             refused with "sessionen är icke-interaktiv".
		//   edits     file edits are accepted; Bash is still refused.
		//   full      --dangerously-skip-permissions. The turn can do whatever
		//             the user running the server can do.
		//
		// `full` is not a detail. This process is reachable from the internet
		// behind one bearer token, so with `full` that token is the ability to
		// run code on this machine. It is a choice the operator makes in the
		// unit file, which is why it is spelled out there too.
		// Reasoning effort, for turns whose answer is one word and whose latency
		// is nearly all process start.
		if (effort) args.push("--effort", effort);

		if (permissions === "full") args.push("--dangerously-skip-permissions");
		else if (permissions === "edits") args.push("--permission-mode", "acceptEdits");
		// The prompt goes last, and something that is not the prompt has to
		// follow every variadic flag: `--allowedTools` and `--tools` swallow
		// everything up to the next `--flag`, so a prompt placed straight after
		// one is read as a tool name and the CLI refuses the turn with an error
		// about tools that gives no hint where it came from. --permission-prompts
		// above is what keeps that from happening here.
		args.push(...extraArgs, prompt);

		const started = Date.now();
		// A progress callback must never be able to fail the turn it is
		// reporting on, and there are now four places that call one.
		const progress = (p) => { try { onProgress?.(p); } catch (e) { log?.warn(`claude progress: ${e.message}`); } };

		let child;
		try {
			child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
		} catch (e) {
			return resolve({ ok: false, kind: "spawn", error: e.message });
		}
		tracker.add(child);
		// Handed out so a caller can interrupt this one turn (PRD 1's
		// `interrupt`) without reaching for the tracker, which would kill every
		// worker's turn at once.
		try { onSpawn?.(child); } catch { /* an interrupt hook must not fail the turn */ }
		// The prompt is now in a process that is running it, which is a stronger
		// claim than "queued" and the only one worth marking an utterance with:
		// everything the user said has been handed over, in full.
		progress({ kind: "start" });

		let out = "";
		let err = "";
		let settled = false;

		// The last `result` event, which is the whole of what the caller gets.
		// Kept as it arrives rather than re-found at close, because the stream
		// may carry anything after it (a rate-limit notice does).
		let result = null;
		let pending = "";
		let aliveAt = 0;
		// The id the CLI itself named, off the stream, which is the only proof
		// that the session now EXISTS. It arrives on the `init` event, before a
		// word of the answer — so a turn that is killed, times out or crashes
		// halfway still comes back knowing its session was created. Without it a
		// first turn stopped by the user was indistinguishable from one that
		// never started, and the next turn tried to create the same id again.
		let streamSessionId = null;
		// What the turn has said so far, and what it was last doing. A turn that
		// is killed at the cap used to come back as nothing at all — ten minutes
		// of work, one line of "no answer in 600s", and the half of the answer
		// that had already been written thrown away with the process. It is kept
		// here so the cut can be reported WITH what there is (see the killer
		// below), which is the difference between a lost turn and a short one.
		let said = "";
		let lastDoing = null;

		/** One event of the stream. Only two shapes matter to a lens: words the
		 *  model has written, and the name of a tool it is running. Everything
		 *  else — init, token estimates, rate limits — is bookkeeping. */
		const event = (v) => {
			if (!streamSessionId && typeof v?.session_id === "string") streamSessionId = v.session_id;
			if (v?.type === "result") { result = v; return; }
			// Read whether or not anyone is listening: `said` is what a cut-off
			// turn is reported with, and that has to be true of a turn nobody
			// was watching the progress of.
			if (v?.type !== "assistant") return;
			for (const block of v.message?.content ?? []) {
				// A thinking block is not an answer, and putting it on the lens
				// would be quoting the model's notes to itself as if it had said
				// them out loud.
				if (block?.type === "text" && block.text) {
					if (said.length < PARTIAL_KEEP) said += (said ? "\n" : "") + String(block.text);
					progress({ kind: "text", text: String(block.text) });
				}
				// `tool` is the raw name and `doing` is the sentence a lens shows.
				// Both, because they answer different questions: the log wants the
				// name, and the person looking up from what they were doing wants
				// to know it is reading workerEngine.js.
				else if (block?.type === "tool_use" && block.name) {
					lastDoing = describeTool(block.name, block.input);
					progress({ kind: "tool", tool: String(block.name), doing: lastDoing });
				}
			}
		};

		const consume = (chunk, last = false) => {
			pending += chunk;
			const lines = pending.split("\n");
			pending = last ? "" : lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try { event(JSON.parse(line)); }
				catch { /* a half-written line, or a CLI that said something in prose */ }
			}
		};
		const finish = (v) => { if (!settled) { settled = true; clearTimeout(killer); clearTimeout(warner); resolve(v); } };

		const cap = perCall ?? timeoutMs;

		// Said before the kill, not after it: the cap is the one failure the
		// user can do something about while it is still avoidable — ten minutes
		// in, a turn that announces it is about to be cut is a turn they can
		// answer, and one that simply stops is a hang they have to guess about.
		//
		// A minute's notice where there is a minute to give, and half the cap
		// where there is not: a short cap is what the tests and the classifier
		// use, and warning at t=0 that the turn ends in a minute would be a
		// sentence that is simply untrue.
		const warnAt = cap > CUTOFF_WARN_MS ? cap - CUTOFF_WARN_MS : Math.round(cap / 2);
		const leftMs = cap - warnAt;
		const warner = setTimeout(() => {
			log?.warn(`claude turn ${Math.round(warnAt / 1000)}s in; cutting off in ${Math.round(leftMs / 1000)}s`);
			progress({ kind: "warn", doing: `cut off in ${Math.max(1, Math.round(leftMs / 1000))}s`, ms: leftMs });
		}, warnAt);

		const killer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { }
			// With what it managed to say. The turn is over either way, and the
			// half-answer is worth more than the sentence saying there is none —
			// a ten-minute turn that ends in "no answer in 600s" is work thrown
			// away, and this is the whole of what "report before it is cut" is.
			const partial = said.trim();
			log?.warn(`claude cut off at ${Math.round(cap / 1000)}s with ${partial.length} chars said${lastDoing ? `, last doing: ${lastDoing}` : ""}`);
			finish({
				ok: false, kind: "timeout",
				error: `cut off after ${humanMs(cap)}`,
				partial, doing: lastDoing,
				sessionId: streamSessionId, durationMs: Date.now() - started
			});
		}, cap);

		// A decoder rather than d.toString(): the stream is split on buffer
		// boundaries, and a chunk that ends mid-character would otherwise put a
		// replacement character in the middle of a word — or in the middle of
		// the JSON line carrying it.
		const decoder = new StringDecoder("utf8");
		child.stdout.on("data", (d) => {
			const chunk = decoder.write(d);
			// Only the tail is ever read again (errTail, and the one-object
			// fallback below), and a turn with tool calls streams megabytes.
			out = (out + chunk).slice(-OUT_KEEP);
			// Evidence, not a heartbeat the server invents: the process wrote
			// something. Between two events there can be minutes of a command
			// running, and this is what tells a lens the difference between that
			// and a turn that has died quietly.
			const now = Date.now();
			if (now - aliveAt >= ALIVE_MS) { aliveAt = now; progress({ kind: "alive" }); }
			try { consume(chunk); } catch (e) { log?.warn(`claude stream: ${e.message}`); }
		});
		child.stderr.on("data", (d) => { err += d.toString(); });
		child.on("error", (e) => finish({ ok: false, kind: "spawn", error: e.message }));

		child.on("close", (code) => {
			const durationMs = Date.now() - started;
			// Somebody asked for this. A killed child exits with no code and
			// nothing on stderr, so without the flag the turn comes back as
			// "claude exited null" — an error bubble for the one thing the user
			// did on purpose.
			if (child.interrupted) {
				log?.info(`claude interrupted after ${durationMs}ms`);
				return finish({ ok: false, kind: "interrupted", error: "stopped", sessionId: streamSessionId, durationMs });
			}
			if (code !== 0) {
				// The log gets the tail, raw. The CALLER gets a sentence: its
				// error reaches a lens, and stream lines are not reading matter.
				log?.warn(`claude exited ${code} in ${durationMs}ms: ${errTail(err) || errTail(out)}`);
				return finish({
					ok: false, kind: "exit", code,
					error: readableError(err, out) || `claude exited ${code}`,
					// A session the CLI refused to open because it is taken is a
					// session that EXISTS; the caller can resume it instead.
					sessionTaken: SESSION_TAKEN.test(`${err} ${out}`),
					sessionId: streamSessionId, durationMs
				});
			}
			try { consume("", true); } catch { /* the last line was torn; `result` decides below */ }

			// A CLI that ignored --output-format, or printed its answer in one
			// piece, still parses: one JSON object is a stream of length one.
			let parsed = result;
			if (!parsed) {
				try { parsed = JSON.parse(out); }
				catch {
					log?.warn(`claude answered unreadably in ${durationMs}ms: ${errTail(out)}`);
					return finish({ ok: false, kind: "parse", error: readableError(err, out) || "nothing readable came back", sessionId: streamSessionId, durationMs });
				}
			}

			// `is_error` is the CLI saying the turn itself failed (an API error,
			// a refused model) while still exiting 0. Treating it as success
			// would put an error string in the transcript as if Mike had said
			// it, which is how a bad model name becomes a personality.
			if (parsed?.is_error) {
				return finish({ ok: false, kind: "model", error: errTail(parsed.result) || "the model could not answer", durationMs, sessionId: parsed.session_id ?? streamSessionId });
			}
			finish({
				ok: true,
				text: typeof parsed?.result === "string" ? parsed.result : "",
				sessionId: parsed?.session_id ?? streamSessionId ?? sessionId ?? resume ?? null,
				costUsd: parsed?.total_cost_usd ?? 0,
				durationMs
			});
		});
	});

	/** The turn in flight for each session id, so the next one can wait for it.
	 *  Keyed by the id itself: `--session-id X` and `--resume X` are two ways of
	 *  asking for the same conversation. */
	const inFlight = new Map();

	/**
	 * One turn — and, per session, one at a time.
	 *
	 * The queue is not an optimisation, it is the invariant: two processes on one
	 * session id is the failure T1 measured (a forked transcript, one turn
	 * silently unsaid) and the one the CLI refuses outright with "Session ID … is
	 * already in use". mike.js and workerEngine.js each serialise their own
	 * turns, which is where a waiting utterance is visible to the user; this is
	 * the floor under both of them, and it covers everything that reaches the CLI
	 * by any other route — a tool call, a retry, a second server-side caller
	 * added later.
	 *
	 * Waiting rather than refusing: the words were said, and the turn in flight
	 * is bounded by its own timeout, so the wait is bounded too.
	 */
	const run = (opts) => {
		const key = opts?.sessionId ?? opts?.resume ?? null;
		if (!key) return spawnTurn(opts);

		const prev = inFlight.get(key);
		if (prev) log?.warn(`claude: session ${String(key).slice(0, 8)} is busy; this turn waits for the one in flight`);
		const mine = prev ? prev.then(() => spawnTurn(opts)) : spawnTurn(opts);
		// The chain the NEXT caller waits on must never reject: one failed turn
		// would otherwise fail every turn queued behind it (same reasoning as
		// workerEngine's enqueue).
		const tail = mine.then(() => { }, () => { });
		inFlight.set(key, tail);
		tail.then(() => { if (inFlight.get(key) === tail) inFlight.delete(key); });
		return mine;
	};

	return {
		run,
		tracker,
		get liveChildren() { return tracker.size; },
		killAll: (sig) => tracker.killAll(sig)
	};
}
