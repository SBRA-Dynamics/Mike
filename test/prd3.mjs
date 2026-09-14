// PRD 3 — Mike, workers, routing, context injection.
//
//   node test/prd3.mjs
//
// Everything here is deterministic and free. The server runs its REAL handler,
// its REAL engine and the REAL MCP round trip; only the `claude` binary is a
// stand-in (test/fixtures/fake-claude.mjs, which documents exactly which half
// of the CLI it reproduces). The claim this suite does not make is "a real
// model would pick that tool" — that one costs money and lives in
// test/e2e-live.mjs.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, connect, check, failed, section, sleep, ROOT, grantTools, McpClient } from "./harness.mjs";
import { route, stripAddress, matchModeCommand, applyModeCommand, MODES, ORIGIN } from "../src/routing.js";
import { buildWorkerContext, composePrompt } from "../src/mike.js";
import { describeTool } from "../src/claudeCli.js";

const FAKE = join(ROOT, "test", "fixtures", "fake-claude.mjs");

/** Every stand-in state directory we make, so a suite that throws does not
 *  leave them (and the sessions inside them) behind. */
const fakeDirs = [];
const newFakeDir = () => { const d = mkdtempSync(join(tmpdir(), "fake-claude-")); fakeDirs.push(d); return d; };
const cleanFakeDirs = () => { for (const d of fakeDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { } } };
process.on("exit", cleanFakeDirs);

/** A server whose Claude Code is the stand-in. */
const startMike = async (extra = [], env = {}) => {
	const fakeDir = newFakeDir();
	const server = await startServer(
		["--claude-bin", FAKE, "--worker-cwd", "/tmp", "--mike-cwd", "/tmp", ...extra],
		{ env: { FAKE_CLAUDE_DIR: fakeDir, ...env } });
	server.fakeDir = fakeDir;
	return server;
};

/** Say one thing and wait for the turn to close. `since` is taken before the
 *  send, always: without it the wait matches the PREVIOUS turn's idle state and
 *  the loop races ahead, passing while measuring nothing. */
const say = async (c, text, ms = 20_000) => {
	const since = c.mark();
	c.send({ type: "say", text });
	await c.waitFor((m) => m.type === "state" && m.busy === false, ms, `idle after ${JSON.stringify(text)}`, since);
	return c.messages.slice(since);
};
/** The same, but declared as coming from a keyboard rather than a microphone. */
const type = async (c, text, ms = 20_000) => {
	const since = c.mark();
	c.send({ type: "say", text, origin: "typed" });
	await c.waitFor((m) => m.type === "state" && m.busy === false, ms, `idle after typing ${JSON.stringify(text)}`, since);
	return c.messages.slice(since);
};
const textsOf = (turn) => turn.filter((m) => m.type === "text");
const eventOf = (turn, kind) => turn.find((m) => m.type === "event" && m.kind === kind);

/** The client's own switch (PRD 3's `switchWorker` control), which is instant
 *  because no model is involved. */
const controlSwitch = async (c, name) => {
	const since = c.mark();
	c.send({ type: "control", action: "switchWorker", args: { name } });
	await c.waitFor((m) => m.type === "event" && m.kind === "workerSwitched", 10_000, `växling till ${name}`, since);
};

/** Ask the server, over the wire, for a worker's Claude Code session id. Read
 *  back rather than guessed: it is the server that chose it. */
const whoIs = async (c, name) => {
	const since = c.mark();
	c.send({ type: "control", action: "whoIs", args: name ? { name } : {} });
	const ev = await c.waitFor((m) => m.type === "event" && (m.kind === "workerIdentity" || m.type === "error"), 5000, "workerIdentity", since);
	return ev.data;
};

const runFake = (args, env) => new Promise((resolve) => {
	const p = spawn("node", [FAKE, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
	let out = "", err = "";
	p.stdout.on("data", (d) => { out += d; });
	p.stderr.on("data", (d) => { err += d; });
	p.on("close", (code) => resolve({ code, out, err }));
});

const servers = [];
const track = (s) => { servers.push(s); return s; };

try {
	// ================================================================ routing
	section("routing: vem orden går till (R3.2, PRD 5a R5a.4)");

	check("namnprefixet plockas bort innan Mike ser texten",
		route("Mike, starta en arbetare", { worker: null }).text === "starta en arbetare",
		JSON.stringify(route("Mike, starta en arbetare", { worker: null })));

	for (const v of ["Mike, hej", "mike hej", "Mike. hej", "Mike: hej", "Hey Mike, hej", "Hej Mike hej", "MIKE, hej"]) {
		check(`dikteringsvariant "${v}" når Mike`,
			route(v, { worker: "Bosse" }).kind === "mike" && route(v, { worker: "Bosse" }).text === "hej",
			JSON.stringify(route(v, { worker: "Bosse" })));
	}

	check("ett namn som BÖRJAR med mike är inte Mike",
		route("Mikeson, hej", { worker: "Mikeson" }).kind === "worker");
	check("prefixet slår igenom oavsett vilken arbetare som är aktiv — R3.2",
		route("Mike, vad gör Bosse", { worker: "Kalle" }).kind === "mike");
	check("utan aktiv arbetare går allt till Mike — R3.1",
		route("Mike, hej", { worker: null }).kind === "mike");
	check("bara namnet är inte tomt utan ett tilltal",
		route("Mike.", { worker: null }).text === "Mike");
	check("arbetarens eget namn tilltalar arbetaren, utan prefixet",
		JSON.stringify(route("Bosse, lista filerna", { worker: "Bosse" })) === JSON.stringify({ kind: "worker", name: "Bosse", text: "lista filerna", addressed: true }));
	check("diakriter i ett arbetarnamn viks ihop som överallt annars",
		route("Mans, hej", { worker: "Måns" }).kind === "worker");
	check("tomt yttrande är inget yttrande", route("   ", { worker: "Bosse" }).kind === "empty");

	section("routing: lägena (PRD 5a R5a.4)");
	check("byname utan tilltal släpps inte fram",
		route("vad är klockan", { worker: "Bosse", mode: MODES.BYNAME }).kind === "dropped");
	check("always släpper fram allt till den aktiva arbetaren — ordagrant",
		JSON.stringify(route("vad är klockan", { worker: "Bosse", mode: MODES.ALWAYS })) === JSON.stringify({ kind: "worker", name: "Bosse", text: "vad är klockan", addressed: false }));
	check("always utan arbetare går till Mike",
		route("vad är klockan", { worker: null, mode: MODES.ALWAYS }).kind === "mike");
	check("ignore släpper inte fram något",
		route("vad är klockan", { worker: "Bosse", mode: MODES.IGNORE }).kind === "dropped");
	check("ignore släpper inte ens fram ett tilltal",
		route("Mike, vad är klockan", { worker: null, mode: MODES.IGNORE }).kind === "dropped");

	// The gate filters ambient speech. Typing has no ambient problem, so the
	// keyboard is never asked to address anyone — but it may.
	section("grinden gäller talet, inte tangentbordet");
	const typed = { origin: ORIGIN.TYPED };
	check("skrivet utan tilltal når arbetaren i byname",
		JSON.stringify(route("lista filerna", { worker: "Bosse", mode: MODES.BYNAME, ...typed })) ===
		JSON.stringify({ kind: "worker", name: "Bosse", text: "lista filerna", addressed: false }));
	check("ett ensamt Mike är ett anrop", route("Mike.", { worker: "Bosse" }).bare === true && route("Mike.", { worker: "Bosse" }).text === "Mike");
	check("Mike med något efter är inget anrop", route("Mike, hej", { worker: "Bosse" }).bare === undefined);
	check("skrivet utan tilltal och utan arbetare går till Mike",
		route("lista filerna", { worker: null, mode: MODES.BYNAME, ...typed }).kind === "mike");
	check("talat utan tilltal släpps fortfarande i byname",
		route("lista filerna", { worker: "Bosse", mode: MODES.BYNAME, origin: ORIGIN.VOICE }).kind === "dropped");
	check("utan angiven härkomst behandlas orden som tal",
		route("lista filerna", { worker: "Bosse", mode: MODES.BYNAME }).kind === "dropped");
	check("ignore pausar lyssnandet, inte tangentbordet",
		route("lista filerna", { worker: "Bosse", mode: MODES.IGNORE, ...typed }).kind === "worker");
	check("skrivet tilltal fungerar fortfarande och prefixet klipps bort",
		JSON.stringify(route("Mike, lista filerna", { worker: "Bosse", mode: MODES.BYNAME, ...typed })) ===
		JSON.stringify({ kind: "mike", text: "lista filerna" }));
	check("lägeskommandon fungerar även skrivna",
		route("pausa input", { worker: "Bosse", mode: MODES.BYNAME, ...typed }).kind === "mode");

	section("lägeskommandon matchas före grinden, i varje läge");
	const commands = [
		["pausa input", MODES.IGNORE], ["pause input", MODES.IGNORE], ["Hey Mike, pause the input.", MODES.IGNORE],
		["fortsätt input", "previous"], ["continue input", "previous"], ["Hej Mike, fortsätt input.", "previous"],
		["ändra input till alltid", MODES.ALWAYS], ["change input to always", MODES.ALWAYS],
		["ändra input till via namn", MODES.BYNAME], ["change input to by name", MODES.BYNAME]
	];
	for (const [text, to] of commands) {
		for (const mode of Object.values(MODES)) {
			const r = route(text, { worker: "Bosse", mode });
			check(`"${text}" i läge ${mode}`, r.kind === "mode" && r.to === to, JSON.stringify(r));
		}
	}
	// The phrasing in the PRD is one way of saying it, not the only way anybody
	// says it. A command nobody guesses is a command that does not exist.
	section("lägeskommandon tål att sägas som folk säger dem");
	for (const [text, to] of [
		["byt till always", MODES.ALWAYS], ["sätt läget till alltid", MODES.ALWAYS],
		["change mode to always", MODES.ALWAYS], ["switch to always", MODES.ALWAYS],
		["gå till alltid", MODES.ALWAYS], ["always mode", MODES.ALWAYS],
		// Said out loud by Mannie, and dropped: "always ON" is how the mode is
		// named in speech, and the command did not know the word.
		["ändra mode till always on", MODES.ALWAYS], ["byt till alltid på", MODES.ALWAYS],
		["byt till via namn", MODES.BYNAME], ["namnläge", MODES.BYNAME],
		["växla till håll in", MODES.PUSHTOTALK], ["byt till knapp", MODES.PUSHTOTALK],
		["sluta lyssna", MODES.IGNORE], ["börja lyssna", "previous"]
	]) {
		const r = route(text, { worker: "Bosse" });
		check(`"${text}"`, r.kind === "mode" && r.to === to, JSON.stringify(r));
	}

	// And the other half, which matters more: these are matched before the
	// addressing gate, so a false positive costs a sentence the user has to say
	// again. The whole utterance must BE the command.
	section("men bara när hela meningen är kommandot");
	for (const text of ["byt till alltid när du felsöker", "gå till alltid samma katalog",
		"switch to always using arrow functions", "stoppa lyssnandet på porten 3000",
		"alltid", "namn", "pausa filmen", "byt till main-branchen",
		"sätt alltid på loggningen i main", "always on for the new files"]) {
		const r = route(text, { worker: "Bosse", origin: ORIGIN.TYPED });
		check(`"${text}" är inte ett kommando`, r.kind !== "mode", JSON.stringify(r));
	}

	check("att prata OM kommandot utlöser det inte",
		route("Mike, what happens if I say pause input to you", { worker: null }).kind === "mike");
	check("fortsätt går tillbaka till läget före pausen, inte till standard",
		JSON.stringify(applyModeCommand("previous", applyModeCommand(MODES.IGNORE, { mode: MODES.ALWAYS, previousMode: null }))) ===
		JSON.stringify({ mode: MODES.ALWAYS, previousMode: null }));
	check("två pauser i rad glömmer inte var man kom ifrån",
		applyModeCommand(MODES.IGNORE, applyModeCommand(MODES.IGNORE, { mode: MODES.ALWAYS, previousMode: null })).previousMode === MODES.ALWAYS);
	check("stripAddress säger nej när det inte är ett tilltal", stripAddress("hej Bosse", "Mike") === null);
	check("matchModeCommand säger nej till vanlig text", matchModeCommand("lista filerna") === null);

	section("null program: Mannies ord för glöm det och vänta");
	for (const v of ["null program", "Null program.", "nullprogram", "Mike, null program", "noll program", "null programme", "Null-program"]) {
		const r = route(v, { worker: "Bosse", mode: MODES.IGNORE });
		check(`"${v}" är ett stopp med namn, även i ignore`, r.kind === "stop" && r.nullProgram === true, JSON.stringify(r));
	}
	check("ett vanligt stopp är inget null program", route("stopp", { worker: null }).nullProgram === false);
	check("null program inuti en mening är en mening", route("Mike, vad betyder null program", { worker: null }).kind === "mike");
	check("Bosse, null program stoppar också", route("Bosse, null program", { worker: "Bosse" }).kind === "stop");

	// ================================================= context injection
	section("arbetarkontext (R3.4)");
	const worker = { name: "Bosse", model: "opus", cwd: "/home/user/projects/MyProject" };
	const lines = [
		{ role: "user", text: "bygg klart testerna" },
		{ role: "assistant", text: "klart, tre av dem fallerar" }
	];
	const block = buildWorkerContext(worker, lines);
	check("blocket namnger arbetaren, modellen och katalogen",
		block.startsWith('[The user is currently talking to worker "Bosse" (opus, /home/user/projects/MyProject).'), block);
	check("blocket citerar utbytet med arbetarens namn", /Bosse: klart, tre av dem fallerar\]$/.test(block), block);
	check("användarens rader heter user", /user: bygg klart testerna/.test(block), block);
	check("en tyst arbetare sägs vara tyst", /Nothing has been said to it yet/.test(buildWorkerContext(worker, [])));
	check("ingen aktiv arbetare ger inget block", buildWorkerContext(null, lines) === null);

	const many = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `rad ${i}` }));
	const six = buildWorkerContext(worker, many, { turns: 6, budgetTokens: 10_000 });
	check("N är antal utbyten, inte antal rader", six.split("\n").length === 2 + 12, `${six.split("\n").length} rader`);
	check("de N senaste, inte de N första", six.includes("rad 39") && !six.includes("rad 27"), six);

	const tight = buildWorkerContext(worker, many, { turns: 12, budgetTokens: 50 });
	check("budgeten kapar, äldst först", tight.includes("rad 39") && !tight.includes("rad 20"), tight);
	check("det som kapades bort sägs ha kapats", /earlier lines? omitted/.test(tight), tight);
	check("budgeten kapar aldrig bort det sista som sades", tight.includes("rad 39"), tight);

	const huge = buildWorkerContext(worker, [{ role: "assistant", text: "x".repeat(50_000) }]);
	check("en enorm replik citeras inte hel", huge.length < 2000, `${huge.length} tecken`);

	check("prompten sätts ihop som PRD 3 visar",
		composePrompt("lista filerna", block) === `${block}\n\nThe user says: lista filerna`);
	check("utan block är prompten bara det användaren sa",
		composePrompt("hej", null) === "hej");

	// ======================================================= the engine
	section("motorn: riktiga Claude Code-sessioner (T1:s serialisering)");
	{
		const server = track(await startMike());
		const c = await connect(server);

		await say(c, "Mike, start a worker called Bosse with sonnet");
		const id = await whoIs(c, "Bosse");
		check("arbetaren har ett sessions-id servern valde", /^[0-9a-f-]{36}$/.test(String(id.sessionId)), JSON.stringify(id));
		check("id:t går att lämna över till en terminal", id.resume === `claude --resume ${id.sessionId}`, id.resume);

		await say(c, "Bosse, första saken");
		const statePath = join(server.fakeDir, `${id.sessionId}.json`);
		check("första turen skapade sessionen med --session-id",
			existsSync(statePath) && JSON.parse(readFileSync(statePath, "utf8")).lastArgs.includes("--session-id"), statePath);

		const second = textsOf(await say(c, "Bosse, andra saken"));
		check("andra turen återupptar samma session",
			JSON.parse(readFileSync(statePath, "utf8")).lastArgs.includes("--resume"),
			JSON.stringify(JSON.parse(readFileSync(statePath, "utf8")).lastArgs));
		check("samtalet fortsätter, det startar inte om", second[0].text === "turn 2: andra saken", JSON.stringify(second));
		check("arbetaren fick modellen användaren bad om",
			JSON.parse(readFileSync(statePath, "utf8")).lastModel === "claude-sonnet-5",
			JSON.parse(readFileSync(statePath, "utf8")).lastModel);
		check("inga verktyg ges till en arbetare — R2.4",
			!JSON.parse(readFileSync(statePath, "utf8")).lastArgs.includes("--mcp-config"));

		// T1: two drivers of one session fork it and lose a turn with no error.
		// The server must never become the second driver of its own worker, so
		// two utterances at once have to queue, not race.
		const before = c.mark();
		c.send({ type: "say", text: "Bosse, samtidigt ett" });
		c.send({ type: "say", text: "Bosse, samtidigt två" });
		await c.waitFor((m) => m.type === "text" && /samtidigt två/.test(m.text), 20_000, "andra samtidiga svaret", before);
		const both = c.messages.slice(before).filter((m) => m.type === "text").map((m) => m.text);
		check("två samtidiga yttranden köas, de kolliderar inte",
			both.some((t) => t === "turn 3: samtidigt ett") && both.some((t) => t === "turn 4: samtidigt två"),
			JSON.stringify(both));
		check("och inget av dem tappades", both.length === 2, JSON.stringify(both));

		// The block Mike is given must be the conversation and nothing else:
		// the engine's own bookkeeping entry would be one more thing for him to
		// reason about, paid for out of his context window.
		await say(c, "Mike, hej");
		const mikeId = (await (await fetch(`${server.base}/healthz`)).json()).mike.sessionId;
		const mikePrompt = JSON.parse(readFileSync(join(server.fakeDir, `${mikeId}.json`), "utf8")).turns.pop().prompt;
		check("Mike får arbetarkontexten injicerad — R3.2",
			mikePrompt.includes('[The user is currently talking to worker "Bosse"'), mikePrompt.slice(0, 200));
		check("kontexten citerar utbytet, inte motorns bokföring",
			mikePrompt.includes("andra saken") && !/session-created|meta/.test(mikePrompt), mikePrompt.slice(0, 400));

		c.close();
		server.stop();
	}

	section("en arbetare kan nollställas och börjar om från noll");
	{
		const server = track(await startMike());
		const c = await connect(server);

		await say(c, "Mike, start a worker called Bosse with sonnet");
		await say(c, "Bosse, kom ihåg ordet banan");
		await say(c, "Bosse, andra saken");
		const before = await whoIs(c, "Bosse");

		const reset = await say(c, "Mike, nollställ Bosse");
		check("reset går via Mike som ett verktyg", !!eventOf(reset, "workerReset"), JSON.stringify(reset));
		const after = await whoIs(c, "Bosse");
		check("arbetaren får en ny session", /^[0-9a-f-]{36}$/.test(String(after.sessionId)) && after.sessionId !== before.sessionId,
			JSON.stringify({ before: before.sessionId, after: after.sessionId }));

		const next = textsOf(await say(c, "Bosse, hej igen"));
		check("nästa tur räknas som den första", next[0]?.text === "turn 1: hej igen", JSON.stringify(next));
		const newState = JSON.parse(readFileSync(join(server.fakeDir, `${after.sessionId}.json`), "utf8"));
		check("den nya sessionen skapas med --session-id, inte --resume",
			newState.lastArgs.includes("--session-id") && !newState.lastArgs.includes("--resume"), JSON.stringify(newState.lastArgs));

		const read = await say(c, "Mike, vad gör Bosse");
		const quoted = textsOf(read).map((m) => m.text).join(" ");
		check("det gamla samtalet citeras inte längre", !/banan|andra saken/.test(quoted) && /hej igen/.test(quoted), quoted);
		check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
		c.close();
		server.stop();
	}

	section("motorn: när en tur misslyckas");
	{
		const server = track(await startMike([], { FAKE_CLAUDE_FAIL: "exit" }));
		const c = await connect(server);
		const turn = await say(c, "Mike, hej");
		const err = turn.find((m) => m.type === "error");
		check("ett misslyckande blir ett felmeddelande, inte tystnad", !!err, JSON.stringify(turn));
		check("felet ryms på en lins", err && err.message.length <= 100 && !/\n/.test(err.message), err?.message);
		check("ingen stack läcker ut", err && !/ at .*:\d+:\d+/.test(err.message), err?.message);
		check("turen stängs ändå", turn.some((m) => m.type === "state" && m.busy === false));
		check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
		c.close();
		server.stop();
	}

	section("motorn: när modellen svarar med ett fel men avslutar med noll");
	{
		// The CLI exits 0 and sets is_error for an API failure or a refused
		// model. Reading that as success would put the error string in the
		// transcript as if Mike had said it, which is how a bad model name
		// becomes a personality.
		const server = track(await startMike([], { FAKE_CLAUDE_FAIL: "error" }));
		const c = await connect(server);
		const turn = await say(c, "Mike, hej");
		check("is_error är ett fel, inte ett svar", turn.some((m) => m.type === "error"), JSON.stringify(turn));
		check("och modellens feltext blir aldrig en replik",
			!textsOf(turn).some((m) => /simulated model error/.test(m.text)), JSON.stringify(textsOf(turn)));
		c.close();
		server.stop();
	}

	section("ett misslyckande på första turen kilar inte fast någon för alltid");
	{
		const server = track(await startMike([], { FAKE_CLAUDE_FAIL: "error-once" }));
		const c = await connect(server);
		const bad = await say(c, "Mike, hej");
		check("första turen misslyckas, som den ska", bad.some((m) => m.type === "error"), JSON.stringify(bad));
		const good = await say(c, "Mike, hej igen");
		check("den andra turen går fram — sessionen skapas inte om",
			textsOf(good).length === 1 && !good.some((m) => m.type === "error"), JSON.stringify(good));

		const t = await say(c, "Mike, start a worker called Bosse");
		check("och en arbetare kan fortfarande skapas", !!eventOf(t, "workerSpawned"), JSON.stringify(t));
		const badWorker = await say(c, "Bosse, första");
		check("arbetarens första tur misslyckas också", badWorker.some((m) => m.type === "error"), JSON.stringify(badWorker));
		const okWorker = textsOf(await say(c, "Bosse, andra"));
		check("men arbetaren är inte död — nästa tur återupptar sessionen",
			okWorker[0]?.text === "turn 2: andra", JSON.stringify(okWorker));
		c.close();
		server.stop();
	}

	// ============================================== mike identity + prompt
	section("Mike är alltid samma samtal (R3.7)");
	{
		const server = track(await startMike());
		const c = await connect(server);
		const health1 = await (await fetch(`${server.base}/healthz`)).json();
		check("servern kan säga vilket samtal Mike är", /^[0-9a-f-]{36}$/.test(health1.mike.sessionId), JSON.stringify(health1.mike));

		await say(c, "Mike, hej");
		const mikeFile = join(server.fakeDir, `${health1.mike.sessionId}.json`);
		check("Mike kör i sin egen session", existsSync(mikeFile), mikeFile);
		check("Mike kör modellen han är konfigurerad med",
			JSON.parse(readFileSync(mikeFile, "utf8")).lastModel === "claude-opus-5");

		const args = JSON.parse(readFileSync(mikeFile, "utf8")).lastArgs;
		check("Mike har verktygen — R2.4 baklänges", args.includes("mcp__mike__spawn_worker"), JSON.stringify(args.slice(-12)));
		check("Mike har Bash, som R3.4 kräver", args.includes("Bash"));
		check("ingen ledtråd om ett skalverktyg i verktygslistan", !args.some((a) => /^mcp__mike__(bash|shell|run)/.test(a)));
		check("systemprompten skickas med", args.includes("--append-system-prompt"));
		check("prompten sparas inte som en ögonblicksbild — annars biter inga redigeringar",
			args[args.indexOf("--system-prompt-snapshot") + 1] === "off", JSON.stringify(args.slice(args.indexOf("--system-prompt-snapshot"), 2)));
		check("permissionsfrågor kan aldrig hänga turen",
			args[args.indexOf("--permission-prompts") + 1] === "none");

		c.close();
		await server.restart();
		const health2 = await (await fetch(`${server.base}/healthz`)).json();
		check("Mike överlever en omstart med samma samtal — R3.7",
			health2.mike.sessionId === health1.mike.sessionId, `${health2.mike.sessionId} vs ${health1.mike.sessionId}`);

		const c2 = await connect(server);
		const after = textsOf(await say(c2, "Mike, hej igen"));
		check("och han fortsätter samtalet i stället för att börja om",
			/mike turn 2/.test(after[0].text), JSON.stringify(after));
		c2.close();
		server.stop();
	}

	section("systemprompten är en fil, redigerbar utan ombyggnad");
	{
		const promptFile = join(newFakeDir(), "mike.md");
		writeFileSync(promptFile, "VERSION ETT");
		const server = track(await startMike(["--mike-prompt", promptFile]));
		const c = await connect(server);
		await say(c, "Mike, hej");
		const id = (await (await fetch(`${server.base}/healthz`)).json()).mike.sessionId;
		const file = join(server.fakeDir, `${id}.json`);
		check("prompten som skickas är filens innehåll",
			JSON.parse(readFileSync(file, "utf8")).lastSystemPrompt === "VERSION ETT");

		// The mtime cache is per millisecond; a second write inside the same
		// millisecond would look unchanged and this would pass for the wrong
		// reason. Nudge past it.
		await sleep(20);
		writeFileSync(promptFile, "VERSION TVÅ");
		await say(c, "Mike, hej igen");
		check("en redigering biter på nästa tur, utan omstart",
			JSON.parse(readFileSync(file, "utf8")).lastSystemPrompt === "VERSION TVÅ",
			JSON.parse(readFileSync(file, "utf8")).lastSystemPrompt);
		c.close();
		server.stop();
	}

	section("den levererade prompten säger det PRD 3 kräver att den säger");
	{
		const shipped = readFileSync(join(ROOT, "prompts", "mike.md"), "utf8");
		check("den är versionerad", /Version \d/i.test(shipped), shipped.slice(0, 80));
		for (const [what, re] of [
			["identitet", /you are mike/i],
			["delegering", /\bdelegate\b|route work to a worker/i],
			["korthet", /two lines|be brief/i],
			["verktyg", /spawn_worker/],
			["kontexthantering", /bracketed block/i],
			["språk", /language you were addressed in/i],
			["diktering", /dictated/i]
		]) check(`prompten etablerar ${what}`, re.test(shipped), String(re));
	}

	// =========================================================== the wire
	section("klienten ser hela tiden vem som lyssnar (R3.5)");
	{
		const server = track(await startMike());
		const c = await connect(server);
		check("ready bär den aktiva arbetaren och läget", c.readyMsg.worker === null && c.readyMsg.mode === "byname", JSON.stringify(c.readyMsg));
		const greeting = await c.waitFor((m) => m.type === "text" && m.from === "mike", 5000, "hälsning");
		check("Mike hälsar när man kommer — steg 1", greeting.text.length > 0 && greeting.text.length < 60, greeting.text);

		const spawn1 = await say(c, "Mike, start a worker called Bosse with sonnet");
		for (const m of spawn1.filter((m) => m.type === "state")) {
			check("varje state bär busy, worker och mode",
				"busy" in m && "worker" in m && "mode" in m, JSON.stringify(m));
		}
		check("state efter växlingen namnger arbetaren",
			spawn1.filter((m) => m.type === "state").pop().worker === "Bosse");

		const reattach = await connect(server, { sessionId: c.readyMsg.sessionId });
		check("en ny anslutning ser samma aktiva arbetare", reattach.readyMsg.worker === "Bosse", JSON.stringify(reattach.readyMsg));
		check("och listan över vilka som finns", reattach.readyMsg.workers.some((w) => w.name === "Bosse"));
		reattach.close();

		const dropped = await new Promise((resolve, reject) => {
			const since = c.mark();
			c.send({ type: "say", text: "det här är inte till någon" });
			c.waitFor((m) => m.type === "event" && m.kind === "notHeard", 5000, "notHeard", since).then(resolve, reject);
		});
		check("det som inte släpps fram rapporteras, aldrig tyst",
			dropped.data.reason === "unaddressed", JSON.stringify(dropped.data));

		const paused = await say(c, "pausa input");
		check("ett lägeskommando bekräftas", /paused/i.test(textsOf(paused).pop()?.text ?? ""), JSON.stringify(textsOf(paused)));
		check("lägesbytet är en händelse klienten kan visa", !!eventOf(paused, "modeChanged"));
		const whilePaused = await new Promise((resolve, reject) => {
			const since = c.mark();
			c.send({ type: "say", text: "Bosse, hör du mig" });
			c.waitFor((m) => m.type === "event" && m.kind === "notHeard", 5000, "notHeard (pausad)", since).then(resolve, reject);
		});
		check("i pausat läge når inte ens ett tilltal fram", whilePaused.data.reason === "paused");
		await say(c, "fortsätt input");
		check("och man kan prata sig ut ur pausen", (await connect(server, { sessionId: c.readyMsg.sessionId })).readyMsg.mode === "byname");

		c.close();
		server.stop();
	}

	// ================================================== the scripted run
	// A worker gets a system prompt built from a template, with the name Mike
	// gave it and the instructions he wrote for it. It must say nothing about
	// workers or orchestration: PRD 3 is deliberate that a session told it is one
	// of several discusses the arrangement instead of doing the job.
	section("arbetaren får en prompt byggd ur mallen");
	{
		const server = await startMike();
		const c = await connect(server);
		await say(c, "Mike, starta en arbetare som heter Bosse.");
		await say(c, "Bosse, gör något.");
		await sleep(200);

		const calls = readdirSync(server.fakeDir)
			.map((f) => JSON.parse(readFileSync(join(server.fakeDir, f), "utf8")))
			.filter((j) => Array.isArray(j.lastArgs));
		const worker = calls.find((j) => !j.lastArgs.includes("--mcp-config"));
		const i = worker ? worker.lastArgs.indexOf("--append-system-prompt") : -1;
		const prompt = i >= 0 ? worker.lastArgs[i + 1] : "";

		check("arbetaren fick en systemprompt", prompt.length > 0, JSON.stringify(worker?.lastArgs?.slice(0, 6)));
		check("den säger vad arbetaren heter", /\bBosse\b/.test(prompt), prompt.slice(0, 120));
		check("den säger var den arbetar", prompt.includes("/tmp"), prompt.slice(0, 200));
		check("den nämner att orden är dikterade", /dictat|spoken/i.test(prompt), prompt.slice(0, 200));
		check("den avslöjar inte orkestreringen",
			!/\bworker\b|\bMike\b|orchestrat/i.test(prompt), (prompt.match(/\bworker\b|\bMike\b|orchestrat\w*/i) ?? [""])[0]);
		check("mallens egna anteckningar följer inte med", !prompt.includes("<!--"), prompt.slice(0, 80));
		check("inga ofyllda platshållare blev kvar", !/\{\{\w+\}\}/.test(prompt), (prompt.match(/\{\{\w+\}\}/) ?? [""])[0]);
		check("den skickas med snapshot av, annars är varje redigering verkningslös",
			worker.lastArgs.includes("--system-prompt-snapshot") && worker.lastArgs.includes("off"));

		c.close(); server.stop();
	}

	// The system prompt is the half a template cannot know: what this one is for.
	// Mike writes it when he spawns, and it has to reach the session itself —
	// not a log line, not the first user message, which scrolls away.
	section("Mike systemprompt når arbetarens egen prompt");
	{
		const server = await startMike();
		const c = await connect(server);
		const mcp = new McpClient(await grantTools(c));
		await mcp.initialize();
		await mcp.call("spawn_worker", { name: "Doris", systemPrompt: "You are looking after the BLE firmware in MyLibrary." });
		await say(c, "Doris, gör något.");
		await sleep(200);

		const calls = readdirSync(server.fakeDir)
			.map((f) => JSON.parse(readFileSync(join(server.fakeDir, f), "utf8")))
			.filter((j) => Array.isArray(j.lastArgs));
		const worker = calls.find((j) => !j.lastArgs.includes("--mcp-config"));
		const i = worker ? worker.lastArgs.indexOf("--append-system-prompt") : -1;
		const prompt = i >= 0 ? worker.lastArgs[i + 1] : "";
		check("systemprompten står i arbetarens prompt", /BLE firmware in MyLibrary/.test(prompt), prompt.slice(0, 300));
		check("och namnet med den", /\bDoris\b/.test(prompt), prompt.slice(0, 120));

		// Den ska överleva en omstart: en arbetare får inte tyst byta identitet.
		await server.restart();
        const c2 = await connect(server, { sessionId: c.readyMsg.sessionId });
		await say(c2, "Doris, gör något igen.");
		await sleep(200);
		const after = readdirSync(server.fakeDir)
			.map((f) => JSON.parse(readFileSync(join(server.fakeDir, f), "utf8")))
			.filter((j) => Array.isArray(j.lastArgs) && !j.lastArgs.includes("--mcp-config"));
		const later = after.map((j) => { const k = j.lastArgs.indexOf("--append-system-prompt"); return k >= 0 ? j.lastArgs[k + 1] : ""; });
		check("systemprompten överlever en omstart", later.some((p) => /BLE firmware in MyLibrary/.test(p)),
			JSON.stringify(later.map((p) => p.slice(0, 60))));

		c2.close(); c.close(); server.stop();
	}

	// A worker finishing while the user is with somebody else must not read as
	// the conversation. The reply is still durable and still in the transcript;
	// what changes is that it is marked, so the client can keep it off the lens.
	section("ett svar från någon man inte pratar med märks som bakgrund");
	{
		const server = await startMike([], { FAKE_CLAUDE_FAIL: "slow", FAKE_CLAUDE_SLOW_MS: "4000" });
		const c = await connect(server);
		await say(c, "Mike, starta en arbetare som heter Bosse.", 40_000);
		await say(c, "Mike, starta en arbetare som heter Kalle.", 40_000);
		await say(c, "Mike, byt till Bosse.", 40_000);

		// En lång tur hos Bosse startas medan man växlar bort: växlingen är en
		// egen Mike-tur, så den ska inte behöva vänta in arbetaren.
		const since = c.mark();
		c.send({ type: "say", text: "Bosse, gör ett långt jobb.", origin: "typed" });
		await sleep(300);
		c.send({ type: "say", text: "Mike, byt till Kalle.", origin: "typed" });
		const switched = await c.waitFor((m) => m.type === "event" && m.kind === "workerSwitched", 60_000, "växlingen", since);
		check("växlingen behöver inte vänta in arbetaren", switched.data.active === "Kalle", JSON.stringify(switched.data));
		await c.waitFor((m) => m.type === "text" && m.from === "Bosse", 60_000, "Bosses svar", since);

		// Och nu det som saken handlar om. Växlingen sker genom klientens egen
		// kontroll i stället för genom Mike: den är omedelbar, så turen hinner
		// garanterat vara kvar i luften när den aktiva arbetaren byts. Med en
		// modelltur i vägen vore det en kapplöpning, och ett test som ibland
		// mäter rätt sak mäter ingenting.
		await controlSwitch(c, "Bosse");
		const bg = c.mark();
		c.send({ type: "say", text: "gör ett till jobb.", origin: "typed" });
		await sleep(300);
		await controlSwitch(c, "Kalle");
		const late = await c.waitFor((m) => m.type === "text" && m.from === "Bosse", 60_000, "Bosses bakgrundssvar", bg);
		check("det sena svaret kommer ändå fram", !!late.text, JSON.stringify(late));
		check("och är märkt som bakgrund", late.background === true, JSON.stringify(late));

		// Ett svar från den man FAKTISKT pratar med är inte bakgrund. Väntat
		// på Kalles ord, inte på nästa busy:false — Bosses bakgrundstur slutar
		// med ett eget state strax efter sitt svar, och ett `say` som nöjde sig
		// med det kom tillbaka innan Kalle hade sagt något (var tredje körning).
		const direct2 = c.mark();
		c.send({ type: "say", text: "Kalle, säg något." });
		const direct = await c.waitFor((m) => m.type === "text" && m.from === "Kalle", 40_000, "Kalles direkta svar", direct2);
		check("ett svar från den aktiva arbetaren är inte bakgrund",
			!!direct && direct.background === undefined, JSON.stringify(direct));

		c.close(); server.stop();
	}

	// The lens shows the latest thing said, so switching back to somebody has to
	// carry what they last said — the client may never have seen it, and only the
	// server has the transcript (R3.6).
	section("växling bär med sig var samtalet slutade");
	{
		const server = await startMike();
		const c = await connect(server);
		await say(c, "Mike, starta en arbetare som heter Bosse.");
		await say(c, "Bosse, vad heter du?");
		await say(c, "Mike, starta en arbetare som heter Kalle.");

		const back = await say(c, "Mike, byt tillbaka till Bosse.");
		const ev = eventOf(back, "workerSwitched");
		check("växlingen bär med sig ett sista yttrande", !!ev?.data?.last?.text, JSON.stringify(ev?.data ?? null));
		check("det är arbetarens ord, inte användarens",
			ev?.data?.last?.from === "Bosse" && /vad heter du/i.test(ev.data.last.text), JSON.stringify(ev?.data?.last));

		// En arbetare som aldrig sagt något har ingenting att bära med sig, och
		// det ska vara null snarare än en påhittad rad.
		const toKalle = await say(c, "Mike, byt till Kalle.");
		const ev2 = eventOf(toKalle, "workerSwitched");
		check("en tyst arbetare bär med sig ingenting", ev2 ? (ev2.data.last ?? null) === null : false,
			JSON.stringify(ev2?.data?.last ?? "ingen växling"));

		c.close(); server.stop();
	}

	// What a worker may do is the operator's decision, and it must reach the
	// worker's turn and nothing else: Mike keeps his narrow allowlist whatever
	// the workers are allowed, or the orchestrator quietly becomes the most
	// powerful thing in the system.
	section("arbetarnas rättigheter är en inställning, inte en egenskap hos anropet");
	for (const [perms, flagWanted] of [["readonly", null], ["edits", "acceptEdits"], ["full", "--dangerously-skip-permissions"]]) {
		const server = await startMike(["--worker-perms", perms]);
		const c = await connect(server);
		await say(c, "Mike, starta en arbetare som heter Bosse.");
		await say(c, "Bosse, gör något.");
		await sleep(200);

		const calls = readdirSync(server.fakeDir)
			.map((f) => JSON.parse(readFileSync(join(server.fakeDir, f), "utf8")))
			.filter((j) => Array.isArray(j.lastArgs));
		const worker = calls.find((j) => !j.lastArgs.includes("--mcp-config"));
		const mike = calls.find((j) => j.lastArgs.includes("--mcp-config"));
		check(`${perms}: både Mike och arbetaren har kört`, !!worker && !!mike, JSON.stringify(calls.map((j) => j.lastArgs.length)));

		if (worker && mike) {
			const has = (j, f) => j.lastArgs.includes(f);
			check(`${perms}: arbetaren får ${flagWanted ?? "ingenting extra"}`,
				flagWanted ? has(worker, flagWanted) : (!has(worker, "acceptEdits") && !has(worker, "--dangerously-skip-permissions")),
				JSON.stringify(worker.lastArgs));
			check(`${perms}: Mike får det inte`,
				!has(mike, "acceptEdits") && !has(mike, "--dangerously-skip-permissions"), JSON.stringify(mike.lastArgs));
			check(`${perms}: godkännandeprompten är fortfarande avstängd`, has(worker, "--permission-prompts"), JSON.stringify(worker.lastArgs));
		}
		c.close(); server.stop();
	}

	// Over the wire, not just through route(): the handler has to actually pass
	// the origin along, and that wiring is what a unit test cannot see.
	section("tangentbordet över tråden");
	{
		const server = await startMike();
		const c = await connect(server);
		await say(c, "Mike, starta en arbetare som heter Bosse.");
		check("en arbetare är aktiv", (await connect(server, { sessionId: c.readyMsg.sessionId })).readyMsg.worker === "Bosse");

		const spoken = await say(c, "lista filerna i mappen");
		check("talat utan tilltal rapporteras som ohört", !!eventOf(spoken, "notHeard"), JSON.stringify(spoken.map((m) => m.type + ":" + (m.kind ?? ""))));

		const written = await type(c, "lista filerna i mappen");
		check("samma ord skrivna når arbetaren", !eventOf(written, "notHeard") && textsOf(written).length > 0,
			JSON.stringify(written.map((m) => m.type + ":" + (m.kind ?? ""))));
		check("och arbetaren fick dem ordagrant",
			textsOf(written).some((m) => String(m.text).includes("lista filerna i mappen")), JSON.stringify(textsOf(written)));

		const bad = c.mark();
		c.send({ type: "say", text: "hej", origin: "smoke-signal" });
		const err = await c.waitFor((m) => m.type === "error", 5000, "fel om okänd härkomst", bad);
		check("en påhittad härkomst avvisas", /origin/.test(String(err.message)), JSON.stringify(err));

		c.close(); server.stop();
	}

	section("PRD 6: turen berättar vad den gör medan den gör det");
	{
		const server = track(await startMike());
		const c = await connect(server);

		// Mike's turn calls a tool. The tool's name has to reach the client
		// while the turn is still running: "thinking" for eight seconds and
		// "spawn_worker for eight seconds" are the same wait and not the same
		// experience.
		const spawn = await say(c, "Mike, start a worker called Bosse");
		const tool = spawn.find((m) => m.type === "event" && m.kind === "progress" && m.data?.tool);
		check("verktyget syns medan turen pågår", !!tool && /spawn_worker/.test(String(tool.data.tool)), JSON.stringify(tool));
		check("händelsen bär vem som håller på", tool?.data?.from === "mike", JSON.stringify(tool?.data));
		check("den kommer före svaret, inte efter",
			spawn.indexOf(tool) < spawn.findIndex((m) => m.type === "text"), JSON.stringify(spawn.map((m) => m.type + (m.kind ? `:${m.kind}` : ""))));

		const turn = await say(c, "Bosse, säg något");
		const partial = turn.find((m) => m.type === "event" && m.kind === "progress" && m.data?.text);
		check("arbetarens svar strömmar fram", !!partial && /turn 1: /.test(String(partial.data.text)), JSON.stringify(partial));
		check("och är märkt med arbetarens namn", partial?.data?.from === "Bosse", JSON.stringify(partial?.data));

		// The finished answer is still exactly one transcript line. A stream
		// that also got recorded would say everything twice, in halves.
		check("svaret sägs en gång, inte två", textsOf(turn).length === 1, JSON.stringify(textsOf(turn)));
		check("turen stängs som vanligt", turn.some((m) => m.type === "state" && m.busy === false));
		check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-300));

		c.close();
		server.stop();
	}

	section("PRD 6: ett ord avbryter en tur som redan tänker");
	{
		// The slow stand-in holds the turn open, which is the only state this
		// feature exists for: the model has decided to think for a while and
		// everything the user says otherwise queues up behind it.
		const server = track(await startMike([], { FAKE_CLAUDE_FAIL: "slow", FAKE_CLAUDE_SLOW_MS: "8000" }));
		const c = await connect(server);

		const since = c.mark();
		c.send({ type: "say", text: "Mike, tänk på något långsamt" });
		await c.waitFor((m) => m.type === "state" && m.busy === true, 5000, "turen har börjat", since);

		const said = c.mark();
		const t0 = Date.now();
		// Spoken, unaddressed, in ByName — a stop is matched before the gate, the
		// same safety property the mode commands have.
		c.send({ type: "say", text: "stopp" });
		const stopped = await c.waitFor((m) => m.type === "event" && m.kind === "interrupted", 5000, "turen avbryts", said);
		const took = Date.now() - t0;

		check("ordet stoppar turen", stopped.data?.stopped === true, JSON.stringify(stopped));
		check("och det går fort, inte efter turens slut", took < 3000, `${took}ms`);
		const after = c.messages.slice(said);
		check("linsen får veta det med ord", after.some((m) => m.type === "text" && /Stopped/.test(m.text)), JSON.stringify(after.map((m) => m.type + (m.kind ? `:${m.kind}` : ""))));
		check("turen stängs", after.some((m) => m.type === "state" && m.busy === false));
		// The kill is the user's own doing; an error bubble about exit code null
		// would be the machine blaming them for it.
		await sleep(400);
		check("ingen felruta om en dödad process", !c.messages.slice(said).some((m) => m.type === "error"),
			JSON.stringify(c.messages.slice(said).filter((m) => m.type === "error")));

		// Nothing running is a different answer, and it is still an answer.
		const idle = c.mark();
		c.send({ type: "say", text: "avbryt" });
		const nothing = await c.waitFor((m) => m.type === "event" && m.kind === "interrupted", 5000, "svar även när inget går", idle);
		check("och när inget pågår sägs det", nothing.data?.stopped === false, JSON.stringify(nothing));

		check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
		c.close();
		server.stop();
	}

	section("ett ensamt Mike får svar på en gång, och nästa mening är hans");
	{
		// With a hold window, because the last check needs one to be open: the
		// suite otherwise runs with the window off so that every fragment is a
		// turn of its own.
		const server = track(await startMike(["--hold", "2000"], { FAKE_CLAUDE_FAIL: "slow", FAKE_CLAUDE_SLOW_MS: "3000" }));
		const c = await connect(server);

		const since = c.mark();
		const t0 = Date.now();
		c.send({ type: "say", text: "Mike." });
		const hello = await c.waitFor((m) => m.type === "text" && m.from === "mike", 3000, "hälsningen", since);
		check("svaret kommer utan modell, på under en sekund", Date.now() - t0 < 1000 && /^Hello, Man/.test(hello.text), `${Date.now() - t0}ms ${hello.text}`);
		check("och Man är den han hälsar på", hello.text === "Hello, Man." || hello.text === "Hello, Man, my only friend.", hello.text);
		await sleep(300);
		check("ingen tur startade", !c.messages.slice(since).some((m) => m.type === "state" && m.busy === true));

		// The sentence after the call, said without his name, in ByName.
		const then = c.mark();
		c.send({ type: "say", text: "vad är klockan" });
		await c.waitFor((m) => m.type === "state" && m.busy === true, 5000, "meningen efter anropet startar en tur", then);
		check("och den tas emot, inte tappad", !c.messages.slice(then).some((m) => m.type === "event" && m.kind === "notHeard"));
		const reply = await c.waitFor((m) => m.type === "text" && m.from === "mike", 15000, "Mikes svar", then);
		check("den gick till Mike", /vad är klockan/.test(reply.text), reply.text);

		// The call is spent: the next unaddressed sentence is dropped as usual.
		const later = c.mark();
		c.send({ type: "say", text: "och nu då" });
		await c.waitFor((m) => m.type === "event" && m.kind === "notHeard", 5000, "en mening utan tilltal tappas igen", later);
		check("ett anrop gäller en mening", true);

		// A call is not made from inside a sentence: "Mike" as the first
		// fragment of "Mike, do this" said with a pause still joins the window.
		const open = c.mark();
		c.send({ type: "say", text: "Mike, gör" });
		await sleep(200);
		c.send({ type: "say", text: "Mike." });
		await sleep(400);
		check("ett Mike i ett öppet fönster hälsar inte", !c.messages.slice(open).some((m) => m.type === "text" && /^Hello, Man/.test(m.text)),
			JSON.stringify(c.messages.slice(open).map((m) => `${m.type}${m.kind ? ":" + m.kind : ""}${m.text ? " " + m.text : ""}${m.data?.phase ? " " + m.data.phase : ""}`)));

		check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
		c.close();
		server.stop();
	}

	section("null program: turen dör, kön töms, och Mike svarar som sig själv");
	{
		// Two instructions in a row while the model is slow: the first is
		// running, the second is queued behind it. "Null program" is meant to
		// take both — "whatever you were about to do, do not" — where a plain
		// stop used to kill the first and let the second run into the silence.
		const server = track(await startMike([], { FAKE_CLAUDE_FAIL: "slow", FAKE_CLAUDE_SLOW_MS: "8000" }));
		const c = await connect(server);

		const since = c.mark();
		c.send({ type: "say", text: "Mike, tänk på något långsamt", origin: "typed" });
		await c.waitFor((m) => m.type === "state" && m.busy === true, 5000, "första turen har börjat", since);
		c.send({ type: "say", text: "Mike, och sedan detta", origin: "typed" });
		await sleep(200);

		const said = c.mark();
		c.send({ type: "say", text: "Null program." });
		const stopped = await c.waitFor((m) => m.type === "event" && m.kind === "interrupted", 5000, "null program avbryter", said);
		check("null program stoppar turen", stopped.data?.stopped === true, JSON.stringify(stopped));
		await c.waitFor((m) => m.type === "state" && m.busy === false, 5000, "turen stängs", said);
		const after = c.messages.slice(said);
		check("svaret är Mikes", after.some((m) => m.type === "text" && /Null program\. Standing by, Man\./.test(m.text)),
			JSON.stringify(after.filter((m) => m.type === "text").map((m) => m.text)));

		// The queued turn would have taken 8 s to answer; if it was dropped,
		// nothing arrives from Mike and busy stays false.
		await sleep(1500);
		const later = c.messages.slice(said);
		check("den köade turen körs inte", !later.some((m) => m.type === "text" && m.from === "mike"),
			JSON.stringify(later.filter((m) => m.type === "text").map((m) => m.text)));
		check("och ingen felruta för den heller", !later.some((m) => m.type === "error"),
			JSON.stringify(later.filter((m) => m.type === "error")));
		check("upptagen är falskt efteråt", !later.slice(later.findIndex((m) => m.type === "state" && m.busy === false) + 1).some((m) => m.type === "state" && m.busy === true));

		// And the next thing said runs as normal: a null program is a reset,
		// not a lock.
		const again = c.mark();
		c.send({ type: "say", text: "Mike, hej igen", origin: "typed" });
		await c.waitFor((m) => m.type === "state" && m.busy === true, 5000, "nästa tur startar", again);

		check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
		c.close();
		server.stop();
	}

	section("PRD 6: ett verktygsanrop blir en mening");
	{
		// Pure, so it is asserted here rather than through a model. The shapes
		// are the inputs Claude Code's own tools take.
		check("en fil läses vid namn, utan katalogen",
			describeTool("Read", { file_path: "/home/robin/mike/src/workerEngine.js" }) === "Reading workerEngine.js",
			describeTool("Read", { file_path: "/home/robin/mike/src/workerEngine.js" }));
		check("ett kommando visas med sin egen beskrivning",
			describeTool("Bash", { description: "Run the PRD 3 suite", command: "node test/prd3.mjs" }) === "Running Run the PRD 3 suite");
		check("och utan beskrivning med kommandot",
			describeTool("Bash", { command: "node test/prd3.mjs" }) === "Running node test/prd3.mjs");
		check("en sökning bär det den söker efter", describeTool("Grep", { pattern: "lensView" }) === "Searching lensView");
		check("ett verktyg vi inte känner blir läsbart ändå",
			describeTool("mcp__mike__spawn_worker", {}) === "Spawn worker", describeTool("mcp__mike__spawn_worker", {}));
		// A lens row is fifty columns and two of them are the prefix.
		const long = describeTool("Bash", { description: "x".repeat(300) });
		check("och ingen rad är längre än linsen", long.length <= 48, `${long.length}: ${long}`);
		check("en tom indata ger ingen trasig mening", describeTool("Read", {}) === "Read", describeTool("Read", {}));
	}

	section("PRD 6: uppdelade meningar blir en tur");
	{
		// The window is on here and off everywhere else (see harness.mjs): this
		// is the one suite that is about what happens between two fragments.
		const server = track(await startMike([], { MIKE_HOLD_MS: "1200" }));
		const c = await connect(server);
		await say(c, "Mike, starta en arbetare som heter Bosse.");

		const since = c.mark();
		// Three fragments of one sentence, the way a person who is choosing
		// between two languages produces them. Only the FIRST names Bosse — in
		// ByName the other two would be dropped as unaddressed, and joining them
		// to an open window is the whole point: the name was said once.
		c.send({ type: "say", text: "Bosse, bygg klart" });
		await sleep(200);
		c.send({ type: "say", text: "testerna" });
		await sleep(200);
		c.send({ type: "say", text: "och kör dem sen" });
		await c.waitFor((m) => m.type === "state" && m.busy === false, 20_000, "turen hinner bli klar", since);
		const msgs = c.messages.slice(since);

		const turns = msgs.filter((m) => m.type === "event" && m.kind === "turn");
		const ids = new Set(turns.map((m) => m.data.id));
		check("tre meningar blir en enda tur", ids.size === 1, JSON.stringify([...ids]));

		const held = turns.filter((m) => m.data.phase === "held");
		check("varje mening kvitteras medan den hålls", held.length === 3, JSON.stringify(held.map((m) => m.data.parts.length)));
		check("och listan växer, den ersätts inte",
			JSON.stringify(held.map((m) => m.data.parts.length)) === "[1,2,3]", JSON.stringify(held.map((m) => m.data.parts)));
		check("de bär användarens egna ord, var för sig",
			JSON.stringify(held.at(-1).data.parts) === JSON.stringify(["bygg klart", "testerna", "och kör dem sen"]),
			JSON.stringify(held.at(-1).data.parts));

		const started = turns.find((m) => m.data.phase === "started");
		check("turen når en process som kör den", !!started, JSON.stringify(turns.map((m) => m.data.phase)));
		check("och det är det som gör bocken sann, inte kön",
			turns.findIndex((m) => m.data.phase === "queued") < turns.indexOf(started));

		const replies = msgs.filter((m) => m.type === "text" && m.from === "Bosse");
		check("arbetaren svarar en gång, inte tre", replies.length === 1, JSON.stringify(replies.map((m) => m.text)));
		check("och fick hela meningen i ett stycke",
			/bygg klart testerna och kör dem sen/.test(String(replies[0]?.text)), JSON.stringify(replies[0]?.text));

		const done = turns.find((m) => m.data.phase === "done");
		check("turen stängs som en tur", !!done);
		check("och den stängs före svaret, inte efter",
			msgs.indexOf(done) < msgs.indexOf(replies[0]), JSON.stringify(msgs.map((m) => m.type + (m.kind ? `:${m.kind}` : ""))));

		// Stopping inside the window: the words never ran, and saying so is the
		// difference between obedience and a shrug.
		const held2 = c.mark();
		c.send({ type: "say", text: "Bosse, glöm inte att" });
		await sleep(250);
		c.send({ type: "say", text: "stopp" });
		const stopped = await c.waitFor((m) => m.type === "event" && m.kind === "interrupted", 5000, "stopp i fönstret", held2);
		check("ord som ännu hålls går att stoppa", stopped.data?.stopped === true, JSON.stringify(stopped));
		check("och turen rapporteras som slängd, inte klar",
			c.messages.slice(held2).some((m) => m.type === "event" && m.kind === "turn" && m.data.phase === "dropped"),
			JSON.stringify(c.messages.slice(held2).filter((m) => m.kind === "turn").map((m) => m.data.phase)));
		await sleep(2000);
		check("och ingenting nådde arbetaren",
			!c.messages.slice(held2).some((m) => m.type === "text" && m.from === "Bosse"),
			JSON.stringify(c.messages.slice(held2).filter((m) => m.type === "text").map((m) => m.text)));

		check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
		c.close();
		server.stop();
	}

	section("PRD 6: fönstret är tystnad, inte klocka");
	{
		// The window is 1200 ms here and the user keeps talking for 2000 ms in
		// the middle of it. Measured from transcript to transcript that is a
		// split sentence, and the log from the glasses said it was the usual
		// case: three merges in forty turns. The client's detector says when it
		// has opened a segment (C2S.SPEAKING), and a window with someone talking
		// into it waits for their fragment instead of counting.
		const server = track(await startMike([], { MIKE_HOLD_MS: "1200" }));
		const c = await connect(server);
		await say(c, "Mike, starta en arbetare som heter Bosse.");

		const since = c.mark();
		c.send({ type: "say", text: "Bosse, starta en ny worker och ta reda på" });
		await sleep(300);
		c.send({ type: "speaking", on: true });     // the second half begins
		await sleep(2000);                            // ...and takes longer than the window
		c.send({ type: "speaking", on: false });
		await sleep(300);                             // whisper
		c.send({ type: "say", text: "vad den här kapningen är, använd opus" });
		await c.waitFor((m) => m.type === "state" && m.busy === false, 20_000, "turen hinner bli klar", since);
		const msgs = c.messages.slice(since);
		const turns = msgs.filter((m) => m.type === "event" && m.kind === "turn");
		check("två fragment med två sekunders tal emellan blir en tur",
			new Set(turns.map((m) => m.data.id)).size === 1, JSON.stringify(turns.map((m) => [m.data.id, m.data.phase])));
		const replies = msgs.filter((m) => m.type === "text" && m.from === "Bosse");
		check("och arbetaren fick hela meningen",
			replies.length === 1 && /ta reda på vad den här kapningen är, använd opus/.test(String(replies[0]?.text)),
			JSON.stringify(replies.map((m) => m.text)));

		// The signal usually arrives BEFORE there is a window: the user starts
		// the next fragment while the first is still in whisper. It has to be
		// remembered for the window that is about to open.
		const early = c.mark();
		c.send({ type: "speaking", on: true });
		await sleep(100);
		c.send({ type: "say", text: "Bosse, och sen" });
		await sleep(2000);
		check("ett fönster som öppnas medan användaren pratar väntar",
			!c.messages.slice(early).some((m) => m.type === "event" && m.kind === "turn" && m.data.phase !== "held"),
			JSON.stringify(c.messages.slice(early).filter((m) => m.kind === "turn").map((m) => m.data.phase)));
		c.send({ type: "speaking", on: false });
		c.send({ type: "say", text: "kör testerna" });
		await c.waitFor((m) => m.type === "state" && m.busy === false, 20_000, "andra turen blir klar", early);
		const second = c.messages.slice(early).filter((m) => m.type === "text" && m.from === "Bosse");
		check("och får båda halvorna", second.length === 1 && /och sen kör testerna/.test(String(second[0]?.text)),
			JSON.stringify(second.map((m) => m.text)));

		// Speech that ends in nothing — a cough, a segment the detector threw
		// away — must not hold the words hostage: the clock starts again when
		// the microphone goes quiet, and the window closes on its own.
		const quiet = c.mark();
		c.send({ type: "say", text: "Bosse, en sak till" });
		await sleep(200);
		c.send({ type: "speaking", on: true });
		await sleep(1500);
		c.send({ type: "speaking", on: false });
		const closed = await c.waitFor((m) => m.type === "event" && m.kind === "turn" && m.data.phase === "queued", 3000, "fönstret stängs efter tystnad", quiet);
		check("tystnad utan fragment stänger fönstret ändå", closed.data.parts.length === 1, JSON.stringify(closed.data));
		await c.waitFor((m) => m.type === "state" && m.busy === false, 20_000, "tredje turen blir klar", quiet);

		check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
		c.close();
		server.stop();
	}

	section("PRD 6: skrivna ord väntar inte");
	{
		const server = track(await startMike([], { MIKE_HOLD_MS: "5000" }));
		const c = await connect(server);
		// Five seconds of window, and the answer has to beat it: pressing Enter
		// already said the sentence was over.
		const t0 = Date.now();
		const turn = await type(c, "Mike, säg något kort");
		const took = Date.now() - t0;
		check("tangentbordet går rakt igenom fönstret", took < 4000, `${took}ms`);
		check("och svaret kommer ändå", turn.some((m) => m.type === "text"), JSON.stringify(turn.map((m) => m.type)));
		c.close();
		server.stop();
	}

	section("PRD 3:s manusstyrda körning, steg 1–9");
	{
		const server = track(await startMike());

		// 1 ------------------------------------------------------------------
		const c = await connect(server);
		const hello = await c.waitFor((m) => m.type === "text" && m.from === "mike", 5000, "Mike hälsar");
		check("1. Mike hälsar när man kopplar upp", !!hello.text, hello.text);

		// 2 ------------------------------------------------------------------
		const t2 = await say(c, "Mike, start a worker called Bosse with sonnet");
		const spawned = eventOf(t2, "workerSpawned");
		check("2. arbetaren skapades", spawned?.data.worker.name === "Bosse", JSON.stringify(t2));
		check("2. med den modell användaren namngav", spawned?.data.worker.model === "sonnet", spawned?.data.worker.model);
		check("2. och samtalet växlade till den — R3.3", spawned?.data.active === "Bosse");
		check("2. i en enda kort rad", textsOf(t2).length === 1 && textsOf(t2)[0].text.length < 120, JSON.stringify(textsOf(t2)));
		const bosseId = (await whoIs(c, "Bosse")).sessionId;

		// 3 ------------------------------------------------------------------
		const t3 = textsOf(await say(c, "Bosse, vad heter huvudstaden i Sverige"));
		check("3. svaret kommer taggat som Bosse", t3[0]?.from === "Bosse", JSON.stringify(t3));
		check("3. och det är arbetaren som svarar, inte Mike", /vad heter huvudstaden/.test(t3[0]?.text ?? ""), JSON.stringify(t3));

		// 4 ------------------------------------------------------------------
		const t4 = await say(c, "Mike, what is Bosse working on");
		check("4. Mike svarar om utbytet", /huvudstaden/.test(textsOf(t4).pop()?.text ?? ""), JSON.stringify(textsOf(t4)));
		check("4. och han läste arbetaren genom verktyget", !!eventOf(t4, "workerRead"));
		check("4. utan att byta vem man pratar med",
			t4.filter((m) => m.type === "state").pop().worker === "Bosse");

		// 5 ------------------------------------------------------------------
		const t5 = textsOf(await say(c, "Mike, list the files in the folder we are talking about"));
		const real = readdirSync("/tmp").slice(0, 20);
		check("5. Mike svarar om arbetarens katalog utan att den namngavs — R3.4",
			t5[0] && t5[0].text.includes("/tmp"), JSON.stringify(t5));
		check("5. och listningen är verklig", real.length === 0 || t5[0].text.includes(real[0]), `väntade ${real[0]}`);

		// 6 ------------------------------------------------------------------
		const t6 = await say(c, "Mike, start a worker called Kalle");
		check("6. den nya arbetaren blev den aktiva", eventOf(t6, "workerSpawned")?.data.active === "Kalle", JSON.stringify(t6));
		const list = await (await fetch(`${server.base}/healthz`)).json();
		check("6. och Bosse finns fortfarande kvar", list.workers === 2, JSON.stringify(list));

		// 7 ------------------------------------------------------------------
		const t7 = await say(c, "Mike, switch back to Bosse");
		check("7. samtalet är tillbaka hos Bosse", eventOf(t7, "workerSwitched")?.data.active === "Bosse", JSON.stringify(t7));
		const t7b = textsOf(await say(c, "Bosse, och nu då"));
		check("7. och transkriptet fortsätter, det startar inte om — R3.6",
			/^turn 2:/.test(t7b[0]?.text ?? ""), JSON.stringify(t7b));
		check("7. arbetaren behöll sitt sessions-id över växlingen",
			(await whoIs(c, "Bosse")).sessionId === bosseId);

		// 8 ------------------------------------------------------------------
		const sessionId = c.readyMsg.sessionId;
		const mikeBefore = (await (await fetch(`${server.base}/healthz`)).json()).mike.sessionId;
		c.close();
		await server.restart();
		const c8 = await connect(server, { sessionId });
		const health8 = await (await fetch(`${server.base}/healthz`)).json();
		check("8. Mike är samma samtal efter omstarten — R3.7", health8.mike.sessionId === mikeBefore);
		check("8. båda arbetarna finns kvar", health8.workers === 2, JSON.stringify(health8));
		check("8. och sessionen minns vem man pratade med", c8.readyMsg.worker === "Bosse", JSON.stringify(c8.readyMsg));
		check("8. arbetaren har kvar sitt sessions-id", (await whoIs(c8, "Bosse")).sessionId === bosseId);
		const t8 = textsOf(await say(c8, "Bosse, efter omstarten"));
		check("8. och man kan prata vidare med den, utan att den startar om",
			/^turn 3:/.test(t8[0]?.text ?? ""), JSON.stringify(t8));

		// 9 ------------------------------------------------------------------
		// The PC handoff, exactly as PRD 3 writes it: a second driver resumes the
		// worker's id and sees the same conversation. T1 measured that this is a
		// baton and not a second seat, so it happens after the server's turn, not
		// during it.
		const term = await runFake(["-p", "--output-format", "json", "--resume", bosseId, "i terminalen"], { FAKE_CLAUDE_DIR: server.fakeDir });
		check("9. en terminal kan återuppta arbetarens session", term.code === 0, term.err.slice(0, 200));
		const parsed = term.code === 0 ? JSON.parse(term.out) : {};
		check("9. och ser samma samtal, inte ett nytt", parsed.result === "turn 4: i terminalen", term.out.slice(0, 200));
		check("9. samma sessions-id hela vägen", parsed.session_id === bosseId);

		check("inga ouppfångade undantag under hela körningen", !server.log().includes("UNCAUGHT"), server.log().slice(-400));
		c8.close();
		server.stop();
	}

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	for (const s of servers) { try { s.stop(); } catch { } }
	cleanFakeDirs();
	await sleep(150);
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
