// PRD 3's scripted run, steps 1–9, against the real `claude` — the test that
// spends money.
//
//   node test/e2e-live.mjs
//
// test/prd3.mjs already drives the same nine steps through the real handler,
// the real engine and the real MCP round trip with a stand-in binary, which is
// why that one can run ten times in a row for nothing. The one claim it cannot
// make is the only one this file is for: that a real model, given the tool
// descriptions and a sentence of plain Swedish or English, chooses the right
// tool and the server actually changes.
//
// Kept cheap and bounded on purpose: haiku everywhere, one short sentence per
// step, --strict-mcp-config through the grant so no other MCP server is
// contacted, and a hard kill so a wedged model run fails instead of hanging.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, connect, check, failed, section, sleep } from "./harness.mjs";

const TURN_MS = 180_000;

/** A working directory with a file nobody else on this machine has, so "the
 *  listing is real" is not satisfied by a hallucinated plausible name. */
const workDir = mkdtempSync(join(tmpdir(), "mike-e2e-"));
writeFileSync(join(workDir, "kanelbulle.txt"), "sju sorters kakor\n");
writeFileSync(join(workDir, "vaniljhjarta.txt"), "och en till\n");

const runClaude = (args, cwd) => new Promise((resolve) => {
	const proc = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
	let out = "", err = "";
	const killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { } }, TURN_MS);
	proc.stdout.on("data", (d) => { out += d; });
	proc.stderr.on("data", (d) => { err += d; });
	proc.on("error", (e) => { clearTimeout(killer); resolve({ spawnError: e.message, out, err }); });
	proc.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err }); });
});

const server = await startServer([
	"--mike-model", "haiku",
	"--worker-model", "haiku",
	"--worker-cwd", workDir,
	"--mike-cwd", workDir,
	// Every utterance below names somebody, so the default mode is what is
	// being exercised rather than worked around.
	"--turn-timeout", String(TURN_MS)
]);

/** Say one thing, wait for the turn to close, print what came back. `since` is
 *  taken before the send: without it the wait matches the previous turn's idle
 *  state and the run races ahead through every step in milliseconds. */
const say = async (c, text) => {
	const since = c.mark();
	const t0 = Date.now();
	c.send({ type: "say", text });
	await c.waitFor((m) => m.type === "state" && m.busy === false, TURN_MS + 20_000, `idle after ${JSON.stringify(text)}`, since);
	const turn = c.messages.slice(since);
	const said = turn.filter((m) => m.type === "text").map((m) => `${m.from}: ${m.text}`).join(" / ");
	console.log(`  > ${text}\n    (${Math.round((Date.now() - t0) / 1000)}s) ${said.replace(/\s+/g, " ").slice(0, 200)}`);
	return turn;
};
const ev = (turn, kind) => turn.find((m) => m.type === "event" && m.kind === kind);
const texts = (turn) => turn.filter((m) => m.type === "text");

const whoIs = async (c, name) => {
	const since = c.mark();
	c.send({ type: "control", action: "whoIs", args: { name } });
	return (await c.waitFor((m) => m.type === "event" && m.kind === "workerIdentity", 5000, "workerIdentity", since)).data;
};

try {
	section("PRD 3 steg 1–9 med en riktig claude");

	// 1 --------------------------------------------------------------------
	const c = await connect(server);
	const hello = await c.waitFor((m) => m.type === "text" && m.from === "mike", 10_000, "Mike hälsar");
	check("1. Mike hälsar", !!hello.text, hello.text);

	// 2 --------------------------------------------------------------------
	const t2 = await say(c, "Mike, starta en arbetare som heter Bosse med sonnet.");
	const spawned = ev(t2, "workerSpawned");
	check("2. arbetaren skapades av modellen själv", spawned?.data.worker.name?.toLowerCase() === "bosse", JSON.stringify(t2.map((m) => m.type + ":" + (m.kind ?? ""))));
	check("2. med modellen användaren namngav, inte standardmodellen", spawned?.data.worker.model === "sonnet", spawned?.data.worker.model);
	check("2. och samtalet växlade i samma anrop — R2.2/R3.3", spawned?.data.active === spawned?.data.worker.name);
	check("2. svaret är kort nog för en lins", (texts(t2)[0]?.text ?? "").length < 300, texts(t2)[0]?.text);
	const bosse = await whoIs(c, "Bosse");

	// 3 --------------------------------------------------------------------
	const t3 = await say(c, "Bosse, vi felsöker en trasig kaffebryggare. Svara bara OK.");
	check("3. svaret kommer taggat som arbetaren", texts(t3)[0]?.from?.toLowerCase() === "bosse", JSON.stringify(texts(t3)));
	check("3. arbetaren fick ett riktigt sessions-id", /^[0-9a-f-]{36}$/.test(String(bosse.sessionId)), JSON.stringify(bosse));

	// 4 --------------------------------------------------------------------
	const t4 = await say(c, "Mike, vad jobbar Bosse med?");
	// PRD 3 step 4 asks for an answer that references the exchange, and does not
	// say how. Both ways are the design working: the injected context is meant
	// to be "observably identical to him having watched", and read_worker is
	// there for when it is not enough. So the answer is asserted and the route
	// he took is only reported.
	console.log(`    (via ${ev(t4, "workerRead") ? "read_worker" : "injicerad kontext"})`);
	check("4. Mike svarar om arbetarens utbyte utan att ha sett det hända — R3.2",
		/kaffebrygg/i.test(texts(t4).map((m) => m.text).join(" ")), texts(t4).map((m) => m.text).join(" ").slice(0, 200));
	check("4. utan att byta vem man pratar med", t4.filter((m) => m.type === "state").pop()?.worker?.toLowerCase() === "bosse");

	// 5 --------------------------------------------------------------------
	const t5 = await say(c, "Mike, lista filerna i mappen vi pratar om.");
	check("5. Mike svarar om arbetarens katalog utan att den namngavs — R3.4",
		/kanelbulle/.test(texts(t5).map((m) => m.text).join(" ")), texts(t5).map((m) => m.text).join(" ").slice(0, 300));

	// 6 --------------------------------------------------------------------
	const t6 = await say(c, "Mike, starta en arbetare som heter Kalle.");
	check("6. den nya arbetaren blev den aktiva", ev(t6, "workerSpawned")?.data.active?.toLowerCase() === "kalle", JSON.stringify(t6.map((m) => m.kind ?? m.type)));
	const health6 = await (await fetch(`${server.base}/healthz`)).json();
	check("6. och Bosse finns kvar", health6.workers === 2, JSON.stringify(health6));

	// 7 --------------------------------------------------------------------
	const t7 = await say(c, "Mike, byt tillbaka till Bosse.");
	check("7. samtalet är tillbaka hos Bosse", (ev(t7, "workerSwitched") ?? ev(t7, "workersListed"))?.data.active?.toLowerCase() === "bosse", JSON.stringify(t7.map((m) => m.kind ?? m.type)));
	const t7b = await say(c, "Bosse, vad var det vi felsökte?");
	check("7. transkriptet fortsätter, det startar inte om — R3.6",
		/kaffebrygg/i.test(texts(t7b).map((m) => m.text).join(" ")), texts(t7b).map((m) => m.text).join(" ").slice(0, 200));
	check("7. arbetaren behöll sitt sessions-id", (await whoIs(c, "Bosse")).sessionId === bosse.sessionId);

	// 8 --------------------------------------------------------------------
	const sessionId = c.readyMsg.sessionId;
	const mikeBefore = (await (await fetch(`${server.base}/healthz`)).json()).mike.sessionId;
	c.close();
	await server.restart();
	const c8 = await connect(server, { sessionId });
	const health8 = await (await fetch(`${server.base}/healthz`)).json();
	check("8. Mike är samma samtal efter omstarten — R3.7", health8.mike.sessionId === mikeBefore, `${health8.mike.sessionId} vs ${mikeBefore}`);
	check("8. båda arbetarna finns kvar", health8.workers === 2, JSON.stringify(health8));
	check("8. sessionen minns vem man pratade med", c8.readyMsg.worker?.toLowerCase() === "bosse", JSON.stringify(c8.readyMsg));
	const t8 = await say(c8, "Bosse, vad var det vi felsökte?");
	check("8. och arbetaren fortsätter där den slutade", /kaffebrygg/i.test(texts(t8).map((m) => m.text).join(" ")), texts(t8).map((m) => m.text).join(" ").slice(0, 200));

	// 9 --------------------------------------------------------------------
	// The handoff, as T1 says it can honestly be promised: a baton, not a second
	// seat. The server's turn is finished before the terminal takes the id.
	section("steg 9: en terminal återupptar arbetarens session");
	const term = await runClaude(["-p", "--resume", bosse.sessionId, "--model", "haiku",
		// `--tools` is variadic, so something that is not the prompt has to come
		// after it: with the prompt straight after, the prompt is read as a tool
		// name and the resume fails in a way that looks like a server bug.
		"--tools", "", "--strict-mcp-config", "--output-format", "json",
		"Vad var det vi felsökte? Svara kort."], workDir);
	if (term.spawnError) {
		check("9. claude finns i PATH", false, term.spawnError);
	} else {
		check("9. terminalen kunde återuppta arbetarens session", term.code === 0, `kod ${term.code}: ${term.err.trim().slice(0, 300)}`);
		let parsed = null;
		try { parsed = JSON.parse(term.out); } catch { }
		check("9. och den svarar", !!parsed, term.out.slice(0, 200));
		if (parsed) {
			console.log(`  (terminalen sa: ${String(parsed.result).trim().slice(0, 120)})`);
			check("9. den ser samma samtal, inte ett nytt", /kaffebrygg/i.test(String(parsed.result)), String(parsed.result).slice(0, 200));
			check("9. samma sessions-id hela vägen", parsed.session_id === bosse.sessionId, `${parsed.session_id} vs ${bosse.sessionId}`);
		}
	}

	check("inga ouppfångade undantag", !server.log().includes("UNCAUGHT"), server.log().slice(-400));
	c8.close();

} catch (err) {
	console.error("\ntestriggen kraschade:", err.stack || err.message);
	check("testriggen överlevde", false, err.message);
} finally {
	server.stop();
	try { rmSync(workDir, { recursive: true, force: true }); } catch { }
	await sleep(200);
}

console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
