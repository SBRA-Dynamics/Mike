// Model selection — PRD 2 "Model selection".
//
// The user says a word and means a model. The mapping is a table rather than a
// fuzzy match on purpose: an unknown model must be an error with the valid
// list, never a silent fall back to the default. Being handed a different model
// than you asked for is worse than being told no, and on a lens you would not
// notice the substitution until the bill or the answer told you.
//
// `id` is what goes to `claude --model`. The CLI takes both its short aliases
// and a model's full name; full names are used here because an alias silently
// follows whatever Anthropic promotes to "latest", and a worker's model should
// not change under it between one restart and the next.

/** The models a worker may run. `label` is what we say back to the user. */
export const MODELS = [
	{ label: "opus", id: "claude-opus-5", aliases: ["opus", "opus 5", "opus five", "claude opus 5", "claude opus"] },
	{ label: "sonnet", id: "claude-sonnet-5", aliases: ["sonnet", "sonnet 5", "sonnet five", "claude sonnet 5", "claude sonnet"] },
	{ label: "haiku", id: "claude-haiku-4-5", aliases: ["haiku", "haiku 4 5", "haiku 4.5", "claude haiku"] },
	{ label: "fable", id: "claude-fable-5-1", aliases: ["fable", "fable 5", "fable 5 1", "fable 5.1", "claude fable"] }
];

/** Spoken-name folding, same shape as names.js but local: a model name is not
 *  a worker name and the two must not accidentally share a rule. */
const fold = (v) => String(v ?? "")
	.toLowerCase()
	.replace(/[^a-z0-9.]+/g, " ")
	.replace(/\s+/g, " ")
	.trim()
	// Dictation appends a full stop to everything: "opus 5." must resolve, while
	// the dot inside "haiku 4.5" has to survive.
	.replace(/^\.+|\.+$/g, "")
	.trim();

const INDEX = new Map();
for (const m of MODELS) {
	INDEX.set(fold(m.id), m);
	INDEX.set(fold(m.label), m);
	for (const a of m.aliases) INDEX.set(fold(a), m);
}

/** The list a refusal quotes back, e.g. "opus, sonnet, haiku or fable". */
export const MODEL_LIST = MODELS.map((m) => m.label).join(", ").replace(/, (?=[^,]*$)/, " or ");

/**
 * Resolve what the user said to a model.
 * Returns { ok: true, label, id } or { ok: false, error }.
 */
export function resolveModel(spoken) {
	const hit = INDEX.get(fold(spoken));
	if (hit) return { ok: true, label: hit.label, id: hit.id };
	const said = String(spoken ?? "").trim().slice(0, 24) || "(nothing)";
	return { ok: false, error: `no model called "${said}" — use ${MODEL_LIST}` };
}

/** True for a label/id we would accept. Used to validate configured defaults at
 *  startup rather than at the first spawn, when the user is waiting. */
export const isKnownModel = (v) => INDEX.has(fold(v));
