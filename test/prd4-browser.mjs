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
	const session = await evaluate(`document.querySelector(".settings .info").textContent`);
	check("och har fått en session av servern", /^session [0-9a-f]{8}/.test(session), session);
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
	await waitFor(`jarvis.listening() !== "thinking"`, 5_000, "turen är över");
	const rows = await evaluate(`[...document.querySelectorAll(".lens .row")].map(r => r.textContent.replace(/\\u00a0/g, ""))`);
	const expected = renderLens({ from: "echo", text: `echo: ${SAID}`, status: null, page: 0 }).lines;
	check("förhandsvisningen är exakt den ram glasögonen skulle få (krav 3)",
		JSON.stringify(rows) === JSON.stringify(expected),
		`${JSON.stringify(rows.slice(0, 2))} mot ${JSON.stringify(expected.slice(0, 2))}`);
	check("rubriken säger vem som talade (krav 6)", rows[0].startsWith("echo"), rows[0]);
	check("ingen rad är bredare än femtio kolumner (krav 2)",
		rows.every((r) => r.length <= 50), JSON.stringify(rows.filter((r) => r.length > 50)));

	// The settings drawer, on a phone-sized viewport. Robin could not reach
	// Reconnect or New conversation: the drawer is the tallest thing in the app,
	// it opens at the bottom, and nothing scrolled.
	section("inställningspanelen går att nå på en telefon");
	const drawer = await evaluate(`(() => {
		const d = document.querySelector("details.settings");
		d.open = true;
		const body = d.querySelector(".body");
		const cs = getComputedStyle(body);
		const buttons = [...d.querySelectorAll("button")].map((b) => b.textContent);
		const last = [...d.querySelectorAll("button")].pop();
		last.scrollIntoView({ block: "center" });
		const r = last.getBoundingClientRect();
		return {
			overflow: cs.overflowY,
			scrolls: body.scrollHeight > body.clientHeight,
			reachable: r.top >= 0 && r.bottom <= innerHeight,
			appTaller: document.getElementById("app").getBoundingClientRect().height <= innerHeight + 1,
			buttons
		};
	})()`);
	check("lådan rullar av sig själv", drawer.overflow === "auto", drawer.overflow);
	check("den sista knappen går att få fram", drawer.reachable === true, JSON.stringify(drawer));
	check("och appen är inte högre än fönstret", drawer.appTaller === true, JSON.stringify(drawer));
	check("skanningsknappen finns", drawer.buttons.includes("Scan QR"), JSON.stringify(drawer.buttons));

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

	const reports = await evaluate(`jarvis.reports()`);
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
