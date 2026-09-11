// A prompt that lives in a file and is re-read when it changes.
//
// Both Jarvis (PRD 3) and the workers load their prompts through this, for the
// same reason: a prompt is a product surface, and editing one must change
// behaviour on the next turn without a restart and without a rebuild.
//
// Passed to Claude Code with `--system-prompt-snapshot off`. Without that flag
// the CLI replays the prompt recorded at the session's first ever turn, and
// every edit here is inert until somebody deletes the session.

import { readFileSync, statSync } from "node:fs";

/** Authoring notes belong in the file, not in the model's context. Everything
 *  in an HTML comment is for whoever edits it. */
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s+/, "");

export class PromptFile {
	constructor(file, log, label = "prompt") {
		this.file = file; this.log = log; this.label = label;
		this.mtime = -1; this.text = "";
	}

	read() {
		try {
			const m = statSync(this.file).mtimeMs;
			if (m !== this.mtime) {
				this.text = stripComments(readFileSync(this.file, "utf8"));
				this.mtime = m;
				this.log?.info(`${this.label}: loaded from ${this.file} (${this.text.length} chars)`);
			}
		} catch (e) {
			// An unreadable prompt is a product outage, not a crash: the session
			// answers as a plain Claude Code session until the file comes back.
			if (this.mtime !== -2) this.log?.error(`${this.label}: cannot read ${this.file}: ${e.message}`);
			this.mtime = -2;
			this.text = "";
		}
		return this.text;
	}
}

/**
 * Fill a template's {{placeholders}}.
 *
 * An absent value empties the slot rather than leaving `{{systemPrompt}}` in the
 * text, and the blank line it leaves behind is collapsed — a worker reading its
 * own prompt should not be able to tell that a slot went unused.
 */
export const fillTemplate = (template, values) =>
	String(template ?? "")
		.replace(/\{\{(\w+)\}\}/g, (_, k) => (values?.[k] == null ? "" : String(values[k])))
		.replace(/\n{3,}/g, "\n\n")
		.trim();
