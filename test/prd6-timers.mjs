// PRD 6 — timers, and the hang that was in them.
//
//   node test/prd6-timers.mjs
//
// The SDK replaces window.setTimeout and friends with "shadow timers" the host
// can tick through window.__tickShadowTimers(elapsedMs). client/src/timers.ts
// says what is wrong with that layer and why the client keeps off it; this
// file holds the SDK to the description and the client to the promise, against
// the SHIPPED SDK in client/node_modules, not a stand-in.
//
// Order matters: timers.ts is imported first, as it is in the bundle (main.ts
// evaluates before glasses.ts dynamically imports the SDK). A test that loaded
// the SDK first would capture the replacements and prove nothing.

import { check, failed, section } from "./harness.mjs";

const nodeSetTimeout = globalThis.setTimeout;
const nodeClearTimeout = globalThis.clearTimeout;

const { after, cancel, natives } = await import("../client/src/timers.ts");

section("timers.ts fångar värdens egna");
check("setTimeout är värdens, inte SDK:ns", natives.setTimeout === nodeSetTimeout);
check("clearTimeout likaså", natives.clearTimeout === nodeClearTimeout);

// A window the SDK is willing to initialise in. Everything it touches at import
// is stubbed; the bridge is a handler that answers 0 to anything.
globalThis.window = globalThis;
globalThis.document = { readyState: "complete", addEventListener() { }, removeEventListener() { } };
globalThis.addEventListener = () => { };
globalThis.removeEventListener = () => { };
globalThis.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.flutter_inappwebview = { callHandler: async () => 0 };

// The SDK narrates its own initialisation; this suite has nothing to learn from that line.
const realLog = console.log;
console.log = () => { };
await import("../client/node_modules/@evenrealities/even_hub_sdk/dist/index.js");
console.log = realLog;

section("SDK:n byter ut fönstrets timers");
const patched = globalThis.setTimeout !== nodeSetTimeout && typeof globalThis.__tickShadowTimers === "function";
check("window.setTimeout är ersatt och __tickShadowTimers finns", patched);

if (patched) {
	// The chain the lens runs while a turn is being worked on: repaint once a
	// second, re-armed from inside the callback. `limit` is what turns a hang
	// into a failed assertion.
	const chain = (set, clear, limit) => {
		let calls = 0;
		let timer = null;
		const paint = () => {
			calls++;
			if (calls > limit) throw new Error("loop");
			clear(timer);
			timer = set(paint, 1000);
		};
		paint();
		// The SDK wraps every callback in a try/catch of its own and prints what
		// it caught, so the throw above ends the chain without reaching here;
		// the count is the evidence, and the console is quiet for the duration.
		const realError = console.error;
		console.error = () => { };
		try { globalThis.__tickShadowTimers(1200); } catch { /* the chain's own throw, if it ever gets out */ }
		console.error = realError;
		clear(timer);
		return { calls, looped: calls > limit };
	};

	section("en kedja som armar om sig själv");
	const shadow = chain(globalThis.setTimeout, globalThis.clearTimeout, 10_000);
	check("på SDK:ns timers är ett tick en loop som aldrig återvänder", shadow.looped, `${shadow.calls} anrop`);
	const ours = chain(after, cancel, 10_000);
	check("på klientens timers rör ticket den inte", !ours.looped && ours.calls === 1, `${ours.calls} anrop`);

	section("en engångstimer avfyras en gång");
	let viaShadow = 0;
	let viaOurs = 0;
	globalThis.setTimeout(() => viaShadow++, 100);
	after(() => viaOurs++, 100);
	globalThis.__tickShadowTimers(150);
	await new Promise((r) => after(r, 300));
	check("SDK:ns timer avfyras två gånger — av ticket och av den riktiga", viaShadow === 2, String(viaShadow));
	check("klientens avfyras en gång", viaOurs === 1, String(viaOurs));

	section("avbeställning");
	let fired = 0;
	const t = after(() => fired++, 50);
	cancel(t);
	cancel(null);
	cancel(undefined);
	await new Promise((r) => after(r, 150));
	check("en avbeställd timer avfyras inte, och null är ofarligt", fired === 0, String(fired));
}

// The grep the module header promises: nothing under client/src reaches for the
// globals. A future edit that does is the bug coming back.
section("ingen i klienten rör window.setTimeout");
const { readdirSync, readFileSync, statSync } = await import("node:fs");
const { join } = await import("node:path");
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const offenders = walk(new URL("../client/src", import.meta.url).pathname)
	.filter((p) => p.endsWith(".ts") && !p.endsWith("/timers.ts"))
	.filter((p) => /\b(setTimeout|clearTimeout|setInterval|clearInterval)\s*\(/.test(readFileSync(p, "utf8")));
check("bara timers.ts anropar dem", offenders.length === 0, offenders.join(", "));

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
