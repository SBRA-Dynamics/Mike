// The wire protocol. One file, imported by both server and client, so the two
// can never drift — PRD 1 R1.6.
//
// Versioned from the first message: a client built against an older protocol is
// told so on connect rather than failing in some confusing way ten messages in.

export const PROTOCOL_VERSION = 1;

/** Client -> server */
export const C2S = {
	HELLO: "hello",         // { protocol, token, sessionId?, resumeFrom? }
	SAY: "say",             // { text, origin? }
	AUDIO: "audio",         // { pcm, final, sampleRate?, durationMs? }  (PRD 5a)
	INTERRUPT: "interrupt", // {}
	CONTROL: "control"      // { action, args }
};

/** Control actions the transport itself owns (PRD 1 R1.5). */
export const CONTROL = {
	LIST_SESSIONS: "listSessions",
	DELETE_SESSION: "deleteSession",
	HISTORY: "history",
	SET_TITLE: "setTitle",
	// PRD 2: hand this connection a short-lived credential for the MCP tool
	// surface, so a Claude Code invocation bound to this session can act on it.
	MCP_GRANT: "mcpGrant",

	// PRD 3. These are conversation-level, so the transport passes them through
	// to the handler rather than answering them itself — but they live here
	// because R1.6 says one shared schema file, and the client imports this one.
	SET_MODE: "setMode",            // { mode: "ignore" | "byname" | "always" | "pushtotalk" }
	SWITCH_WORKER: "switchWorker",  // { name } or { name: null } to go back to Jarvis
	WHO_IS: "whoIs"                 // { name? } -> the worker's Claude Code session id
};

/** Server -> client */
export const S2C = {
	READY: "ready",   // { sessionId, cursor, protocol, worker, workers, mode }
	TEXT: "text",     // { text, from }
	STATE: "state",   // { busy, worker, mode }
	HEARD: "heard",   // { text, confidence }             (PRD 5a)
	EVENT: "event",   // { kind, data }
	ERROR: "error"    // { message, fatal }
};

/** Close codes, so a client can tell "you are not allowed" from "try again". */
export const CLOSE = {
	UNAUTHORIZED: 4001,
	BAD_PROTOCOL: 4002,
	BAD_MESSAGE: 4003,
	SERVER_SHUTDOWN: 4004
};

const isStr = (v) => typeof v === "string";

/** The one audio format on the wire — 16 kHz, signed 16-bit little-endian,
 *  mono. Chosen in R5a.1 so the glasses frames of PRD 5b need no conversion. */
export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_BYTES_PER_SAMPLE = 2;

/** Base64 characters, so it can be checked before decoding: 2 MB of base64 is
 *  ~1.5 MB of PCM, about 47 seconds. Also comfortably inside the WebSocket's
 *  own 4 MB maxPayload, so the two limits cannot disagree. */
export const MAX_AUDIO_BASE64 = 2_000_000;

// A sessionId becomes a filename. "type is string" is not validation: a client
// sending "../../../x" made the server write outside its data directory, which
// was only survivable because the process does not run as root. Ids are
// server-generated UUIDs, so a client may only ever echo one back.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isSessionId = (v) => typeof v === "string" && UUID_RE.test(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validate one decoded client message.
 * Returns { ok: true, msg } or { ok: false, error } — never throws, because the
 * input is whatever arrived on a socket from the internet.
 */
export function validateC2S(raw) {
	if (!isObj(raw)) return { ok: false, error: "message must be an object" };
	const { type } = raw;
	if (!isStr(type)) return { ok: false, error: "missing type" };

	switch (type) {
		case C2S.HELLO:
			if (!Number.isInteger(raw.protocol)) return { ok: false, error: "hello needs a protocol number" };
			if (!isStr(raw.token) || !raw.token) return { ok: false, error: "hello needs a token" };
			if (raw.sessionId !== undefined && !isSessionId(raw.sessionId)) return { ok: false, error: "sessionId must be a UUID issued by the server" };
			if (raw.resumeFrom !== undefined && !Number.isInteger(raw.resumeFrom)) return { ok: false, error: "resumeFrom must be an integer" };
			return { ok: true, msg: raw };

		case C2S.SAY:
			if (!isStr(raw.text)) return { ok: false, error: "say needs text" };
			if (raw.text.length > 100_000) return { ok: false, error: "text too long" };
			// Where the words came from decides whether the addressing mode gates
			// them (PRD 5a R5a.4). Absent means spoken, which is the gated case: a
			// client that forgets to declare itself is filtered rather than
			// having its user's kitchen conversation forwarded to a model.
			if (raw.origin !== undefined && raw.origin !== "typed" && raw.origin !== "voice") {
				return { ok: false, error: "origin must be typed or voice" };
			}
			return { ok: true, msg: raw };

		case C2S.AUDIO:
			if (!isStr(raw.pcm)) return { ok: false, error: "audio needs base64 pcm" };
			// R5a.6: a segment is bounded on the server as well as in the client,
			// because an unbounded audio message is a way to fill a disk. This is
			// the outer wall — a length check on the string, before anything
			// allocates a buffer from it — and the handler applies the (smaller)
			// configured limit to the decoded bytes. The client's own maximum
			// segment is 15 s; this allows three times that, so a legitimate
			// segment is never refused here and an abusive one never gets far.
			if (raw.pcm.length > MAX_AUDIO_BASE64) return { ok: false, error: "audio segment too long" };
			// The pipeline is 16 kHz s16le mono from both sources (R5a.1, R5b.1).
			// A client that resampled to something else is a bug worth naming
			// rather than a stream to transcribe at the wrong speed.
			if (raw.sampleRate !== undefined && raw.sampleRate !== AUDIO_SAMPLE_RATE) {
				return { ok: false, error: `audio must be ${AUDIO_SAMPLE_RATE} Hz` };
			}
			if (raw.final !== undefined && typeof raw.final !== "boolean") return { ok: false, error: "final must be a boolean" };
			return { ok: true, msg: raw };

		case C2S.INTERRUPT:
			return { ok: true, msg: raw };

		case C2S.CONTROL:
			if (!isStr(raw.action)) return { ok: false, error: "control needs an action" };
			if (raw.args !== undefined && !isObj(raw.args)) return { ok: false, error: "args must be an object" };
			return { ok: true, msg: raw };

		default:
			return { ok: false, error: `unknown type "${type}"` };
	}
}

/** Server-side message constructors, so shapes live in exactly one place. */
export const msg = {
	// `cursor`, not `seq`: every other message carries `seq` meaning "this
	// message's own id", and ready carries "the session's current id". Reusing
	// the name made a test count ready as a replayed message, and a real client
	// would make the same mistake.
	ready: (sessionId, cursor, extra = {}) => ({ type: S2C.READY, sessionId, cursor, protocol: PROTOCOL_VERSION, ...extra }),
	// `extra` carries the background-reply fields: a reply from a worker the user
	// is not talking to is a notice, not the conversation (see handler.js).
	text: (text, from = "system", extra = {}) => ({ type: S2C.TEXT, text, from, ...extra }),
	state: (state) => ({ type: S2C.STATE, ...state }),
	heard: (text, confidence = null) => ({ type: S2C.HEARD, text, confidence }),
	event: (kind, data = {}) => ({ type: S2C.EVENT, kind, data }),
	error: (message, fatal = false) => ({ type: S2C.ERROR, message, fatal })
};
