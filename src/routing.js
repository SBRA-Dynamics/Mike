// Routing — PRD 3 "Routing", gated by the addressing mode from PRD 5 R5.4.
//
// Every utterance is classified here before anything else sees it, and the
// classification is a rule rather than a model call. A classifier in this path
// would add latency to every single turn and be wrong occasionally, which is
// worse than a rule that is wrong never and that the user controls by how they
// speak.
//
// Two layers, in this order, and the order is the point:
//
//   1. The mode commands. Matched in EVERY mode, including Ignore, before the
//      gate. R5.4 calls this a safety property, not a convenience: there must be
//      no state the user can reach from which they cannot speak their way out.
//   2. The mode gate, then the destination.
//
// | mode   | what is admitted                                          |
// |--------|-----------------------------------------------------------|
// | ignore | nothing but the mode commands                              |
// | byname | utterances starting with "Jarvis" or the active worker's name |
// | always | everything                                                 |
//
// and an admitted utterance goes to Jarvis if it named him, otherwise to the
// active worker, otherwise to Jarvis (PRD 3's three rules).
//
// Reading note, because the two PRDs can be read against each other here:
// PRD 3's rule 3 says an unaddressed utterance "goes to the active worker
// verbatim", and R5.4's table says ByName admits only named utterances. Both
// are true at once only if rule 3 describes what happens to an utterance that
// got through the gate — which is what is implemented. In ByName an unnamed
// utterance is therefore dropped (and reported, so it is never mysterious); in
// Always rule 3 is the common case. If that gate turns out to be wrong for the
// typed path, `--mode always` changes the default for a fresh session without
// touching this file.

import { normalizeName } from "./names.js";

export const MODES = { IGNORE: "ignore", BYNAME: "byname", ALWAYS: "always" };
export const DEFAULT_MODE = MODES.BYNAME;
export const isMode = (v) => Object.values(MODES).includes(v);

/** How the user hears each mode named back. Short: this is read on a lens. */
export const MODE_LABEL = {
	[MODES.IGNORE]: "paused",
	[MODES.BYNAME]: "by name",
	[MODES.ALWAYS]: "always"
};

/** The name Jarvis answers to. Folded once, here, so the rest of the file can
 *  compare keys and never strings. */
export const JARVIS_NAME = "Jarvis";

// ---------------------------------------------------------------- folding
//
// The same folding names.js uses, but it has to be reversible enough to strip a
// prefix off the ORIGINAL text: the user said "Måns," and the fold says "mans",
// so a naive `slice(key.length)` would cut in the wrong place on every accented
// or punctuated name. So fold with an index for each surviving character, and
// map the match back.

const foldWithIndex = (raw) => {
	const src = String(raw ?? "");
	let folded = "";
	const index = [];         // index[i] = offset in `src` of folded[i]
	let pendingSpace = false;

	for (let i = 0; i < src.length; i++) {
		// NFD per character so one source offset maps to one folded character:
		// normalising the whole string first would shift every later index.
		const ch = src[i].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
		const isWord = /^[a-z0-9]+$/.test(ch);
		if (isWord) {
			if (pendingSpace && folded) { folded += " "; index.push(i); }
			pendingSpace = false;
			for (const c of ch) { folded += c; index.push(i); }
		} else {
			pendingSpace = true;
		}
	}
	return { folded, index, src };
};

/** Where in the original text the folded prefix of length `n` ends. */
const originalOffset = (f, n) => (n >= f.index.length ? f.src.length : f.index[n]);

/** Leading words dictation and politeness add before a name. */
const GREETING = "(?:hey|hi|hej|halla|hallo|ok|okej|okay|yo|so|sa)";

/**
 * If `text` is addressed to `name`, return the text with the address removed.
 * Returns null when it is not addressed to that name.
 *
 * Dictation variants are the whole job: "Jarvis." / "Jarvis," / "jarvis" /
 * "Hey Jarvis" / "Hej Jarvis:" all count, and they count because the check runs
 * on the same folded form the rest of the system matches names with.
 */
export function stripAddress(text, name) {
	const key = normalizeName(name);
	if (!key) return null;
	const f = foldWithIndex(text);
	if (!f.folded) return null;

	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// The name must be followed by a word boundary, or "Jarvis" would swallow
	// the first half of a worker called "Jarvisson".
	const m = f.folded.match(new RegExp(`^(?:${GREETING} )?${escaped}(?= |$)`));
	if (!m) return null;

	const rest = f.src.slice(originalOffset(f, m[0].length));
	// Whatever separated the address from the sentence is punctuation the user
	// spoke as a pause, not content.
	return rest.replace(/^[\s,.:;!?—–-]+/, "").trim();
}

/** True when the utterance names someone, without caring who. */
export const isAddressedTo = (text, name) => stripAddress(text, name) !== null;

// ------------------------------------------------------------ mode commands
//
// Matched on the folded text, so casing, trailing full stops and Swedish
// diacritics are already gone ("ändra" folds to "andra", "fortsätt" to
// "fortsatt"). Anchored end to end: a command is the whole utterance, never a
// phrase inside a sentence, or discussing the feature would trigger it.

const VERB = "(?:change|set|switch|put|andra|satt|byt|stall)";
const MODE_COMMANDS = [
	{ to: MODES.IGNORE, re: new RegExp(`^(?:${VERB} )?(?:pause|paus|pausa|stop|stoppa|mute|tysta) (?:the )?(?:input|inputen|ingangen|lyssnandet)$`) },
	{ to: "previous", re: new RegExp(`^(?:${VERB} )?(?:continue|resume|unpause|fortsatt|fortsatta|aterta|aterupta) (?:the )?(?:input|inputen|ingangen|lyssnandet)$`) },
	{ to: MODES.ALWAYS, re: new RegExp(`^(?:${VERB} )?(?:the )?input (?:to|till) (?:always|alltid|allt)$`) },
	{ to: MODES.BYNAME, re: new RegExp(`^(?:${VERB} )?(?:the )?input (?:to|till) (?:by ?name|byname|via namn|namn)$`) }
];

/**
 * Match a mode command. `text` may or may not be addressed to Jarvis: R5.4
 * writes every command as "Hey Jarvis, ..." but a bare "pausa input" has to
 * work too, because the user who is paused has just learned that nothing they
 * say is getting through and will start dropping words.
 *
 * Returns { to } where `to` is a mode or "previous", or null.
 */
export function matchModeCommand(text) {
	const candidates = [text];
	const bare = stripAddress(text, JARVIS_NAME);
	if (bare !== null) candidates.push(bare);

	for (const c of candidates) {
		const { folded } = foldWithIndex(c);
		if (!folded) continue;
		for (const cmd of MODE_COMMANDS) if (cmd.re.test(folded)) return { to: cmd.to };
	}
	return null;
}

// ------------------------------------------------------------------ routing

/**
 * Classify one utterance.
 *
 * `mode` is the session's addressing mode, `worker` the active worker's name or
 * null. Returns one of:
 *
 *   { kind: "empty" }
 *   { kind: "mode", to }                     — a mode command, always first
 *   { kind: "jarvis", text }                 — address stripped
 *   { kind: "worker", name, text }           — address stripped if there was one
 *   { kind: "dropped", reason: "paused" | "unaddressed" }
 *
 * Nothing here mutates anything: the caller owns the session, and a classifier
 * that changed state would be impossible to test one utterance at a time.
 */
export function route(text, { mode = DEFAULT_MODE, worker = null } = {}) {
	const raw = String(text ?? "").trim();
	if (!raw) return { kind: "empty" };

	// 1. Mode commands, before the gate, in every mode. R5.4.
	const cmd = matchModeCommand(raw);
	if (cmd) return { kind: "mode", to: cmd.to };

	// 2. The gate.
	if (mode === MODES.IGNORE) return { kind: "dropped", reason: "paused" };

	const toJarvis = stripAddress(raw, JARVIS_NAME);
	if (toJarvis !== null) {
		// "Jarvis" on its own is an address with nothing after it. Sending the
		// empty string to a model asks it to invent what was wanted; sending his
		// own name back gets "yes?", which is the right answer to being called.
		return { kind: "jarvis", text: toJarvis || JARVIS_NAME };
	}

	const toWorker = worker ? stripAddress(raw, worker) : null;
	if (toWorker !== null) {
		// The address is stripped from a worker's text too. Workers are not told
		// they are workers (PRD 3), so a worker that is handed "Bosse, list the
		// files" spends its first sentence on not being called Bosse.
		return { kind: "worker", name: worker, text: toWorker || worker };
	}

	if (mode === MODES.BYNAME) return { kind: "dropped", reason: "unaddressed" };

	// 3. Always: unaddressed goes to the active worker verbatim, or to Jarvis
	//    when there is none — which is also what "starting a session means
	//    talking to Jarvis" means (R3.1).
	return worker ? { kind: "worker", name: worker, text: raw } : { kind: "jarvis", text: raw };
}

/** Apply a mode command to a session's mode. Returns { mode, previous }.
 *
 *  "Continue" restores what was in use before the pause rather than a fixed
 *  default: pausing during a work session and resuming into ByName would
 *  silently undo a setting the user chose (R5.4). */
export function applyModeCommand(to, { mode, previousMode }) {
	if (to === "previous") {
		const back = isMode(previousMode) && previousMode !== MODES.IGNORE ? previousMode : DEFAULT_MODE;
		return { mode: back, previousMode: null };
	}
	if (!isMode(to)) return { mode, previousMode };
	// Only a pause remembers where it came from; there is nothing to come back
	// to from a mode the user chose on purpose.
	return { mode: to, previousMode: to === MODES.IGNORE ? (mode === MODES.IGNORE ? previousMode : mode) : null };
}
