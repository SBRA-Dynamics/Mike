// The wire protocol, imported rather than mirrored.
//
// PRD 1 R1.6 says one shared schema file that both server and client import,
// and this is that import: `../../src/protocol.js` is the server's own file, so
// a message name, a control action or a close code can only ever be changed in
// one place. Vite bundles it like any other module and tree-shakes the
// server-only half (validateC2S, the msg constructors) out of the build.
//
// The `type` declarations below are not a second copy of the schema. They are
// the client's structural view of messages it receives — every key in them is a
// field the server actually sends, and the union below is what the client
// switches on.
//
// Why the reducer switches on "text" rather than on S2C.TEXT: protocol.js is
// plain JS with no `as const`, so TypeScript types S2C.TEXT as `string`, and a
// switch over it narrows nothing. The literals in the union below are therefore
// the place the names live on this side — and any drift between them and the
// server shows up as a message the client silently ignores, which is what the
// suite's round trip against a real server is for.

export { C2S, S2C, CONTROL, CLOSE, PROTOCOL_VERSION } from "../../src/protocol.js";

/** Where an utterance came from. PRD 3: a keyboard client MUST say "typed", or
 *  the addressing mode treats its words as speech and filters them. */
export type Origin = "typed" | "voice";

export type Framed = { seq: number };

export type ReadyMsg = {
	type: "ready";
	sessionId: string;
	cursor: number;
	protocol: number;
	worker: string | null;
	workers: WorkerInfo[];
	mode: string;
	resumed: boolean;
	missed: number;
	gap: boolean;
};

export type WorkerInfo = { name: string; model?: string; cwd?: string; busy?: boolean };

/** `command` marks the answer to a spoken command, which is not part of the
 *  conversation and must not take the lens from it. */
export type TextMsg = { type: "text"; text: string; from: string; command?: boolean } & Framed;
export type StateMsg = { type: "state"; busy: boolean; worker: string | null; mode: string } & Framed;
export type HeardMsg = { type: "heard"; text: string; confidence: number | null } & Framed;
export type EventMsg = { type: "event"; kind: string; data: Record<string, any> } & Framed;
export type ErrorMsg = { type: "error"; message: string; fatal: boolean } & Framed;

export type ServerMsg = ReadyMsg | TextMsg | StateMsg | HeardMsg | EventMsg | ErrorMsg;

/** Everything the server frames with a sequence number — i.e. everything except
 *  `ready`, which is addressed to one connection and is not replayed. */
export type SeqMsg = TextMsg | StateMsg | HeardMsg | EventMsg | ErrorMsg;
