#!/usr/bin/env node
// A stand-in for the `claude` binary.
//
// This is a test double, and it is honest about which half it doubles. What it
// reproduces is the CLI *contract* the server depends on, as measured against
// claude 2.1.268 in T1:
//
//   * `-p --output-format json` prints one JSON object with `result`,
//     `session_id`, `is_error`, `total_cost_usd`
//   * `-p --output-format stream-json --verbose` prints one JSON object per
//     line — `assistant` events as the turn runs, then that same result object
//     last. PRD 6 reads the turn off this stream, so the double has to have
//     one: a tool call announces itself before it is made, and the answer is
//     announced before the result line.
//   * `--session-id <uuid>` creates a conversation, and fails if it exists
//   * `--resume <uuid>` continues one, and fails if it does not exist
//   * the conversation accumulates: turn N sees turns 1..N-1
//   * `--mcp-config` is a JSON string naming an HTTP MCP server and a bearer
//     token, and tools are really called over it
//   * a non-zero exit and a zero exit with `is_error` are different failures
//
// What it does NOT reproduce is a model. Its "decisions" are a handful of
// regexes over the prompt. That is the point: it makes the routing, the context
// injection, the MCP round trip, the transcript and the restart paths testable
// ten times in a row for nothing, and it makes no claim at all about whether a
// real model would choose the same tool. That claim belongs to test/e2e-live.mjs,
// which spends money to make it.
//
// State lives in $FAKE_CLAUDE_DIR, one JSON file per session id.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const has = (name) => argv.includes(name);

// The prompt is the last positional argument, the way the real CLI takes it.
const FLAGS_WITH_VALUE = new Set([
	"--session-id", "--resume", "--model", "--output-format", "--mcp-config",
	"--append-system-prompt", "--system-prompt", "--system-prompt-snapshot",
	"--permission-prompts", "--max-budget-usd", "--effort", "--agent"
]);
const positional = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--allowedTools" || a === "--allowed-tools" || a === "--tools" || a === "--disallowedTools") {
		// Variadic: everything up to the next flag belongs to it.
		while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) i++;
		continue;
	}
	if (FLAGS_WITH_VALUE.has(a)) { i++; continue; }
	if (a.startsWith("-")) continue;
	positional.push(a);
}
const prompt = positional[positional.length - 1] ?? "";

const streaming = argv.includes("stream-json");
const emit = (v) => process.stdout.write(JSON.stringify(v) + "\n");
/** An assistant event the way the real CLI frames one: the content blocks are
 *  what PRD 6 reads, and everything else on the message is ignored by it. */
const assistant = (content) => { if (streaming) emit({ type: "assistant", message: { role: "assistant", content }, session_id: id }); };

const die = (msg, code = 1) => { process.stderr.write(msg + "\n"); process.exit(code); };

const dir = process.env.FAKE_CLAUDE_DIR;
if (!dir) die("fake-claude: FAKE_CLAUDE_DIR is not set");
mkdirSync(dir, { recursive: true });

// A simulated failure, so the server's error paths can be exercised without
// breaking the binary. FAKE_CLAUDE_FAIL=exit|error|error-once|hang|slow.
// `error-once` is the nasty one worth reproducing: the real CLI reports an API
// failure as exit 0 with is_error set, AFTER it has created the session — so a
// server that does not record the session as existing tries to create it again
// on the next turn and is wedged for good.
const failMode = process.env.FAKE_CLAUDE_FAIL ?? "";
if (failMode === "exit") die("fake-claude: simulated crash", 2);
if (failMode === "hang") { setInterval(() => { }, 1 << 30); }
if (failMode === "slow") await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_SLOW_MS ?? 3000)));

const sessionId = opt("--session-id");
const resume = opt("--resume");
if (sessionId && resume) die("fake-claude: --session-id and --resume together");
const id = sessionId ?? resume;
if (!id) die("fake-claude: neither --session-id nor --resume");
if (!/^[0-9a-f-]{36}$/i.test(id)) die(`fake-claude: not a uuid: ${id}`);

const file = join(dir, `${id}.json`);
let state;
if (sessionId) {
	// The real CLI refuses to create a session id that already exists. The
	// server's restart path depends on that being a real refusal.
	if (existsSync(file)) die(`fake-claude: session ${id} already exists`);
	state = { id, turns: [], model: opt("--model"), cwd: process.cwd(), createdAt: Date.now() };
} else {
	if (!existsSync(file)) die(`fake-claude: no conversation found with session id ${id}`);
	state = JSON.parse(readFileSync(file, "utf8"));
}

// Recorded so a test can assert what the server actually passed without having
// to intercept a process: the model, the system prompt, the allowed tools.
state.lastArgs = argv;
state.lastModel = opt("--model");
state.lastSystemPrompt = opt("--append-system-prompt") ?? opt("--system-prompt") ?? null;
state.lastSnapshot = opt("--system-prompt-snapshot");
state.lastCwd = process.cwd();

// ------------------------------------------------------------------ tool calls

const mcpConfig = opt("--mcp-config");
let mcp = null;
if (mcpConfig) {
	try {
		const parsed = JSON.parse(mcpConfig);
		const entry = Object.values(parsed.mcpServers ?? {})[0];
		if (entry?.url) mcp = { url: entry.url, token: String(entry.headers?.Authorization ?? "").replace(/^Bearer /, "") };
	} catch { /* a malformed config is the server's bug, and the turn says so below */ }
}

let rpcId = 0;
const rpc = async (method, params) => {
	const res = await fetch(mcp.url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcp.token}` },
		body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, ...(params ? { params } : {}) })
	});
	return await res.json();
};

const callTool = async (name, args) => {
	assistant([{ type: "tool_use", name: `mcp__mike__${name}`, input: args }]);
	if (!mcp) return { isError: true, text: "no tools configured" };
	const r = await rpc("tools/call", { name, arguments: args });
	if (r?.error) return { isError: true, text: r.error.message };
	return { isError: !!r?.result?.isError, text: r?.result?.content?.[0]?.text ?? "" };
};

// ------------------------------------------------------------------ "thinking"
//
// Regexes, not a model. Written to cover exactly the phrasings the PRD 3
// end-to-end script uses, in English and Swedish.

const NAME = "([\\p{L}\\p{N}]+)";
const R = (src) => new RegExp(src, "iu");

const SPAWN = R(`(?:start|starta|skapa|create|open)\\b[^.]*?\\b(?:worker|arbetare)\\b[^.]*?\\b(?:called|named|som heter|vid namn|heter)\\s+${NAME}(?:\\s+(?:with|med|på|using)\\s+([\\p{L}\\p{N}. ]+?))?\\s*[.!?]?\\s*$`);
const SWITCH = R(`(?:switch|byt|vaxla|växla|go|ga|gå)\\b[^.]*?\\b(?:to|till|tillbaka till)\\s+${NAME}\\s*[.!?]?\\s*$`);
const READ = R(`(?:what\\s+(?:is|was)\\s+${NAME}\\s+(?:working on|doing|up to)|vad\\s+(?:gör|gor|jobbar)\\s+${NAME}(?:\\s+med)?)`);
const LIST_WORKERS = R("(?:list|show|lista|visa)\\s+(?:the\\s+|alla\\s+)?(?:workers|arbetare|arbetarna)");
const END = R(`(?:end|stop|avsluta|stoppa)\\s+(?:the\\s+)?(?:worker\\s+)?${NAME}\\s*[.!?]?\\s*$`);
const RESET = R(`(?:reset|nollställ|nollstall)\\s+(?:the\\s+)?(?:worker\\s+|arbetaren\\s+)?${NAME}\\s*[.!?]?\\s*$`);
const LIST_FILES = R("(?:list|show|lista|visa)\\s+(?:the\\s+|de\\s+)?(?:files|filerna|filer)");

/** The bracketed block PRD 3 injects. Reading the working directory out of it
 *  is exactly what R3.4 asks a real Mike to do, so the double does it the
 *  same way rather than being told the answer. */
const contextCwd = (text) => {
	const m = text.match(/^\[The user is currently talking to worker "[^"]+" \([^,]+, ([^)]+)\)\./m);
	return m ? m[1] : null;
};
const contextWorker = (text) => {
	const m = text.match(/^\[The user is currently talking to worker "([^"]+)"/m);
	return m ? m[1] : null;
};

const answer = async () => {
	// A worker (no tools) just continues its conversation. The turn number is in
	// the reply on purpose: "coming back resumes where it left off" (R3.6) is
	// only assertable if the answer proves how much has been said.
	if (!mcp) return `turn ${state.turns.length + 1}: ${prompt}`;

	const said = prompt.includes("The user says:") ? prompt.split("The user says:").pop().trim() : prompt;

	let m;
	if ((m = said.match(SPAWN))) {
		// A real model writes the worker's system prompt; the stand-in has to do
		// the same or it stops standing in for one. spawn_worker requires it.
		const args = { name: m[1], systemPrompt: `You are ${m[1]}. You look after whatever you are asked about here.` };
		if (m[2]) args.model = m[2].trim();
		const r = await callTool("spawn_worker", args);
		return r.isError ? `Could not: ${r.text}` : `${m[1]} is up. You are talking to it.`;
	}
	if ((m = said.match(READ))) {
		const who = m[1] ?? m[2];
		const r = await callTool("read_worker", { name: who, turns: 3 });
		return r.isError ? `Could not: ${r.text}` : `${who}: ${r.text.replace(/\s+/g, " ").slice(0, 300)}`;
	}
	if (LIST_WORKERS.test(said)) {
		const r = await callTool("list_workers", {});
		return r.isError ? `Could not: ${r.text}` : r.text.replace(/\n/g, " | ");
	}
	if ((m = said.match(RESET))) {
		const r = await callTool("reset_worker", { name: m[1] });
		return r.isError ? `Could not: ${r.text}` : r.text;
	}
	if ((m = said.match(END))) {
		const r = await callTool("end_worker", { name: m[1] });
		return r.isError ? `Could not: ${r.text}` : r.text;
	}
	if ((m = said.match(SWITCH))) {
		const r = await callTool("switch_worker", { name: m[1] });
		return r.isError ? `Could not: ${r.text}` : `Back with ${m[1]}.`;
	}
	if (LIST_FILES.test(said)) {
		// "the folder we are talking about" — the folder is only knowable from
		// the injected context, which is the whole of R3.4.
		const cwd = contextCwd(prompt);
		if (!cwd) return "Which folder?";
		try {
			const files = readdirSync(cwd).slice(0, 20).join(", ");
			return `${contextWorker(prompt)} is in ${cwd}: ${files}`;
		} catch (e) { return `Cannot read ${cwd}: ${e.code}`; }
	}
	// Anything else: a short answer that proves what he was given.
	return `mike turn ${state.turns.length + 1}${contextWorker(prompt) ? ` [context:${contextWorker(prompt)}]` : ""}: ${said.slice(0, 120)}`;
};

let result;
let isError = false;
try {
	result = await answer();
} catch (e) {
	result = `fake-claude failed: ${e.message}`;
	isError = true;
}

if (failMode === "error") { result = "simulated model error"; isError = true; }
if (failMode === "error-once" && state.turns.length === 0) { result = "simulated first-turn API error"; isError = true; }

assistant([{ type: "text", text: result }]);

state.turns.push({ prompt, result, at: Date.now() });
writeFileSync(file, JSON.stringify(state, null, 1));

emit({
	type: "result", subtype: isError ? "error" : "success",
	is_error: isError, result,
	session_id: id, num_turns: state.turns.length,
	total_cost_usd: 0, duration_ms: 1
});
