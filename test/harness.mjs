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

/** A server in its own temp data directory, so tests never see each other's sessions. */
export async function startServer(extraArgs = []) {
	const dataDir = mkdtempSync(join(tmpdir(), "jarvis-test-"));
	const port = 34000 + Math.floor(Math.random() * 1000);
	const token = "test-token-" + Math.random().toString(16).slice(2, 10);

	const proc = spawn("node", ["server.js", "--port", String(port), "--host", "127.0.0.1",
		"--token", token, "--data", dataDir, ...extraArgs], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

	let logText = "";
	proc.stdout.on("data", (d) => { logText += d.toString(); });
	proc.stderr.on("data", (d) => { logText += d.toString(); });

	const base = `http://127.0.0.1:${port}`;
	// Fail loudly here. A server that never started otherwise shows up as a
	// mysterious socket error twenty assertions later.
	let up = false;
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(`${base}/healthz`)).ok) { up = true; break; } } catch { }
		await sleep(100);
	}
	if (!up) {
		try { proc.kill("SIGKILL"); } catch { }
		throw new Error(`server did not start on ${port}:\n${logText || "(no output)"}`);
	}

	return {
		port, token, dataDir, proc, base,
		wsUrl: `ws://127.0.0.1:${port}/ws`,
		log: () => logText,
		async restart() {
			proc.kill("SIGTERM");
			await sleep(600);
			const next = await startServerOn(port, token, dataDir, extraArgs);
			Object.assign(this, { proc: next.proc, log: next.log });
			return this;
		},
		stop() {
			try { proc.kill("SIGKILL"); } catch { }
			try { rmSync(dataDir, { recursive: true, force: true }); } catch { }
		}
	};
}

async function startServerOn(port, token, dataDir, extraArgs) {
	const proc = spawn("node", ["server.js", "--port", String(port), "--host", "127.0.0.1",
		"--token", token, "--data", dataDir, ...extraArgs], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
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

	/** Wait for a message matching a predicate, or time out. */
	async waitFor(pred, ms = 5000, label = "message") {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			const hit = this.messages.find(pred);
			if (hit) return hit;
			if (this.closed) return null;
			await sleep(25);
		}
		throw new Error(`timed out waiting for ${label}`);
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
	const ready = await c.waitFor((m) => m.type === "ready", 5000, "ready").catch(() => null);
	c.readyMsg = ready;
	return c;
}
