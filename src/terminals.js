// Claude Code sessions started in a terminal — the PC → glasses half of the
// PRD 3 handoff.
//
// The terminal side starts every session with `claude --bg` and a name from the
// book (scripts/terminal-session.mjs, through the `Claude` shell function), so
// a session running on the desk has a spoken name before Mike ever hears of it.
// This file is the server's read of those sessions, and it reads them from the
// one place that knows: `claude agents --json --all`. There is no registry of
// ours to fall out of step with it.
//
// What that list says, measured against claude 2.1.273:
//
//  * A session whose process is alive has a `pid`. That is the only reliable
//    "live" signal: a background session that finished its turn still has a
//    pid and says `state: "done"`, and one that was stopped says `done` too,
//    without one.
//  * `status` is "busy" while a turn runs, "idle" otherwise.
//  * Every `claude` process is listed, `-p` ones included, as kind
//    "interactive". Mike's own turns and every worker's therefore show up in
//    it while they run — which is why "live" alone never means "a terminal".
//
// T1 is the reason any of this matters: two processes driving one session fork
// it, and one side's turns silently stop having been said. So adoption is a
// baton, not a second seat — the terminal's process is stopped before the
// worker takes a turn — and every worker turn first checks that nobody has
// picked the session up again in a terminal since.

import { execFile } from "node:child_process";
import { existsSync, openSync, readSync, fstatSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { normalizeName } from "./names.js";
import { MODELS } from "./models.js";

/** How long a listing may take. It is ~0.1 s; a CLI that hangs must not hold a
 *  spawn or a turn with it. */
const LIST_TIMEOUT_MS = 5000;

/** How much of a Claude Code transcript is read to find the last exchanges. The
 *  file of a long session is many megabytes of tool output; the last few things
 *  said are near its end. */
const TAIL_BYTES = 2 * 1024 * 1024;

/** Longest single message kept from a terminal transcript, same as the
 *  engine's own cap on what it quotes. */
const MAX_TEXT = 4000;

const run = (bin, args) => new Promise((resolve, reject) => {
	execFile(bin, args, { timeout: LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
		if (err) reject(err);
		else resolve(stdout);
	});
});

/** A sentence's worth of text out of a message's content, or "" for one that
 *  is not something a person said: tool calls and results, thinking, and the
 *  bracketed bookkeeping the CLI writes as user messages. */
const textOf = (content) => {
	const parts = typeof content === "string"
		? [content]
		: Array.isArray(content) ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text) : [];
	const t = parts.join("\n").trim();
	if (!t || t.startsWith("<")) return "";
	return t.length <= MAX_TEXT ? t : t.slice(0, MAX_TEXT) + " …";
};

/** The worker label for a model id as the CLI records it
 *  ("claude-haiku-4-5-20251001" → "haiku"), or null for one we do not run. */
export const modelLabelOf = (id) => {
	const s = String(id ?? "");
	return MODELS.find((m) => s === m.id || s.startsWith(m.id + "-"))?.label ?? null;
};

/**
 * Read the end of a Claude Code transcript: the last exchanges said in words,
 * oldest first, and the model the session last answered with.
 *
 * Only the tail is read, so the first line may be torn and is dropped. The file
 * is a tree once anything forked it; reading it in order is the right answer
 * for the one thing this is for, which is putting "where it left off" on a lens.
 */
export function readTranscriptTail(file, { limit = 20 } = {}) {
	const out = { entries: [], model: null };
	let fd;
	try {
		fd = openSync(file, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		const lines = buf.toString("utf8").split("\n");
		if (start > 0) lines.shift();

		for (const line of lines) {
			if (!line.trim()) continue;
			let v;
			try { v = JSON.parse(line); } catch { continue; }
			if (v?.isMeta || v?.isSidechain) continue;
			const role = v?.type === "user" ? "user" : v?.type === "assistant" ? "assistant" : null;
			if (!role) continue;
			if (role === "assistant" && v.message?.model && v.message.model !== "<synthetic>") out.model = v.message.model;
			const text = textOf(v.message?.content);
			if (!text) continue;
			const at = Date.parse(v.timestamp) || Date.now();
			const last = out.entries[out.entries.length - 1];
			// One answer is often several assistant messages with tool calls in
			// between. It is still one answer to the person reading it.
			if (last && last.role === role && role === "assistant") last.text = `${last.text}\n${text}`.slice(0, MAX_TEXT);
			else out.entries.push({ role, text, at });
		}
	} catch {
		return out;
	} finally {
		if (fd !== undefined) try { closeSync(fd); } catch { }
	}
	out.entries = out.entries.slice(-limit);
	return out;
}

/**
 * The terminal sessions.
 *
 * `enabled: false` makes every read empty and every action a refusal: a test
 * suite must not see — let alone stop — the sessions of whoever runs it.
 * `own()` names the session ids that are this server's own (Mike's), so they
 * are never offered as something to connect to.
 */
export function createTerminals({ bin = "claude", log, enabled = true, projectsDir = join(homedir(), ".claude", "projects"), own = () => [] } = {}) {
	let warned = false;

	/** Every session Claude Code knows, or [] when it cannot be asked. */
	const list = async () => {
		if (!enabled) return [];
		try {
			const parsed = JSON.parse(await run(bin, ["agents", "--json", "--all"]));
			warned = false;
			return Array.isArray(parsed) ? parsed.filter((s) => s && typeof s.sessionId === "string") : [];
		} catch (e) {
			// Once per outage, not once per turn.
			if (!warned) log?.warn(`terminals: could not list Claude Code sessions: ${String(e.message).split("\n")[0]}`);
			warned = true;
			return [];
		}
	};

	const isLive = (s) => Number.isInteger(s.pid) && s.pid > 0;
	const ownIds = () => new Set(own().filter(Boolean));

	return {
		enabled,

		/** Folded names in use by any session Claude Code knows, so a worker
		 *  spawned by Mike never takes a name a terminal session already has. A
		 *  finished one counts: it can be attached again, under that name. */
		async takenNames() {
			return new Set((await list()).map((s) => s.name).filter(Boolean).map(normalizeName).filter(Boolean));
		},

		/** The background sessions running right now — what a terminal started
		 *  with `Claude` is — newest first. */
		async running() {
			const mine = ownIds();
			return (await list())
				.filter((s) => s.kind === "background" && isLive(s) && !mine.has(s.sessionId))
				.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
		},

		/** A session by spoken name, short id or session id. Background sessions
		 *  first, live before finished; an interactive one only when nothing
		 *  else answers to it, so the caller can say why it cannot be taken. */
		async find(ref) {
			const raw = String(ref ?? "").trim();
			const key = normalizeName(raw);
			if (!raw) return null;
			const mine = ownIds();
			const hits = (await list()).filter((s) => !mine.has(s.sessionId) && (
				s.id === raw || s.sessionId === raw
				|| (raw.length >= 8 && s.sessionId.startsWith(raw.toLowerCase()))
				|| (key && s.name && normalizeName(s.name) === key)));
			const rank = (s) => (s.kind === "background" ? 0 : 2) + (isLive(s) ? 0 : 1);
			return hits.sort((a, b) => rank(a) - rank(b))[0] ?? null;
		},

		isLive,

		/** Whatever process holds this session right now, or null. Asked before
		 *  every worker turn: a session picked up again in a terminal after it
		 *  was adopted must not get a second driver. */
		async holder(sessionId) {
			if (!sessionId) return null;
			return (await list()).find((s) => s.sessionId === sessionId && isLive(s)) ?? null;
		},

		/** Stop a background session's process. The conversation stays on disk,
		 *  which is the point. True once it no longer has one. */
		async stop(session) {
			if (!enabled) return false;
			const ref = session.id ?? session.sessionId.slice(0, 8);
			try { await run(bin, ["stop", ref]); }
			catch (e) { log?.warn(`terminals: stop ${ref} failed: ${String(e.message).split("\n")[0]}`); }
			return !(await this.holder(session.sessionId));
		},

		/** The Claude Code transcript of a session, located by id: the project
		 *  directory's name is a mangled cwd, and matching the mangling is a
		 *  guess where looking is not. */
		transcriptFile(sessionId) {
			if (!/^[0-9a-f-]{36}$/i.test(String(sessionId))) return null;
			try {
				for (const d of readdirSync(projectsDir)) {
					const f = join(projectsDir, d, `${sessionId}.jsonl`);
					if (existsSync(f)) return f;
				}
			} catch { }
			return null;
		},

		/** Where a session left off, and the model it ran. */
		tail(sessionId, opts) {
			const f = this.transcriptFile(sessionId);
			return f ? readTranscriptTail(f, opts) : { entries: [], model: null };
		}
	};
}

/** A terminal session as Mike reads it in a list. */
export const describeTerminal = (s) => {
	const secs = Math.max(0, Math.round((Date.now() - (s.startedAt ?? Date.now())) / 1000));
	const age = secs < 3600 ? `${Math.max(1, Math.round(secs / 60))}m` : secs < 86400 ? `${Math.round(secs / 3600)}h` : `${Math.round(secs / 86400)}d`;
	return `${s.name ?? s.id} — ${s.cwd}, ${s.status === "busy" ? "busy" : "idle"}, started ${age} ago`;
};
