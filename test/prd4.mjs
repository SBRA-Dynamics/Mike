// PRD 4 — the client: lens frame, shared model, connection, resume.
//
//   node test/prd4.mjs
//
// Everything here drives the SHIPPED client source (client/src/*.ts), imported
// straight into Node, which strips the types. Not a copy of it, and not a
// reimplementation of the wrapping rules — a test that agrees with a second
// implementation of the same idea proves nothing about the one that ships.
//
// The lens half that needs pixels on a screen is test/prd4-lens.mjs, which
// drives the real simulator.
//
// `--quick` skips the thirty-second outage at the end. It exists for the
// falsification loop — every assertion in here was checked against deliberately
// broken code, and doing that eighteen times at fifty seconds a run is a waste
// of an afternoon. A real run has no flag.

import { WebSocketServer } from "ws";

import { startServer, connect, check, failed, section, sleep } from "./harness.mjs";
import { validateC2S, S2C } from "../src/protocol.js";
import { startProxy } from "./netcut.mjs";

import { renderLens, wrapText, buildHeader, LENS, BODY_ROWS } from "../client/src/lens/render.ts";
import { Connection, wsUrlFrom } from "../client/src/connection.ts";
import { Store } from "../client/src/state.ts";
import { readUrlSettings, SettingsStore } from "../client/src/settings.ts";
import { Glasses, hasHostChannel } from "../client/src/glasses.ts";
import { getTextWidth } from "../client/node_modules/@evenrealities/pretext/dist/font_measure.js";

const QUICK = process.argv.includes("--quick");

const servers = [];
const track = (s) => { servers.push(s); return s; };

/** Every line of a frame, against both budgets. Returns the offender, or null. */
const budgetBreak = (lines) => {
	for (const line of lines) {
		if (line.length > LENS.cols) return `${line.length} tecken: ${JSON.stringify(line)}`;
		if (getTextWidth(line) > LENS.width) return `${getTextWidth(line)} px: ${JSON.stringify(line)}`;
	}
	return null;
};

/** A client connection wired to a store, the way main.ts wires it — plus the
 *  bookkeeping a test needs: what was applied, what was sent on the wire, and
 *  every status the connection passed through. */
const clientPair = (url, token, opts = {}) => {
	const store = new Store();
	const seen = [];
	const readies = [];
	const statuses = [];
	const sent = [];
	const conn = new Connection({
		url, token,
		// Wrapping the socket rather than conn.send(): hello is written straight
		// to the socket, and it is the frame most worth validating.
		socketFactory: (u) => {
			const ws = new WebSocket(u);
			const original = ws.send.bind(ws);
			ws.send = (data) => { try { sent.push(JSON.parse(data)); } catch { sent.push({ unparsable: String(data) }); } original(data); };
			return ws;
		},
		...opts,
		handlers: {
			onStatus: (s, d) => { statuses.push(s); store.setConnection(s, d); },
			onReady: (r) => { readies.push(r); store.applyReady(r); },
			onHistory: (m) => store.applyHistory(m),
			onMessage: (m) => { seen.push(m); store.apply(m); }
		}
	});
	return { store, conn, seen, readies, statuses, sent };
};

const waitUntil = async (pred, ms, label) => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		const v = pred();
		if (v) return v;
		await sleep(25);
	}
	throw new Error(`tiden gick ut medan vi väntade på ${label}`);
};

try {
	// ============================================================ lens-ramen
	section("linsen: ramen är alltid tio rader och aldrig bredare än linsen (R4.2, krav 2)");

	const LONG = "Jag har gått igenom katalogen och hittat fyra filer som matchar, varav två är genererade och bör lämnas i fred. De andra två är källkod och den ena importerar den andra, vilket gör ordningen viktig när du ändrar dem. Vill du att jag börjar med den understa?";
	const cases = {
		"tom text": "",
		"en rad": "Klart.",
		"ett stycke": LONG,
		"tio stycken": Array.from({ length: 10 }, (_, i) => `Rad nummer ${i} med lite text efter.`).join("\n"),
		"ett enda långt ord": "x".repeat(400),
		"en url utan mellanslag": "https://exempel.se/en/mycket/lang/sokvag/som/aldrig/tar/slut/filnamn-med-bindestreck.txt",
		"breda tecken": "W".repeat(200),
		"tusen tecken": "abcdefghij ".repeat(100)
	};

	for (const [name, text] of Object.entries(cases)) {
		const f = renderLens({ from: "Jarvis", text, page: 0 });
		check(`${name}: exakt ${LENS.rows} rader`, f.lines.length === LENS.rows, `${f.lines.length}`);
		check(`${name}: ingen rad spränger 50 kolumner eller 576 px`, budgetBreak(f.lines) === null, budgetBreak(f.lines) ?? "");
	}

	check("rubriken är rad noll och resten är kroppen",
		renderLens({ from: "Bosse", text: LONG, page: 0 }).lines[0].startsWith("Bosse"));

	section("linsen: vem som talar syns (R4.2, krav 6)");
	check("arbetarens namn står i rubriken",
		renderLens({ from: "Bosse", text: "hej", page: 0 }).header.startsWith("Bosse"),
		renderLens({ from: "Bosse", text: "hej", page: 0 }).header);
	check("status visas bredvid namnet",
		renderLens({ from: "Bosse", text: "hej", status: "thinking", page: 0 }).header.includes("thinking"));
	{
		// A name long enough to crowd out the page counter must lose characters
		// before the counter does: a cut name is still legible, a missing "2/3"
		// hides the existence of the rest of the answer.
		const h = buildHeader("A".repeat(80), "thinking", 1, 3);
		check("ett orimligt långt namn kortas men sidräknaren överlever",
			h.includes("2/3") && h.length <= LENS.cols && getTextWidth(h) <= LENS.width, `${h.length}: ${h}`);
	}

	section("linsen: överflöd markeras, aldrig tyst kapning (R4.2, krav 7)");
	{
		// Long enough to need more than the nine body rows — which the previous
		// sample was not, and the test said so.
		const LONGER = LONG + " Filen heter src/handler.js och den ändringen rör bara den ena grenen, så det går att göra i två steg om du vill ha något att läsa igenom innan resten. Jag kan också lämna den som den är och bara skriva ned vad som skulle behöva göras.";
		const f0 = renderLens({ from: "Jarvis", text: LONGER, page: 0 });
		check("ett långt svar blir flera sidor", f0.pages > 1, `${f0.pages} sidor`);
		check("första sidan säger att det finns mer", f0.header.includes("↓") && f0.header.includes(`1/${f0.pages}`), f0.header);

		const last = renderLens({ from: "Jarvis", text: LONGER, page: f0.pages - 1 });
		check("sista sidan säger att det finns något ovanför", last.header.includes("↑"), last.header);
		check("sista sidan lovar inte mer nedanför", !last.header.includes("↓"), last.header);

		// Nothing may be lost between the source and the pages: this is the
		// difference between "readable through tap or swipe" and "truncated".
		const wrapped = wrapText(LONGER);
		const paged = [];
		for (let p = 0; p < f0.pages; p++) paged.push(...renderLens({ from: "Jarvis", text: LONGER, page: p }).lines.slice(1));
		const words = (s) => s.split(/\s+/).filter(Boolean);
		check("varje rad från radbrytningen finns på någon sida",
			wrapped.every((line) => paged.includes(line)), `${wrapped.length} rader`);
		check("inget ord försvinner mellan källa och sidor",
			words(paged.join(" ")).join(" ") === words(LONGER).join(" "),
			words(paged.join(" ")).length + " mot " + words(LONGER).length);

		check("en sida rymmer nio rader kropp", BODY_ROWS === 9);
		check("sidräkningen stämmer med antalet rader",
			f0.pages === Math.ceil(wrapped.length / BODY_ROWS), `${f0.pages} mot ${wrapped.length} rader`);
	}

	check("ett sidnummer bortom slutet klampas i stället för att visa tomt",
		renderLens({ from: "Jarvis", text: "kort", page: 99 }).page === 0);
	check("ett kort svar har ingen sidräknare i rubriken",
		!renderLens({ from: "Jarvis", text: "kort", page: 0 }).header.includes("1/"));

	{
		// A word that cannot fit on a line of its own is broken by us, where the
		// preview can show it, rather than by the firmware where it cannot.
		const f = renderLens({ from: "Jarvis", text: "y".repeat(120), page: 0 });
		const body = f.lines.slice(1).filter(Boolean);
		check("ett för långt ord bryts i stället för att skjutas ut ur linsen",
			body.length >= 2 && body.join("").startsWith("y".repeat(60)), JSON.stringify(body.slice(0, 2)));
	}

	check("radbrytningen respekterar tecken som redan finns i texten",
		wrapText("ett\ntvå\ntre").join("|") === "ett|två|tre");

	// ============================================================== modellen
	section("modellen: linsen och telefonen läser samma tillstånd (R4.4)");
	{
		const s = new Store();
		s.apply({ type: "text", text: "Hej, jag är här.", from: "jarvis", seq: 1 });
		check("text hamnar på linsen med avsändare", s.state.lens.from === "jarvis" && s.state.lens.text === "Hej, jag är här.");
		check("och i transkriptet", s.state.transcript.at(-1).text === "Hej, jag är här.");

		s.setPage(2);
		s.apply({ type: "text", text: "Nästa svar.", from: "Bosse", seq: 2 });
		check("ett nytt svar börjar om på sida ett", s.state.lens.page === 0);

		s.apply({ type: "state", busy: true, worker: "Bosse", mode: "byname", seq: 3 });
		check("state ger aktiv arbetare", s.state.worker === "Bosse" && s.state.busy === true);

		s.apply({ type: "event", kind: "notHeard", data: { reason: "mode" }, seq: 4 });
		check("ohörda ord rapporteras på linsen, aldrig tyst",
			/Not heard/.test(s.state.lens.text), s.state.lens.text);

		s.apply({ type: "event", kind: "modeChanged", data: { mode: "ignore" }, seq: 5 });
		s.apply({ type: "event", kind: "notHeard", data: { reason: "mode" }, seq: 6 });
		check("i pausat läge säger notisen att mikrofonen är pausad",
			s.state.lens.text.includes("paused"), s.state.lens.text);

		s.apply({ type: "error", message: "worker Bosse dog", seq: 7 });
		check("fel når linsen, inte bara konsolen", s.state.lens.text === "worker Bosse dog");

		s.apply({ type: "event", kind: "workerSwitched", data: { active: "Kalle", worker: { name: "Kalle", model: "sonnet" } }, seq: 8 });
		check("byte av arbetare syns i modellen", s.state.worker === "Kalle" && /Kalle/.test(s.state.lastEvent));
		check("en arbetare som dyker upp i en händelse hamnar i listan",
			s.state.workers.some((w) => w.name === "Kalle"));

		const before = s.state.transcript.length;
		s.applyHistory([{ type: "text", text: "gammalt", from: "jarvis", seq: 1 }]);
		check("historik ersätter transkriptet i stället för att lägga till",
			s.state.transcript.length === 1 && before > 1, `${before} -> ${s.state.transcript.length}`);
	}

	section("modellen: varje meddelandetyp servern kan skicka betyder något (R1.6)");
	{
		// The drift guard. The client imports the server's schema file, so the
		// NAMES cannot drift — but a type the server grows and the client ignores
		// looks exactly like nothing happening. One representative message per
		// S2C value, and every one of them has to move the model.
		const samples = {
			[S2C.TEXT]: { type: "text", text: "ett svar", from: "jarvis", seq: 1 },
			[S2C.STATE]: { type: "state", busy: true, worker: "Bosse", mode: "always", seq: 2 },
			[S2C.HEARD]: { type: "heard", text: "det jag sa", confidence: 0.9, seq: 3 },
			[S2C.EVENT]: { type: "event", kind: "workerSwitched", data: { active: "Kalle" }, seq: 4 },
			[S2C.ERROR]: { type: "error", message: "det gick fel", fatal: false, seq: 5 }
		};
		// `ready` belongs to the connection, not the model: it is addressed to one
		// socket, carries no seq and is never replayed.
		const covered = Object.values(S2C).filter((t) => t !== S2C.READY);
		check("varje typ i schemat har ett fall i modellen",
			covered.every((t) => samples[t]), JSON.stringify(covered.filter((t) => !samples[t])));

		for (const type of covered.filter((t) => samples[t])) {
			const s = new Store();
			const before = JSON.stringify(s.state);
			s.apply(samples[type]);
			check(`"${type}" ändrar något i modellen`, JSON.stringify(s.state) !== before);
		}
	}

	section("modellen: sidvändning (R4.3)");
	{
		const s = new Store();
		s.apply({ type: "text", text: "x", from: "jarvis", seq: 1 });
		check("sidvändning nedåt över sista sidan gör ingenting", s.turnPage(1, 1) === false);
		check("sidvändning uppåt från första sidan gör ingenting", s.turnPage(-1, 3) === false);
		check("sidvändning inom svaret flyttar sidan", s.turnPage(1, 3) === true && s.state.lens.page === 1);
	}

	// ============================================================== glasögon
	section("glasögonen: värden upptäcks, gester dirigeras, avslut går genom systemet (R4.3, R4.6, krav 5)");
	{
		// A stand-in for the SDK bridge. The host gate is NOT stubbed — the test
		// has to look like a Flutter host, which is exactly what R4.6 says the
		// client must require before it believes it has glasses.
		const calls = [];
		let emit = null;
		const makeBridge = (createResult = 0) => ({
			createStartUpPageContainer: async (c) => { calls.push(["create", c]); return createResult; },
			textContainerUpgrade: async (c) => { calls.push(["upgrade", c]); return true; },
			shutDownPageContainer: async (mode) => { calls.push(["shutdown", mode]); return true; },
			onEvenHubEvent: (fn) => { emit = fn; return () => { calls.push(["unsubscribe"]); }; }
		});

		delete globalThis.flutter_inappwebview;
		check("utan Flutter-kanal finns ingen värd", hasHostChannel() === false);
		{
			let asked = false;
			const g = new Glasses({}, { bridgeFactory: async () => { asked = true; return makeBridge(); } });
			const ok = await g.attach("hej", 100);
			check("utan värd kopplas ingenting upp — det är ett normalt läge, inte ett fel", ok === false && g.error === "no Even App host", String(g.error));
			check("och SDK:n rörs inte alls", asked === false);
		}

		// From here on the page looks like an Even App WebView.
		globalThis.flutter_inappwebview = { callHandler: async () => ({}) };
		check("med Flutter-kanal finns en värd", hasHostChannel() === true);

		const gestures = [];
		let foreground = 0, exited = null;
		const g = new Glasses(
			{ onGesture: (x) => gestures.push(x), onForeground: () => foreground++, onExit: (r) => { exited = r; } },
			{ bridgeFactory: async () => makeBridge(0), callTimeoutMs: 300 });

		check("med värd byggs sidan", (await g.attach("rad ett\nrad två", 500)) === true, String(g.error));
		const page = calls.find(([k]) => k === "create")[1];
		check("en enda textbehållare, hela linsen", page.containerTotalNum === 1 && page.textObject.length === 1);
		check("den fångar händelser — annars kommer ingen gest fram",
			page.textObject[0].isEventCapture === 1);
		check("576×288 utan marginal, så tio rader om 27 px får plats",
			page.textObject[0].width === 576 && page.textObject[0].height === 288
			&& page.textObject[0].paddingLength === 0 && page.textObject[0].borderWidth === 0);

		emit({ textEvent: { eventType: 1 } });
		emit({ textEvent: { eventType: 2 } });
		check("svep uppåt och nedåt kommer in som textEvent", gestures.join(",") === "swipeUp,swipeDown", gestures.join(","));

		// Protobuf omits zero values, so a single press has NO eventType at all.
		// Reading that as "no gesture" is the documented first mistake.
		gestures.length = 0;
		emit({ sysEvent: {} });
		check("en tapp saknar eventType i protobuf och är ändå en tapp", gestures.join(",") === "tap", gestures.join(","));

		emit({ sysEvent: { eventType: 3 } });
		await sleep(50);
		check("dubbeltapp räknas som dubbeltapp", gestures.includes("doubleTap"));
		const shutdown = calls.find(([k]) => k === "shutdown");
		check("dubbeltapp går genom systemets avslutsdialog — läge 1, inte 0 (krav 5)",
			!!shutdown && shutdown[1] === 1, JSON.stringify(shutdown));

		// SDK 0.0.15 reports the two halves of a hold separately, which is what
		// PRD 5's push-to-talk capture spans. R4.3 reserves the gesture, so the
		// reservation has to be real: both halves must arrive, distinctly.
		gestures.length = 0;
		emit({ sysEvent: { eventType: 9 } });
		emit({ sysEvent: { eventType: 10 } });
		check("långtryckets början och slut kommer fram var för sig (R4.3, för PRD 5)",
			gestures.join(",") === "holdStart,holdEnd", gestures.join(","));

		gestures.length = 0;
		emit({ sysEvent: { eventType: 8, imuData: { x: 1, y: 2, z: 3 } } });
		check("IMU-rapporter är inga gester", gestures.length === 0, gestures.join(","));

		emit({ sysEvent: { eventType: 4 } });
		check("förgrund rapporteras så klienten kan återansluta i stället för att visa gammal text", foreground === 1);

		calls.length = 0;
		g.show("ny text");
		await sleep(50);
		const upgrade = calls.find(([k]) => k === "upgrade");
		check("uppdateringar går via textContainerUpgrade, aldrig rebuild", !!upgrade);
		check("och ersätter hela innehållet", upgrade[1].contentOffset === 0 && upgrade[1].contentLength === 0);
		check("mot samma behållare som skapades",
			upgrade[1].containerID === page.textObject[0].containerID && upgrade[1].containerName === page.textObject[0].containerName);

		calls.length = 0;
		g.show("ny text");
		await sleep(30);
		check("samma text skickas inte igen — varje hopp kostar mätta millisekunder",
			calls.filter(([k]) => k === "upgrade").length === 0);

		emit({ sysEvent: { eventType: 7 } });
		check("systemets avslut släpper glasögonen", exited === "system exit" && g.attached === false, String(exited));

		{
			// One hanging BLE call must not wedge the update loop for good.
			let release;
			const hung = new Glasses({}, {
				bridgeFactory: async () => ({
					createStartUpPageContainer: async () => 0,
					textContainerUpgrade: () => new Promise((r) => { release = r; }),
					onEvenHubEvent: () => () => { }
				}),
				callTimeoutMs: 150
			});
			await hung.attach("start", 500);
			hung.show("något");
			await sleep(400);
			check("ett hängande anrop ger upp i stället för att låsa linsen", /timed out/.test(hung.error ?? ""), String(hung.error));
			release?.(true);
		}

		{
			// A page the firmware refuses (oversize, out of memory) is not glasses.
			const refused = new Glasses({}, { bridgeFactory: async () => makeBridge(2) });
			check("en avvisad sida rapporteras som inga glasögon", (await refused.attach("x", 500)) === false);
			check("och säger varför", /rejected \(2\)/.test(refused.error ?? ""), String(refused.error));
		}

		delete globalThis.flutter_inappwebview;
	}

	// =============================================================== adress
	section("adressen: klienten vet var servern finns utan konfiguration (R4.1)");
	check("https blir wss", wsUrlFrom("https://jarvis.example.se/") === "wss://jarvis.example.se/ws");
	check("http blir ws och porten följer med", wsUrlFrom("http://127.0.0.1:3460/x?y=1") === "ws://127.0.0.1:3460/ws");
	check("frågesträngen följer inte med in i socket-adressen", !wsUrlFrom("http://h/?token=hemligt").includes("hemligt"));
	check("token kan komma in i länken en gång", readUrlSettings("http://h/?token=abc").token === "abc");
	check("en länk utan token ger ingen token", readUrlSettings("http://h/").token === undefined);

	{
		// R4.7: settings go through an injected store, so the SDK's storage and
		// the browser fallback are the same code path with a different backend.
		const mem = new Map();
		const kv = { async get(k) { return mem.get(k) ?? ""; }, async set(k, v) { mem.set(k, v); } };
		const st = new SettingsStore(kv);
		await st.save({ token: "t", sessionId: "s" });
		const again = new SettingsStore(kv);
		await again.load();
		check("inställningar överlever en omstart av klienten", again.value.token === "t" && again.value.sessionId === "s");

		const broken = { async get() { return "{inte json"; }, async set() { } };
		const st3 = new SettingsStore(broken);
		await st3.load();
		check("trasiga sparade inställningar startar rent i stället för att stoppa klienten", st3.value.token === "");
	}

	// ========================================================== dubbletter
	section("anslutningen: ett meddelande kan inte tillämpas två gånger (krav 4)");
	{
		// A scripted server, not the real one: the duplicate this guards against
		// is a half-open socket delivering its backlog after the replacement has
		// caught up, and no real server can be asked to produce one on cue.
		const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
		const port = await new Promise((r) => wss.on("listening", () => r(wss.address().port)));
		wss.on("connection", (ws) => {
			ws.on("message", (data) => {
				const m = JSON.parse(data.toString());
				if (m.type !== "hello") return;
				ws.send(JSON.stringify({ type: "ready", sessionId: "11111111-2222-4333-8444-555555555555", cursor: 0, protocol: 1, worker: null, workers: [], mode: "byname", resumed: false, missed: 0, gap: false }));
				ws.send(JSON.stringify({ type: "text", text: "ett", from: "jarvis", seq: 1 }));
				ws.send(JSON.stringify({ type: "text", text: "två", from: "jarvis", seq: 2 }));
				ws.send(JSON.stringify({ type: "text", text: "ett igen", from: "jarvis", seq: 1 }));   // efterslängen
				ws.send(JSON.stringify({ type: "text", text: "två igen", from: "jarvis", seq: 2 }));
				ws.send(JSON.stringify({ type: "text", text: "tre", from: "jarvis", seq: 3 }));
			});
		});

		const { conn, seen, store } = clientPair(`ws://127.0.0.1:${port}/ws`, "vilken som helst");
		conn.start();
		await waitUntil(() => seen.length >= 3, 5000, "tre meddelanden");
		await sleep(300);      // ge dubbletterna tid att komma fram om de skulle

		check("bara nya sekvensnummer tillämpas", seen.length === 3, `${seen.length}: ${seen.map((m) => m.text).join(", ")}`);
		check("de gamla räknas som dubbletter i stället för att tappas tyst", conn.stats.duplicates === 2, String(conn.stats.duplicates));
		check("markören står på det högsta sedda numret", conn.cursor === 3, String(conn.cursor));
		check("transkriptet innehåller inget dubbelt",
			store.state.transcript.filter((e) => e.text === "ett").length === 1);
		conn.stop();
		wss.close();
	}

	// ======================================================= mot riktig server
	const server = track(await startServer(["--handler", "echo"]));

	section("anslutningen: mot en riktig server (R4.5)");
	{
		const { conn, store } = clientPair(server.wsUrl, server.token);
		conn.start();
		await waitUntil(() => conn.status === "online", 8000, "online");
		check("klienten kommer upp mot servern den serverades från", conn.status === "online");
		check("sessionen är serverns", typeof conn.sessionId === "string" && conn.sessionId.length === 36);

		// A fresh page knows nothing and asks; a reconnect does not, because the
		// replay covers it.
		await waitUntil(() => store.state.transcript.length > 0, 5000, "historik");
		check("en ny flik hämtar transkriptet i stället för att visa tomt", store.state.transcript.length > 0);

		const before = store.state.transcript.length;
		conn.say("hej på dig");
		await waitUntil(() => store.state.transcript.length > before, 5000, "eko");
		check("det som sägs kommer tillbaka och hamnar på linsen",
			store.state.lens.text.includes("hej på dig"), store.state.lens.text);
		check("linsen vet vem som svarade", store.state.lens.from === "echo", store.state.lens.from);

		conn.stop();
		check("ingenting skickas när sockeln är nere — det köas inte heller", conn.say("i tomma intet") === false);
	}

	section("anslutningen: vad klienten faktiskt lägger på tråden (PRD 3, R1.6)");
	{
		// The gate filters ambient speech, so a client that forgets `origin:
		// typed` has its user's words treated as overheard and dropped in ByName
		// — the whole reason the field exists. What is asserted here is the wire.
		const { conn, sent } = clientPair(server.wsUrl, server.token);
		conn.start();
		await waitUntil(() => conn.status === "online", 8000, "online");
		conn.say("vad är klockan");
		conn.control("setMode", { mode: "always" });
		conn.interrupt();
		await sleep(200);

		const say = sent.find((m) => m.type === "say");
		check("klienten märker varje yttrande som typed", say?.origin === "typed", JSON.stringify(say));

		const hello = sent.find((m) => m.type === "hello");
		check("hello bär protokollversion och token", hello?.protocol === 1 && hello?.token === server.token, JSON.stringify(hello));

		// The client imports the server's own schema file, so this is a check
		// that it USES it correctly, not that the two agree on the words.
		const bad = sent.map((m) => [m, validateC2S(m)]).filter(([, v]) => !v.ok);
		check(`alla ${sent.length} utgående meddelanden godkänns av serverns egen validering`,
			bad.length === 0, JSON.stringify(bad.slice(0, 2)));
		conn.stop();
	}

	// ================================================================ krav 4
	section("krav 4: nätet dör i 30 sekunder, kommer tillbaka, ingenting dubbleras");
	if (QUICK) console.log("  (hoppas över: --quick)");
	else {
		const proxy = await startProxy(server.port);
		const { conn, store, seen, readies, statuses } = clientPair(proxy.url, server.token);
		conn.start();
		await waitUntil(() => conn.status === "online", 8000, "online genom proxyn");
		const sessionId = conn.sessionId;

		conn.say("innan avbrottet");
		await waitUntil(() => store.state.lens.text.includes("innan avbrottet"), 5000, "eko före avbrottet");
		// Let the turn's trailing `state` land before the cut is timed: taking
		// the mark while a message is still in flight is how a reconnect test
		// ends up measuring the previous turn.
		await sleep(400);
		const cursorBefore = conn.cursor;
		const statusesBefore = statuses.length;

		const t0 = Date.now();
		proxy.cut();
		await waitUntil(() => conn.status === "offline", 5000, "offline");
		check("klienten märker att nätet är borta", conn.status === "offline", conn.detail);

		// A second device keeps the conversation going while the first is dark.
		// This is also what makes the replay non-empty: the server carried on.
		const other = await connect(server, { sessionId });
		for (const line of ["ett under avbrottet", "två under avbrottet", "tre under avbrottet"]) {
			await other.sayAndSettle(line);
		}

		// Thirty seconds, as the criterion says, with the shipped backoff ladder
		// rather than a shortened one: the point is partly that it keeps trying.
		while (Date.now() - t0 < 30_000) await sleep(250);
		// Not "status is offline": an attempt may be in flight at the moment we
		// look, and an assertion that depends on that timing is a coin toss.
		// What matters is that it kept trying and that nothing got through.
		const attempts = statuses.slice(statusesBefore).filter((x) => x === "connecting").length;
		check(`klienten fortsätter försöka under hela avbrottet (${attempts} försök)`, attempts >= 3, String(attempts));
		check("men kommer inte upp", conn.online === false);
		check("ingenting tillämpades medan nätet var nere", conn.cursor === cursorBefore, `${conn.cursor} mot ${cursorBefore}`);

		proxy.restore();
		// No poke(): "the user should never press anything" (R4.5). The ladder
		// tops out at 15 s, so this is the slowest the shipped client can be.
		await waitUntil(() => conn.status === "online", 25_000, "återanslutning utan att någon rör något");
		const backAfter = Math.round((Date.now() - t0) / 1000);
		check(`återansluter av sig själv (efter ${backAfter}s)`, conn.status === "online");

		// Asserted before the wait below, so a client that reconnects without a
		// cursor fails on the reason rather than on a timeout twenty lines later.
		const resumed = readies.at(-1);
		check("återanslutningen bad om fortsättningen, inte om allt", resumed?.resumed === true, JSON.stringify(resumed));
		check("och servern hade något att spela upp", (resumed?.missed ?? 0) > 0, String(resumed?.missed));
		check("ingen lucka i uppspelningen", resumed?.gap === false, String(resumed?.gap));

		await waitUntil(() => store.state.lens.text.includes("tre under avbrottet"), 8000, "ikapp");
		check("den hämtar in det den missade", store.state.lens.text.includes("tre under avbrottet"), store.state.lens.text);

		const seqs = seen.map((m) => m.seq);
		check("varje sekvensnummer kom exakt en gång", new Set(seqs).size === seqs.length,
			JSON.stringify(seqs.filter((v, i) => seqs.indexOf(v) !== i)));
		check("och i ordning", seqs.every((v, i) => i === 0 || v > seqs[i - 1]), JSON.stringify(seqs));

		const texts = store.state.transcript.filter((e) => e.kind === "text").map((e) => e.text);
		for (const line of ["ett under avbrottet", "två under avbrottet", "tre under avbrottet"]) {
			check(`"${line}" finns exakt en gång i transkriptet`,
				texts.filter((t) => t.includes(line)).length === 1,
				String(texts.filter((t) => t.includes(line)).length));
		}

		// The server's own log of the session is the authority on what was said.
		// Comparing against it is what makes "caught up" mean something.
		const sinceHist = other.mark();
		other.send({ type: "control", action: "history", args: { limit: 500 } });
		const hist = await other.waitFor((m) => m.type === "event" && m.kind === "history", 5000, "historik", sinceHist);
		const serverSeqs = hist.data.messages.filter((m) => m.seq > cursorBefore && m.seq <= conn.cursor).map((m) => m.seq);
		check("klienten såg exakt det servern skickade under avbrottet",
			JSON.stringify(serverSeqs) === JSON.stringify(seqs.filter((s) => s > cursorBefore && s <= conn.cursor)),
			`server ${serverSeqs.length}, klient ${seqs.filter((s) => s > cursorBefore).length}`);

		check("klienten räknade inga dubbletter", conn.stats.duplicates === 0, String(conn.stats.duplicates));
		check("och minst ett avbrott", conn.stats.drops >= 1, String(conn.stats.drops));

		conn.stop();
		other.close();
		await proxy.close();
	}

	section("loggen");
	check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
	check("inga obehandlade rejections", !server.log().includes("UNHANDLED"));

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	for (const s of servers) { try { s.stop(); } catch { } }
	await sleep(150);
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
