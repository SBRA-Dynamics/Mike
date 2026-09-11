// PRD 4 — the lens, on the real LVGL renderer.
//
//   node test/prd4-lens.mjs [--no-build] [--keep]
//
// The Even Hub simulator runs the BUILT client, served by a real Jarvis server,
// and its automation API hands back the actual glasses framebuffer, the
// WebView's console, and injected touchpad gestures. That makes most of the
// lens half of this PRD testable without hardware, which is the difference
// between "it should fit in fifty columns" and a measurement.
//
// It runs headless on Xvfb. A simulator window on the developer's desktop
// steals focus every run, and everything this test reads comes over HTTP.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

import { startServer, connect, check, failed, section, sleep, ROOT } from "./harness.mjs";
import { decodePng, textBands, litPixels, differingPixels, countNear } from "./png.mjs";
import { renderLens } from "../client/src/lens/render.ts";

const args = process.argv.slice(2);
const SHOTS = join(ROOT, "test", "out", "prd4-lens");
const DISPLAY = ":99";

let sim = null;
let automationPort = 0;
const api = (path) => `http://127.0.0.1:${automationPort}${path}`;

const shot = async (name, path = "/api/screenshot/glasses") => {
	const res = await fetch(api(path));
	if (!res.ok) throw new Error(`${path} svarade ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(join(SHOTS, `${name}.png`), buf);
	return decodePng(buf);
};

const input = async (action) => {
	const res = await fetch(api("/api/input"), {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action })
	});
	if (!res.ok) throw new Error(`input ${action} svarade ${res.status}`);
	// A gesture is a BLE round trip in the simulator too; give the repaint time.
	await sleep(900);
};

const consoleEntries = async (sinceId) => {
	const res = await fetch(api(`/api/console${sinceId === undefined ? "" : `?since_id=${sinceId}`}`));
	return res.ok ? (await res.json()).entries ?? [] : [];
};

const waitUntil = async (fn, ms, label) => {
	const until = Date.now() + ms;
	let last = null;
	while (Date.now() < until) {
		last = await fn();
		if (last) return last;
		await sleep(250);
	}
	throw new Error(`tiden gick ut medan vi väntade på ${label}`);
};

/** A port the OS says is free, read back rather than picked. */
const freePort = async () => {
	const s = net.createServer();
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	const port = s.address().port;
	await new Promise((r) => s.close(r));
	return port;
};

const servers = [];

try {
	// Cleared first: a stale screenshot from a previous run, sitting next to this
	// one's, is a thing to misread later.
	rmSync(SHOTS, { recursive: true, force: true });
	mkdirSync(SHOTS, { recursive: true });

	// ------------------------------------------------------------------ build
	if (!args.includes("--no-build")) {
		section("bygget: samma artefakt som servern serverar (R4.1)");
		const built = spawnSync("npm", ["run", "build"], { cwd: join(ROOT, "client"), encoding: "utf8" });
		check("klienten byggs utan fel", built.status === 0, (built.stderr || built.stdout || "").slice(-500));
		if (built.status !== 0) throw new Error("bygget gick inte igenom");
	}
	check("bygget hamnade där servern letar (--static ./public)", existsSync(join(ROOT, "public", "index.html")));

	// ----------------------------------------------------------------- server
	const server = await startServer(["--handler", "echo"]);
	servers.push(server);
	const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;

	const page = await fetch(`http://127.0.0.1:${server.port}/`);
	const html = await page.text();
	check("servern serverar den byggda klienten på sin egen adress (krav 1)",
		page.ok && /<script type="module"/.test(html), `${page.status}`);

	// -------------------------------------------------------------- simulator
	section("simulatorn: headless på Xvfb");
	if (spawnSync("pgrep", ["-x", "Xvfb"]).status !== 0) {
		spawn("Xvfb", [DISPLAY, "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
			{ detached: true, stdio: "ignore" }).unref();
		await sleep(2000);
	}
	automationPort = await freePort();
	sim = spawn("evenhub-simulator", ["--automation-port", String(automationPort), url], {
		env: { ...process.env, DISPLAY },
		detached: true, stdio: ["ignore", "pipe", "pipe"]
	});
	let simLog = "";
	sim.stdout.on("data", (d) => { simLog += d; });
	sim.stderr.on("data", (d) => { simLog += d; });

	let pong = false;
	try {
		pong = await waitUntil(async () => {
			try { return (await (await fetch(api("/api/ping"))).text()) === "pong"; } catch { return false; }
		}, 40_000, "simulatorns automations-API");
	} catch (e) {
		// The simulator's own output is the only thing that says why — a missing
		// display, a busy port, a crash on start.
		throw new Error(`${e.message}\nsimulatorn sa:\n${simLog.slice(-800) || "(ingenting)"}`);
	}
	check("simulatorn svarar på sitt automations-API", pong === true);

	// ------------------------------------------------------------------ start
	section("värden: klienten hittar Even-appen genom Flutter-kanalen (R4.6)");
	const ready = await waitUntil(async () => (await consoleEntries()).find((e) => e.message.includes("[jarvis] client up")), 40_000, "klientens startrad");
	check("klienten startar i simulatorn", !!ready, ready?.message);
	check("och ser att den har glasögon — inte en stubbe", /glasses attached/.test(ready.message), ready.message);

	const errors = (await consoleEntries()).filter((e) => e.level === "error" || e.message.startsWith("[uncaught]"));
	check("inga fel i webbvyns konsol under uppstarten", errors.length === 0, JSON.stringify(errors.slice(0, 2)));

	const first = await shot("01-start");
	check("linsen är 576×288", first.width === 576 && first.height === 288, `${first.width}×${first.height}`);
	check("något är tänt på linsen direkt", litPixels(first) > 0, String(litPixels(first)));

	// --------------------------------------------------------------- ett svar
	section("linsen: ett riktigt svar renderas rad för rad (R4.2, krav 2)");

	// Drive text into the simulator's session from outside, the way a second
	// device would. The session the simulator created is the one that is not
	// ours, which is why this asks the server rather than assuming.
	const lister = await connect(server);
	const sinceList = lister.mark();
	lister.send({ type: "control", action: "listSessions", args: { limit: 20 } });
	const listed = await lister.waitFor((m) => m.type === "event" && m.kind === "sessions", 5000, "sessionslista", sinceList);
	const target = listed.data.sessions.find((s) => s.id !== lister.readyMsg.sessionId);
	check("simulatorns klient skapade en session på servern", !!target, JSON.stringify(listed.data.sessions.map((s) => s.id.slice(0, 8))));
	lister.close();

	// Long enough for three pages: nine rows of about fifty columns each, so a
	// page is roughly four hundred characters and the answer has to beat twelve.
	const REPLY = "Jag har läst igenom katalogen och hittat fyra filer som matchar det du beskrev, varav två ser genererade ut och bör lämnas i fred. De andra två är källkod, och den ena importerar den andra, vilket gör ordningen viktig när du ändrar dem. "
		+ "Den första filen sätter upp anslutningen och innehåller den tidsgräns vi pratade om i förra veckan, medan den andra bara läser resultatet och skriver det vidare utan att bry sig om var det kom ifrån. "
		+ "Om du vill kan jag börja med den understa och arbeta uppåt, så att ingenting går sönder på vägen, men då kommer de första ändringarna inte att synas förrän hela kedjan är på plats. "
		+ "Alternativet är att jag skriver ned vad som skulle behöva göras, lämnar filerna precis som de är, och låter dig läsa igenom det innan någon rör koden. Vad föredrar du? "
		+ "Jag kan också lägga in en kort sammanfattning överst i filen, så att nästa person som öppnar den slipper läsa hela kedjan för att förstå vad som händer.";
	const expected = renderLens({ from: "echo", text: `echo: ${REPLY}`, page: 0 });
	check("svaret är långt nog att spänna över flera sidor", expected.pages >= 3, `${expected.pages} sidor`);

	const driver = await connect(server, { sessionId: target.id });
	await driver.sayAndSettle(REPLY);
	await sleep(1200);      // one BLE-shaped round trip in the simulator

	const page1 = await shot("02-sida1");
	const bands1 = textBands(page1);
	const expectedRows = expected.content.split("\n").filter((l) => l.trim() !== "").length;
	check(`linsen visar ${expectedRows} rader — precis de klienten radbröt`,
		bands1.length === expectedRows, `${bands1.length} band: ${JSON.stringify(bands1)}`);
	check("och aldrig fler än tio", bands1.length <= 10, String(bands1.length));
	check("ingenting ritas utanför linsens 288 px", bands1.at(-1).bottom < 288, JSON.stringify(bands1.at(-1)));
	check("rubrikraden ligger överst", bands1[0].top < 27, JSON.stringify(bands1[0]));
	check("mer text tänder fler pixlar än startskärmen", litPixels(page1) > litPixels(first),
		`${litPixels(page1)} mot ${litPixels(first)}`);

	// ------------------------------------------------------------- gesterna
	section("gesterna: ett långt svar går att läsa till slutet (R4.3, krav 7)");
	await input("click");
	const page2 = await shot("03-sida2-efter-tapp");
	check("en tapp visar nästa sida", differingPixels(page1, page2) > 500, String(differingPixels(page1, page2)));

	await input("click");
	const page3 = await shot("04-sida3-efter-tapp");
	check("en tapp till visar sista sidan",
		differingPixels(page3, page2) > 500 && differingPixels(page3, page1) > 500,
		`${differingPixels(page3, page2)} / ${differingPixels(page3, page1)}`);

	await input("up");
	const backTo2 = await shot("05-svep-upp-till-sida2");
	check("svep uppåt går tillbaka till exakt samma sida som förut",
		differingPixels(backTo2, page2) === 0, String(differingPixels(backTo2, page2)));

	await input("down");
	const downTo3 = await shot("06-svep-ned-till-sida3");
	check("svep nedåt går framåt igen", differingPixels(downTo3, page3) === 0, String(differingPixels(downTo3, page3)));

	await input("down");
	const stillLast = await shot("07-svep-ned-bortom-slutet");
	check("svep nedåt bortom sista sidan står stilla i stället för att tömma linsen",
		differingPixels(stillLast, page3) === 0, String(differingPixels(stillLast, page3)));

	// Past the last page a tap repeats from the top rather than doing nothing —
	// the lens must never sit still on a gesture the user made deliberately.
	await input("click");
	const wrapped = await shot("08-tapp-bortom-slutet-borjar-om");
	check("bortom sista sidan börjar en tapp om från början",
		differingPixels(wrapped, page1) === 0, String(differingPixels(wrapped, page1)));

	// ------------------------------------------------------------- companion
	section("telefonen: samma text som linsen (krav 3)");
	const web = await shot("09-companion", "/api/screenshot/webview");
	// The preview box is the only thing on the page painted in the lens green,
	// so finding those pixels is finding a rendered preview.
	const green = countNear(web, [0x6e, 0xf0, 0x8a], 40);
	check("telefonens förhandsvisning ritar linsrutan", green > 200, `${green} px`);

	// ------------------------------------------------------------------ exit
	section("dubbeltapp: systemets avslutsdialog (krav 5)");
	const beforeExit = await consoleEntries();
	const lastId = Math.max(0, ...beforeExit.map((e) => e.id));
	await input("double_click");
	const exitShot = await shot("10-efter-dubbeltapp");
	const afterExit = await consoleEntries(lastId);
	const bridged = afterExit.filter((e) => /Flutter Bridge intercepted/.test(e.message));
	check("dubbeltappen når klienten och går vidare till värden",
		bridged.length > 0 || differingPixels(exitShot, wrapped) > 0,
		`${bridged.length} brokall, ${differingPixels(exitShot, wrapped)} px ändrade`);
	check("inga ouppfångade fel efter dubbeltappen",
		!afterExit.some((e) => e.message.startsWith("[uncaught]")), JSON.stringify(afterExit.slice(0, 3)));

	driver.close();
	check("inga ouppfångade undantag i servern", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
	console.log(`\nskärmbilder: ${SHOTS}`);

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	if (sim && !args.includes("--keep")) {
		// The whole group: the packaged binary spawns a webview child, and
		// killing only the parent leaves a window (and a port) behind.
		try { process.kill(-sim.pid, "SIGKILL"); } catch { try { sim.kill("SIGKILL"); } catch { } }
		await sleep(500);
	}
	for (const s of servers) { try { s.stop(); } catch { } }
	await sleep(200);
	const leaked = spawnSync("pgrep", ["-f", "bin/evenhub[-]simulator"], { encoding: "utf8" });
	const count = (leaked.stdout || "").trim().split("\n").filter(Boolean).length;
	check("inga simulatorer lämnade kvar", args.includes("--keep") || count === 0, `${count} kvar`);
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
