// PRD 2 acceptance tests — the tool surface, without spending money.
//
//   node test/mcp.mjs
//
// Everything here drives a real server, a real WebSocket and the real loopback
// MCP listener over HTTP. The only thing not present is the model: this file
// speaks the JSON-RPC claude was measured to speak, so it can assert things a
// live model run cannot assert deterministically. test/mcp-live.mjs is the one
// run that puts a real `claude -p` in front of it.

import { startServer, connect, grantTools, McpClient, check, failed, section, sleep } from "./harness.mjs";
import { resolveModel, MODEL_LIST, MODELS } from "../src/models.js";
import { normalizeName, displayName, checkName } from "../src/names.js";

/** Collected for the R2.5 sweep at the end: every refusal the model ever sees
 *  has to fit on a lens. Asserting it once per call site would be easy to
 *  forget; asserting it over everything that happened cannot be. */
const refusals = [];
const refused = (label, r) => { if (r.isError) refusals.push({ label, text: r.text }); return r; };

// `--engine stub`: PRD 2's suite is about the tool surface, and the stub is the
// seam it was written against — it answers turns without spending money and
// without a `claude` process anywhere near the assertions.
const server = await startServer(["--engine", "stub"]);

try {
	// -------------------------------------------------------------- model names
	section("modellnamn — R2, 'Model selection'");
	check("opus löser ut ett modell-id", resolveModel("opus").id === "claude-opus-5", JSON.stringify(resolveModel("opus")));
	check("dikterad punkt stör inte", resolveModel("Opus 5.").id === "claude-opus-5");
	check("versaler stör inte", resolveModel("SONNET").label === "sonnet");
	check("fullt modell-id accepteras", resolveModel("claude-haiku-4-5").label === "haiku");
	const unknown = resolveModel("gpt-4");
	check("okänd modell är ett fel, inte ett tyst byte", unknown.ok === false && unknown.id === undefined);
	check("felet räknar upp de giltiga", MODELS.every((m) => unknown.error.includes(m.label)), unknown.error);
	check("tom modell är också ett fel", resolveModel("").ok === false);
	check("listan läses som en mening", MODEL_LIST === "opus, sonnet, haiku or fable", MODEL_LIST);

	// --------------------------------------------------------------- spoken names
	section("namn från diktering — R2, 'Naming'");
	check("punkt och versal viks ihop", normalizeName("Bosse.") === normalizeName("bosse"));
	check("diakriter viks ihop", normalizeName("Måns") === normalizeName("Mans"));
	check("visningsnamnet behåller versalen", displayName("Bosse.") === "Bosse");
	check("mike är reserverat", checkName("Mike").ok === false);
	check("tomt namn avvisas", checkName("   ").ok === false);

	// ------------------------------------------------------------------ transport
	section("mcp-transporten");
	const c1 = await connect(server);
	const sessionId = c1.readyMsg.sessionId;
	check("ready bär workers-listan", Array.isArray(c1.readyMsg.workers), JSON.stringify(c1.readyMsg.workers));

	const grant = await grantTools(c1);
	check("grant pekar på loopback", /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(grant.url), grant.url);
	check("grant är en http-mcp-config", grant.parsedConfig.mcpServers.mike.type === "http");
	check("grant räknar upp verktygsnamnen claude ska tillåta",
		grant.allowedTools.includes("mcp__mike__spawn_worker"), JSON.stringify(grant.allowedTools));
	check("grant-token skrivs inte in i transkriptet",
		!JSON.stringify(c1.messages.filter((m) => m.seq !== undefined)).includes(grant.token));

	const mcp = new McpClient(grant);
	const init = await mcp.initialize();
	check("initialize svarar med samma protokollversion", init.result.protocolVersion === "2025-11-25", JSON.stringify(init));
	check("servern presenterar sig", init.result.serverInfo.name === "mike");
	check("okänd metod ger -32601, inte en krasch", (await mcp.rpc("server/discover")).error.code === -32601);
	check("notifikation utan id besvaras med 202",
		(await mcp.raw({ jsonrpc: "2.0", method: "notifications/initialized" })).status === 202);

	const withoutToken = await mcp.raw({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: null });
	check("utan grant: 401", withoutToken.status === 401, String(withoutToken.status));
	const wrongToken = await mcp.raw({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: "0".repeat(64) });
	check("fel grant: 401", wrongToken.status === 401, String(wrongToken.status));
	check("GET avvisas", (await mcp.raw(null, { method: "GET" })).status === 405);
	check("trasig JSON ger parse error, inte en hängning",
		(await mcp.raw("{ nope")).json.error.code === -32700);

	// ---------------------------------------------------------------- tool list
	section("verktygen — PRD 2 'Tools'");
	const listed = await mcp.listTools();
	const names = listed.result.tools.map((t) => t.name).sort();
	check("exakt de sju verktygen finns",
		JSON.stringify(names) === JSON.stringify(["end_worker", "leave_worker", "list_workers", "read_worker", "rename_worker", "spawn_worker", "switch_worker"]),
		JSON.stringify(names));
	check("inget skal-verktyg exponeras", !names.some((n) => /bash|shell|exec|run/.test(n)));
	check("varje verktyg har ett schema", listed.result.tools.every((t) => t.inputSchema?.type === "object"));

	// -------------------------------------------------------------- spawn/switch
	section("spawn_worker byter samtal i samma anrop — R2.2");
	const c1b = await connect(server, { sessionId });   // a second device on the same session
	const since = c1.mark();
	const sinceB = c1b.mark();
	const spawned = await mcp.call("spawn_worker", { name: "Bosse", model: "sonnet", prompt: "bygg klart testerna", systemPrompt: "Du sköter en uppgift i testriggen." });
	check("spawn lyckas", spawned.isError === false, spawned.text);
	check("svaret säger att samtalet bytt", /talking to Bosse/i.test(spawned.text), spawned.text);

	const ev = await c1.waitFor((m) => m.type === "event" && m.kind === "workerSpawned", 5000, "workerSpawned", since);
	check("klienten ser händelsen — R2.3", ev.data.worker.name === "Bosse", JSON.stringify(ev.data));
	check("händelsen bär verktyg och argument", ev.data.tool === "spawn_worker" && ev.data.args.name === "Bosse");
	check("händelsen bär den nya aktiva arbetaren", ev.data.active === "Bosse");
	check("händelsen har ett seq som allt annat", typeof ev.seq === "number");
	const evB = await c1b.waitFor((m) => m.type === "event" && m.kind === "workerSpawned", 5000, "workerSpawned hos klient 2", sinceB);
	check("alla anslutna klienter ser den — R2.1", evB.seq === ev.seq, `${evB?.seq} vs ${ev.seq}`);

	const health = await (await fetch(`${server.base}/healthz`)).json();
	check("servern har faktiskt muterats", health.workers === 1, JSON.stringify(health));

	const reattach = await connect(server, { sessionId });
	check("ready visar den aktiva arbetaren", reattach.readyMsg.worker === "Bosse", JSON.stringify(reattach.readyMsg));
	check("ready listar arbetaren", reattach.readyMsg.workers.some((w) => w.name === "Bosse" && w.model === "sonnet"),
		JSON.stringify(reattach.readyMsg.workers));
	reattach.close();

	// ------------------------------------------------------------- loud failures
	section("kollisioner och okända modeller misslyckas högt");
	const collision = refused("kollision", await mcp.call("spawn_worker", { name: "bosse.", systemPrompt: "Du sköter en uppgift i testriggen." }));
	check("samma namn igen misslyckas", collision.isError === true, collision.text);
	check("felet nämner namnet", /bosse/i.test(collision.text), collision.text);
	check("ingen andra arbetare skapades",
		(await (await fetch(`${server.base}/healthz`)).json()).workers === 1);

	const badModel = refused("okänd modell", await mcp.call("spawn_worker", { name: "Kalle", model: "gpt-4", systemPrompt: "Du sköter en uppgift i testriggen." }));
	check("okänd modell misslyckas", badModel.isError === true, badModel.text);
	check("felet räknar upp de giltiga modellerna", MODELS.every((m) => badModel.text.includes(m.label)), badModel.text);
	check("inget tyst byte till standardmodellen",
		(await (await fetch(`${server.base}/healthz`)).json()).workers === 1);

	const badCwd = refused("relativ sökväg", await mcp.call("spawn_worker", { name: "Kalle", cwd: "inte/absolut", systemPrompt: "Du sköter en uppgift i testriggen." }));
	check("relativ arbetskatalog avvisas", badCwd.isError === true, badCwd.text);
	const goneCwd = refused("obefintlig katalog", await mcp.call("spawn_worker", { name: "Kalle", cwd: "/finns/inte/alls", systemPrompt: "Du sköter en uppgift i testriggen." }));
	check("obefintlig arbetskatalog avvisas", goneCwd.isError === true, goneCwd.text);
	const fileCwd = refused("fil som katalog", await mcp.call("spawn_worker", { name: "Kalle", cwd: "/etc/hostname", systemPrompt: "Du sköter en uppgift i testriggen." }));
	check("en fil duger inte som arbetskatalog", fileCwd.isError === true, fileCwd.text);
	check("fortfarande bara en arbetare",
		(await (await fetch(`${server.base}/healthz`)).json()).workers === 1);

	refused("reserverat namn", await mcp.call("spawn_worker", { name: "Mike", systemPrompt: "Du sköter en uppgift i testriggen." }));
	refused("namnlös", await mcp.call("spawn_worker", {}));
	refused("okänd arbetare", await mcp.call("switch_worker", { name: "finns inte" }));
	refused("okänt verktyg", await mcp.call("spawn_helicopter", { name: "x" }));

	// ---------------------------------------------------------------- the rest
	section("switch, read, rename, end");
	const kalle = await mcp.call("spawn_worker", { name: "Kalle", model: "haiku", cwd: "/tmp", systemPrompt: "Du sköter en uppgift i testriggen." });
	check("andra arbetaren skapas", kalle.isError === false, kalle.text);

	const listBoth = await mcp.call("list_workers");
	check("list_workers visar bägge", /Bosse/.test(listBoth.text) && /Kalle/.test(listBoth.text), listBoth.text);
	check("list_workers markerar den aktiva", /Kalle.*talking to/s.test(listBoth.text), listBoth.text);
	check("list_workers visar modell och katalog", /haiku, \/tmp/.test(listBoth.text), listBoth.text);

	const sinceSwitch = c1.mark();
	const back = await mcp.call("switch_worker", { name: "bosse" });      // as dictation would send it
	check("switch hittar namnet trots diktering", back.isError === false, back.text);
	const switched = await c1.waitFor((m) => m.type === "event" && m.kind === "workerSwitched", 5000, "workerSwitched", sinceSwitch);
	check("switch syns som händelse", switched.data.active === "Bosse", JSON.stringify(switched.data));

	const read = await mcp.call("read_worker", { name: "Bosse", turns: 3 });
	check("read_worker ger transkriptet", /bygg klart testerna/.test(read.text), read.text);
	check("read_worker taggar med arbetarens namn", /Bosse:/.test(read.text), read.text);
	const readOther = await mcp.call("read_worker", { name: "Kalle" });
	check("read_worker på en tyst arbetare säger det rent ut", /has not said anything/.test(readOther.text), readOther.text);

	const sinceRename = c1.mark();
	const renamed = await mcp.call("rename_worker", { name: "Bosse", newName: "Berit" });
	check("rename lyckas", renamed.isError === false, renamed.text);
	const renameEv = await c1.waitFor((m) => m.type === "event" && m.kind === "workerRenamed", 5000, "workerRenamed", sinceRename);
	check("den aktiva arbetaren följer med namnbytet", renameEv.data.active === "Berit", JSON.stringify(renameEv.data));
	check("gamla namnet är borta", (await mcp.call("switch_worker", { name: "Bosse" })).isError === true);
	refused("gammalt namn efter rename", await mcp.call("switch_worker", { name: "Bosse" }));
	refused("rename till upptaget namn", await mcp.call("rename_worker", { name: "Berit", newName: "Kalle" }));

	const sinceEnd = c1.mark();
	const ended = await mcp.call("end_worker", { name: "Berit" });
	check("end lyckas", ended.isError === false, ended.text);
	check("end lämnar tillbaka samtalet till Mike", /back with Mike/.test(ended.text), ended.text);
	const endEv = await c1.waitFor((m) => m.type === "event" && m.kind === "workerEnded", 5000, "workerEnded", sinceEnd);
	check("aktiv arbetare är ingen efteråt", endEv.data.active === null, JSON.stringify(endEv.data));
	check("namnet är ledigt igen", (await mcp.call("spawn_worker", { name: "Berit", systemPrompt: "Du sköter en uppgift i testriggen." })).isError === false);
	await mcp.call("end_worker", { name: "Berit" });

	// ------------------------------------------------------------------- R2.4
	section("en arbetare kommer inte åt verktygen — R2.4");
	const workerGrant = await grantTools(c1, "worker");
	const asWorker = new McpClient(workerGrant);
	await asWorker.initialize();
	const workerTools = await asWorker.listTools();
	check("en arbetare ser inga verktyg alls", workerTools.result.tools.length === 0, JSON.stringify(workerTools.result.tools));
	const workersBefore = (await (await fetch(`${server.base}/healthz`)).json()).workers;
	const sneaky = refused("arbetare anropar verktyg", await asWorker.call("spawn_worker", { name: "Smyg", systemPrompt: "Du sköter en uppgift i testriggen." }));
	check("en arbetare får inte anropa dem heller", sneaky.isError === true, sneaky.text);
	check("och ingenting muterades",
		(await (await fetch(`${server.base}/healthz`)).json()).workers === workersBefore);

	// ------------------------------------------------------------------- R2.5
	section("fel är läsbara på en lins — R2.5");
	check("det finns fel att granska", refusals.length >= 8, `${refusals.length}`);
	for (const r of refusals) {
		check(`${r.label}: ryms på linsen`, r.text.length > 0 && r.text.length <= 100, `${r.text.length} tecken: ${r.text}`);
		check(`${r.label}: en rad, ingen stack`, !/\n/.test(r.text) && !/\bat .*:\d+:\d+/.test(r.text), r.text);
	}

	section("loggen före omstart");
	check("varje verktygsanrop loggades", (server.log().match(/mcp tool /g) ?? []).length >= 10,
		String((server.log().match(/mcp tool /g) ?? []).length));
	check("granten loggades aldrig i klartext", !server.log().includes(grant.token));
	check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-300));

	// ------------------------------------------------------- other conversations
	// A worker is shared, so ending or renaming one reaches every session that
	// was pointing at it. Without this a second session keeps naming somebody
	// who no longer exists, and PRD 3 routes on that name.
	section("en annan session lämnas inte pekande på ett spöke");
	{
		const other = await connect(server);
		const otherMcp = new McpClient(await grantTools(other));
		await otherMcp.initialize();

		await mcp.call("spawn_worker", { name: "Doris", systemPrompt: "Du sköter en uppgift i testriggen." });
		await otherMcp.call("switch_worker", { name: "Doris" });

		const sinceRename = other.mark();
		await mcp.call("rename_worker", { name: "Doris", newName: "Dora" });
		const renamed = await other.waitFor((m) => m.type === "state" && m.worker !== undefined, 5000, "state efter namnbyte", sinceRename);
		check("den andra sessionen får veta om namnbytet", renamed.worker === "Dora", JSON.stringify(renamed));

		const sinceEnd = other.mark();
		await mcp.call("end_worker", { name: "Dora" });
		const ended = await other.waitFor((m) => m.type === "state" && m.worker !== undefined, 5000, "state efter avslut", sinceEnd);
		check("den andra sessionen släpps tillbaka till Mike", ended.worker === null, JSON.stringify(ended));

		const back = await connect(server, { sessionId: other.readyMsg.sessionId });
		check("ready namnger aldrig en arbetare som inte finns",
			back.readyMsg.worker === null || back.readyMsg.workers.some((w) => w.name === back.readyMsg.worker),
			JSON.stringify({ worker: back.readyMsg.worker, workers: back.readyMsg.workers.map((w) => w.name) }));
		back.close(); other.close();
	}

	// -------------------------------------------------------------- persistence
	// Leaving is not ending. The distinction is the whole point of the tool: a
	// user with their hands busy who wants to come back to Mike must not have
	// to destroy the conversation they were in to do it.
	section("att lämna en arbetare är inte att avsluta den");
	{
		await mcp.call("spawn_worker", { name: "Ester", systemPrompt: "Du sköter en uppgift i testriggen." });
		const left = await mcp.call("leave_worker", {});
		check("att lämna lyckas", left.isError === false, JSON.stringify(left));
		check("och säger att arbetaren lever", /keeps running/i.test(left.text), left.text);
		check("arbetaren finns kvar i listan", /Ester/.test((await mcp.call("list_workers")).text));

		// The tool saying so is not the same as the session being so.
		const reattached = await connect(server, { sessionId });
		check("sessionen pekar inte längre på någon arbetare", reattached.readyMsg.worker === null, JSON.stringify(reattached.readyMsg.worker));
		check("men arbetaren står kvar i ready-listan",
			reattached.readyMsg.workers.some((w) => w.name === "Ester"), JSON.stringify(reattached.readyMsg.workers));
		reattached.close();

		const again = await mcp.call("leave_worker", {});
		check("att lämna när man redan är hos Mike är inget fel", again.isError === false, JSON.stringify(again));

		const back = await mcp.call("switch_worker", { name: "Ester" });
		check("man kan växla tillbaka till den", back.isError === false, JSON.stringify(back));
		await mcp.call("end_worker", { name: "Ester" });
		check("efter avslut är den borta", !/Ester/.test((await mcp.call("list_workers")).text));
	}

	// A schema that says a field is required, and a server that runs the tool
	// without it, is a schema the model is free to ignore. Measured: spawn_worker
	// asked for a system prompt, did not get one, and answered "ok" — every time.
	section("schemats obligatoriska fält gäller på riktigt");
	{
		const missing = await mcp.call("spawn_worker", { name: "Tyst" });
		check("ett saknat obligatoriskt fält avvisas", missing.isError === true, JSON.stringify(missing));
		check("och felet namnger fältet", /systemPrompt/.test(missing.text), missing.text);
		check("tom sträng räknas som saknad",
			(await mcp.call("spawn_worker", { name: "Tyst", systemPrompt: "   " })).isError === true);
		check("ingen arbetare skapades av det misslyckade anropet",
			!/Tyst/.test((await mcp.call("list_workers")).text));
		const ok = await mcp.call("spawn_worker", { name: "Tyst", systemPrompt: "Du sköter testriggen." });
		check("med fältet går det igenom", ok.isError === false, JSON.stringify(ok));
		await mcp.call("end_worker", { name: "Tyst" });
	}

	section("arbetare överlever en omstart — acceptans 4");
	const beforeRestart = await mcp.call("list_workers");
	check("en arbetare kvar att räkna", /Kalle/.test(beforeRestart.text), beforeRestart.text);
	c1.close(); c1b.close();

	await server.restart();
	const c2 = await connect(server, { sessionId });
	check("sessionen minns vem man pratade med", c2.readyMsg.worker === null || typeof c2.readyMsg.worker === "string");
	check("ready listar arbetaren efter omstart",
		c2.readyMsg.workers.some((w) => w.name === "Kalle" && w.model === "haiku" && w.cwd === "/tmp"),
		JSON.stringify(c2.readyMsg.workers));

	// The port is ephemeral, so the old grant's URL is stale — which is the
	// point: a grant belongs to one invocation, and PRD 3 mints a fresh one.
	const grant2 = await grantTools(c2);
	const mcp2 = new McpClient(grant2);
	await mcp2.initialize();
	const afterRestart = await mcp2.call("list_workers");
	check("arbetaren går att nå vid namn efter omstart", /Kalle — haiku, \/tmp/.test(afterRestart.text), afterRestart.text);
	check("den gamla granten gäller inte längre",
		(await mcp2.raw({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: grant.token })).status === 401);
	check("switch till den överlevande fungerar", (await mcp2.call("switch_worker", { name: "kalle" })).isError === false);
	c2.close();

	section("loggen efter omstart");
	check("inga ouppfångade undantag efter omstart", !server.log().includes("UNCAUGHT"), server.log().slice(-300));
	check("inga obehandlade rejections", !server.log().includes("UNHANDLED"));

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	server.stop();
	await sleep(100);
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
