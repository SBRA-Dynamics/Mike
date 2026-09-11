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

		this.recent = [];              // { seq, msg } for replay
		this.sockets = new Set();      // live connections attached to this session
	}

	/** Send to every attached connection, and remember it for replay. */
	emit(message) {
		const seq = ++this.seq;
		const framed = { ...message, seq };

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

	/** Everything after `from`, for a reconnecting client. */
	replay(from) {
		return this.recent.filter((e) => e.seq > from).map((e) => e.msg);
	}

	/** True when the client asked to resume from further back than we kept. */
	replayGap(from) {
		if (!this.recent.length) return from > 0 && from < this.seq;
		return from > 0 && from < this.recent[0].seq - 1;
	}

	attach(ws) { this.sockets.add(ws); }
	detach(ws) { this.sockets.delete(ws); }
	get connectionCount() { return this.sockets.size; }

	meta() {
		return {
			id: this.id, createdAt: this.createdAt, updatedAt: this.updatedAt,
			title: this.title, seq: this.seq, worker: this.worker, mode: this.mode
		};
	}
}

export class SessionStore {
	constructor(dir) {
		this.dir = dir;
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
				if (meta?.id) this.sessions.set(meta.id, new Session(this, meta));
			} catch { /* a corrupt meta file must not stop the server booting */ }
		}
	}

	get(id) { return this.sessions.get(id) ?? null; }

	create(id = randomUUID()) {
		const s = new Session(this, { id, createdAt: Date.now() });
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
