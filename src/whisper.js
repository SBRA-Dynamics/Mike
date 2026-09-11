// Transcription — PRD 5a R5a.5.
//
// The model runs in a Python process next to this one (services/whisper/serve.py)
// and is reached over loopback HTTP. Not in-process, and not a child this file
// spawns, for three reasons: whisper is a GPU process that takes seconds to load
// and must stay warm across server restarts, Node has no business holding a
// CUDA context, and a transcription that wedges must be survivable by killing
// one process rather than the conversation.
//
// The contract is deliberately tiny — raw PCM in, one JSON object out — because
// both ends of it are ours and a protocol is a thing to keep in sync:
//
//   POST /transcribe        body: 16 kHz s16le mono PCM, Content-Type
//                                 application/octet-stream
//                           -> { text, language, languageProbability,
//                                confidence, ms, dropped }
//   GET  /healthz           -> { ok, model, device, warm }
//
// Honest degradation is the whole design rule here. A server whose whisper is
// not running must still start, still answer typed input, and say plainly that
// it cannot hear — see `ServiceDown` below, which the handler turns into one
// sentence on the lens instead of a stack trace.

/** A failure the user can act on: the service is not up. Separated from every
 *  other error because the answer differs — "start the whisper service" rather
 *  than "the model said something odd". */
export class TranscriptionUnavailable extends Error {
	constructor(message) {
		super(message);
		this.name = "TranscriptionUnavailable";
		this.unavailable = true;
	}
}

/** How long one transcription may take before we stop waiting. R5a.7 budgets
 *  800 ms; this is the point at which something is wrong rather than slow, and
 *  a 45-second segment on a cold model is still inside it. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * A client for the loopback whisper service.
 *
 * `url` is the service's base URL. It is passed in rather than discovered:
 * the service binds a port the operator chose (or port 0 and prints it), and a
 * server that guessed would be right until the day it was not.
 */
export function createWhisperClient({ url, log, timeoutMs = DEFAULT_TIMEOUT_MS, sampleRate = 16_000 }) {
	const base = String(url).replace(/\/+$/, "");

	/** One request, with every network failure turned into something a user can
	 *  read. `fetch` rejects with "fetch failed" for a refused connection, a DNS
	 *  failure and a reset alike, so the cause is read off `err.cause`. */
	const post = async (path, body, contentType) => {
		let res;
		try {
			res = await fetch(`${base}${path}`, {
				method: "POST",
				headers: { "Content-Type": contentType, "Content-Length": String(body.length) },
				body,
				signal: AbortSignal.timeout(timeoutMs)
			});
		} catch (e) {
			if (e?.name === "TimeoutError" || e?.name === "AbortError") {
				throw new TranscriptionUnavailable(`transcription timed out after ${timeoutMs} ms`);
			}
			const code = e?.cause?.code ?? e?.code ?? "";
			throw new TranscriptionUnavailable(
				code === "ECONNREFUSED" ? "the transcription service is not running" : `transcription service unreachable (${code || e?.message || "unknown"})`
			);
		}
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
			// A 4xx is our bug (a malformed body); a 5xx is the model's. Both are
			// reported as themselves rather than as "unavailable", because
			// "restart the service" would be the wrong advice for either.
			throw new Error(`transcription failed (${res.status})${detail ? ": " + detail : ""}`);
		}
		return await res.json();
	};

	return {
		name: "whisper",
		url: base,
		sampleRate,

		/** Is it up? Used at startup for one honest log line, and by the tests.
		 *  Never throws: "no" is an answer. */
		async health() {
			try {
				const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) });
				if (!res.ok) return { ok: false, error: `healthz ${res.status}` };
				return { ok: true, ...(await res.json()) };
			} catch (e) {
				return { ok: false, error: e?.cause?.code ?? e?.message ?? "unreachable" };
			}
		},

		/**
		 * One segment of 16 kHz s16le mono PCM in, one utterance out.
		 *
		 * Returns `{ text, confidence, language, ms }` where `text` may be the
		 * empty string — R5a.5: a segment that transcribes to nothing produces
		 * nothing, and that decision belongs to the caller, not to an exception.
		 */
		async transcribe(pcm) {
			const started = Date.now();
			const r = await post("/transcribe", pcm, "application/octet-stream");
			const ms = Date.now() - started;
			const text = typeof r?.text === "string" ? r.text.trim() : "";
			if (r?.dropped) log?.info(`whisper dropped a segment as non-speech (${r.dropped})`);
			return {
				text,
				confidence: typeof r?.confidence === "number" ? r.confidence : null,
				language: typeof r?.language === "string" ? r.language : null,
				// The service's own measurement is the model's time; ours includes
				// the round trip. Both are logged, because a gap between them is
				// the only way to see the transport costing anything.
				modelMs: typeof r?.ms === "number" ? r.ms : null,
				ms
			};
		}
	};
}

/** What the server uses when no service is configured (`--whisper off`).
 *
 *  It exists so the audio path has exactly one shape: every caller awaits a
 *  transcriber and handles TranscriptionUnavailable. A null object here means
 *  there is no second code path that only runs on the machine without a GPU. */
export function createNullTranscriber({ reason = "transcription is turned off (--whisper)" } = {}) {
	return {
		name: "none",
		url: null,
		sampleRate: 16_000,
		async health() { return { ok: false, error: reason }; },
		async transcribe() { throw new TranscriptionUnavailable(reason); }
	};
}
