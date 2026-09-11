// A real browser, driven over the DevTools protocol.
//
// Factored out of test/prd4-browser.mjs when the voice suite needed the same
// thing with a microphone attached. Nothing here is specific to either.
//
// Why the DevTools protocol rather than dumping the DOM once: --dump-dom with
// --virtual-time-budget freezes real time, so a WebSocket handshake never
// completes under it and the page is photographed mid-connect. Here the page
// runs in real time and is asked questions.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "./harness.mjs";

/** Whichever Chrome this machine has. Named rather than assumed, so a missing
 *  browser is a clear message instead of an ENOENT twenty lines down. */
export const CHROME = ["google-chrome", "google-chrome-stable", "chromium"]
	.find((bin) => spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0);

/** Kill a detached child and everything it spawned. The negative pid is the
 *  process GROUP, which is the only way to be sure Chrome's helpers go with it. */
const killTree = (proc) => {
	try { process.kill(-proc.pid, "SIGKILL"); }
	catch { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }
};

/** Remove the profile directory, retrying for half a second.
 *
 *  Synchronous on purpose: close() is called from a suite's `finally`, which is
 *  followed by process.exit, so there is nowhere to await. A single rmSync there
 *  leaves the directory behind about half the time — Chrome's children are
 *  still flushing their own files as the tree dies, and each run then costs
 *  another abandoned profile in /tmp. */
const removeProfile = (dir) => {
	const idle = new Int32Array(new SharedArrayBuffer(4));
	for (let i = 0; i < 10; i++) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* busy; try again */ }
		if (!existsSync(dir)) return;
		Atomics.wait(idle, 0, 0, 50);
	}
};

/**
 * Launch headless Chrome on `url` and attach to the page.
 *
 * `args` are extra command-line flags — the voice suite passes the fake audio
 * device there. Returns a small object rather than a class: everything a suite
 * does with a browser is one of these five verbs.
 */
export async function launchChrome(url, { args = [], timeoutMs = 20_000 } = {}) {
	if (!CHROME) throw new Error("ingen Chrome installerad — det här testet behöver en riktig webbläsare");

	const profile = mkdtempSync(join(tmpdir(), "jarvis-chrome-"));
	// Its own process group, so close() can kill the whole tree. Chrome's
	// zygotes, renderers and GPU process are its children, and SIGKILL on the
	// browser process alone orphans them: nine processes per run survived into
	// the next one, which is the leak this exists to prevent.
	const proc = spawn(CHROME, [
		"--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
		// Port 0: Chrome writes the one it actually took into the profile, so
		// nothing here is a guess.
		"--remote-debugging-port=0", `--user-data-dir=${profile}`,
		...args, url
	], { stdio: ["ignore", "pipe", "pipe"], detached: true });

	let browserLog = "";
	proc.stdout.on("data", (d) => { browserLog += d.toString(); });
	proc.stderr.on("data", (d) => { browserLog += d.toString(); });

	const portFile = join(profile, "DevToolsActivePort");
	let debugPort = 0;
	const until = Date.now() + timeoutMs;
	while (Date.now() < until && !debugPort) {
		try { debugPort = Number(readFileSync(portFile, "utf8").split("\n")[0]); }
		catch { await sleep(100); }
		if (proc.exitCode !== null) break;
	}
	if (!debugPort) {
		killTree(proc);
		removeProfile(profile);
		throw new Error(`webbläsaren startade aldrig:\n${browserLog.slice(-500)}`);
	}

	// The page target, matched on the URL we asked for: a Chrome profile can
	// come up with an about:blank tab as well, and talking to that one gives a
	// suite that waits forever for an element.
	const origin = new URL(url).origin;
	let page = null;
	while (Date.now() < until && !page) {
		const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
		page = targets.find((t) => t.type === "page" && t.url.startsWith(origin));
		if (!page) await sleep(150);
	}
	if (!page) {
		killTree(proc);
		removeProfile(profile);
		throw new Error(`sidan öppnades aldrig från ${origin}`);
	}

	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve);
		ws.addEventListener("error", () => reject(new Error("kunde inte tala med webbläsaren")));
	});

	let nextId = 1;
	const pending = new Map();
	const consoleErrors = [];
	const consoleLines = [];

	ws.addEventListener("message", (e) => {
		const m = JSON.parse(e.data);
		if (m.id && pending.has(m.id)) {
			const { resolve, reject } = pending.get(m.id);
			pending.delete(m.id);
			return m.error ? reject(new Error(m.error.message)) : resolve(m.result);
		}
		if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails?.text ?? "exception");
		if (m.method === "Runtime.consoleAPICalled") {
			const text = m.params.args.map((a) => a.value ?? a.description).join(" ");
			consoleLines.push(`${m.params.type}: ${text}`);
			if (m.params.type === "error") consoleErrors.push(text);
		}
	});

	const cdp = (method, params = {}) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
		setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} svarade inte`)); }, 15_000);
	});

	await cdp("Runtime.enable");

	/** Evaluate an expression in the page and get the value back. */
	const evaluate = async (expression) => {
		const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(`sidan kastade: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
		return r.result?.value;
	};

	/** Poll an expression until it is truthy. Returns its value. */
	const waitFor = async (expression, ms, label) => {
		const stop = Date.now() + ms;
		let last;
		while (Date.now() < stop) {
			last = await evaluate(expression);
			if (last) return last;
			await sleep(150);
		}
		throw new Error(`tiden gick ut medan vi väntade på ${label} (senast: ${JSON.stringify(last)})`);
	};

	/** Where an element is on screen, in CSS pixels. Null when it is not there. */
	const box = async (selector) => evaluate(`(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
	})()`);

	/** A real mouse press at an element's centre, so the page's own pointer
	 *  handlers run — a dispatched synthetic event would prove nothing about a
	 *  control that listens for pointerdown. */
	const mouse = async (selector, type) => {
		const at = await box(selector);
		if (!at) throw new Error(`hittar inte ${selector}`);
		await cdp("Input.dispatchMouseEvent", {
			type, x: at.x, y: at.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1
		});
		return at;
	};

	const click = async (selector) => {
		await mouse(selector, "mousePressed");
		await mouse(selector, "mouseReleased");
	};

	return {
		proc, page, cdp, evaluate, waitFor, box, mouse, click,
		consoleErrors, consoleLines,
		browserLog: () => browserLog,
		close() {
			try { ws.close(); } catch { /* already closed */ }
			killTree(proc);
			removeProfile(profile);
		}
	};
}
