// One WebSocket connection: handshake, auth, resume, keepalive, dispatch.
//
// PRD 1 R1.3 and R1.7. The rule that shapes this file is that a connection is
// disposable and a session is not — nothing here may own conversation state,
// and a socket dying must never disturb work in flight.

import { C2S, CLOSE, PROTOCOL_VERSION, msg, validateC2S } from "./protocol.js";

/** A connection must say hello before anything else, and quickly. */
const HELLO_TIMEOUT_MS = 10_000;

export function attachConnection({ ws, req, store, config, handler, log }) {
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

		const from = Number.isInteger(m.resumeFrom) ? m.resumeFrom : 0;
		const gapped = session.replayGap(from);
		const missed = gapped ? [] : session.replay(from);

		// `ready` is sent directly rather than through session.emit: it is
		// addressed to this one connection and must not consume a sequence
		// number or be replayed to anyone else.
		send(msg.ready(session.id, session.seq, {
			worker: session.worker,
			mode: session.mode,
			resumed: from > 0,
			missed: missed.length,
			gap: gapped
		}));

		for (const m2 of missed) send(m2);
		if (gapped) send(msg.error("too much missed to replay; reload the transcript", false));

		log.info(`hello from ${peer} session=${session.id.slice(0, 8)} resumeFrom=${from} missed=${missed.length}${gapped ? " GAP" : ""}`);
		handler.onOpen?.(session, { peer, resumed: from > 0 });
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
