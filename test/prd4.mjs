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
import { MODES } from "../src/routing.js";
import { startProxy } from "./netcut.mjs";

import { renderLens, wrapText, buildHeader, LENS, BODY_ROWS } from "../client/src/lens/render.ts";
import { Connection, wsUrlFrom } from "../client/src/connection.ts";
import { Store, NOTICE_MS, STALE_MS, MARK_WAITING, MARK_TAKEN, MARK_THEIRS } from "../client/src/state.ts";
import { settingsFromScan, decodeFrame } from "../client/src/qr.ts";
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

	// R3.5 through the client's own reducer: the name at the top of the lens is
	// who your next sentence goes to, so it has to change when that changes —
	// not at the next reply, which is what was actually shipped.
	section("linsrubriken följer den aktiva arbetaren (R3.5)");
	{
		const s = new Store();
		let n = 0;
		const feed = (m) => s.apply({ ...m, seq: ++n });

		feed({ type: "text", from: "Jarvis", text: "Hej." });
		check("utan arbetare står Jarvis överst", s.state.lens.from === "Jarvis", s.state.lens.from);

		// Jarvis skapar en arbetare: hans bekräftelse, sedan turens state.
		feed({ type: "text", from: "Jarvis", text: "Bosse är igång." });
		feed({ type: "state", busy: false, worker: "Bosse", mode: "byname" });
		check("efter att en arbetare skapats står arbetaren överst", s.state.lens.from === "Bosse", s.state.lens.from);
		check("och texten står kvar", /Bosse är igång/.test(s.state.lens.text), s.state.lens.text);

		// Ett inpass från Jarvis mitt i: samma arbetare kvar.
		feed({ type: "text", from: "Jarvis", text: "Den läser om filerna." });
		feed({ type: "state", busy: false, worker: "Bosse", mode: "byname" });
		check("Jarvis inpass hamnar inte under arbetarens namn", s.state.lens.from === "Jarvis", s.state.lens.from);

		feed({ type: "text", from: "Jarvis", text: "Nu pratar du med Kalle." });
		feed({ type: "state", busy: false, worker: "Kalle", mode: "byname" });
		check("vid växling står den nya arbetaren överst", s.state.lens.from === "Kalle", s.state.lens.from);

		feed({ type: "state", busy: false, worker: null, mode: "byname" });
		check("när arbetaren avslutas står Jarvis överst igen", s.state.lens.from === "Jarvis", s.state.lens.from);
	}

	// R3.6 on the lens: switching back to somebody is not a new conversation, so
	// what you see is where it left off — not Jarvis's sentence announcing the
	// switch, which is the one thing the user already knows.
	section("växling visar arbetarens samtal, inte bekräftelsen");
	{
		const s = new Store();
		let n = 0;
		const feed = (m) => s.apply({ ...m, seq: ++n });

		feed({ type: "event", kind: "workerSwitched",
			data: { active: "Bosse", worker: { name: "Bosse", model: "sonnet", cwd: "/tmp" },
				last: { from: "Bosse", text: "Jag hittade felet i BLE-koden." } } });
		feed({ type: "text", from: "Jarvis", text: "Nu pratar du med Bosse." });
		feed({ type: "state", busy: false, worker: "Bosse", mode: "byname" });
		check("linsen visar det Bosse sa, inte bekräftelsen",
			s.state.lens.text === "Jag hittade felet i BLE-koden.", s.state.lens.text);
		check("och under Bosses namn", s.state.lens.from === "Bosse", s.state.lens.from);

		// En arbetare som aldrig sagt något har ingenting att återuppta.
		feed({ type: "event", kind: "workerSpawned",
			data: { active: "Kalle", worker: { name: "Kalle", model: "sonnet", cwd: "/tmp" } } });
		feed({ type: "text", from: "Jarvis", text: "Kalle är igång." });
		feed({ type: "state", busy: false, worker: "Kalle", mode: "byname" });
		check("en ny arbetare behåller Jarvis besked", /Kalle är igång/.test(s.state.lens.text), s.state.lens.text);
		check("men namnet är den nyas", s.state.lens.from === "Kalle", s.state.lens.from);

		// Det återupptagna får inte dyka upp igen vid en senare, orelaterad växling.
		feed({ type: "event", kind: "workerSwitched",
			data: { active: "Doris", worker: { name: "Doris", model: "sonnet", cwd: "/tmp" }, last: null } });
		feed({ type: "text", from: "Jarvis", text: "Nu pratar du med Doris." });
		feed({ type: "state", busy: false, worker: "Doris", mode: "byname" });
		check("ett gammalt återupptagande läcker inte in", /Doris/.test(s.state.lens.text), s.state.lens.text);
	}

	// A reply from somebody the user is not talking to is a notice, not the
	// conversation. The lens keeps what they are reading; the header says who is
	// waiting, and a question stays while a remark fades.
	section("bakgrundssvar blir en notis, inte en kapning av linsen");
	{
		const s = new Store();
		let n = 0;
		const feed = (m) => s.apply({ ...m, seq: ++n });
		const t0 = Date.now();

		feed({ type: "state", busy: false, worker: "Kalle", mode: "byname" });
		feed({ type: "text", from: "Kalle", text: "Jag tittar på det." });
		feed({ type: "text", from: "Bosse", text: "Jag är klar med bygget.", background: true });
		check("linsen står kvar hos den man pratar med", s.state.lens.from === "Kalle", s.state.lens.from);
		check("och texten är oförändrad", /tittar på det/.test(s.state.lens.text), s.state.lens.text);
		check("men svaret finns i transkriptet", s.state.transcript.some((e) => /klar med bygget/.test(e.text)));
		check("ingen notis förrän servern sagt vilken sort det är", s.notice(t0) === null, String(s.notice(t0)));

		feed({ type: "event", kind: "workerNotice", data: { worker: "Bosse", kind: "said" } });
		check("ett påstående nämner vem", s.notice() === "Bosse spoke", String(s.notice()));
		check("och det bleknar av sig självt", s.notice(Date.now() + NOTICE_MS + 100) === null, String(s.notice(Date.now() + NOTICE_MS + 100)));

		feed({ type: "event", kind: "workerNotice", data: { worker: "Doris", kind: "question" } });
		check("en fråga bleknar aldrig", s.notice(Date.now() + NOTICE_MS * 10) === "Doris asks", String(s.notice(Date.now() + NOTICE_MS * 10)));

		feed({ type: "event", kind: "workerNotice", data: { worker: "Bosse", kind: "said" } });
		check("en fråga slår ett påstående och räknar resten", s.notice() === "Doris asks +1", String(s.notice()));

		feed({ type: "event", kind: "workerNotice", data: { worker: "Ester", kind: "question" } });
		check("flera frågor räknas", s.notice() === "2 ask +1", String(s.notice()));

		// Att bli satt framför någon besvarar det de sa.
		feed({ type: "event", kind: "workerSwitched", data: { active: "Doris", worker: { name: "Doris" } } });
		feed({ type: "state", busy: false, worker: "Doris", mode: "byname" });
		check("växling till den som frågade tar bort just den notisen",
			s.notice() === "Ester asks +1", String(s.notice()));

		// Flera påståenden och inga frågor räknas utan namn.
		const s2 = new Store();
		let m2 = 0;
		const feed2 = (m) => s2.apply({ ...m, seq: ++m2 });
		feed2({ type: "event", kind: "workerNotice", data: { worker: "A", kind: "said" } });
		feed2({ type: "event", kind: "workerNotice", data: { worker: "B", kind: "said" } });
		feed2({ type: "event", kind: "workerNotice", data: { worker: "C", kind: "said" } });
		check("tre som bara sagt något räknas", s2.notice() === "3 spoke", String(s2.notice()));
		check("samma arbetare två gånger blir en notis", (() => {
			feed2({ type: "event", kind: "workerNotice", data: { worker: "A", kind: "said" } });
			return s2.notice() === "3 spoke";
		})(), String(s2.notice()));
	}

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

	section("modellen: arbetarlistan är vilka som FINNS, inte vilka som har funnits");
	{
		// The companion's "Talking to" picker reads state.workers, and an entry
		// there is a promise that switching to it will work. Names were folded in
		// from events and never taken out again, so an ended worker stayed on
		// offer for the rest of the session — long enough to be picked and
		// answered with "he does not exist any more, you ended him".
		const names = (st) => st.state.workers.map((w) => w.name).join(",");
		const worker = (name) => ({ name, model: "sonnet", cwd: "/tmp" });
		const spawn = (st, name) => st.apply({ type: "event", kind: "workerSwitched", data: { active: name, worker: worker(name) } });
		// The event the server ACTUALLY sends when a worker is created. The
		// helper above models a switch, which is a different message, and the
		// difference hid a real bug: `workerSpawned` was unhandled, so a
		// freshly created worker was missing from the picker while being the
		// one the user was talking to.
		const spawned = (st, name) => st.apply({ type: "event", kind: "workerSpawned", data: { active: name, worker: worker(name) } });
		const ended = (st, name, active = null) => st.apply({ type: "event", kind: "workerEnded", data: { worker: worker(name), active } });
		const renamed = (st, from, to, active = null) =>
			st.apply({ type: "event", kind: "workerRenamed", data: { worker: worker(to), previousName: from, active } });

		{
			const st = new Store();
			spawned(st, "Bosse");
			check("en nyskapad arbetare hamnar i listan", names(st) === "Bosse", names(st));
			check("och är den man pratar med", st.state.worker === "Bosse", String(st.state.worker));
			// Det som gick fel: listan erbjöd alla utom den aktiva, så väljaren
			// visade "Jarvis" medan orden gick till Bosse.
			check("väljaren kan alltså visa den aktiva",
				st.state.workers.some((w) => w.name === st.state.worker), names(st));
			ended(st, "Bosse");
			check("och den försvinner när den avslutas", names(st) === "", names(st));
		}

		{
			const st = new Store();
			spawn(st, "Kalle");
			spawn(st, "Bosse");
			check("arbetare som skapas under sessionen syns i listan", names(st) === "Kalle,Bosse", names(st));

			ended(st, "Kalle");
			check("en avslutad arbetare försvinner ur listan", names(st) === "Bosse", names(st));
			ended(st, "Bosse");
			check("och när den sista avslutas är listan tom", names(st) === "", names(st));
		}

		{
			// The same bug in a different shape, and the one it is easy to leave
			// behind: a rename must REPLACE the entry, not add a second one.
			const st = new Store();
			spawn(st, "Kalle");
			spawn(st, "Bosse");
			renamed(st, "Kalle", "Karin");
			check("ett namnbyte ger exakt en post, under det nya namnet",
				names(st) === "Karin,Bosse", names(st));
			check("och det gamla namnet finns inte kvar någonstans",
				!st.state.workers.some((w) => w.name === "Kalle"), names(st));
			check("platsen i listan behålls — ordningen är den användaren lärt sig",
				st.state.workers[0].name === "Karin", names(st));

			// Events can arrive in an order where the new name is already known.
			renamed(st, "Bosse", "Karin");
			check("och ett namnbyte till ett namn som redan finns ger fortfarande en post",
				names(st) === "Karin", names(st));
		}

		{
			// state.pending is the header's background notices, and the two
			// events must treat it differently: an ended worker cannot be gone
			// back to, a renamed one can.
			const st = new Store();
			spawn(st, "Kalle");
			spawn(st, "Bosse");
			st.apply({ type: "event", kind: "workerNotice", data: { worker: "Kalle", kind: "question" } });
			st.apply({ type: "event", kind: "workerNotice", data: { worker: "Bosse", kind: "question" } });
			check("två arbetare väntar på svar", /2 ask/.test(st.notice() ?? ""), String(st.notice()));

			ended(st, "Kalle");
			check("en avslutad arbetares notis försvinner med honom",
				st.state.pending.map((p) => p.worker).join(",") === "Bosse", JSON.stringify(st.state.pending));
			check("men den andres står kvar — han väntar fortfarande",
				/Bosse asks/.test(st.notice() ?? ""), String(st.notice()));

			renamed(st, "Bosse", "Berit");
			check("och en omdöpt arbetares notis följer med till det nya namnet",
				/Berit asks/.test(st.notice() ?? ""), String(st.notice()));
			check("den räknas fortfarande som en enda notis",
				st.state.pending.length === 1, JSON.stringify(st.state.pending));
		}

		{
			// Both events carry `active`, which arms the addressee handoff applied
			// at the `state` that ends the same turn (R3.5). Removing a name from
			// the list must not disturb that.
			const st = new Store();
			spawn(st, "Kalle");
			st.apply({ type: "state", busy: false, worker: "Kalle", mode: MODES.BYNAME, seq: 1 });
			ended(st, "Kalle", null);
			st.apply({ type: "state", busy: false, worker: null, mode: MODES.BYNAME, seq: 2 });
			check("att avsluta den man talar med lämnar tillbaka en till Jarvis på linsen",
				st.state.lens.from === "Jarvis" && st.state.worker === null,
				JSON.stringify({ from: st.state.lens.from, worker: st.state.worker }));

			const st2 = new Store();
			spawn(st2, "Kalle");
			st2.apply({ type: "state", busy: false, worker: "Kalle", mode: MODES.BYNAME, seq: 1 });
			renamed(st2, "Kalle", "Karin", "Karin");
			st2.apply({ type: "state", busy: false, worker: "Karin", mode: MODES.BYNAME, seq: 2 });
			check("och ett namnbyte flyttar rubriken till det nya namnet",
				st2.state.lens.from === "Karin" && names(st2) === "Karin",
				JSON.stringify({ from: st2.state.lens.from, workers: names(st2) }));
		}
	}

	section("modellen: historiken bygger samtalet, inte registret");
	{
		// The half that a reload makes WORSE rather than better, and the reason
		// it is a separate bug: applyHistory replays every message through the
		// same reducer, so folding worker names in from events rebuilt the
		// registry as it was at any point in the past. `ready.workers` is the
		// server's snapshot of who exists; a transcript is a record of what was
		// said.
		const names = (st) => st.state.workers.map((w) => w.name).join(",");
		const worker = (name) => ({ name, model: "sonnet", cwd: "/tmp" });
		const ready = (workers) => ({ sessionId: "s", worker: null, mode: MODES.BYNAME, workers, resumed: true, missed: 0, gap: false });

		{
			const st = new Store();
			st.applyReady(ready([]));
			st.applyHistory([
				{ type: "event", kind: "workerSwitched", data: { active: "Kalle", worker: worker("Kalle") }, seq: 1 },
				{ type: "text", text: "hej", from: "Kalle", seq: 2 },
				{ type: "event", kind: "workerEnded", data: { worker: worker("Kalle"), active: null }, seq: 3 }
			]);
			check("en historik med skapa-och-avsluta lämnar listan som ready sa", names(st) === "", names(st));
			check("men samtalet byggs som vanligt av historiken",
				st.state.transcript.some((e) => e.text === "hej"), JSON.stringify(st.state.transcript.map((e) => e.text)));
		}

		{
			// The cross-session case, and the one that proves the fix: the worker
			// was ended from another device, so there is NO end event in this
			// transcript to undo the spawn with. Handling workerEnded alone
			// leaves this one on the list for ever.
			const st = new Store();
			st.applyReady(ready([]));
			st.applyHistory([
				{ type: "event", kind: "workerSwitched", data: { active: "Bosse", worker: worker("Bosse") }, seq: 1 },
				{ type: "event", kind: "workerIdentity", data: { name: "Bosse", resume: "claude --resume abc" }, seq: 2 },
				{ type: "text", text: "klart", from: "Bosse", seq: 3 }
			]);
			check("en arbetare som avslutats från en annan enhet återuppstår inte ur historiken",
				names(st) === "", names(st));
		}

		{
			// And ready's own list survives a replay that mentions nobody.
			const st = new Store();
			st.applyReady(ready([worker("Kalle")]));
			st.applyHistory([{ type: "text", text: "hej", from: "jarvis", seq: 1 }]);
			check("det ready sa står kvar efter en historik", names(st) === "Kalle", names(st));
		}

		{
			// The regression risk of the fix above: it is easy to silence history
			// and silence the live events with it, and then a worker created
			// mid-session is invisible until the next reconnect — which is the
			// bug this mechanism was written to solve in the first place.
			const st = new Store();
			st.applyReady(ready([]));
			st.applyHistory([{ type: "text", text: "hej", from: "jarvis", seq: 1 }]);
			st.apply({ type: "event", kind: "workerSwitched", data: { active: "Nina", worker: worker("Nina") }, seq: 2 });
			check("men en arbetare som skapas live syns fortfarande direkt", names(st) === "Nina", names(st));
			st.apply({ type: "event", kind: "workerEnded", data: { worker: worker("Nina"), active: null }, seq: 3 });
			check("och försvinner live också", names(st) === "", names(st));
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

	section("modellen: linsen medan något arbetas på (PRD 6)");
	{
		const s = new Store();
		s.state.connection = "online";
		s.state.worker = "Bosse";
		const turn = (phase, parts) => s.apply({ type: "event", kind: "turn", data: { id: "t1", to: "Bosse", parts, phase } });
		const progress = (data) => s.apply({ type: "event", kind: "progress", data: { from: "Bosse", turn: "t1", ...data } });
		const lines = () => s.lensView().text.split("\n");

		turn("held", ["bygg klart testerna"]);
		check("en mening som hålls står på linsen med en gång",
			lines()[0] === `${MARK_WAITING} bygg klart testerna`, JSON.stringify(lines()));
		check("och det räknas som att något pågår, före serverns state", s.working() === true);

		turn("held", ["bygg klart testerna", "och kör dem sen"]);
		check("båda meningarna syns, inte bara den sista", lines().length === 2, JSON.stringify(lines()));

		turn("started", ["bygg klart testerna", "och kör dem sen"]);
		check("när processen har orden byts pilen mot en bock",
			lines().every((l) => l.startsWith(MARK_TAKEN)), JSON.stringify(lines()));
		// The tick everybody reaches for first is not in the firmware font, and a
		// missing glyph is a box on the user's eye. This is the check that keeps
		// somebody from "fixing" the mark back to it.
		check("och bocken är en glyf som finns i fonten", getTextWidth(MARK_TAKEN) > 8, String(getTextWidth(MARK_TAKEN)));
		check("till skillnad från ✓", getTextWidth("✓") <= 4, String(getTextWidth("✓")));

		progress({ text: "Jag kör sviten och lagar det som failar." });
		progress({ tool: "Bash", doing: "Running node test/prd3.mjs" });
		const withWork = lines();
		check("det den sa att den skulle göra står kvar",
			withWork.some((l) => l === `${MARK_THEIRS} Jag kör sviten och lagar det som failar.`), JSON.stringify(withWork));
		check("och vad den gör just nu står under det",
			withWork.at(-1) === `${MARK_THEIRS} Running node test/prd3.mjs`, JSON.stringify(withWork));

		// Ten seconds of nothing new. No word for it — the mark is the whole
		// message, and it goes away again so that the line keeps changing.
		const t = s.state.turns[0];
		const age = (ms) => { t.doingAt -= ms; t.aliveAt -= ms; };
		age(STALE_MS + 2000);
		check("tystnad tänder en markering", s.lensView().text.endsWith(" *"), JSON.stringify(lines().at(-1)));
		check("och inget ord om att den fortfarande jobbar", !/still|fortfarande/i.test(s.lensView().text));
		age(STALE_MS);
		check("och släcker den igen, så raden ändrar sig", !s.lensView().text.endsWith(" *"), JSON.stringify(lines().at(-1)));

		check("hela vyn ryms på linsen", s.lensView().text.split("\n").length <= BODY_ROWS, JSON.stringify(lines()));

		// A process producing output refreshes the blink without changing a word.
		const before = s.lensView().text;
		progress({ alive: true });
		check("ett livstecken ändrar inga ord", s.lensView().text === before.replace(/ \*$/, ""), s.lensView().text);

		s.apply({ type: "event", kind: "turn", data: { id: "t1", to: "Bosse", parts: ["bygg klart testerna", "och kör dem sen"], phase: "done" } });
		s.apply({ type: "text", text: "Alla 41 checkar gröna.", from: "Bosse", seq: 2 });
		check("svaret tar över linsen när turen är slut", s.lensView().text === "Alla 41 checkar gröna.", s.lensView().text);
		check("och ingenting påstår längre att något pågår", s.working() === false);
	}

	section("modellen: många meningar får plats, de äldsta viker undan");
	{
		const s = new Store();
		s.state.connection = "online";
		s.state.worker = "Bosse";
		const parts = Array.from({ length: 12 }, (_, i) => `mening nummer ${i + 1} som är ganska lång och radbryts`);
		s.apply({ type: "event", kind: "turn", data: { id: "t1", to: "Bosse", parts, phase: "started" } });
		s.apply({ type: "event", kind: "progress", data: { from: "Bosse", turn: "t1", tool: "Bash", doing: "Running the suite" } });

		const lines = s.lensView().text.split("\n");
		check("linsen svämmar aldrig över", lines.length <= BODY_ROWS, `${lines.length}: ${JSON.stringify(lines)}`);
		check("det som görs just nu överlever alltid", lines.at(-1) === `${MARK_THEIRS} Running the suite`, JSON.stringify(lines.at(-1)));
		check("den sista meningen man sa överlever", lines.some((l) => l.includes("nummer 12")), JSON.stringify(lines));
		check("och det som inte fick plats räknas, det försvinner inte tyst",
			/^\+\d+ earlier$/.test(lines[0]), JSON.stringify(lines[0]));
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

section("QR i stället för att skriva in server och token");
{
	// Typing a host and a 64-character token on a phone is the worst input this
	// app asks for. The link already exists; the camera is the honest way in.
	const url = "https://kontoret.onvo.se:3456/?token=" + "a1b2c3d4".repeat(8);
	const read = settingsFromScan(url);
	check("en skannad länk ger både adress och token", read.ok && !!read.settings.token, JSON.stringify(read));
	check("adressen blir en ws-adress mot samma värd",
		read.ok && read.settings.server === "wss://kontoret.onvo.se:3456/ws", JSON.stringify(read.settings));
	check("och värdnamnet kan visas för användaren", read.ok && read.host === "kontoret.onvo.se:3456", JSON.stringify(read));

	// A packaged app is served from somewhere else entirely, so an explicit
	// server has to win over the origin the code was read from.
	const explicit = settingsFromScan("https://a.example/?token=x&server=wss://b.example/ws");
	check("en utskriven server vinner över ursprunget",
		explicit.ok && explicit.settings.server === "wss://b.example/ws", JSON.stringify(explicit.settings));

	for (const [bad, why] of [["", "tomt"], ["inte en länk", "inte en URL"],
		["https://host/", "utan token"], ["mailto:robin@example.com", "fel protokoll"]]) {
		const r = settingsFromScan(bad);
		check(`${why} avvisas med något läsbart`, r.ok === false && r.error.length > 0 && r.error.length < 60, JSON.stringify(r));
	}

	// The decoder, against a real QR rendered by a different program than the
	// one reading it — otherwise this only proves jsQR agrees with itself.
	const { execFileSync } = await import("node:child_process");
	const png = "/tmp/prd4-qr-test.png";
	execFileSync("qrencode", ["-t", "PNG32", "-o", png, "-s", "6", "-m", "2", url]);
	const { readFileSync } = await import("node:fs");
	const { decodePng } = await import("./png.mjs");
	const pixels = decodePng(readFileSync(png));
	// jsQR wants a Uint8ClampedArray; the decoder hands back a Buffer over the
	// same bytes.
	const text = decodeFrame(new Uint8ClampedArray(pixels.data.buffer, pixels.data.byteOffset, pixels.data.length),
		pixels.width, pixels.height);
	check("avkodaren läser en riktig QR-bild", text === url, String(text));
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
