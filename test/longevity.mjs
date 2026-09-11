// PRD 1 R1.4 — does a long-lived WebSocket actually survive?
//
// The previous system measured Node's own https.Server cutting every SSE stream
// at exactly 30 s over the phone's mobile path, with keepalives flowing and no
// error reported. The cause was never found. This test exists so the same thing
// cannot be discovered three phases later.
//
// Local run (transport sanity, starts its own server):
//   node test/longevity.mjs --minutes 2
//
// Real run (the one that counts — public hostname, phone on mobile data):
//   node test/longevity.mjs --url wss://<host>/ws --token <token> --minutes 10
//
// Exits nonzero if the socket dies, if a round trip is lost, or if latency
// degrades — silence is the failure mode we are hunting, so it also proves
// traffic was flowing the whole time.

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const MINUTES = Number(flag("minutes", "10"));
const PROBE_MS = Number(flag("probe", "15000"));
const externalUrl = flag("url", null);
const externalToken = flag("token", null);

let server = null;
let wsUrl = externalUrl;
let token = externalToken;

if (!externalUrl) {
	const { startServer } = await import("./harness.mjs");
	server = await startServer();
	wsUrl = server.wsUrl;
	token = server.token;
	console.log(`lokal server på ${wsUrl}`);
} else {
	if (!token) { console.error("--url kräver --token"); process.exit(2); }
	console.log(`extern server ${wsUrl}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const deadline = started + MINUTES * 60_000;

const ws = new WebSocket(wsUrl);
const inbox = [];
let closed = null;

ws.addEventListener("message", (e) => { try { inbox.push(JSON.parse(e.data)); } catch { } });
ws.addEventListener("close", (e) => { closed = { code: e.code, reason: String(e.reason || ""), at: Date.now() }; });
ws.addEventListener("error", () => { if (!closed) closed = { code: -1, reason: "socket error", at: Date.now() }; });

await new Promise((res, rej) => {
	ws.addEventListener("open", res);
	ws.addEventListener("error", () => rej(new Error("could not connect")));
});

ws.send(JSON.stringify({ type: "hello", protocol: 1, token }));

const waitFor = async (pred, ms, label) => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		const hit = inbox.find(pred);
		if (hit) return hit;
		if (closed) return null;
		await sleep(25);
	}
	throw new Error(`timeout waiting for ${label}`);
};

const ready = await waitFor((m) => m.type === "ready", 10_000, "ready");
if (!ready) { console.error("stängd före ready:", closed); process.exit(1); }
console.log(`ansluten, session ${ready.sessionId.slice(0, 8)} — håller ${MINUTES} min, sonderar var ${PROBE_MS / 1000}:e sekund\n`);

let probes = 0, lost = 0, worstMs = 0;

while (Date.now() < deadline && !closed) {
	await sleep(PROBE_MS);
	if (closed) break;

	const marker = `probe-${++probes}`;
	const before = inbox.length;
	const t0 = Date.now();
	try { ws.send(JSON.stringify({ type: "say", text: marker })); }
	catch (e) { console.error(`  kunde inte skicka: ${e.message}`); break; }

	let hit = null;
	try { hit = await waitFor((m) => m.type === "text" && String(m.text).includes(marker), 20_000, marker); }
	catch { /* handled below */ }

	const elapsed = ((Date.now() - started) / 1000).toFixed(0).padStart(4);
	if (!hit) {
		lost++;
		console.log(`  ${elapsed}s  sond ${probes}: INGET SVAR${closed ? ` (stängd ${closed.code})` : ""}`);
		if (closed) break;
	} else {
		const rtt = Date.now() - t0;
		worstMs = Math.max(worstMs, rtt);
		console.log(`  ${elapsed}s  sond ${probes}: ${String(rtt).padStart(4)} ms  (${inbox.length - before} meddelanden)`);
	}
}

const heldSec = (Date.now() - started) / 1000;
const targetSec = MINUTES * 60;

console.log();
console.log(`höll        ${heldSec.toFixed(0)} s av ${targetSec} s`);
console.log(`sonder      ${probes}, förlorade ${lost}`);
console.log(`värsta rtt  ${worstMs} ms`);
if (closed) console.log(`stängdes    kod ${closed.code} ${closed.reason} efter ${((closed.at - started) / 1000).toFixed(1)} s`);

try { ws.close(); } catch { }
server?.stop();

// A close near 30 s is the specific failure we are hunting; name it so nobody
// has to rediscover the history to understand the result.
const suspicious = closed && Math.abs((closed.at - started) / 1000 - 30) < 3;
const ok = !closed && lost === 0 && heldSec >= targetSec - 5;

console.log(ok ? "\nPASS — transporten överlever\n"
	: suspicious ? "\nFAIL — stängd vid ~30 s, samma signatur som SSE-problemet. Kör bakom TLS-bryggan istället.\n"
		: "\nFAIL\n");
process.exit(ok ? 0 : 1);
