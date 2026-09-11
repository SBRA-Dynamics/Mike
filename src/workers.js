// The worker registry — the state the PRD 2 tools mutate.
//
// A worker record is the orchestration half of a worker: its spoken name, the
// model the user asked for, where it works, and whether it is busy. The other
// half — an actual Claude Code session — lives behind the engine seam in
// workerEngine.js and is PRD 3's problem.
//
// Persistence: one small JSON file, rewritten whole through a temp file, same
// shape and same reasoning as SessionStore's meta. PRD 2 acceptance 4 is
// "restarting the server does not orphan workers — they are re-attachable by
// name", so the names and ids have to outlive the process. What does not
// outlive it is `busy`: nothing is running a moment after a restart, and a
// record that claims otherwise would wedge every tool that checks it.

import { randomUUID } from "node:crypto";
import { renameSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { checkName, normalizeName } from "./names.js";
import { resolveModel } from "./models.js";

/** An error whose message is meant to be read out loud on a 50x10 lens.
 *  Thrown by the registry and the tools; rendered verbatim to the model. */
export class ToolError extends Error {
	constructor(message) {
		super(message);
		this.name = "ToolError";
		this.lens = true;
	}
}

/** Hard cap. Each worker is a Claude Code process in PRD 3; an orchestrator
 *  that can be talked into spawning a hundred of them is a fork bomb with a
 *  friendly voice. */
const MAX_WORKERS = 24;

export class WorkerRegistry {
	constructor({ file, log, defaultModel = "sonnet", defaultCwd = process.cwd() }) {
		this.file = file;
		this.log = log;
		this.defaultModel = defaultModel;
		this.defaultCwd = defaultCwd;
		this.workers = new Map();      // key (normalized name) -> record
		this.#load();
	}

	// ------------------------------------------------------------------ reading

	/** Every live worker, newest activity first. This is what `list_workers`
	 *  answers with and what `ready` carries to a reconnecting client. */
	list() {
		return [...this.workers.values()]
			.sort((a, b) => b.lastActivity - a.lastActivity)
			.map((w) => ({ ...w }));
	}

	/** Resolve a spoken name. Returns null rather than throwing so callers can
	 *  phrase their own refusal — "no worker called X" reads better than a
	 *  generic not-found. */
	get(spokenName) {
		return this.workers.get(normalizeName(spokenName)) ?? null;
	}

	/** Like get(), but refuses in the words the user should hear. */
	require(spokenName) {
		const w = this.get(spokenName);
		if (!w) throw new ToolError(`no worker called "${String(spokenName ?? "").trim().slice(0, 24)}"`);
		return w;
	}

	get size() { return this.workers.size; }

	// ------------------------------------------------------------------ writing

	/**
	 * Create a worker. Throws ToolError on a collision, a reserved name, an
	 * unknown model or a working directory that is not there.
	 */
	create({ name, model, cwd, systemPrompt }) {
		if (this.workers.size >= MAX_WORKERS) throw new ToolError(`${MAX_WORKERS} workers is the limit; end one first`);

		const named = checkName(name);
		if (!named.ok) throw new ToolError(named.error);
		// Loudly, as PRD 2 requires: reusing the existing worker would look like
		// success and put the user in front of someone else's conversation.
		if (this.workers.has(named.key)) throw new ToolError(`"${named.name}" already exists`);

		const resolved = resolveModel(model ?? this.defaultModel);
		if (!resolved.ok) throw new ToolError(resolved.error);

		const dir = this.#checkCwd(cwd);

		const now = Date.now();
		const record = {
			id: randomUUID(),
			name: named.name,
			key: named.key,
			model: resolved.label,
			modelId: resolved.id,
			cwd: dir,
			// The worker-specific half of its system prompt, written by Jarvis at
			// spawn time and folded into the template on every turn. Kept on the
			// record so a restart does not quietly change who it is.
			systemPrompt: typeof systemPrompt === "string" ? systemPrompt.slice(0, 2000).trim() : "",
			busy: false,
			createdAt: now,
			lastActivity: now,
			// Filled in by the engine once a real Claude Code session exists, so a
			// restart can `--resume` it. Null under the stub engine.
			engineSessionId: null
		};
		this.workers.set(named.key, record);
		this.#save();
		return record;
	}

	rename(spokenName, newName) {
		const w = this.require(spokenName);
		const named = checkName(newName);
		if (!named.ok) throw new ToolError(named.error);
		if (named.key !== w.key && this.workers.has(named.key)) throw new ToolError(`"${named.name}" already exists`);

		this.workers.delete(w.key);
		w.name = named.name;
		w.key = named.key;
		w.lastActivity = Date.now();
		this.workers.set(named.key, w);
		this.#save();
		return w;
	}

	remove(spokenName) {
		const w = this.require(spokenName);
		this.workers.delete(w.key);
		this.#save();
		return w;
	}

	/** Mark activity. Called on every turn so `list_workers` can answer the
	 *  "which one was I talking to" question the user actually asks. */
	touch(worker, patch = {}) {
		Object.assign(worker, patch, { lastActivity: Date.now() });
		this.#save();
		return worker;
	}

	// ------------------------------------------------------------- internals

	/** A working directory is the one tool argument that names something on the
	 *  filesystem, so it is the one that gets checked. It is not confined to a
	 *  root: Jarvis has Bash and can already reach anywhere, so a jail here
	 *  would be theatre. What it must not be is a relative path or a directory
	 *  that is not there — both fail later, inside a spawn, where the error is
	 *  unreadable. */
	#checkCwd(cwd) {
		const raw = cwd == null || cwd === "" ? this.defaultCwd : String(cwd);
		if (raw.includes("\0")) throw new ToolError("that folder name is not valid");
		if (!raw.startsWith("/")) throw new ToolError(`"${raw.slice(0, 40)}" is not a full path`);
		let stat;
		try { stat = statSync(raw); } catch { throw new ToolError(`no folder ${raw.slice(0, 60)}`); }
		if (!stat.isDirectory()) throw new ToolError(`${raw.slice(0, 60)} is not a folder`);
		return raw;
	}

	#load() {
		if (!existsSync(this.file)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8"));
			for (const w of parsed?.workers ?? []) {
				if (!w?.id || !w?.name) continue;
				const key = normalizeName(w.name);
				if (!key || this.workers.has(key)) continue;   // a duplicate on disk: first wins
				this.workers.set(key, { ...w, key, busy: false });
			}
			this.log?.info(`workers: ${this.workers.size} restored from ${this.file}`);
		} catch (e) {
			// Same call as SessionStore's: a corrupt file must not stop the server
			// booting. Losing the registry costs names, not transcripts.
			this.log?.error(`workers: could not read ${this.file}: ${e.message}`);
		}
	}

	#save() {
		const tmp = `${this.file}.tmp`;
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			writeFileSync(tmp, JSON.stringify({ version: 1, workers: this.list() }));
			renameSync(tmp, this.file);
		} catch (e) {
			this.log?.error(`workers: could not persist: ${e.message}`);
		}
	}
}
