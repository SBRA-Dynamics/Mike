// Keyboards — a line editor on a desk, typing into the conversation on the glasses.
//
// A keyboard is not a conversation client. It never names a session: the person
// at it wants to type into whatever the glasses are showing, and a sessionId is
// something a phone keeps, not something a board taped to a keyboard could be
// told. So the hub picks the target, and keeps picking it as the phone comes and
// goes, and the lens is told two things about it:
//
//   keyboard { connected, text, cursor }   — a keyboard is (or is no longer) typing here
//   draft    { text, cursor }              — the line as it stands after a keystroke
//
// Both are transient. A half-typed line is a fact about this moment on this
// screen, not about the conversation (sessions.js's rule for choosing): it is
// never written to the transcript, never replayed, and costs no sequence number,
// which matters at one message per keystroke.

import { msg } from "./protocol.js";

export function createKeyboards({ store, log }) {
	/** ws -> { session, text, cursor } */
	const boards = new Map();

	const byRecent = (a, b) => b.updatedAt - a.updatedAt;

	/**
	 * Where a keyboard types. Sticky: while the conversation it is typing into
	 * still has a client attached, it stays there, so opening a browser tab on
	 * another session does not move the line out from under the glasses. It
	 * moves when its conversation has nobody left in it and another has — which
	 * is what the phone reconnecting under a fresh session looks like.
	 */
	const choose = (current) => {
		const live = [...store.sessions.values()].filter((s) => s.connectionCount > 0).sort(byRecent);
		if (current && store.get(current.id) && current.connectionCount > 0) return current;
		if (live.length) return live[0];
		// Nobody is looking. Stay put if there is somewhere to stay, so the line
		// is still there when the phone comes back; otherwise the newest session.
		if (current && store.get(current.id)) return current;
		return [...store.sessions.values()].sort(byRecent)[0] ?? null;
	};

	const typingInto = (session) => {
		for (const b of boards.values()) if (b.session === session) return b;
		return null;
	};

	const presence = (board) => msg.event("keyboard", { connected: true, text: board.text, cursor: board.cursor });
	const absence = () => msg.event("keyboard", { connected: false, text: "", cursor: 0 });

	/** Point one keyboard at its target, telling both conversations if it moved. */
	const resolve = (ws) => {
		const board = boards.get(ws);
		if (!board) return null;
		const next = choose(board.session);
		if (next === board.session) return next;

		const prev = board.session;
		board.session = next;
		if (prev && !typingInto(prev)) prev.transient(absence());
		if (next) next.transient(presence(board));
		log?.info(`keyboard ${prev ? prev.id.slice(0, 8) : "-"} -> ${next ? next.id.slice(0, 8) : "-"}`);
		return next;
	};

	return {
		/** A keyboard said hello. Returns the session it types into, if any. */
		attach(ws) {
			boards.set(ws, { session: null, text: "", cursor: 0 });
			return resolve(ws);
		},

		detach(ws) {
			const board = boards.get(ws);
			if (!board) return;
			boards.delete(ws);
			if (board.session && !typingInto(board.session)) board.session.transient(absence());
		},

		resolve,

		/** The line after a keystroke, onto the lens of the conversation it is for. */
		draft(ws, text, cursor) {
			const board = boards.get(ws);
			if (!board) return null;
			board.text = text;
			board.cursor = Math.min(cursor, Array.from(text).length);
			const session = resolve(ws);
			session?.transient(msg.event("draft", { text: board.text, cursor: board.cursor }));
			return session;
		},

		/** A conversation client arrived or left: a keyboard may have somewhere
		 *  better to type now. */
		clientsChanged() {
			for (const ws of boards.keys()) resolve(ws);
		},

		/** A client that has just attached learns what a keyboard is already
		 *  doing here. Sent to that one connection: the rest already know. */
		greet(session, send) {
			const board = typingInto(session);
			if (board) send(presence(board));
		},

		get count() { return boards.size; }
	};
}
