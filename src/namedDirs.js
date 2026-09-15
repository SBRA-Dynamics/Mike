// Spoken names for directories — IDEAS.md "Spoken names for directories".
//
// A path is the one thing dictation cannot carry: whisper never produces a
// slash, so "start a worker in MyProject" has to resolve without one. This is a
// small alias table, re-read on mtime like PromptFile, so a new project can be
// added by editing the file, not by restarting the server.
//
// Matching is folded harder than a worker's name (names.js): a directory name
// has no natural word boundary when spoken, so "my project" has to land on
// the same entry as "MyProject" with every space gone, not just collapsed.

import { readFileSync, statSync } from "node:fs";

const fold = (raw) => String(raw ?? "")
	.normalize("NFD")
	.replace(/[̀-ͯ]/g, "")
	.toLowerCase()
	.replace(/[^a-z0-9]/g, "");

export class NamedDirs {
	constructor(file, log) {
		this.file = file;
		this.log = log;
		this.mtime = -1;
		this.map = new Map();   // fold(name) -> { name, path }
	}

	#reload() {
		let m;
		try { m = statSync(this.file).mtimeMs; }
		catch { this.map = new Map(); this.mtime = -1; return; }
		if (m === this.mtime) return;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8"));
			const next = new Map();
			for (const [name, dir] of Object.entries(parsed ?? {})) {
				if (typeof dir !== "string" || !dir.startsWith("/")) continue;
				const key = fold(name);
				if (!key) continue;
				next.set(key, { name, path: dir });
			}
			this.map = next;
			this.mtime = m;
			this.log?.info(`dirs: ${this.map.size} names loaded from ${this.file}`);
		} catch (e) {
			// A corrupt file must not stop workers spawning by absolute path; it
			// just means no name resolves until the file is fixed.
			this.log?.error(`dirs: could not read ${this.file}: ${e.message}`);
			this.map = new Map();
			this.mtime = m;
		}
	}

	/** The path for a spoken name, or undefined. */
	resolve(spoken) {
		this.#reload();
		return this.map.get(fold(spoken))?.path;
	}

	/** The names as written in the file, for a schema description or a refusal. */
	names() {
		this.#reload();
		return [...this.map.values()].map((v) => v.name);
	}
}
