// Session store — PRD 1 R1.5.
//
// A session is the durable thing: it owns the transcript, the outbound sequence
// number, and a replay buffer so a reconnect can catch up. Connections come and
// go; sessions do not.
//
// Storage is one JSONL file per session plus a small meta file. JSONL because
// appends are atomic enough for this and a partially written last line can be
// dropped without losing the rest — a database would be a dependency and a
// backup problem for something one person runs on one machine.

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isSessionId } from "./protocol.js";

/** How many outbound messages are kept for replay after a reconnect. */
const REPLAY_DEPTH = 500;

export class Session {
	constructor(store, meta) {
		this.store = store;
		this.id = meta.id;
		this.createdAt = meta.createdAt ?? Date.now();
		this.updatedAt = meta.updatedAt ?? this.createdAt;
		this.title = meta.title ?? "";
		this.seq = meta.seq ?? 0;
		// State later phases own; carried here so it survives a restart.
		this.worker = meta.worker ?? null;
		this.mode = meta.mode ?? "byname";
		// What "continue input" goes back to (PRD 5a R5a.4). Durable for the same
		// reason `mode` is: a restart that resumed into ByName would silently
		// undo a setting the user chose before pausing.
		this.previousMode = meta.previousMode ?? null;

		this.recent = [];              // { seq, msg } for replay
		this.sockets = new Set();      // live connections attached to this session
	}

	/** Send to every attached connection, and remember it for replay. */
	emit(message) {
		const seq = ++this.seq;
		// When, as well as what. A transcript replayed into a client that has
		// just started has to be readable as history: without this every line of
		// it arrived "now", the last answer of a conversation from yesterday lit
		// the lens as if it had just been said, and the companion stamped a
		// week of talk with one timestamp.
		const framed = { ...message, seq, at: Date.now() };

		this.recent.push({ seq, msg: framed });
		if (this.recent.length > REPLAY_DEPTH) this.recent.shift();

		this.updatedAt = Date.now();
		this.store.appendEvent(this.id, framed);
		this.store.touch(this);

		for (const ws of [...this.sockets]) {
			try { ws.send(JSON.stringify(framed)); }
			catch { this.sockets.delete(ws); }   // dead socket; the close handler will tidy up
		}
		return seq;
	}

	/**
	 * Send to every attached connection, and forget it.
	 *
	 * No sequence number, no transcript line, no replay — the opposite of
	 * emit() in every way that matters. It exists for the messages an always-on
	 * microphone produces by the dozen (PRD 5a): in Ignore mode every overheard
	 * sentence in the room would otherwise write `heard`, `notHeard` and a
	 * `state` into the durable transcript, which is a disk problem and, with
	 * speech in it, a worse one than that.
	 *
	 * The rule for choosing: is this a fact about the conversation, or a fact
	 * about this moment on this screen? Words that reached a model are the
	 * first; words the gate threw away are the second.
	 */
	transient(message) {
		for (const ws of [...this.sockets]) {
			try { ws.send(JSON.stringify(message)); }
			catch { this.sockets.delete(ws); }
		}
	}

	/** Everything after `from`, for a reconnecting client. */
	replay(from) {
		return this.recent.filter((e) => e.seq > from).map((e) => e.msg);
	}

	/** True when we cannot honestly satisfy the client's cursor — either it is
	 *  further back than the buffer reaches, or ahead of us, which is what a
	 *  server rewind or a wiped data directory looks like from outside. */
	replayGap(from) {
		if (from <= 0) return false;
		if (from > this.seq) return true;                       // client is ahead of us
		if (!this.recent.length) return from < this.seq;        // nothing buffered to bridge with
		return from < this.recent[0].seq - 1;                   // older than the buffer
	}

	attach(ws) { this.sockets.add(ws); }
	detach(ws) { this.sockets.delete(ws); }
	get connectionCount() { return this.sockets.size; }

	meta() {
		return {
			id: this.id, createdAt: this.createdAt, updatedAt: this.updatedAt,
			title: this.title, seq: this.seq, worker: this.worker,
			mode: this.mode, previousMode: this.previousMode
		};
	}
}

export class SessionStore {
	/** `defaultMode` is the addressing mode a FRESH session starts in (PRD 5a
	 *  R5a.4 "defaults from config for a fresh session"). An existing session
	 *  keeps whatever it was last set to — the whole point of persisting it. */
	constructor(dir, { defaultMode = "byname" } = {}) {
		this.dir = dir;
		this.defaultMode = defaultMode;
		this.sessions = new Map();
		mkdirSync(this.dir, { recursive: true });
		this.#loadAll();
	}

	#metaPath(id) { return join(this.dir, `${id}.meta.json`); }
	#logPath(id) { return join(this.dir, `${id}.jsonl`); }

	#loadAll() {
		for (const f of readdirSync(this.dir)) {
			if (!f.endsWith(".meta.json")) continue;
			try {
				const meta = JSON.parse(readFileSync(join(this.dir, f), "utf8"));
				if (!meta?.id) continue;

				// emit() appends to the log before rewriting the meta, so a crash
				// between the two leaves meta behind. Handing those numbers out again
				// would label two different messages with the same seq and make every
				// later replay quietly wrong. The log is the authority.
				const logged = this.#lastLoggedSeq(meta.id);
				if (logged > (meta.seq ?? 0)) {
					console.error(`[sessions] ${meta.id}: meta seq ${meta.seq ?? 0} is behind the log (${logged}); trusting the log`);
					meta.seq = logged;
				}

				const session = new Session(this, meta);
				this.sessions.set(meta.id, session);
				this.touch(session);   // rewrite the reconciled meta immediately
			} catch { /* a corrupt meta file must not stop the server booting */ }
		}
	}

	/** Highest seq actually written to the transcript, or 0. */
	#lastLoggedSeq(id) {
		const p = this.#logPath(id);
		if (!existsSync(p)) return 0;
		try {
			const lines = readFileSync(p, "utf8").split("\n");
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i].trim();
				if (!line) continue;
				try {
					const v = JSON.parse(line);
					if (Number.isInteger(v?.seq)) return v.seq;
				} catch { /* torn last line from a crash; look further back */ }
			}
		} catch { /* unreadable log; meta is all we have */ }
		return 0;
	}

	get(id) { return this.sessions.get(id) ?? null; }

	create(id = randomUUID()) {
		// Second line of defence. The protocol already rejects non-UUID ids, but an
		// id becomes a filename here and this must not depend on a caller
		// remembering to validate.
		if (!isSessionId(id)) throw new Error(`refusing to create session with unsafe id ${JSON.stringify(id)}`);
		const s = new Session(this, { id, createdAt: Date.now(), mode: this.defaultMode });
		this.sessions.set(id, s);
		this.touch(s);
		return s;
	}

	getOrCreate(id) {
		if (!id) return this.create();
		return this.get(id) ?? this.create(id);
	}

	list(limit = 50) {
		return [...this.sessions.values()]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, limit)
			.map((s) => s.meta());
	}

	delete(id) {
		const s = this.sessions.get(id);
		if (!s) return false;
		for (const ws of [...s.sockets]) { try { ws.close(); } catch { } }
		this.sessions.delete(id);
		for (const p of [this.#metaPath(id), this.#logPath(id)]) {
			try { if (existsSync(p)) unlinkSync(p); } catch { }
		}
		return true;
	}

	/** Meta is rewritten whole, through a temp file: a half-written meta would
	 *  lose the sequence number and make replay silently wrong after a crash. */
	touch(session) {
		const p = this.#metaPath(session.id);
		const tmp = `${p}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(session.meta()));
			renameSync(tmp, p);
		} catch (e) {
			console.error(`[sessions] could not persist ${session.id}: ${e.message}`);
		}
	}

	appendEvent(id, framed) {
		try { appendFileSync(this.#logPath(id), JSON.stringify(framed) + "\n"); }
		catch (e) { console.error(`[sessions] could not append to ${id}: ${e.message}`); }
	}

	/** Transcript from disk. A trailing partial line from a crash is dropped. */
	history(id, limit = 200) {
		const p = this.#logPath(id);
		if (!existsSync(p)) return [];
		const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
		const out = [];
		for (const line of lines.slice(-limit)) {
			try { out.push(JSON.parse(line)); } catch { /* partial write */ }
		}
		return out;
	}
}
