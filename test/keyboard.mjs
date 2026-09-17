// Keyboards — src/keyboard.js, over a real server and real sockets.
//
//   node test/keyboard.mjs

import { startServer, connect, TestClient, check, failed, section, sleep } from "./harness.mjs";
import { validateC2S, PROTOCOL_VERSION } from "../src/protocol.js";

const server = await startServer(["--handler", "echo"]);

/** A keyboard: hello with the role, nothing else. */
const keyboard = async () => {
	const k = new TestClient(server.wsUrl);
	await k.ready;
	k.send({ type: "hello", protocol: PROTOCOL_VERSION, token: server.token, role: "keyboard" });
	k.readyMsg = await k.waitFor((m) => m.type === "ready", 5000, "keyboard ready");
	return k;
};
const event = (kind, pred = () => true) => (m) => m.type === "event" && m.kind === kind && pred(m.data);

try {
	section("protokoll");
	check("draft med text och cursor godtas", validateC2S({ type: "draft", text: "hej", cursor: 3 }).ok);
	check("draft utan cursor avvisas", !validateC2S({ type: "draft", text: "hej" }).ok);
	check("draft med negativ cursor avvisas", !validateC2S({ type: "draft", text: "hej", cursor: -1 }).ok);
	check("orimligt lång draft avvisas", !validateC2S({ type: "draft", text: "x".repeat(3000), cursor: 0 }).ok);
	check("okänd roll avvisas", !validateC2S({ type: "hello", protocol: 1, token: "t", role: "toaster" }).ok);

	section("ett tangentbord utan någon konversation");
	const early = await keyboard();
	check("ready utan session", early.readyMsg.sessionId === null && early.readyMsg.role === "keyboard");
	check("skapade ingen session", (await (await fetch(`${server.base}/healthz`)).json()).sessions === 0);
	early.send({ type: "say", text: "ingen lyssnar" });
	check("say utan konversation ger ett fel", !!(await early.waitFor((m) => m.type === "error", 3000, "error")));

	section("glasögonen ansluter — tangentbordet följer med");
	const glasses = await connect(server);
	check("den nya klienten får veta att ett tangentbord skriver",
		!!(await glasses.waitFor(event("keyboard", (d) => d.connected === true), 3000, "keyboard connected", 0)));

	section("utkast");
	let since = glasses.mark();
	early.send({ type: "draft", text: "kör tes", cursor: 7 });
	const d1 = await glasses.waitFor(event("draft"), 3000, "draft", since);
	check("utkastet når linsen", d1.data.text === "kör tes" && d1.data.cursor === 7, JSON.stringify(d1.data));
	check("utkastet har inget seq (sparas inte)", d1.seq === undefined);
	since = glasses.mark();
	early.send({ type: "draft", text: "åäö", cursor: 99 });
	const d2 = await glasses.waitFor(event("draft", (d) => d.text === "åäö"), 3000, "draft clamp", since);
	check("cursor kläms till radens längd", d2.data.cursor === 3, JSON.stringify(d2.data));
	const history = await (async () => {
		glasses.send({ type: "control", action: "history", args: { limit: 100 } });
		return (await glasses.waitFor(event("history"), 3000, "history")).data.messages;
	})();
	check("inget utkast i transkriptet", !history.some((m) => m.kind === "draft" || m.kind === "keyboard"));

	section("enter");
	since = glasses.mark();
	early.send({ type: "say", text: "hej från tangentbordet" });
	const cleared = await glasses.waitFor(event("draft", (d) => d.text === ""), 3000, "cleared", since);
	check("rutan töms", cleared.data.cursor === 0);
	const echo = await glasses.waitFor((m) => m.type === "text" && m.text.includes("hej från tangentbordet"), 5000, "echo", since);
	check("raden blir en tur i konversationen", echo.text === "echo: hej från tangentbordet", echo.text);
	check("tangentbordet får inget av konversationen", !early.messages.some((m) => m.type === "text"));

	section("en till klient på samma session");
	const phone = await connect(server, { sessionId: glasses.readyMsg.sessionId });
	check("får tangentbordets läge direkt", !!(await phone.waitFor(event("keyboard", (d) => d.connected), 3000, "greet")));

	section("tangentbordet går");
	since = glasses.mark();
	early.close();
	check("linsen får veta att det är borta",
		!!(await glasses.waitFor(event("keyboard", (d) => d.connected === false), 3000, "gone", since)));

	section("två konversationer — tangentbordet stannar där det är");
	const k2 = await keyboard();
	check("skriver in i den levande sessionen", k2.readyMsg.sessionId === glasses.readyMsg.sessionId);
	const other = await connect(server);
	await sleep(200);
	since = glasses.mark();
	k2.send({ type: "draft", text: "stannar", cursor: 7 });
	check("utkastet går fortfarande till glasögonen", !!(await glasses.waitFor(event("draft", (d) => d.text === "stannar"), 3000, "sticky", since)));
	check("inte till den andra", !other.messages.some((m) => m.type === "event" && m.kind === "draft"));

	section("glasögonens session töms — tangentbordet flyttar");
	glasses.close();
	phone.close();
	await sleep(300);
	since = other.mark();
	k2.send({ type: "draft", text: "flyttad", cursor: 7 });
	check("följer med till konversationen som är öppen", !!(await other.waitFor(event("draft", (d) => d.text === "flyttad"), 3000, "moved", since)));
	k2.close();
	other.close();
} finally {
	await server.stop();
}

if (failed()) process.exit(1);
