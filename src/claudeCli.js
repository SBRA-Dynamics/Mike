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

/** A turn that never comes back must not wedge the worker forever. Ten minutes
 *  is longer than any answer and shorter than a lost afternoon. */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** What we keep of a run that failed, for the log. Full stderr from a crashed
 *  CLI can be megabytes of stack. */
const errTail = (s) => String(s ?? "").trim().split("\n").slice(-4).join(" ").slice(0, 400);

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

	const run = ({
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
		// replays that recording on every later resume. Jarvis's prompt is a
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

		let out = "";
		let err = "";
		let settled = false;

		// The last `result` event, which is the whole of what the caller gets.
		// Kept as it arrives rather than re-found at close, because the stream
		// may carry anything after it (a rate-limit notice does).
		let result = null;
		let pending = "";

		/** One event of the stream. Only two shapes matter to a lens: words the
		 *  model has written, and the name of a tool it is running. Everything
		 *  else — init, token estimates, rate limits — is bookkeeping. */
		const event = (v) => {
			if (v?.type === "result") { result = v; return; }
			if (v?.type !== "assistant" || !onProgress) return;
			for (const block of v.message?.content ?? []) {
				// A thinking block is not an answer, and putting it on the lens
				// would be quoting the model's notes to itself as if it had said
				// them out loud.
				if (block?.type === "text" && block.text) onProgress({ kind: "text", text: String(block.text) });
				else if (block?.type === "tool_use" && block.name) onProgress({ kind: "tool", tool: String(block.name) });
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
		const finish = (v) => { if (!settled) { settled = true; clearTimeout(killer); resolve(v); } };

		const killer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { }
			finish({ ok: false, kind: "timeout", error: `no answer in ${Math.round((perCall ?? timeoutMs) / 1000)}s`, durationMs: Date.now() - started });
		}, perCall ?? timeoutMs);

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
			// A progress callback must never be able to kill the turn it is
			// reporting on.
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
				return finish({ ok: false, kind: "interrupted", error: "stopped", durationMs });
			}
			if (code !== 0) {
				log?.warn(`claude exited ${code} in ${durationMs}ms: ${errTail(err) || errTail(out)}`);
				return finish({ ok: false, kind: "exit", code, error: errTail(err) || errTail(out) || `claude exited ${code}`, durationMs });
			}
			try { consume("", true); } catch { /* the last line was torn; `result` decides below */ }

			// A CLI that ignored --output-format, or printed its answer in one
			// piece, still parses: one JSON object is a stream of length one.
			let parsed = result;
			if (!parsed) {
				try { parsed = JSON.parse(out); }
				catch { return finish({ ok: false, kind: "parse", error: `unreadable answer: ${errTail(out)}`, durationMs }); }
			}

			// `is_error` is the CLI saying the turn itself failed (an API error,
			// a refused model) while still exiting 0. Treating it as success
			// would put an error string in the transcript as if Jarvis had said
			// it, which is how a bad model name becomes a personality.
			if (parsed?.is_error) {
				return finish({ ok: false, kind: "model", error: errTail(parsed.result) || "the model could not answer", durationMs, sessionId: parsed.session_id });
			}
			finish({
				ok: true,
				text: typeof parsed?.result === "string" ? parsed.result : "",
				sessionId: parsed?.session_id ?? sessionId ?? resume ?? null,
				costUsd: parsed?.total_cost_usd ?? 0,
				durationMs
			});
		});
	});

	return {
		run,
		tracker,
		get liveChildren() { return tracker.size; },
		killAll: (sig) => tracker.killAll(sig)
	};
}
