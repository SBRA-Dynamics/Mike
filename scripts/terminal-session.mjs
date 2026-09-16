#!/usr/bin/env node
// Terminal-side half of adopting a Claude Code session as a worker.
//
// The `Claude` shell function starts every terminal session in the background
// and names it the way Mike names a worker, so "Mike, connect to Wyoh" has a
// spoken name to find. The name lives on the session itself (`claude -n`), and
// `claude agents --json --all` is where Mike reads it back — no registry of
// ours to fall out of step with it.
//
//   terminal-session.mjs name          a free book name, printed
//   terminal-session.mjs find <ref>    the short id of the background session
//                                      <ref> names (id, id prefix or name);
//                                      exit 1 when none does
//
// Taken names are every background session Claude Code still knows — a stopped
// one can be attached again, so its name is not free — every live interactive
// one, and every worker Mike has. Two sessions started in the same second can
// still draw the same name; that is a lens reading "which Wyoh", not lost work.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { normalizeName, pickName } from "../src/names.js";

const sessions = () => {
	try {
		const out = execFileSync("claude", ["agents", "--json", "--all"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });
		return JSON.parse(out);
	} catch {
		return [];
	}
};

const workerNames = () => {
	const dataDir = process.env.MIKE_DATA || path.join(homedir(), ".local", "share", "mike");
	try {
		return JSON.parse(readFileSync(path.join(dataDir, "workers.json"), "utf8")).workers?.map((w) => w.name) ?? [];
	} catch {
		return [];
	}
};

const [cmd, ref] = process.argv.slice(2);

if (cmd === "name") {
	const taken = new Set([...sessions().map((s) => s.name), ...workerNames()].filter(Boolean).map(normalizeName));
	console.log(pickName(taken));
} else if (cmd === "find" && ref) {
	const key = normalizeName(ref);
	const hit = sessions().filter((s) => s.kind === "background").find((s) =>
		s.id === ref || s.sessionId === ref || (ref.length >= 8 && s.sessionId?.startsWith(ref)) || (s.name && normalizeName(s.name) === key));
	if (!hit) process.exit(1);
	console.log(hit.id);
} else {
	console.error("usage: terminal-session.mjs name | find <id|name>");
	process.exit(2);
}
