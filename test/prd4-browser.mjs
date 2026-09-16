// PRD 4 — the client in a plain desktop browser (acceptance criteria 1 and 3).
//
//   node test/prd4-browser.mjs
//
// The same build the glasses run, opened in Chrome with no Even App behind it.
// That is both the development path and R4.6's honest degradation: no host is a
// normal state, and the companion must be fully usable without one.
//
// Driven over the DevTools protocol rather than by dumping the DOM once:
// --virtual-time-budget freezes real time, so a WebSocket handshake never
// completes under it and the page is photographed mid-connect. Here the page
// runs in real time and is asked questions.

import { join } from "node:path";
import { existsSync } from "node:fs";

import { startServer, check, failed, section, sleep, ROOT } from "./harness.mjs";
import { launchChrome, CHROME } from "./chrome.mjs";
import { renderLens } from "../client/src/lens/render.ts";

let browser = null;
const servers = [];

try {
	check("klienten är byggd", existsSync(join(ROOT, "public", "index.html")),
		"kör npm run build:client först");
	if (!CHROME) throw new Error("ingen Chrome installerad — det här testet behöver en riktig webbläsare");

	const server = await startServer(["--handler", "echo"]);
	servers.push(server);
	const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;

	// ----------------------------------------------------------------- chrome
	section("skrivbordet: serverns adress i en vanlig webbläsare (krav 1)");
	browser = await launchChrome(url);
	const { evaluate, waitFor, consoleErrors } = browser;
	check("webbläsaren startade och sidan kom från servern, inte från någon annanstans",
		browser.page.url.startsWith(`http://127.0.0.1:${server.port}`), browser.page.url);

	// ------------------------------------------------------------------ state
	await waitFor(`document.querySelectorAll(".lens .row").length === 10`, 15_000, "linsrutan");
	check("förhandsvisningen är exakt tio rader (krav 2)",
		(await evaluate(`document.querySelectorAll(".lens .row").length`)) === 10);

	// Waited for, not sampled: the notice is written after the host detection
	// window closes, which is two seconds after the rows exist. Reading it
	// straight after the rows appear measures the moment before the answer.
	await waitFor(`(document.querySelector(".notice")?.textContent ?? "").length > 0`, 8000, "beskedet om glasögon");
	const notice = await evaluate(`document.querySelector(".notice").textContent`);
	check("utan Even-app säger klienten det, en gång (R4.6)", /companion only/.test(notice), notice);
	check("och den står kvar i stället för att blinka förbi",
		(await evaluate(`document.querySelector(".notice").hidden`)) === false);

	// No token pasted anywhere, no server address configured: the link carried
	// the one credential and the origin carried the rest.
	await waitFor(`document.querySelector(".dot").className.includes("online")`, 15_000, "anslutning");
	const status = await evaluate(`document.querySelector("header .chip:last-child").textContent`);
	check("klienten kopplar upp sig av sig själv, utan konfiguration (krav 1)", status === "online", status);
	const session = await evaluate(`mike.state().sessionId ?? ""`);
	check("och har fått en session av servern", /^[0-9a-f]{8}/.test(session), session);
	check("token ligger inte kvar i adressfältet efteråt",
		!(await evaluate(`location.search`)).includes("token"), await evaluate(`location.search`));

	// -------------------------------------------------------------- ett varv
	section("skrivbordet: skriva och få svar (R4.4)");
	const SAID = "hej från skrivbordet";
	await evaluate(`(() => {
		const i = document.querySelector(".composer input");
		i.value = ${JSON.stringify(SAID)};
		document.querySelector(".composer").dispatchEvent(new Event("submit", { cancelable: true }));
		return true;
	})()`);

	await waitFor(`document.querySelector(".transcript").textContent.includes("echo: ${SAID}")`, 10_000, "ekot");
	check("det man skriver hamnar i transkriptet",
		(await evaluate(`document.querySelector(".transcript").textContent`)).includes(SAID));
	check("inmatningsfältet töms när det gick iväg",
		(await evaluate(`document.querySelector(".composer input").value`)) === "");

	// Acceptance 3, on the desktop half: the preview is not an approximation of
	// what the lens shows, it is the same frame — so comparing it against what
	// renderLens produces here is comparing it against what the glasses get.
	//
	// The reply lands one message before the `state` that ends the turn, so
	// for a moment the header still says "thinking"; the frame compared is the
	// one after that moment, or the comparison measures the race and not the
	// preview.
	await waitFor(`mike.listening() !== "thinking"`, 5_000, "turen är över");
	const rows = await evaluate(`[...document.querySelectorAll(".lens .row")].map(r => r.textContent.replace(/\\u00a0/g, ""))`);
	// The title bar names who the next sentence goes to — Mike, there being
	// no worker — and words from anybody else say whose they are. The echo
	// handler is "anybody else". The microphone mark is whatever the browser's
	// microphone is, which is a switch that is off.
	const mic = (await evaluate(`mike.state().voice ? (mike.state().voice.live ? "live" : "off") : null`));
	const expected = renderLens({ from: "Mike", text: `echo: echo: ${SAID}`, status: null, mic, page: 0 }).lines;
	check("förhandsvisningen är exakt den ram glasögonen skulle få (krav 3)",
		JSON.stringify(rows) === JSON.stringify(expected),
		`${JSON.stringify(rows.slice(0, 2))} mot ${JSON.stringify(expected.slice(0, 2))}`);
	check("rubriken säger vem man talar med, och texten vem som talade (krav 6)", rows[0].includes("Mike") && rows[1].includes("echo:"), rows[0] + rows[1]);
	check("ingen rad är bredare än femtio kolumner (krav 2)",
		rows.every((r) => r.length <= 50), JSON.stringify(rows.filter((r) => r.length > 50)));

	// No settings. The only configuration is the QR code, and the only time it
	// is offered is when there is no server: the pairing screen covers the app
	// then and is gone the rest of the time.
	section("inga inställningar — bara QR-skanning, och bara utan server");
	const pairing = await evaluate(`(() => {
		const p = document.querySelector(".pairing");
		return {
			exists: !!p,
			hidden: p?.hidden ?? null,
			buttons: [...(p?.querySelectorAll("button") ?? [])].map((b) => b.textContent),
			drawer: !!document.querySelector("details.settings"),
			inputs: [...document.querySelectorAll("input")].map((i) => i.placeholder)
		};
	})()`);
	check("parkopplingsskärmen finns men är dold när servern svarar", pairing.exists && pairing.hidden === true, JSON.stringify(pairing));
	// Two ways to read the code — the camera and the photo library — and
	// nothing else: no settings, no fields. Both buttons scan; neither configures.
	check("dess knappar är bara skanning (kamera och bild)", JSON.stringify(pairing.buttons) === JSON.stringify(["Scan QR", "Choose a photo instead"]), JSON.stringify(pairing.buttons));
	check("inställningslådan är borta", pairing.drawer === false);
	check("och inget fält för server eller token finns kvar", !pairing.inputs.some((p) => /token|wss/.test(p)), JSON.stringify(pairing.inputs));

	check("inga fel i konsolen under hela varvet", consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));
	check("inga ouppfångade undantag i servern", !server.log().includes("UNCAUGHT"), server.log().slice(-300));

	// Sist, för att det här avsnittet med flit skriver fel i konsolen.
	//
	// Kraschen PRD 6 lämnade öppen var svarta lådan själv. I Even-appen är
	// console bryggad till värden genom ett löfte som ingen äger; när det
	// avvisas blir det en unhandledrejection, som rapporteras med console.error,
	// som bryggas, som avvisas. Serverloggen har 588 identiska rader på en
	// sekund och sedan en död socket.
	//
	// Så: bygg samma brygga i en riktig webbläsare — en console.error som
	// avvisar ett löfte varje gång den anropas — och släpp in ETT fel. Utan
	// spärren är det här ett test som aldrig återvänder.
	section("svarta lådan kan inte bli kraschen");
	await evaluate(`(() => {
		globalThis.__consoleCalls = 0;
		const real = console.error.bind(console);
		console.error = (...a) => {
			globalThis.__consoleCalls++;
			// Precis vad flutter_inappwebview gör: ett löfte som ingen tar hand om.
			Promise.reject(new Error("console bridge unavailable"));
			real(...a);
		};
		Promise.reject(new Error("frö"));
		return true;
	})()`);

	// En sekund är hundratals varv om loopen lever: den mätta takten var ~600
	// rapporter i sekunden.
	await sleep(1000);

	const reports = await evaluate(`mike.reports()`);
	const calls = await evaluate(`globalThis.__consoleCalls`);
	check("sidan svarar fortfarande", (await evaluate(`1 + 1`)) === 2);
	check("rapporterna slutar växa", reports.total <= 5, JSON.stringify(reports));
	check("och konsolen anropas ett fåtal gånger, inte hundratals", calls <= 5, String(calls));
	check("det som tystades är räknat, inte glömt", reports.suppressed > 0, JSON.stringify(reports));

	// Klienten lever kvar efteråt: spärren får inte vara ett sätt att dö tyst.
	const AFTER = "efter loopen";
	await evaluate(`(() => {
		const i = document.querySelector(".composer input");
		i.value = ${JSON.stringify(AFTER)};
		document.querySelector(".composer").dispatchEvent(new Event("submit", { cancelable: true }));
		return true;
	})()`);
	await waitFor(`document.querySelector(".transcript").textContent.includes("echo: ${AFTER}")`, 10_000, "svaret efteråt");
	check("och en tur går igenom efteråt",
		(await evaluate(`document.querySelector(".transcript").textContent`)).includes(AFTER));

	// Allra sist, för att det här lämnar servern. Statuschipet i listen är
	// vägen till serverraden; knappen där kräver två tryck; efteråt är token
	// borta ur lagret och parkopplingsskärmen tillbaka med rätt besked.
	section("glömma servern: två tryck, sedan QR-skärmen igen");
	const rowBefore = await evaluate(`document.querySelector(".serverrow").hidden`);
	check("serverraden är dold tills chipet trycks", rowBefore === true);
	await evaluate(`(document.querySelector("header .chip:last-child").click(), true)`);
	const row = await evaluate(`(() => { const r = document.querySelector(".serverrow"); return { hidden: r.hidden, text: r.querySelector(".serverhost").textContent, button: r.querySelector("button").textContent }; })()`);
	check("chipet fäller ut raden med serverns värdnamn", row.hidden === false && row.text.includes(`127.0.0.1:${server.port}`), JSON.stringify(row));
	check("och en knapp för att glömma", row.button === "Forget this server", row.button);
	await evaluate(`(document.querySelector(".serverrow button").click(), true)`);
	const armed = await evaluate(`(() => { const b = document.querySelector(".serverrow button"); return { text: b.textContent, armed: b.classList.contains("armed"), pairing: document.querySelector(".pairing").hidden }; })()`);
	check("ett tryck beväpnar bara knappen", armed.armed === true && armed.text === "Tap again to forget" && armed.pairing === true, JSON.stringify(armed));
	await evaluate(`(document.querySelector(".serverrow button").click(), true)`);
	await waitFor(`document.querySelector(".pairing").hidden === false`, 5_000, "parkopplingsskärmen");
	const why = await evaluate(`document.querySelector(".pairing .why").textContent`);
	check("det andra trycket tar fram parkopplingsskärmen som oparad, inte som nekad", why === "Not paired with a server yet.", why);
	const stored = await evaluate(`Object.values(localStorage).join(" ")`);
	check("token och adress är borta ur lagret", !stored.includes(server.token) && !stored.includes("127.0.0.1"), stored.slice(0, 120));
	check("och serverraden är dold igen", (await evaluate(`document.querySelector(".serverrow").hidden`)) === true);

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	try { browser?.close(); } catch { }
	await sleep(300);
	for (const s of servers) { try { s.stop(); } catch { } }
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
