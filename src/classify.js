// Is a worker asking, or just talking?
//
// When a worker answers while the user is with somebody else, the reply must
// not take over the lens — it becomes a notice in the header instead. A notice
// that says "Bosse is asking" has to stay until it is dealt with; one that says
// "Bosse said something" can fade. So the difference has to be decided, and the
// only thing that can decide it is something that reads the sentence: a worker
// writing "I can do A or B, tell me which" is asking, with no question mark
// anywhere, and that is the exact case a heuristic gets wrong.
//
// Deliberately NOT Jarvis. PRD 3 keeps worker turns out of his session on
// purpose — he is fed context when addressed, not fed every turn as it happens.
// Routing every background reply through him would undo that, fill his context
// with work he is not doing, and cost an opus turn for a one-word judgement.
// A separate cheap call is both cheaper and architecturally quieter.

/** One word, and the CLI is started fresh for it, so keep the model small and
 *  the effort low. Measured at ~6 s, nearly all of it process start. */
const MODEL = "haiku";
const EFFORT = "low";
const TIMEOUT_MS = 30_000;

const PROMPT = (text) =>
	`Answer with exactly one word, QUESTION or STATEMENT.

QUESTION if the message asks the reader something, or waits for a decision or
information before it can continue. STATEMENT otherwise — including when it
reports what was done, or offers something without needing an answer.

The message may be in any language.

Message:
${String(text).slice(0, 4000)}`;

export function createClassifier({ cli, log, model = MODEL, effort = EFFORT, timeoutMs = TIMEOUT_MS } = {}) {
	return {
		/**
		 * "question" or "said". Never throws and never rejects: a notice that
		 * guessed wrong is a small annoyance, while a background classification
		 * that can break a turn is a real one. Anything unexpected is "said",
		 * the fading kind, so a failure cannot pin a stale notice to the lens.
		 */
		async classify(text) {
			if (!String(text ?? "").trim()) return "said";
			try {
				const r = await cli.run({ prompt: PROMPT(text), model, effort, timeoutMs });
				if (!r?.ok) { log?.warn(`classify: ${r?.kind ?? "failed"}`); return "said"; }
				return /\bQUESTION\b/i.test(String(r.text ?? "")) ? "question" : "said";
			} catch (e) {
				log?.warn(`classify threw: ${e.message}`);
				return "said";
			}
		}
	};
}
