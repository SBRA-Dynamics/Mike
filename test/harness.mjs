// Test harness: starts a real server on a spare port and talks to it with
// Node's built-in WebSocket client — no client-side dependency at all.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
export const check = (name, ok, detail = "") => {
	console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || !detail ? "" : "  — " + detail}`);
	if (!ok) failures++;
	return ok;
};
export const failed = () => failures;
export const section = (name) => console.log(`\n${name}`);

// Every server we spawn, so a suite that throws before stop() does not leave a
// listener (and a temp directory) behind. 110 of those accumulated over one
// afternoon and turned into the port-collision flake described in startServer.
const spawned = new Set();
const track = (proc) => {
	spawned.add(proc);
	proc.on("exit", () => spawned.delete(proc));
};
const killAll = () => { for (const p of spawned) { try { p.kill("SIGKILL"); } catch { } } };
process.on("exit", killAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killAll(); process.exit(130); });
process.on("uncaughtException", (e) => { killAll(); console.error(e); process.exit(1); });

/** A server in its own temp data directory, so tests never see each other's sessions.
 *
 *  `env` is merged over the parent's, which is how PRD 3's suites point the
 *  server's `claude` at the stand-in binary: the path is a flag, but the
 *  stand-in's state directory has to be per-run or two suites share one. */
export async function startServer(extraArgs = [], { env: extraEnv = {} } = {}) {
	const dataDir = mkdtempSync(join(tmpdir(), "mike-test-"));
	const token = "test-token-" + Math.random().toString(16).slice(2, 10);
	// The hold window (PRD 6) is off unless a suite asks for it. Every test
	// here sends one whole utterance and waits for the answer, which is the one
	// shape the window is not for — leaving it on would add two seconds to every
	// one of a few hundred turns and assert nothing. The suite that tests the
	// merging turns it back on.
	//
	// MIKE_MCP_SERVERS is pinned INSIDE the run's own temp directory, after
	// process.env rather than before it. A machine whose operator has real
	// extra MCP servers in ~/.config/mike/mcp.json would otherwise hand every
	// spawned server a different --mcp-config and a longer --allowedTools than
	// the assertions here are written against, and the suite would pass or fail
	// depending on whose machine it ran on. A suite that wants extra servers
	// passes its own path in `env`, which still wins.
	const env = { MIKE_HOLD_MS: "0", ...process.env, MIKE_MCP_SERVERS: join(dataDir, "no-extra-mcp.json"), ...extraEnv };

	// Port 0: the OS hands out one that is free, and tells us which.
	//
	// This used to pick a random port in a 1000-wide range and then poll
	// /healthz on it. When that port was already taken the new server died of
	// EADDRINUSE while the SQUATTER answered /healthz — so the harness happily
	// went on to talk to a foreign server, whose token was different, and the
	// run failed twenty lines later as a null readyMsg. With enough leaked
	// servers around (and a crashing suite leaks one every time) that was a
	// flake nobody could reproduce in isolation.
	const proc = spawn("node", ["server.js", "--port", "0", "--host", "127.0.0.1",
		"--token", token, "--data", dataDir, ...extraArgs], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
	track(proc);

	let logText = "";
	proc.stdout.on("data", (d) => { logText += d.toString(); });
	proc.stderr.on("data", (d) => { logText += d.toString(); });

	// The server logs the port it actually bound. Waiting for that line, rather
	// than probing a port we guessed, means we can only ever reach our own.
	let port = 0;
	for (let i = 0; i < 100 && !port; i++) {
		// Anchored on "mike-server": the MCP listener logs its own
		// "on http://127.0.0.1:PORT/mcp" line first, and matching that one sent
		// the whole suite at the tool surface instead of the server.
		const m = logText.match(/mike-server \S+ protocol \S+ on https?:\/\/127\.0\.0\.1:(\d+)/);
		if (m) port = Number(m[1]);
		else if (proc.exitCode !== null) break;
		else await sleep(100);
	}
	if (!port) {
		try { proc.kill("SIGKILL"); } catch { }
		throw new Error(`server never reported a port:\n${logText || "(no output)"}`);
	}

	const base = `http://127.0.0.1:${port}`;
	let up = false;
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(`${base}/healthz`)).ok) { up = true; break; } } catch { }
		await sleep(100);
	}
	if (!up) {
		try { proc.kill("SIGKILL"); } catch { }
		throw new Error(`server did not answer on ${port}:\n${logText || "(no output)"}`);
	}

	return {
		port, token, dataDir, proc, base, env,
		wsUrl: `ws://127.0.0.1:${port}/ws`,
		log: () => logText,
		async restart() {
			proc.kill("SIGTERM");
			await sleep(600);
			// Same port on purpose: a reconnect test needs the URL to stay valid.
			const next = await startServerOn(port, token, dataDir, extraArgs, env);
			Object.assign(this, { proc: next.proc, log: next.log });
			return this;
		},
		stop() {
			try { this.proc.kill("SIGKILL"); } catch { }
			try { proc.kill("SIGKILL"); } catch { }
			try { rmSync(dataDir, { recursive: true, force: true }); } catch { }
		}
	};
}

async function startServerOn(port, token, dataDir, extraArgs, env = process.env) {
	const proc = spawn("node", ["server.js", "--port", String(port), "--host", "127.0.0.1",
		"--token", token, "--data", dataDir, ...extraArgs], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
	track(proc);
	let logText = "";
	proc.stdout.on("data", (d) => { logText += d.toString(); });
	proc.stderr.on("data", (d) => { logText += d.toString(); });
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { }
		await sleep(100);
	}
	return { proc, log: () => logText };
}

/** A connected client that records everything it receives. */
export class TestClient {
	constructor(url) {
		this.ws = new WebSocket(url);       // Node's built-in client
		this.messages = [];
		this.closed = null;
		this.ready = new Promise((resolve, reject) => {
			this.ws.addEventListener("open", () => resolve(this));
			this.ws.addEventListener("error", () => reject(new Error("socket error")));
		});
		this.ws.addEventListener("message", (e) => {
			try { this.messages.push(JSON.parse(e.data)); } catch { this.messages.push({ type: "__unparsable", raw: String(e.data) }); }
		});
		this.ws.addEventListener("close", (e) => { this.closed = { code: e.code, reason: String(e.reason || "") }; });
	}

	send(obj) { this.ws.send(JSON.stringify(obj)); }

	/** Index to pass as `since`, so a wait ignores everything already received. */
	mark() { return this.messages.length; }

	/**
	 * Wait for a message matching a predicate, or time out.
	 *
	 * `since` matters more than it looks. Without it, a loop that waits for a
	 * repeated message type — "state busy:false" after each turn — matches the
	 * one from the PREVIOUS turn and returns instantly, so the loop races ahead
	 * and the test passes while measuring nothing. Pass mark() before sending.
	 */
	async waitFor(pred, ms = 5000, label = "message", since = 0) {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			const hit = this.messages.slice(since).find(pred);
			if (hit) return hit;
			if (this.closed) return null;
			await sleep(25);
		}
		throw new Error(`timed out waiting for ${label}`);
	}

	/** Send, then wait for the turn to close — the safe pairing for a loop. */
	async sayAndSettle(text, ms = 8000) {
		const since = this.mark();
		this.send({ type: "say", text });
		await this.waitFor((m) => m.type === "state" && m.busy === false, ms, `idle after ${JSON.stringify(text)}`, since);
		return this.messages.slice(since);
	}

	async waitForClose(ms = 5000) {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (this.closed) return this.closed;
			await sleep(25);
		}
		throw new Error("timed out waiting for close");
	}

	of(type) { return this.messages.filter((m) => m.type === type); }
	close() { try { this.ws.close(); } catch { } }
}

/**
 * Ask, over the WebSocket, for a credential for the MCP tool surface (PRD 2).
 * Returns the grant event's data plus the bearer token parsed back out of the
 * `--mcp-config` string — parsed rather than passed separately, so every test
 * that uses it also proves the config claude is handed is well formed.
 */
export async function grantTools(client, role = "mike") {
	const since = client.mark();
	client.send({ type: "control", action: "mcpGrant", args: { role } });
	const ev = await client.waitFor((m) => m.type === "event" && m.kind === "mcpGrant", 5000, "mcpGrant", since);
	const parsed = JSON.parse(ev.data.config);
	const server = parsed.mcpServers.mike;
	return { ...ev.data, parsedConfig: parsed, token: server.headers.Authorization.replace(/^Bearer /, "") };
}

/**
 * An MCP client that speaks exactly what claude 2.1.268 was observed to speak:
 * POST /mcp, JSON-RPC, one JSON body back. Nothing here is a mock of the
 * server — it talks to the real loopback listener the real claude talks to.
 */
export class McpClient {
	constructor(grant) {
		this.url = grant.url;
		this.token = grant.token;
		this.nextId = 0;
	}

	async raw(body, { token = this.token, method = "POST" } = {}) {
		const res = await fetch(this.url, {
			method,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...(token ? { Authorization: `Bearer ${token}` } : {})
			},
			...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
		});
		const text = await res.text();
		let json = null;
		try { json = text ? JSON.parse(text) : null; } catch { }
		return { status: res.status, json, text };
	}

	async rpc(method, params) {
		const id = this.nextId++;
		const { json } = await this.raw({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
		return json;
	}

	initialize() { return this.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "harness", version: "1" } }); }
	listTools() { return this.rpc("tools/list"); }

	/** Returns { isError, text } the way the model would see it. */
	async call(name, args = {}) {
		const r = await this.rpc("tools/call", { name, arguments: args });
		if (r?.error) return { isError: true, text: r.error.message, rpcError: r.error };
		return { isError: !!r?.result?.isError, text: r?.result?.content?.[0]?.text ?? "" };
	}
}

/** Connect, say hello, and wait for ready — the normal path, in one call. */
export async function connect(server, { token, sessionId, resumeFrom } = {}) {
	const c = new TestClient(server.wsUrl);
	await c.ready;
	c.send({
		type: "hello", protocol: 1,
		token: token ?? server.token,
		...(sessionId ? { sessionId } : {}),
		...(resumeFrom !== undefined ? { resumeFrom } : {})
	});
	// No .catch(() => null) here. Swallowing a missing ready handed every caller
	// a client whose readyMsg was null, and the run then died with a TypeError
	// in whatever line touched it first — a transport failure reported as a bug
	// somewhere else entirely. If the handshake does not complete, say so here.
	const ready = await c.waitFor((m) => m.type === "ready", 10_000, "ready");
	c.readyMsg = ready;
	return c;
}
