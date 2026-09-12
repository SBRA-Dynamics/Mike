// Routing — PRD 3 "Routing", gated by the addressing mode from PRD 5a R5a.4.
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
//      gate. R5a.4 calls this a safety property, not a convenience: there must be
//      no state the user can reach from which they cannot speak their way out.
//   2. The mode gate, then the destination.
//
// | mode       | what is admitted                                          |
// |------------|-----------------------------------------------------------|
// | ignore     | nothing but the mode commands (spoken input; see ORIGIN)   |
// | byname     | utterances starting with "Mike" or the active worker's name |
// | always     | everything                                                 |
// | pushtotalk | everything — but the microphone is only open while held    |
//
// PushToTalk is the one mode whose behaviour is a microphone decision rather
// than a routing one (R5a.4): the hold IS the address, so what reaches this
// file while the control is held is admitted exactly as Always admits it. The
// difference lives in the client, which keeps the microphone closed the rest of
// the time — and that is the whole reason the mode exists, so nothing here may
// second-guess it. A prefix still overrides during a hold, because stripAddress
// runs before the verbatim fallthrough for every mode.
//
// and an admitted utterance goes to Mike if it named him, otherwise to the
// active worker, otherwise to Mike (PRD 3's three rules).
//
// Reading note, because the two PRDs can be read against each other here:
// PRD 3's rule 3 says an unaddressed utterance "goes to the active worker
// verbatim", and R5a.4's table says ByName admits only named utterances. Both
// are true at once only if rule 3 describes what happens to an utterance that
// got through the gate — which is what is implemented. In ByName an unnamed
// utterance is therefore dropped (and reported, so it is never mysterious); in
// Always rule 3 is the common case. If that gate turns out to be wrong for the
// typed path, `--mode always` changes the default for a fresh session without
// touching this file.

import { normalizeName } from "./names.js";

export const MODES = { IGNORE: "ignore", BYNAME: "byname", ALWAYS: "always", PUSHTOTALK: "pushtotalk" };

/** Where an utterance came from. The addressing mode exists to filter AMBIENT
 *  SPEECH — the wearer talking to someone else in a kitchen — and typing has no
 *  ambient problem: every typed line was aimed at the machine by the act of
 *  typing it. So the gate applies to `voice` and never to `typed`.
 *
 *  Two consequences worth stating plainly:
 *   * Ignore pauses LISTENING, not the keyboard. The lens still reads "paused",
 *     which is the truth about the microphone.
 *   * Addressing still works when typed: "Mike, ..." from a keyboard reaches
 *     Mike and the prefix is stripped, exactly as when spoken. What typing
 *     skips is the REQUIREMENT to address, not the ability to.
 *
 *  `voice` is the default for anything that does not say, so a client that
 *  forgets to declare itself is filtered rather than forwarding a dinner
 *  conversation to a model. */
export const ORIGIN = { TYPED: "typed", VOICE: "voice" };
export const DEFAULT_MODE = MODES.BYNAME;
export const isMode = (v) => Object.values(MODES).includes(v);

/** How the user hears each mode named back. Short: this is read on a lens. */
export const MODE_LABEL = {
	[MODES.IGNORE]: "paused",
	[MODES.BYNAME]: "by name",
	[MODES.ALWAYS]: "always",
	// Two words, because "ptt" on a lens is a thing nobody has ever read
	// correctly the first time.
	[MODES.PUSHTOTALK]: "hold to talk"
};

/** The name Mike answers to. Folded once, here, so the rest of the file can
 *  compare keys and never strings. */
export const MIKE_NAME = "Mike";

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
 * Dictation variants are the whole job: "Mike." / "Mike," / "mike" /
 * "Hey Mike" / "Hej Mike:" all count, and they count because the check runs
 * on the same folded form the rest of the system matches names with.
 */
export function stripAddress(text, name) {
	const key = normalizeName(name);
	if (!key) return null;
	const f = foldWithIndex(text);
	if (!f.folded) return null;

	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// The name must be followed by a word boundary, or "Mike" would swallow
	// the first half of a worker called "Mikeson".
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
// The words for the thing being changed, and the words for what to change it
// to. Written as two lists rather than as a dozen literal sentences, because
// the sentences are the cross product and a user who says "change mode to
// always" instead of "change input to always" is not making a mistake.
const NOUN = "(?:input|inputen|ingangen|lyssnandet|mode|modet|laget|lage|lyssningen)";
const TO = "(?:to|till)";
const GO = `(?:${VERB}|go|ga|byt|vaxla|switch|set|satt|stall)`;

// A trailing particle is allowed, and only these: "always ON", "alltid PÅ" is
// how the mode is actually said out loud. Measured — Robin said "ändra mode
// till always on" and the command fell through to Mike, who explained the
// exact word that did not match. The alternative, allowing any trailing word,
// would throw away the anchoring that keeps "byt till alltid när du felsöker"
// out of the command path, and that anchoring is worth more than reach.
const TARGETS = {
	[MODES.ALWAYS]: "(?:always|alltid|allt)(?: (?:on|pa|igang))?",
	[MODES.BYNAME]: "(?:by ?name|byname|via namn|namn|namnet)",
	// "håll in" folds to "hall in", and a hyphenated "push-to-talk" folds to
	// three words — so the optional spaces cover the written form too.
	[MODES.PUSHTOTALK]: "(?:push ?to ?talk|hall in|halla in|hall inne|tryck och tala|knapp)"
};

/** Every way of saying "make it X" that is still unambiguous.
 *
 *  A bare target is deliberately NOT one of them: "alltid" and "namn" are
 *  ordinary words, and these are matched before the addressing gate, so a false
 *  positive costs the user a sentence they have to say again. Either a verb or
 *  the noun has to be present — someone who says only "always" gets their word
 *  passed through, which is the safe way to be wrong. */
const MODE_COMMANDS = [
	{ to: MODES.IGNORE, re: new RegExp(`^(?:${VERB} )?(?:pause|paus|pausa|stop|stoppa|mute|tysta) (?:the )?${NOUN}$`) },
	{ to: MODES.IGNORE, re: new RegExp(`^(?:stop|sluta|stanna) (?:listening|lyssna|att lyssna)$`) },
	{ to: "previous", re: new RegExp(`^(?:${VERB} )?(?:continue|resume|unpause|fortsatt|fortsatta|aterta|aterupta) (?:the )?${NOUN}$`) },
	{ to: "previous", re: new RegExp(`^(?:start|borja|fortsatt) (?:listening|lyssna|att lyssna)$`) },
	...Object.entries(TARGETS).flatMap(([mode, target]) => [
		// "change the input to always", "byt läge till alltid", "switch to always"
		{ to: mode, re: new RegExp(`^${GO} (?:the )?(?:${NOUN} )?(?:${TO} )?${target}$`) },
		// "always mode", "namnläge" — the target naming the noun directly
		{ to: mode, re: new RegExp(`^${target} ?${NOUN}$`) }
	])
];

/** Turning the microphone on and off by voice.
 *
 * The microphone switch is not the addressing mode — it is whether there is a
 * microphone for a mode to listen with — but the commands need the same
 * guarantee, and for a sharper reason. Saying "turn the mic off" leaves the
 * user in a state where nothing they say can be heard at all, so the way back
 * has to be one they can reach: holding the touchpad and saying it. That works
 * because these, like the mode commands, are matched before the gate in every
 * mode, and because a hold is unconditional (R5a.4).
 *
 * The noun list is deliberately only the microphone's names. A broader word
 * like "ljudet" would catch a sentence meant for a worker — and these are
 * matched before everything, so a false positive here costs a turn the user
 * has to repeat. Predictability over reach, the same trade PRD 3 makes for
 * name-prefix routing. */
const MIC_COMMANDS = [
	{ on: true, re: new RegExp(`^(?:${VERB} |turn |sla |satt |slag )?(?:on|pa) (?:the |min )?(?:mic|mick|micken|micken|mikken|microphone|mikrofon|mikrofonen)$`) },
	{ on: true, re: new RegExp(`^(?:turn |sla |satt |slag )?(?:the |min )?(?:mic|mick|micken|micken|mikken|microphone|mikrofon|mikrofonen) (?:on|pa)$`) },
	{ on: false, re: new RegExp(`^(?:${VERB} |turn |sla |stang )?(?:off|av) (?:the |min )?(?:mic|mick|micken|micken|mikken|microphone|mikrofon|mikrofonen)$`) },
	{ on: false, re: new RegExp(`^(?:turn |sla |stang |stanga )?(?:the |min )?(?:mic|mick|micken|micken|mikken|microphone|mikrofon|mikrofonen) (?:off|av)$`) }
];

/** Switching the lens off and on by voice — "display off", "display on".
 *
 * Off means dark until on is said: not a reply, not the user speaking, not a
 * turn starting lights it, which is what separates this from the idle blanking
 * (the client's LENS_IDLE_MS) that any of those wakes. The nouns are the ways
 * the lens gets named out loud in both languages; "screen" and "skärmen" are
 * in because that is what people say, and "display" is what the command is
 * called. Matched before the gate like the microphone switch, and for the
 * same reason: a user who has turned the lens off must be able to turn it
 * back on from every mode. */
const SCREEN = "(?:display|displayen|screen|skarmen|skarm|lens|linsen|glaset|glasen)";
const DISPLAY_COMMANDS = [
	{ on: true, re: new RegExp(`^(?:${VERB} |turn |sla |satt |slag |tand )?(?:on|pa) (?:the |min )?${SCREEN}$`) },
	{ on: true, re: new RegExp(`^(?:turn |sla |satt |slag |tand )?(?:the |min )?${SCREEN} (?:on|pa)$`) },
	{ on: true, re: new RegExp(`^(?:tand|tand upp|light|light up|wake|wake up) (?:the |min )?${SCREEN}$`) },
	{ on: false, re: new RegExp(`^(?:${VERB} |turn |sla |stang |slack )?(?:off|av) (?:the |min )?${SCREEN}$`) },
	{ on: false, re: new RegExp(`^(?:turn |sla |stang |stanga |slack |slacka )?(?:the |min )?${SCREEN} (?:off|av)$`) },
	{ on: false, re: new RegExp(`^(?:slack|slack ner|slack ned|darken|dim|kill) (?:the |min )?${SCREEN}$`) }
];

/** Same shape as matchMicCommand. Returns { on } or null. */
export function matchDisplayCommand(text) {
	const candidates = [text];
	const bare = stripAddress(text, MIKE_NAME);
	if (bare !== null) candidates.push(bare);

	for (const c of candidates) {
		const { folded } = foldWithIndex(c);
		if (!folded) continue;
		for (const cmd of DISPLAY_COMMANDS) if (cmd.re.test(folded)) return { on: cmd.on };
	}
	return null;
}

/** Stopping a turn that is already running.
 *
 * The same footing as the mode and microphone commands, and for the sharpest
 * version of the same reason: a model that has decided to think for two minutes
 * is a state the user cannot leave by talking, because everything they say goes
 * into the queue behind it. So these are matched before the gate, before the
 * address, in every mode — one word and the process dies.
 *
 * Nothing is queued here. The kill happens on the connection's own turn (the
 * server handles messages as they arrive, it does not serialise them), which is
 * why a word can reach past a turn that is holding the model.
 *
 * Deliberately a short list of whole utterances. These are the words a user
 * says when they are already annoyed, so they have to fire on the first try —
 * but a stop that fired inside a sentence would kill the turn whenever somebody
 * said "sluta" to a worker about its own work. Anchored end to end, like every
 * command here. "avsluta" is included and "avsluta Bosse" is not, which is the
 * anchoring earning its keep. */
const STOP_COMMANDS = [
	// Swedish, spoken: "stopp", "sluta", "avbryt", "avsluta", "lägg av",
	// "glöm det", "strunt i det".
	{ re: /^(?:stopp|stoppa|sluta|slut|avbryt|avbryt det|avbryta|avsluta|lagg av|glom det|strunta i det|strunt i det)$/ },
	// English and the two words that get typed rather than said.
	{ re: /^(?:stop|stop it|halt|cancel|abort|exit|quit|never mind|nevermind|forget it|null)$/ },
	// "Null program" — what Man tells Mike in The Moon Is a Harsh Mistress
	// when the current job is to be forgotten and nothing done until he says
	// otherwise. The same kill as the words above, plus everything waiting
	// behind the turn that dies, and answered in Mike's own words. Dictation
	// hears it as one word or two, and a Swede says "noll".
	{ re: /^(?:null|noll) ?program(?:me|met)?$/, nullProgram: true }
];

/** Match a stop command. Returns { nullProgram } or null.
 *
 *  Addressed forms count too ("Mike, stopp"), for the same reason the other
 *  commands accept them: the user who is interrupting has no idea whether the
 *  thing that will not shut up is Mike or the worker, and should not have to. */
export function matchStopCommand(text) {
	const candidates = [text];
	const bare = stripAddress(text, MIKE_NAME);
	if (bare !== null) candidates.push(bare);

	for (const c of candidates) {
		const { folded } = foldWithIndex(c);
		if (!folded) continue;
		for (const cmd of STOP_COMMANDS) if (cmd.re.test(folded)) return { nullProgram: !!cmd.nullProgram };
	}
	return null;
}

/** Same shape as matchModeCommand, and matched at the same point. Returns
 *  { on } or null. */
export function matchMicCommand(text) {
	const candidates = [text];
	const bare = stripAddress(text, MIKE_NAME);
	if (bare !== null) candidates.push(bare);

	for (const c of candidates) {
		const { folded } = foldWithIndex(c);
		if (!folded) continue;
		for (const cmd of MIC_COMMANDS) if (cmd.re.test(folded)) return { on: cmd.on };
	}
	return null;
}

/**
 * Match a mode command. `text` may or may not be addressed to Mike: R5a.4
 * writes every command as "Hey Mike, ..." but a bare "pausa input" has to
 * work too, because the user who is paused has just learned that nothing they
 * say is getting through and will start dropping words.
 *
 * Returns { to } where `to` is a mode or "previous", or null.
 */
export function matchModeCommand(text) {
	const candidates = [text];
	const bare = stripAddress(text, MIKE_NAME);
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
 *   { kind: "mic", on }                      — the microphone switch, likewise
 *   { kind: "display", on }                  — the lens switch, likewise
 *   { kind: "stop", nullProgram }            — kill whatever turn is running;
 *                                               nullProgram when said that way
 *   { kind: "mike", text, bare? }          — address stripped; bare when
 *                                               there was nothing after it
 *   { kind: "worker", name, text, addressed } — address stripped if there
 *                                               was one, and addressed says so
 *   { kind: "dropped", reason: "paused" | "unaddressed" }
 *
 * Nothing here mutates anything: the caller owns the session, and a classifier
 * that changed state would be impossible to test one utterance at a time.
 */
export function route(text, { mode = DEFAULT_MODE, worker = null, origin = ORIGIN.VOICE } = {}) {
	const raw = String(text ?? "").trim();
	if (!raw) return { kind: "empty" };

	// 1. Mode commands, before the gate, in every mode. R5a.4.
	const cmd = matchModeCommand(raw);
	if (cmd) return { kind: "mode", to: cmd.to };

	// The microphone switch, on the same footing and for the same reason: the
	// state it can put the user in is one they must be able to speak out of.
	const mic = matchMicCommand(raw);
	if (mic) return { kind: "mic", on: mic.on };

	// The lens switch, on the same footing: "display off" is a state the
	// user must be able to say their way out of.
	const display = matchDisplayCommand(raw);
	if (display) return { kind: "display", on: display.on };

	// Stop, likewise before the gate. The worker's own name is accepted as an
	// address here and nowhere else in this block: "Bosse, stopp" is the most
	// natural way to say it while Bosse is the one thinking.
	const toStopped = worker ? stripAddress(raw, worker) : null;
	const stop = matchStopCommand(raw) ?? (toStopped !== null ? matchStopCommand(toStopped) : null);
	if (stop) return { kind: "stop", nullProgram: stop.nullProgram };

	// 2. The gate — for speech only. See ORIGIN above for why typing skips it.
	const gated = origin !== ORIGIN.TYPED;
	if (gated && mode === MODES.IGNORE) return { kind: "dropped", reason: "paused" };

	const toMike = stripAddress(raw, MIKE_NAME);
	if (toMike !== null) {
		// "Mike" on its own is an address with nothing after it — a call. It is
		// marked as such (`bare`) so the handler can answer it at once instead
		// of spending a model turn on "yes?", and the name goes as the text so
		// that a caller which does not know about calls still gets an answer.
		return toMike ? { kind: "mike", text: toMike } : { kind: "mike", text: MIKE_NAME, bare: true };
	}

	const toWorker = worker ? stripAddress(raw, worker) : null;
	if (toWorker !== null) {
		// The address is stripped from a worker's text too. Workers are not told
		// they are workers (PRD 3), so a worker that is handed "Bosse, list the
		// files" spends its first sentence on not being called Bosse.
		return { kind: "worker", name: worker, text: toWorker || worker, addressed: true };
	}

	if (gated && mode === MODES.BYNAME) return { kind: "dropped", reason: "unaddressed" };

	// 3. Always: unaddressed goes to the active worker verbatim, or to Mike
	//    when there is none — which is also what "starting a session means
	//    talking to Mike" means (R3.1). `addressed: false` is what lets a call
	//    to Mike a moment earlier claim the sentence instead.
	return worker ? { kind: "worker", name: worker, text: raw, addressed: false } : { kind: "mike", text: raw };
}

/** Apply a mode command to a session's mode. Returns { mode, previous }.
 *
 *  "Continue" restores what was in use before the pause rather than a fixed
 *  default: pausing during a work session and resuming into ByName would
 *  silently undo a setting the user chose (R5a.4). */
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
