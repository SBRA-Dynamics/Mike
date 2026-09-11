// The WebSocket the whole client hangs off — PRD 4 R4.5.
//
// Environment-free on purpose: no DOM, no SDK, no `location`, no `console`. It
// takes a URL and a token and calls back. That is what lets the Node suite
// drive the SHIPPED client code against a real server instead of a copy of it,
// and it is why the lens and the companion cannot end up on different sockets.
//
// The one rule that matters here is the resume cursor. The server replays
// everything after `resumeFrom` (PRD 1 R1.3), and a client that also keeps its
// own high-water mark can never apply a message twice — not on a normal
// reconnect, and not when a half-open socket delivers its backlog after the
// replacement socket has already caught up. Acceptance criterion 4 is that
// property, and it is cheap to hold: one comparison per message.

import { C2S, CONTROL, CLOSE, PROTOCOL_VERSION } from "./protocol.ts";
import type { Origin, ReadyMsg, SeqMsg, ServerMsg } from "./protocol.ts";

export type ConnectionStatus = "idle" | "connecting" | "online" | "offline" | "fatal";

export type ConnectionHandlers = {
	/** One server message, in order, never twice. */
	onMessage?: (m: SeqMsg) => void;
	onReady?: (r: ReadyMsg) => void;
	/** A whole transcript, in answer to the history control. Replaces, not appends. */
	onHistory?: (messages: SeqMsg[]) => void;
	onStatus?: (status: ConnectionStatus, detail: string) => void;
};

export type ConnectionOptions = {
	url: string;
	token: string;
	sessionId?: string | null;
	handlers?: ConnectionHandlers;
	/** Backoff ladder in ms. Overridden by the tests so a suite does not spend
	 *  its life asleep; the last entry is the ceiling. */
	backoff?: number[];
	/** How long a socket may take to open, and then to answer hello. A mobile
	 *  network can leave a connect hanging indefinitely, which without this
	 *  looks exactly like "connecting…" forever. */
	openTimeoutMs?: number;
	socketFactory?: (url: string) => WebSocket;
};

const DEFAULT_BACKOFF = [500, 1000, 2000, 4000, 8000, 15_000];

/** Close codes we must not retry through: retrying a wrong token or a protocol
 *  mismatch is an infinite loop that also hides the real problem from the user. */
const FATAL_CLOSE: Record<number, string> = {
	[CLOSE.UNAUTHORIZED]: "token refused",
	[CLOSE.BAD_PROTOCOL]: "protocol mismatch — reload the client"
};

/** Same origin, same host, same port — R4.1's "no configuration". http becomes
 *  ws and https becomes wss, so a TLS page never opens a cleartext socket. */
export const wsUrlFrom = (href: string): string => {
	const u = new URL(href);
	u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
	u.pathname = "/ws";
	u.search = "";
	u.hash = "";
	return u.toString();
};

export class Connection {
	readonly opts: ConnectionOptions;
	handlers: ConnectionHandlers;
	status: ConnectionStatus = "idle";
	detail = "";
	sessionId: string | null;
	/** Highest sequence number applied. The client's half of the resume contract. */
	cursor = 0;
	/** Diagnostics the suite asserts on, and the settings panel shows. */
	stats = { connects: 0, drops: 0, duplicates: 0, replayed: 0, gaps: 0 };

	#ws: WebSocket | null = null;
	#attempt = 0;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#openTimer: ReturnType<typeof setTimeout> | null = null;
	#stopped = true;
	#backoff: number[];

	constructor(opts: ConnectionOptions) {
		this.opts = opts;
		this.handlers = opts.handlers ?? {};
		this.sessionId = opts.sessionId ?? null;
		this.#backoff = opts.backoff?.length ? opts.backoff : DEFAULT_BACKOFF;
	}

	// ------------------------------------------------------------- lifecycle

	start(): void {
		this.#stopped = false;
		this.#open();
	}

	/** Deliberate shutdown: no reconnect, and the socket is closed cleanly so
	 *  the server logs a close rather than a ping timeout. */
	stop(reason = "client stopped"): void {
		this.#stopped = true;
		this.#clearTimers();
		const ws = this.#ws;
		this.#ws = null;
		try { ws?.close(1000, reason); } catch { /* already gone */ }
		this.#setStatus("idle", reason);
	}

	/** "Try again now." The phone coming back to the foreground, the OS saying
	 *  the network is back — both mean the backoff ladder is measuring a
	 *  condition that no longer holds, and waiting out eight seconds after the
	 *  user has looked at the screen is the stale-screen bug R4.5 names. */
	poke(reason = "resumed"): void {
		if (this.#stopped || this.status === "fatal") return;
		if (this.status === "online" && this.#ws?.readyState === 1) return;
		this.#clearTimers();
		this.#attempt = 0;
		this.#setStatus("connecting", reason);
		this.#open();
	}

	get online(): boolean { return this.status === "online" && this.#ws?.readyState === 1; }

	// ---------------------------------------------------------------- sending

	/** Returns false when there is no socket to send on. Deliberately not
	 *  queued: an utterance that leaves the phone four minutes after it was
	 *  typed arrives in a conversation that has moved on, and the user cannot
	 *  tell that is what happened. The caller keeps the text and says so. */
	send(obj: Record<string, unknown>): boolean {
		if (!this.online) return false;
		try { this.#ws!.send(JSON.stringify(obj)); return true; }
		catch { return false; }
	}

	/** PRD 3: `origin` decides whether the addressing mode gates the words.
	 *  Typing defaults to "typed" — a keyboard has no ambient-speech problem,
	 *  and a client that forgets to say so is filtered in ByName mode. */
	say(text: string, origin: Origin = "typed"): boolean {
		return this.send({ type: C2S.SAY, text, origin });
	}

	/** One segment of speech — PRD 5a R5a.6. One message per segment, never a
	 *  stream: whisper is markedly better given a whole utterance (R5a.3), and a
	 *  segment that cannot be sent is dropped rather than queued, exactly like a
	 *  typed line. */
	audio(pcm: string, info: { durationMs?: number } = {}): boolean {
		return this.send({ type: C2S.AUDIO, pcm, final: true, sampleRate: 16_000, ...info });
	}

	interrupt(): boolean { return this.send({ type: C2S.INTERRUPT }); }

	control(action: string, args?: Record<string, unknown>): boolean {
		return this.send({ type: C2S.CONTROL, action, ...(args ? { args } : {}) });
	}

	/** Ask for the transcript. A fresh page load has no messages and asks for
	 *  them explicitly; a reconnect does not, because the replay covers it. */
	requestHistory(limit = 200): boolean {
		return this.control(CONTROL.HISTORY, { limit });
	}

	// ----------------------------------------------------------------- socket

	#open(): void {
		this.#clearTimers();
		if (this.#stopped) return;

		// A poke() while a connect is already in flight would otherwise leave the
		// old socket open with nobody reading it: every handler below is guarded
		// on `this.#ws !== ws`, which makes it silent, not closed.
		if (this.#ws) { const old = this.#ws; this.#ws = null; try { old.close(); } catch { /* already gone */ } }

		this.#setStatus("connecting", this.#attempt ? `attempt ${this.#attempt + 1}` : "connecting");
		let ws: WebSocket;
		try {
			ws = this.opts.socketFactory ? this.opts.socketFactory(this.opts.url) : new WebSocket(this.opts.url);
		} catch (e) {
			// A malformed URL throws synchronously. Retrying it forever is
			// pointless, but so is dying: the settings panel can fix the URL.
			this.#scheduleRetry(`could not open socket: ${(e as Error).message}`);
			return;
		}
		this.#ws = ws;

		this.#openTimer = setTimeout(() => {
			if (this.#ws !== ws) return;
			// A socket stuck in CONNECTING never fires close, so nothing would
			// ever schedule the retry.
			try { ws.close(); } catch { /* nothing to close */ }
			this.#ws = null;
			this.#scheduleRetry("no answer");
		}, this.opts.openTimeoutMs ?? 10_000);

		ws.addEventListener("open", () => {
			if (this.#ws !== ws) return;
			this.stats.connects++;
			ws.send(JSON.stringify({
				type: C2S.HELLO,
				protocol: PROTOCOL_VERSION,
				token: this.opts.token,
				...(this.sessionId ? { sessionId: this.sessionId } : {}),
				// Only once we have a cursor: hello without resumeFrom means "I
				// want nothing replayed", which is right for a fresh page and
				// wrong for a reconnect that missed a turn.
				...(this.cursor > 0 ? { resumeFrom: this.cursor } : {})
			}));
		});

		ws.addEventListener("message", (ev: MessageEvent) => {
			if (this.#ws !== ws) return;   // a socket we have already replaced
			let m: ServerMsg;
			try { m = JSON.parse(String((ev as MessageEvent).data)); }
			catch { return; }              // the server does not send non-JSON
			this.#receive(m);
		});

		ws.addEventListener("close", (ev: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#ws = null;
			const code = (ev as CloseEvent).code ?? 0;
			const fatal = FATAL_CLOSE[code];
			if (fatal) {
				this.#clearTimers();
				this.#setStatus("fatal", fatal);
				return;
			}
			if (this.status === "online") this.stats.drops++;
			this.#scheduleRetry(`closed (${code})`);
		});

		// `error` always precedes `close` in both browsers and Node, so the
		// retry is scheduled exactly once, in the close handler.
		ws.addEventListener("error", () => { /* reported by close */ });
	}

	#receive(m: ServerMsg): void {
		if (m.type === "ready") {
			const ready = m as ReadyMsg;
			this.#clearOpenTimer();
			this.#attempt = 0;
			const fresh = this.sessionId !== ready.sessionId;
			this.sessionId = ready.sessionId;

			if (ready.gap) {
				// The server cannot honestly bridge our cursor. Taking its word
				// and re-reading the transcript is the only way back to a state
				// we can trust; silently continuing would leave a hole nobody
				// ever notices.
				this.stats.gaps++;
				this.cursor = ready.cursor;
				this.handlers.onReady?.(ready);
				this.#setStatus("online", "resynced");
				this.requestHistory();
				return;
			}

			if (!ready.resumed || fresh) {
				// A page that has just loaded knows nothing. The cursor moves to
				// the server's, and the transcript comes from the history
				// control rather than from a replay of the whole buffer.
				this.cursor = ready.cursor;
				this.handlers.onReady?.(ready);
				this.#setStatus("online", "connected");
				this.requestHistory();
				return;
			}

			this.stats.replayed += ready.missed ?? 0;
			this.handlers.onReady?.(ready);
			this.#setStatus("online", ready.missed ? `caught up (${ready.missed})` : "connected");
			return;
		}

		const seq = (m as SeqMsg).seq;
		if (typeof seq === "number") {
			// The duplicate guard. Everything durable the server sends is
			// numbered, so "have I seen this" is a comparison rather than a
			// heuristic over content.
			if (seq <= this.cursor) { this.stats.duplicates++; return; }
			this.cursor = seq;
		}

		if (m.type === "event" && (m as any).kind === "history") {
			const messages = ((m as any).data?.messages ?? []) as SeqMsg[];
			this.handlers.onHistory?.(messages);
			return;
		}

		this.handlers.onMessage?.(m as SeqMsg);
	}

	// ---------------------------------------------------------------- retries

	#scheduleRetry(detail: string): void {
		this.#clearTimers();
		if (this.#stopped) return;
		this.#setStatus("offline", detail);

		const step = this.#backoff[Math.min(this.#attempt, this.#backoff.length - 1)];
		this.#attempt++;
		// Jitter, because a phone and a desktop that lost the same wifi would
		// otherwise reconnect in lockstep forever.
		const wait = Math.round(step * (0.8 + Math.random() * 0.4));
		this.#timer = setTimeout(() => this.#open(), wait);
	}

	#clearOpenTimer(): void {
		if (this.#openTimer) { clearTimeout(this.#openTimer); this.#openTimer = null; }
	}

	#clearTimers(): void {
		this.#clearOpenTimer();
		if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
	}

	#setStatus(status: ConnectionStatus, detail: string): void {
		if (this.status === status && this.detail === detail) return;
		this.status = status;
		this.detail = detail;
		this.handlers.onStatus?.(status, detail);
	}
}
