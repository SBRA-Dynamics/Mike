// PRD 1 acceptance tests. Every one drives a real server over a real socket.
//
//   node test/run.mjs

import { startServer, connect, TestClient, check, failed, section, sleep } from "./harness.mjs";
import { validateC2S, PROTOCOL_VERSION, CLOSE, CONTROL } from "../src/protocol.js";
import { request } from "node:http";

// `--handler echo`: this suite pins PRD 1's transport, and a model in the
// path would make it slow, expensive and non-deterministic for no gain.
const server = await startServer(["--handler", "echo"]);

try {
	// ---------------------------------------------------------------- protocol
	section("protokoll — validering utan att kasta");
	check("avvisar icke-objekt", validateC2S("nej").ok === false);
	check("avvisar okänd typ", validateC2S({ type: "nonsense" }).ok === false);
	check("avvisar hello utan token", validateC2S({ type: "hello", protocol: 1 }).ok === false);
	check("avvisar say utan text", validateC2S({ type: "say" }).ok === false);
	check("accepterar giltig say", validateC2S({ type: "say", text: "hej" }).ok === true);
	check("avvisar orimligt lång text", validateC2S({ type: "say", text: "x".repeat(200_000) }).ok === false);
	check("accepterar speaking med en boolean", validateC2S({ type: "speaking", on: true }).ok === true);
	check("avvisar speaking utan boolean", validateC2S({ type: "speaking", on: "ja" }).ok === false);

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

	const since1 = c1.mark();
	c1.send({ type: "say", text: "hej" });
	const echo = await c1.waitFor((m) => m.type === "text" && m.text.includes("hej"), 5000, "eko", since1);
	check("eko kommer tillbaka", echo.text === "echo: hej", echo.text);
	check("varje meddelande har seq", typeof echo.seq === "number" && echo.seq > 0);
	await c1.waitFor((m) => m.type === "state" && m.busy === false, 5000, "idle", since1);
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
	await c2.waitFor((m) => m.type === "state" && m.busy === false, 5000, "idle", c2.mark() - 1);
	const before = c2.messages.at(-1).seq;
	c2.close();
	await sleep(200);

	const c3 = await connect(server, { sessionId, resumeFrom: before });
	check("samma session återupptas", c3.readyMsg.sessionId === sessionId);
	check("ready rapporterar resumed", c3.readyMsg.resumed === true);
	check("inget replayas i onödan", c3.readyMsg.missed === 0, `missed=${c3.readyMsg.missed}`);

	// A turn that happens while nobody is attached must be waiting on return.
	const c4 = await connect(server, { sessionId });
	await c4.sayAndSettle("medan ingen lyssnar");
	const mark = c4.messages.at(-1).seq;
	c4.close();
	await sleep(200);

	const c5 = await connect(server, { sessionId, resumeFrom: mark - 3 });
	check("replay levererar det missade", c5.readyMsg.missed >= 1, `missed=${c5.readyMsg.missed}`);
	const replayed = c5.messages.filter((m) => m.seq !== undefined && m.seq > mark - 3);
	check("replay levererade faktiskt något att kontrollera", replayed.length > 0, `${replayed.length} meddelanden`);
	check("replay dupliceras inte", replayed.length > 0 && new Set(replayed.map((m) => m.seq)).size === replayed.length,
		JSON.stringify(replayed.map((m) => m.seq)));

	const ahead = await connect(server, { sessionId, resumeFrom: 999_999 });
	check("klient före servern rapporteras som gap, inte tyst tapp",
		ahead.readyMsg.gap === true, JSON.stringify(ahead.readyMsg));
	ahead.close();

	const fresh = await connect(server);
	check("ny anslutning utan resumeFrom replayar ingenting",
		fresh.readyMsg.missed === 0 && fresh.readyMsg.resumed === false, JSON.stringify(fresh.readyMsg));
	fresh.close();

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
	// fetch() normalises "../" client-side, so the old version of this test
	// never sent a traversal at all. Write the request line by hand.
	const rawGet = (path) => new Promise((resolve) => {
		const req = request({ host: "127.0.0.1", port: server.port, path, method: "GET" }, (res) => {
			let body = "";
			res.on("data", (d) => { body += d; });
			res.on("end", () => resolve({ status: res.statusCode, body }));
		});
		req.on("error", (e) => resolve({ status: -1, body: e.message }));
		req.end();
	});

	for (const path of [
		"/../../../../etc/passwd",
		"/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
		"/..%2f..%2f..%2fetc%2fpasswd",
		"/....//....//etc/passwd"
	]) {
		const r = await rawGet(path);
		check(`sökvägsflykt blockeras: ${path}`, !r.body.includes("root:"), `status ${r.status}`);
	}
	const malformed = await rawGet("/%");
	check("trasig procentkodning svarar 400 istället för att hänga",
		malformed.status === 400, `status ${malformed.status}`);
	const nul = await rawGet("/a%00b");
	check("NUL i sökvägen avvisas", nul.status === 400, `status ${nul.status}`);

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
	c10.send({ type: "control", action: CONTROL.HISTORY, args: { limit: 500 } });
	const hist = await c10.waitFor((m) => m.type === "event" && m.kind === "history", 5000, "historik");
	check("titeln överlevde omstarten",
		hist.data.messages.some((h) => h.kind === "titleChanged" && h.data?.title === "överlever omstart"),
		`${hist.data.messages.length} rader i transkriptet`);
	check("seq fortsätter, nollställs inte", c10.readyMsg.cursor >= seqBeforeRestart,
		`${c10.readyMsg.cursor} < ${seqBeforeRestart}`);
	c10.send({ type: "say", text: "efter omstart" });
	check("konversationen fungerar efter omstart",
		!!(await c10.waitFor((m) => m.type === "text" && m.text.includes("efter omstart"), 5000, "eko")));
	c10.close();

	section("sessionId får inte bli ett filnamn");
	for (const evil of ["../../../ESCAPED", "..", "a/b", "nope"]) {
		const c = new TestClient(server.wsUrl);
		await c.ready;
		c.send({ type: "hello", protocol: PROTOCOL_VERSION, token: server.token, sessionId: evil });
		const closed = await c.waitForClose(4000).catch(() => null);
		check(`avvisar sessionId ${JSON.stringify(evil)}`, closed?.code === CLOSE.BAD_MESSAGE, JSON.stringify(closed));
	}

	section("transportkontroller — R1.5");
	const ctl = await connect(server);
	const ctlId = ctl.readyMsg.sessionId;
	await ctl.sayAndSettle("något att ha i historiken");

	ctl.send({ type: "control", action: CONTROL.LIST_SESSIONS });
	const listed = await ctl.waitFor((m) => m.type === "event" && m.kind === "sessions", 5000, "sessionslista");
	check("listSessions returnerar sessioner", listed.data.sessions.some((x) => x.id === ctlId));

	ctl.send({ type: "control", action: CONTROL.HISTORY });
	const hist2 = await ctl.waitFor((m) => m.type === "event" && m.kind === "history", 5000, "historik");
	check("history returnerar transkriptet",
		hist2.data.messages.some((h) => h.type === "text" && String(h.text).includes("något att ha")),
		`${hist2.data.messages.length} rader`);

	ctl.send({ type: "control", action: CONTROL.DELETE_SESSION, args: { sessionId: "11111111-2222-4333-8444-555555555555" } });
	const refused = await ctl.waitFor((m) => m.type === "error", 5000, "vägran");
	check("kan inte radera någon annans session", /only delete/.test(refused.message), refused.message);

	ctl.send({ type: "control", action: CONTROL.DELETE_SESSION });
	await ctl.waitFor((m) => m.type === "event" && m.kind === "sessionDeleted", 5000, "raderad");
	await sleep(200);
	const after = await connect(server);
	after.send({ type: "control", action: CONTROL.LIST_SESSIONS });
	const listed2 = await after.waitFor((m) => m.type === "event" && m.kind === "sessions", 5000, "lista");
	check("raderad session är borta ur listan", !listed2.data.sessions.some((x) => x.id === ctlId));
	after.close();

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
