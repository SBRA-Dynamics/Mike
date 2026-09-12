// One WebSocket connection: handshake, auth, resume, keepalive, dispatch.
//
// PRD 1 R1.3 and R1.7. The rule that shapes this file is that a connection is
// disposable and a session is not — nothing here may own conversation state,
// and a socket dying must never disturb work in flight.

import { C2S, CLOSE, CONTROL, PROTOCOL_VERSION, msg, validateC2S } from "./protocol.js";

/** A connection must say hello before anything else, and quickly. */
const HELLO_TIMEOUT_MS = 10_000;

export function attachConnection({ ws, req, store, config, handler, log, registry, mcp }) {
	const peer = req.socket.remoteAddress;
	let session = null;
	let alive = true;
	let helloTimer = null;

	const fail = (code, message) => {
		try { ws.send(JSON.stringify(msg.error(message, true))); } catch { }
		try { ws.close(code, message); } catch { }
	};

	helloTimer = setTimeout(() => {
		if (!session) { log.warn(`no hello from ${peer} within ${HELLO_TIMEOUT_MS}ms`); fail(CLOSE.BAD_PROTOCOL, "no hello"); }
	}, HELLO_TIMEOUT_MS);

	// Keepalive. ws answers pings itself; this detects a peer that has gone away
	// without a close frame, which is the normal case on mobile networks.
	ws.on("pong", () => { alive = true; });
	const ping = setInterval(() => {
		if (!alive) { log.info(`ping timeout, closing ${peer}`); try { ws.terminate(); } catch { } return; }
		alive = false;
		try { ws.ping(); } catch { }
	}, config.pingIntervalMs);

	ws.on("message", async (data, isBinary) => {
		if (isBinary) return fail(CLOSE.BAD_MESSAGE, "binary frames are not used");

		let raw;
		try { raw = JSON.parse(data.toString()); }
		catch { return fail(CLOSE.BAD_MESSAGE, "not JSON"); }

		const v = validateC2S(raw);
		if (!v.ok) {
			// A bad message after hello is reported but not fatal: one malformed
			// frame should not cost the user their conversation.
			if (!session) return fail(CLOSE.BAD_MESSAGE, v.error);
			log.warn(`bad message from ${peer}: ${v.error}`);
			return session.emit(msg.error(v.error));
		}
		const m = v.msg;

		if (m.type === C2S.HELLO) {
			if (session) return session.emit(msg.error("already said hello"));
			return onHello(m);
		}
		if (!session) return fail(CLOSE.BAD_PROTOCOL, "say hello first");

		if (m.type === C2S.CONTROL && handleTransportControl(m)) return;

		try {
			await handler.onMessage(session, m, { peer });
		} catch (e) {
			log.error(`handler threw on ${m.type}: ${e.stack || e.message}`);
			session.emit(msg.error(`internal error handling ${m.type}`));
		}
	});

	function onHello(m) {
		clearTimeout(helloTimer);

		// Constant-time-ish comparison is overkill for a single local token, but
		// checking length first avoids leaking it through early-exit timing.
		const ok = m.token.length === config.token.length && m.token === config.token;
		if (!ok) { log.warn(`bad token from ${peer}`); return fail(CLOSE.UNAUTHORIZED, "unauthorized"); }

		if (m.protocol !== PROTOCOL_VERSION) {
			return fail(CLOSE.BAD_PROTOCOL, `protocol ${m.protocol} not supported, server speaks ${PROTOCOL_VERSION}`);
		}

		session = store.getOrCreate(m.sessionId);
		session.attach(ws);
		ws.sessionId = session.id;

		// No cursor means "I have nothing and want nothing replayed" — a fresh
		// client asks for history explicitly. Treating it as 0 replayed the whole
		// buffer to every new connection, which is both surprising and the reason
		// the test suite was non-deterministic.
		const asked = Number.isInteger(m.resumeFrom);
		const from = asked ? m.resumeFrom : session.seq;
		const gapped = session.replayGap(from);
		const missed = gapped ? [] : session.replay(from);

		// `ready` is sent directly rather than through session.emit: it is
		// addressed to this one connection and must not consume a sequence
		// number or be replayed to anyone else.
		send(msg.ready(session.id, session.seq, {
			worker: session.worker,
			// R1.6 declares `workers` in ready and PRD 1 never filled it in. It is
			// the registry PRD 2 introduced, and a client that has just come back
			// needs it to render who exists before anything else happens.
			workers: registry ? registry.list().map((w) => ({ name: w.name, model: w.model, cwd: w.cwd, busy: w.busy })) : [],
			mode: session.mode,
			resumed: asked,
			missed: missed.length,
			gap: gapped
		}));

		for (const m2 of missed) send(m2);
		if (gapped) send(msg.error("too much missed to replay; reload the transcript", false));

		log.info(`hello from ${peer} session=${session.id.slice(0, 8)} resumeFrom=${from} missed=${missed.length}${gapped ? " GAP" : ""}`);
		handler.onOpen?.(session, { peer, resumed: asked });
	}

	/** Control actions the transport owns (PRD 1 R1.5). Returns true when handled. */
	function handleTransportControl(m) {
		switch (m.action) {
			case CONTROL.CLIENT_LOG: {
				// Bounded, and never emitted back: it is a log line, not a fact
				// about the conversation, and a client that decided to send a
				// megabyte of them must not be able to fill a disk with them.
				const text = String(m.args?.text ?? "").replace(/\s+/g, " ").slice(0, 500);
				const level = m.args?.level === "error" ? "error" : "info";
				if (text) log[level](`client ${session?.id.slice(0, 8) ?? "?"}: ${text}`);
				return true;
			}

			case CONTROL.LIST_SESSIONS:
				send(msg.event("sessions", { sessions: store.list(Number(m.args?.limit) || 50) }));
				return true;

			case CONTROL.HISTORY: {
				// Answers for this session only: a client must not be able to read
				// another session's transcript by naming it.
				const limit = Math.min(Number(m.args?.limit) || 200, 1000);
				send(msg.event("history", { sessionId: session.id, messages: store.history(session.id, limit) }));
				return true;
			}

			case CONTROL.MCP_GRANT: {
				// Mint the credential a Claude Code invocation uses to reach the
				// tools (PRD 2). Sent through send(), never emit(): this is a live
				// token for THIS connection. emit() would fan it out to every other
				// attached device and write it into the durable transcript, where it
				// would outlive its hour by months.
				//
				// Any holder of the bearer token may ask for a "mike" grant,
				// because R1.7 makes that token the one credential in the system.
				// The "worker" role exists so the server can mint a grant that sees
				// no tools at all (R2.4) — in PRD 3 the server mints these itself
				// and a worker is never handed one.
				if (!mcp) { send(msg.error("tools are not available")); return true; }
				const role = m.args?.role === "worker" ? "worker" : "mike";
				const grant = mcp.mintGrant({ sessionId: session.id, role });
				send(msg.event("mcpGrant", {
					role: grant.role, url: grant.url, config: grant.config,
					expiresAt: grant.expiresAt, allowedTools: mcp.allowedToolNames(grant.role)
				}));
				log.info(`mcp grant for session=${session.id.slice(0, 8)} role=${grant.role}`);
				return true;
			}

			case CONTROL.DELETE_SESSION: {
				const target = m.args?.sessionId;
				if (target !== undefined && target !== session.id) {
					send(msg.error("can only delete the session you are attached to"));
					return true;
				}
				const id = session.id;
				send(msg.event("sessionDeleted", { sessionId: id }));
				store.delete(id);
				log.info(`deleted session ${id.slice(0, 8)} at client request`);
				return true;
			}

			default:
				return false;   // the handler may know it
		}
	}

	function send(message) {
		try { ws.send(JSON.stringify(message)); } catch { /* closing */ }
	}

	ws.on("close", (code, reason) => {
		clearInterval(ping);
		clearTimeout(helloTimer);
		if (session) {
			session.detach(ws);
			log.info(`closed ${peer} session=${session.id.slice(0, 8)} code=${code}${reason?.length ? " " + reason : ""} remaining=${session.connectionCount}`);
			// Deliberately no cancellation here: a turn in flight keeps running
			// and its output lands in the session, ready to be replayed when the
			// client comes back. PRD 1 R1.3.
			handler.onClose?.(session, { peer });
		} else {
			log.info(`closed ${peer} before hello code=${code}`);
		}
	});

	ws.on("error", (e) => log.warn(`socket error ${peer}: ${e.message}`));
}
