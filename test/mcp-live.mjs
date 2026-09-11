// The one test that spends money — PRD 2 acceptance criterion 1.
//
//   node test/mcp-live.mjs
//
// A real `claude -p`, configured with this server's MCP grant, asked in plain
// Swedish to start a worker. Nothing about the tool is named in the prompt; the
// model has to decide from the tool descriptions that this is a spawn_worker.
// The assertion is not on what it said — it is on the server having actually
// changed, observed from a WebSocket client that was attached the whole time.
//
// Everything is chosen to keep this cheap and bounded: haiku, one short prompt,
// --strict-mcp-config so no other MCP server is contacted, and a hard kill so a
// hung model run fails the test instead of hanging the suite.

import { spawn } from "node:child_process";
import { startServer, connect, grantTools, check, failed, section, sleep, ROOT } from "./harness.mjs";

/** Long enough for a cold start plus one tool call; short enough that a wedged
 *  run is reported rather than waited on. */
const CLAUDE_TIMEOUT_MS = 180_000;

const runClaude = (args, { cwd }) => new Promise((resolve) => {
	const proc = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	let err = "";
	let timedOut = false;

	const killer = setTimeout(() => {
		timedOut = true;
		try { proc.kill("SIGKILL"); } catch { }
	}, CLAUDE_TIMEOUT_MS);

	proc.stdout.on("data", (d) => { out += d.toString(); });
	proc.stderr.on("data", (d) => { err += d.toString(); });
	proc.on("error", (e) => { clearTimeout(killer); resolve({ spawnError: e.message, out, err, timedOut }); });
	proc.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err, timedOut }); });
});

const server = await startServer();

try {
	section("en riktig claude -p skapar en arbetare i den körande servern");

	const client = await connect(server);
	const grant = await grantTools(client);
	check("servern var tom innan", (await (await fetch(`${server.base}/healthz`)).json()).workers === 0);

	const since = client.mark();
	const started = Date.now();
	const run = await runClaude([
		"-p",
		"--strict-mcp-config",
		"--mcp-config", grant.config,
		"--allowedTools", ...grant.allowedTools,
		"--model", "haiku",
		// Plain language, in Swedish, naming no tool. PRD 2 acceptance 1.
		"Starta en ny worker som heter Bosse."
	], { cwd: ROOT });

	if (run.spawnError) {
		check("claude finns i PATH", false, run.spawnError);
	} else {
		console.log(`  (claude svarade på ${Math.round((Date.now() - started) / 1000)}s: ${run.out.trim().slice(0, 120)})`);
		check("claude avslutade utan att behöva dödas", run.timedOut === false, `timeout efter ${CLAUDE_TIMEOUT_MS} ms`);
		check("claude avslutade med 0", run.code === 0, `kod ${run.code}: ${run.err.trim().slice(0, 300)}`);
	}

	// The real assertion: the already-running server changed, and a client that
	// was attached before claude even started saw it happen.
	const ev = await client.waitFor((m) => m.type === "event" && m.kind === "workerSpawned", 10_000, "workerSpawned", since)
		.catch(() => null);
	check("en arbetare skapades i den körande servern", !!ev, "ingen workerSpawned-händelse kom");
	if (ev) {
		check("den heter Bosse", /^bosse$/i.test(ev.data.worker.name), ev.data.worker.name);
		check("samtalet växlade till den i samma anrop — R2.2", ev.data.active === ev.data.worker.name, JSON.stringify(ev.data));
		check("händelsen är loggbar för användaren — R2.3", ev.data.tool === "spawn_worker" && ev.data.ok === true);
		check("arbetaren har en modell och en katalog", !!ev.data.worker.model && ev.data.worker.cwd.startsWith("/"),
			JSON.stringify(ev.data.worker));
	}

	const health = await (await fetch(`${server.base}/healthz`)).json();
	check("servern rapporterar arbetaren", health.workers === 1, JSON.stringify(health));

	const reconnect = await connect(server, { sessionId: client.readyMsg.sessionId });
	check("en ny klient ser den aktiva arbetaren", reconnect.readyMsg.worker?.toLowerCase() === "bosse",
		JSON.stringify(reconnect.readyMsg));
	reconnect.close();
	client.close();

	check("verktygsanropet loggades på servern", /mcp tool spawn_worker/.test(server.log()), server.log().slice(-400));
	check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-300));

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	server.stop();
	await sleep(100);
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
