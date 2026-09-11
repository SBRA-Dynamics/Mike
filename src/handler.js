// The conversation seam.
//
// PRD 1 owns transport, not conversation. This echo handler exists so the
// transport can be exercised and tested end to end on its own; PRD 3 replaces
// it with Jarvis and workers without touching anything else.
//
// The contract a real handler must honour:
//   onMessage(session, msg, ctx)  — may be async and long-running
//   onOpen(session, ctx)          — optional
//   onClose(session, ctx)         — optional; must not cancel work in flight

import { C2S, msg } from "./protocol.js";

export function createEchoHandler({ log }) {
	return {
		onOpen(session, { resumed }) {
			if (!resumed) session.emit(msg.text("Jarvis transport online (echo handler).", "system"));
		},

		async onMessage(session, m) {
			switch (m.type) {
				case C2S.SAY: {
					session.emit(msg.state({ busy: true, worker: session.worker, mode: session.mode }));
					// A deliberate pause: it makes "a turn survives a disconnect"
					// testable, and mirrors the shape of a real model call.
					await new Promise((r) => setTimeout(r, 150));
					session.emit(msg.text(`echo: ${m.text}`, "echo"));
					session.emit(msg.state({ busy: false, worker: session.worker, mode: session.mode }));
					break;
				}
				case C2S.INTERRUPT:
					session.emit(msg.event("interrupted"));
					session.emit(msg.state({ busy: false, worker: session.worker, mode: session.mode }));
					break;
				case C2S.CONTROL:
					// Transport-level controls only; conversation controls are PRD 3.
					if (m.action === "setTitle" && typeof m.args?.title === "string") {
						session.title = m.args.title.slice(0, 120);
						session.store.touch(session);
						session.emit(msg.event("titleChanged", { title: session.title }));
					} else {
						session.emit(msg.error(`unknown control "${m.action}"`));
					}
					break;
				case C2S.AUDIO:
					session.emit(msg.error("audio is not implemented until PRD 5"));
					break;
				default:
					log.warn(`handler ignored ${m.type}`);
			}
		}
	};
}
