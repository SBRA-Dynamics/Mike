// The audio message, decoded and bounded — PRD 5a R5a.6.
//
// Split out of the handler because it is the part with an attacker in it: the
// bytes arrive base64-encoded from a socket, and "an unbounded audio message is
// a way to fill a disk" is the PRD's own phrasing. Everything here is pure, so
// the limits can be tested one message at a time without a server.
//
// The handler does the orchestration (transcribe, `heard`, route). This file
// only answers one question: are these bytes a segment we are willing to look
// at, and how long is it?

import { AUDIO_BYTES_PER_SAMPLE, AUDIO_SAMPLE_RATE } from "./protocol.js";

/** What the server accepts per segment, in decoded bytes. 1 MB is ~31 seconds
 *  of 16 kHz s16le mono — twice the client's own 15-second maximum, so a legal
 *  segment is never refused and a client with a broken segmenter is. */
export const DEFAULT_MAX_AUDIO_BYTES = 1_000_000;

/** Below this there is no utterance in there, whatever the energy detector
 *  thought. Dropped without a word to the user: R5a.5 says silence mistaken for
 *  speech should cost them nothing at all, and an error message is a cost. */
export const MIN_SEGMENT_MS = 120;

/** Base64 as the spec writes it, plus its padding. `Buffer.from(s, "base64")`
 *  silently skips anything else, so without this check a client could send a
 *  sentence of JSON and get back a plausible-looking buffer of noise. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded byte count of a base64 string, without decoding it. Used to refuse
 *  an oversized segment BEFORE allocating a buffer for it. */
export const base64Bytes = (s) => {
	if (!s) return 0;
	const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
	return Math.floor((s.length / 4) * 3) - padding;
};

/**
 * Turn one validated `audio` message into PCM, or say why not.
 *
 * Returns one of:
 *   { ok: true, pcm, bytes, samples, durationMs }
 *   { ok: false, error }              — tell the user; something is wrong
 *   { ok: false, error, ignore: true } — say nothing; there was nothing there
 */
export function decodeSegment(m, { maxBytes = DEFAULT_MAX_AUDIO_BYTES, sampleRate = AUDIO_SAMPLE_RATE } = {}) {
	const b64 = typeof m?.pcm === "string" ? m.pcm : "";
	if (!b64) return { ok: false, error: "empty audio segment", ignore: true };
	if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return { ok: false, error: "audio pcm is not base64" };

	const bytes = base64Bytes(b64);
	if (bytes > maxBytes) return { ok: false, error: `audio segment is ${Math.round(bytes / 1024)} kB, limit is ${Math.round(maxBytes / 1024)} kB` };

	const pcm = Buffer.from(b64, "base64");
	// A stream of 16-bit samples has an even length. An odd one means the client
	// cut a sample in half, and transcribing it would shift every sample after
	// the cut by one byte — noise that sounds like speech to no one.
	if (pcm.length % AUDIO_BYTES_PER_SAMPLE !== 0) return { ok: false, error: "audio pcm is not whole 16-bit samples" };

	const samples = pcm.length / AUDIO_BYTES_PER_SAMPLE;
	const durationMs = Math.round((samples / sampleRate) * 1000);
	if (durationMs < MIN_SEGMENT_MS) return { ok: false, error: `segment is only ${durationMs} ms`, ignore: true };

	return { ok: true, pcm, bytes: pcm.length, samples, durationMs };
}
