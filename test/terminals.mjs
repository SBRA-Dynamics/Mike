// PC → glasses: Claude Code sessions in terminals become workers.
//
//   node test/terminals.mjs
//
// The server runs its real handler, engine, MCP listener and src/terminals.js;
// `claude agents` and `claude stop` are the stand-in's (test/fixtures/
// fake-claude.mjs), fed from an agents.json this file writes. Nothing here can
// see or stop a real session: the list is ours, and the binary is not claude.

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { startServer, connect, check, failed, section, ROOT, grantTools, McpClient } from "./harness.mjs";
import { readTranscriptTail, modelLabelOf } from "../src/terminals.js";
import { BOOK_NAMES, normalizeName } from "../src/names.js";

const FAKE = join(ROOT, "test", "fixtures", "fake-claude.mjs");

const temps = [];
const temp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
process.on("exit", () => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true }); } catch { } } });

const say = async (c, text, ms = 20_000) => {
	const since = c.mark();
	c.send({ type: "say", text });
	await c.waitFor((m) => m.type === "state" && m.busy === false, ms, `idle after ${JSON.stringify(text)}`, since);
	return c.messages.slice(since);
};
const eventOf = (turn, kind) => turn.find((m) => m.type === "event" && m.kind === kind);

/** A Claude Code transcript line, in the shape 2.1.273 writes one. */
const line = (type, content, extra = {}) => JSON.stringify({
	type, timestamp: new Date().toISOString(),
	message: { role: type, content, ...(type === "assistant" ? { model: "claude-haiku-4-5-20251001" } : {}) }, ...extra
});

let servers = [];
try {
	// ======================================================= reading transcripts
	section("en terminals transkript läses som samtal, inte som verktygsbrus");
	{
		const d = temp("cc-projects-");
		const f = join(d, "t.jsonl");
		writeFileSync(f, [
			JSON.stringify({ type: "custom-title", title: "x" }),
			line("user", "bygg klart parsern"),
			line("assistant", [{ type: "thinking", thinking: "hmm" }]),
			line("assistant", [{ type: "text", text: "Jag börjar med testerna." }, { type: "tool_use", name: "Bash", input: {} }]),
			line("user", [{ type: "tool_result", content: "ok" }]),
			line("assistant", [{ type: "text", text: "Klart, alla gröna." }]),
			line("user", "<command-name>/clear</command-name>"),
			line("user", "meta", { isMeta: true }),
			"{ torn"
		].join("\n") + "\n");
		const t = readTranscriptTail(f);
		check("två repliker: frågan och svaret", t.entries.length === 2, JSON.stringify(t.entries));
		check("svaret är texten ihopfogad, utan tankar och verktyg",
			t.entries[1]?.text === "Jag börjar med testerna.\nKlart, alla gröna.", JSON.stringify(t.entries[1]));
		check("kommandon och meta räknas inte som sagt", !t.entries.some((e) => /command-name|meta/.test(e.text)));
		check("modellen läses ur svaret", t.model === "claude-haiku-4-5-20251001", t.model);
		check("daterat modell-id blir en etikett", modelLabelOf(t.model) === "haiku");
		check("okänd modell blir ingen etikett", modelLabelOf("gpt-4") === null);
		check("en fil som saknas är tom, inte ett fel", readTranscriptTail(join(d, "nope.jsonl")).entries.length === 0);
	}

	// ============================================================ switched off
	section("avstängt: servern ser inga terminaler");
	{
		const server = await startServer(["--engine", "stub", "--claude-bin", FAKE, "--mike-cwd", "/tmp"]);
		servers.push(server);
		const c = await connect(server);
		const mcp = new McpClient(await grantTools(c));
		await mcp.initialize();
		const list = await mcp.call("list_terminals");
		check("listan är tom", !list.isError && /no Claude Code sessions/.test(list.text), list.text);
		const r = await mcp.call("connect_terminal", { session: "Wyoh" });
		check("anslutning vägras med en mening", r.isError && /switched off/.test(r.text), r.text);
		c.close();
		server.stop();
	}

	// ================================================================ switched on
	const fakeDir = temp("fake-claude-");
	const projects = temp("cc-projects-");
	const worksDir = temp("terminal-cwd-");
	const S = { wyoh: randomUUID(), prof: randomUUID(), hans: randomUUID(), mum: randomUUID(), greg: randomUUID(), gone: randomUUID() };
	const now = Date.now();
	const agentsFile = join(fakeDir, "agents.json");
	const writeAgents = (a) => writeFileSync(agentsFile, JSON.stringify(a, null, 1));
	const readAgents = () => JSON.parse(readFileSync(agentsFile, "utf8"));
	const agent = (name) => readAgents().find((a) => a.name === name);
	const bg = (name, sessionId, extra = {}) => ({ pid: 4242, id: sessionId.slice(0, 8), cwd: worksDir, kind: "background", startedAt: now - 60_000, sessionId, name, status: "idle", state: "blocked", ...extra });
	writeAgents([
		bg("Wyoh", S.wyoh),
		bg("Prof", S.prof, { status: "busy", state: "working" }),
		{ pid: 5151, cwd: worksDir, kind: "interactive", startedAt: now, sessionId: S.hans, name: "Hans", status: "idle" },
		{ ...bg("Mum", S.mum, { state: "done" }), pid: undefined, status: undefined },
		bg("Greg", S.greg),
		bg("Sidris", S.gone, { cwd: "/finns/inte/alls" })
	]);
	// The conversation Wyoh had in the terminal, where Claude Code keeps it, and
	// the stand-in's own record of the session so `--resume` finds it.
	mkdirSync(join(projects, "-some-folder"), { recursive: true });
	writeFileSync(join(projects, "-some-folder", `${S.wyoh}.jsonl`), [
		line("user", "fixa inloggningen"),
		line("assistant", [{ type: "text", text: "Inloggningen fungerar nu." }])
	].join("\n") + "\n");
	for (const id of [S.wyoh, S.mum, S.greg]) {
		writeFileSync(join(fakeDir, `${id}.json`), JSON.stringify({ id, turns: [{ prompt: "i terminalen", result: "ok", at: now }], cwd: worksDir, createdAt: now }));
	}

	const server = await startServer(
		["--claude-bin", FAKE, "--worker-cwd", "/tmp", "--mike-cwd", "/tmp"],
		{ env: { FAKE_CLAUDE_DIR: fakeDir, MIKE_TERMINALS: "on", MIKE_CLAUDE_PROJECTS: projects } });
	servers.push(server);
	const c = await connect(server);
	const mcp = new McpClient(await grantTools(c));
	await mcp.initialize();

	section("list_terminals visar det som körs i en terminal nu");
	{
		const tools = (await mcp.rpc("tools/list")).result.tools.map((t) => t.name);
		check("verktygen finns", tools.includes("list_terminals") && tools.includes("connect_terminal"), JSON.stringify(tools));
		const list = await mcp.call("list_terminals");
		check("bakgrundssessioner som lever listas", /Wyoh/.test(list.text) && /Prof — .*busy/.test(list.text), list.text);
		check("ett vanligt terminalfönster listas inte", !/Hans/.test(list.text), list.text);
		check("en stoppad session listas inte", !/Mum/.test(list.text), list.text);
	}

	section("en ny arbetare tar aldrig ett namn som en terminal har");
	{
		const terminalNames = new Set(["Wyoh", "Prof", "Hans", "Mum", "Greg", "Sidris"].map(normalizeName));
		const free = BOOK_NAMES.filter((n) => !terminalNames.has(normalizeName(n)));
		const got = [];
		for (let i = 0; i < free.length; i++) {
			const r = await mcp.call("spawn_worker", { systemPrompt: "Du sköter en uppgift i testriggen." });
			got.push(/^(\S+(?: \d+)?) is running/.exec(r.text)?.[1]);
		}
		check("de lediga namnen delas ut, och bara de", JSON.stringify([...got].sort()) === JSON.stringify([...free].sort()), JSON.stringify({ got, free }));
		const next = await mcp.call("spawn_worker", { systemPrompt: "Du sköter en uppgift i testriggen." });
		check("när boken är slut blir det ett numrerat namn", /^\S+ 2 is running/.test(next.text), next.text);
		for (const n of [...got, /^(\S+ 2) is running/.exec(next.text)?.[1]]) await mcp.call("end_worker", { name: n });
	}

	section("det som inte går att ta över vägras, och lämnas orört");
	{
		const busy = await mcp.call("connect_terminal", { session: "Prof" });
		check("en upptagen session vägras", busy.isError && /still working/.test(busy.text), busy.text);
		check("och får jobba vidare", agent("Prof").pid === 4242);
		const win = await mcp.call("connect_terminal", { session: "Hans" });
		check("ett öppet terminalfönster vägras", win.isError && /open in a terminal window/.test(win.text), win.text);
		const none = await mcp.call("connect_terminal", { session: "Nobody" });
		check("ett okänt namn vägras", none.isError && /no terminal session called/.test(none.text), none.text);
		const gone = await mcp.call("connect_terminal", { session: "Sidris" });
		check("en mapp som inte finns vägras", gone.isError && /no folder/.test(gone.text), gone.text);
		check("innan terminalen stoppas", agent("Sidris").pid === 4242);
	}

	section("anslut till Wyoh: terminalen stoppas och samtalet fortsätter här");
	let wyohWorker;
	{
		const turn = await say(c, "Mike, anslut till Wyoh.");
		const ev = eventOf(turn, "workerSpawned");
		check("anslutningen är ett verktygsanrop som byter samtal", ev?.data?.tool === "connect_terminal" && ev.data.active === "Wyoh", JSON.stringify(ev));
		check("linsen får var samtalet slutade", ev?.data?.last?.text === "Inloggningen fungerar nu.", JSON.stringify(ev?.data?.last));
		check("processen i terminalen är stoppad", agent("Wyoh").pid === undefined, JSON.stringify(agent("Wyoh")));
		wyohWorker = ev?.data?.worker;
		check("mappen och modellen kommer från sessionen", wyohWorker?.cwd === worksDir && wyohWorker?.model === "haiku", JSON.stringify(wyohWorker));
		const reg = JSON.parse(readFileSync(join(server.dataDir, "workers.json"), "utf8")).workers.find((w) => w.name === "Wyoh");
		check("arbetaren kör terminalens session", reg?.engineSessionId === S.wyoh && reg?.sessionCreated === true, JSON.stringify(reg));

		const said = (await say(c, "Wyoh, hur gick det?")).filter((m) => m.type === "text");
		check("nästa tur fortsätter terminalens samtal", said[0]?.text === "turn 2: hur gick det?", JSON.stringify(said));
		const st = JSON.parse(readFileSync(join(fakeDir, `${S.wyoh}.json`), "utf8"));
		check("med --resume, aldrig --session-id", st.lastArgs.includes("--resume") && !st.lastArgs.includes("--session-id"), JSON.stringify(st.lastArgs));

		const read = await mcp.call("read_worker", { name: "Wyoh" });
		check("read_worker citerar terminalens historik", /fixa inloggningen/.test(read.text) && /hur gick det/.test(read.text), read.text);
	}

	section("öppnas den i terminalen igen får arbetaren inte köra samtidigt");
	{
		writeAgents(readAgents().map((a) => a.name === "Wyoh" ? { ...a, pid: 4343, status: "idle", state: "blocked" } : a));
		const turns = JSON.parse(readFileSync(join(fakeDir, `${S.wyoh}.json`), "utf8")).turns.length;
		const turn = await say(c, "Wyoh, en sak till");
		const err = turn.find((m) => m.type === "error");
		check("turen vägras med en mening", /open in a terminal — connect to Wyoh/.test(err?.message ?? ""), JSON.stringify(turn));
		check("ingen andra förare startades", JSON.parse(readFileSync(join(fakeDir, `${S.wyoh}.json`), "utf8")).turns.length === turns);
		check("orden hamnar inte i transkriptet", !/en sak till/.test((await mcp.call("read_worker", { name: "Wyoh" })).text));

		const back = await mcp.call("connect_terminal", { session: "wyoh" });
		check("anslut igen tar tillbaka den", !back.isError && /^Took back Wyoh/.test(back.text), back.text);
		check("utan att skapa en till arbetare", (await mcp.call("list_workers")).text.match(/Wyoh/g)?.length === 1);
		check("och terminalen är stoppad igen", agent("Wyoh").pid === undefined);
		const ok = (await say(c, "Wyoh, nu då?")).filter((m) => m.type === "text");
		check("då går turen igenom", ok[0]?.text === "turn 3: nu då?", JSON.stringify(ok));
	}

	section("stoppade sessioner och namnkrockar");
	{
		const mum = await mcp.call("connect_terminal", { session: "Mum" });
		check("en stoppad session ansluts utan att något stoppas", !mum.isError && /^Connected to Mum/.test(mum.text) && !/no longer running/.test(mum.text), mum.text);

		await mcp.call("spawn_worker", { name: "greg", systemPrompt: "Du sköter en uppgift i testriggen." });
		const clash = await mcp.call("connect_terminal", { session: "Greg" });
		check("en arbetare med samma namn vägras", clash.isError && /already called greg/.test(clash.text), clash.text);
		check("och terminalen lämnas igång", agent("Greg").pid === 4242);
		const renamed = await mcp.call("connect_terminal", { session: "Greg", name: "Gregor" });
		check("med ett eget namn går det", !renamed.isError && /Connected to Gregor/.test(renamed.text), renamed.text);
	}

	check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-400));
	c.close();
	server.stop();
} catch (e) {
	console.error(e);
	process.exitCode = 1;
} finally {
	for (const s of servers) { try { s.stop(); } catch { } }
}

if (failed()) process.exitCode = 1;
