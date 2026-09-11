// PRD 1 acceptance tests. Every one drives a real server over a real socket.
//
//   node test/run.mjs

import { startServer, connect, TestClient, check, failed, section, sleep } from "./harness.mjs";
import { validateC2S, PROTOCOL_VERSION, CLOSE } from "../src/protocol.js";

const server = await startServer();

try {
	// ---------------------------------------------------------------- protocol
	section("protokoll — validering utan att kasta");
	check("avvisar icke-objekt", validateC2S("nej").ok === false);
	check("avvisar okänd typ", validateC2S({ type: "nonsense" }).ok === false);
	check("avvisar hello utan token", validateC2S({ type: "hello", protocol: 1 }).ok === false);
	check("avvisar say utan text", validateC2S({ type: "say" }).ok === false);
	check("accepterar giltig say", validateC2S({ type: "say", text: "hej" }).ok === true);
	check("avvisar orimligt lång text", validateC2S({ type: "say", text: "x".repeat(200_000) }).ok === false);

	// -------------------------------------------------------------------- auth
	section("auth — R1.7");
	const bad = new TestClient(server.wsUrl);
	await bad.ready;
	bad.send({ type: "hello", protocol: PROTOCOL_VERSION, token: "fel-token" });
	const badClose = await bad.waitForClose();
	check("fel token stängs med 4001", badClose.code === CLOSE.UNAUTHORIZED, JSON.stringify(badClose));
	check("ingen session skapades av fel token", (await (await fetch(`${server.base}/healthz`)).json()).sessions === 0);

	const wrongProto = new TestClient(server.wsUrl);
	await wrongProto.ready;
	wrongProto.send({ type: "hello", protocol: 999, token: server.token });
	check("fel protokollversion stängs med 4002", (await wrongProto.waitForClose()).code === CLOSE.BAD_PROTOCOL);

	const noHello = new TestClient(server.wsUrl);
	await noHello.ready;
	noHello.send({ type: "say", text: "utan hello" });
	check("meddelande före hello stängs", (await noHello.waitForClose()).code === CLOSE.BAD_PROTOCOL);

	// ------------------------------------------------------------------ basics
	section("session och eko");
	const c1 = await connect(server);
	check("ready har sessionId", typeof c1.readyMsg?.sessionId === "string");
	check("ready har protokollversion", c1.readyMsg?.protocol === PROTOCOL_VERSION);
	const sessionId = c1.readyMsg.sessionId;

	c1.send({ type: "say", text: "hej" });
	const echo = await c1.waitFor((m) => m.type === "text" && m.text.includes("hej"), 5000, "eko");
	check("eko kommer tillbaka", echo.text === "echo: hej", echo.text);
	check("varje meddelande har seq", typeof echo.seq === "number" && echo.seq > 0);
	await c1.waitFor((m) => m.type === "state" && m.busy === false, 5000, "idle");
	check("busy följt av idle", c1.of("state").some((m) => m.busy) && c1.of("state").some((m) => !m.busy));

	const seqs = c1.messages.filter((m) => m.seq !== undefined).map((m) => m.seq);
	check("seq är strikt växande", seqs.every((v, i) => i === 0 || v > seqs[i - 1]), JSON.stringify(seqs));

	// --------------------------------------------------------------- resilience
	section("felaktiga meddelanden efter hello — R1.3");
	c1.ws.send("{ inte json");
	await sleep(300);
	check("trasig JSON stänger anslutningen", c1.closed !== null);

	const c2 = await connect(server, { sessionId });
	c2.send({ type: "say" });                       // valid JSON, invalid shape
	const err = await c2.waitFor((m) => m.type === "error", 3000, "felmeddelande");
	check("ogiltig form ger fel men behåller anslutningen", !!err && c2.closed === null, err?.message);
	c2.send({ type: "say", text: "fortfarande här" });
	check("konversationen fungerar efteråt",
		!!(await c2.waitFor((m) => m.type === "text" && m.text.includes("fortfarande här"), 5000, "eko efter fel")));

	// ------------------------------------------------------------------- replay
	section("återanslutning och replay — R1.3");
	// Wait for the turn to close, or the trailing state message lands after the
	// snapshot and is legitimately replayed — which is correct behaviour, not a bug.
	await c2.waitFor((m) => m.type === "state" && m.busy === false, 5000, "idle");
	const before = c2.messages.at(-1).seq;
	c2.close();
	await sleep(200);

	const c3 = await connect(server, { sessionId, resumeFrom: before });
	check("samma session återupptas", c3.readyMsg.sessionId === sessionId);
	check("ready rapporterar resumed", c3.readyMsg.resumed === true);
	check("inget replayas i onödan", c3.readyMsg.missed === 0, `missed=${c3.readyMsg.missed}`);

	// A turn that happens while nobody is attached must be waiting on return.
	const c4 = await connect(server, { sessionId });
	c4.send({ type: "say", text: "medan ingen lyssnar" });
	await c4.waitFor((m) => m.type === "state" && m.busy === false, 5000, "idle");
	const mark = c4.messages.at(-1).seq;
	c4.close();
	await sleep(200);

	const c5 = await connect(server, { sessionId, resumeFrom: mark - 3 });
	check("replay levererar det missade", c5.readyMsg.missed >= 1, `missed=${c5.readyMsg.missed}`);
	const replayed = c5.messages.filter((m) => m.seq !== undefined && m.seq > mark - 3);
	check("replay dupliceras inte", new Set(replayed.map((m) => m.seq)).size === replayed.length);

	const c6 = await connect(server, { sessionId, resumeFrom: 1 });
	check("för gammal resumeFrom rapporteras som gap istället för tyst tapp",
		c6.readyMsg.gap === true || c6.readyMsg.missed > 0, JSON.stringify(c6.readyMsg));

	// -------------------------------------------------------- turn survives drop
	section("en tur överlever att anslutningen dör — R1.3");
	const c7 = await connect(server);
	const sid7 = c7.readyMsg.sessionId;
	const seqAtDrop = c7.readyMsg.cursor;
	c7.send({ type: "say", text: "dropp mitt i" });
	c7.ws.close();                                   // close immediately, before the reply
	await sleep(800);
	const c8 = await connect(server, { sessionId: sid7, resumeFrom: seqAtDrop });
	check("svaret finns kvar när klienten kommer tillbaka",
		c8.messages.some((m) => m.type === "text" && m.text.includes("dropp mitt i")),
		JSON.stringify(c8.messages.map((m) => m.type)));

	// ---------------------------------------------------------------- multi-client
	section("flera klienter på samma session");
	const a = await connect(server, { sessionId });
	const b = await connect(server, { sessionId });
	a.send({ type: "say", text: "till båda" });
	const gotA = await a.waitFor((m) => m.type === "text" && m.text.includes("till båda"), 5000, "a");
	const gotB = await b.waitFor((m) => m.type === "text" && m.text.includes("till båda"), 5000, "b");
	check("båda klienterna ser samma sak", !!gotA && !!gotB);
	check("och samma seq", gotA.seq === gotB.seq, `${gotA.seq} vs ${gotB.seq}`);
	a.close(); b.close();

	// ------------------------------------------------------------------- health
	section("drift — R1.8");
	const health = await (await fetch(`${server.base}/healthz`)).json();
	check("/healthz utan token", health.ok === true);
	check("/healthz räknar sessioner", health.sessions >= 1, JSON.stringify(health));
	check("/healthz rapporterar protokollversion", health.protocol === PROTOCOL_VERSION);

	// ------------------------------------------------------------ static safety
	section("statiska filer — R1.2");
	const escape = await fetch(`${server.base}/../../../../etc/passwd`);
	const escapeBody = await escape.text();
	check("sökvägsflykt blockeras", !escapeBody.includes("root:"), `status ${escape.status}`);
	const encoded = await fetch(`${server.base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
	check("kodad sökvägsflykt blockeras", !(await encoded.text()).includes("root:"), `status ${encoded.status}`);

	// ---------------------------------------------------------- persistence
	section("omstart — R1.5");
	const c9 = await connect(server, { sessionId });
	c9.send({ type: "control", action: "setTitle", args: { title: "överlever omstart" } });
	await c9.waitFor((m) => m.type === "event" && m.kind === "titleChanged", 3000, "titel");
	const seqBeforeRestart = c9.messages.at(-1).seq;
	c9.close();

	await server.restart();
	const c10 = await connect(server, { sessionId });
	check("sessionen finns efter omstart", c10.readyMsg?.sessionId === sessionId);
	check("seq fortsätter, nollställs inte", c10.readyMsg.cursor >= seqBeforeRestart,
		`${c10.readyMsg.cursor} < ${seqBeforeRestart}`);
	c10.send({ type: "say", text: "efter omstart" });
	check("konversationen fungerar efter omstart",
		!!(await c10.waitFor((m) => m.type === "text" && m.text.includes("efter omstart"), 5000, "eko")));
	c10.close();

	section("loggen");
	const logText = server.log();
	check("inga ouppfångade undantag", !logText.includes("UNCAUGHT"), logText.slice(-200));
	check("inga obehandlade rejections", !logText.includes("UNHANDLED"));

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	server.stop();
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
