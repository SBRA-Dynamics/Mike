// MCP over HTTP, served by the process that owns the sessions.
//
// PRD 2's "plumbing problem" is that an MCP server spawned as a child knows
// nothing about the running server, and its proposed answer was a stdio adapter
// forwarding to loopback HTTP. The PRD also says to try direct HTTP/SSE first.
// Measured against claude 2.1.268: `--mcp-config` with `{"type":"http"}` works,
// and the whole exchange is five plain POSTs — server/discover (which may 404
// into a fallback), initialize, notifications/initialized, tools/list,
// tools/call — each answered with a single JSON body. No SSE stream, no
// session header, no GET. So there is no adapter, and the tools mutate the
// live server because they run inside it.
//
// The listener is its own plain-HTTP socket bound to 127.0.0.1, not a route on
// the public server, for three reasons: the client is always on this machine,
// so loopback binding is a stronger guarantee than any path check; the public
// server may be terminating TLS for a hostname a 127.0.0.1 URL cannot match;
// and the tool surface stays entirely off the internet-facing listener.
//
// Authentication is a per-invocation grant rather than the shared bearer token.
// A grant binds a token to one session and one role, which is what makes
// PRD 2 R2.4 enforceable: Mike gets a "mike" grant and sees the tools, a
// worker would get a "worker" grant and sees none. The server mints grants; a
// worker is never handed one, and could not use it if it were.

import http from "node:http";
import { randomBytes } from "node:crypto";

import { msg } from "./protocol.js";
import { ToolError } from "./workers.js";

/** MCP version we answer with when the client does not name one. Claude Code
 *  2.1.268 asks for 2025-11-25 and we echo whatever it asks. */
const DEFAULT_PROTOCOL = "2025-11-25";

/** A grant lives for one Mike invocation. An hour is generous for a turn and
 *  short enough that a leaked config file is not a standing key. */
const GRANT_TTL_MS = 60 * 60 * 1000;
const MAX_GRANTS = 64;

/** Request body cap. An MCP call is a few hundred bytes; anything near this is
 *  either a bug or someone probing. */
const MAX_BODY = 256 * 1024;

/** The name the server is configured under, so tools reach Mike as
 *  `mcp__mike__spawn_worker`. Changing it changes every --allowedTools entry. */
export const MCP_SERVER_NAME = "mike";

/** One line, no newlines, short enough to survive a 50x10 lens with room for
 *  the words around it. Applied at the boundary so no handler has to remember. */
const lensLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 100) || "something went wrong";

/** Arguments come from a model and go into a log file that runs for months.
 *  A prompt argument can be arbitrarily long; the log line must not be. */
const logArgs = (args) => {
	const s = JSON.stringify(args ?? {});
	return s.length > 200 ? s.slice(0, 197) + "..." : s;
};

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export function createMcpServer({ store, toolset, registry, log }) {
	const grants = new Map();   // token -> { sessionId, role, expiresAt, calls }

	const sweep = () => {
		const now = Date.now();
		for (const [t, g] of grants) if (g.expiresAt <= now) grants.delete(t);
	};

	let listener = null;
	let boundPort = 0;

	// ------------------------------------------------------------------ grants

	/**
	 * Mint a grant for one Claude Code invocation.
	 * `role` is "mike" (sees the tools) or "worker" (sees none).
	 * Returns { token, url, config, expiresAt } where `config` is the exact
	 * string to hand to `claude --mcp-config`.
	 */
	const mintGrant = ({ sessionId, role = "mike", ttlMs = GRANT_TTL_MS }) => {
		sweep();
		if (grants.size >= MAX_GRANTS) {
			// Drop the oldest rather than refuse: a refusal here means Mike
			// cannot act at all, which is worse than evicting a stale grant.
			const oldest = [...grants.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
			if (oldest) grants.delete(oldest[0]);
		}
		const token = randomBytes(32).toString("hex");
		const expiresAt = Date.now() + ttlMs;
		grants.set(token, { sessionId, role: role === "worker" ? "worker" : "mike", expiresAt, calls: 0 });

		const url = `http://127.0.0.1:${boundPort}/mcp`;
		const config = JSON.stringify({
			mcpServers: {
				[MCP_SERVER_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } }
			}
		});
		log?.info(`mcp grant minted role=${role} session=${String(sessionId).slice(0, 8)} port=${boundPort}`);
		return { token, url, config, expiresAt, role: grants.get(token).role };
	};

	/** Every tool name a grant of this role may call, for --allowedTools. */
	const allowedToolNames = (role = "mike") =>
		role === "worker" ? [] : toolset.definitions().map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`);

	// ------------------------------------------------------------------ dispatch

	const callTool = async (grant, params) => {
		const name = params?.name;
		const args = params?.arguments ?? {};

		// R2.4. A worker holds no tools, so this is the same answer it would get
		// for a tool that does not exist — there is nothing here to discover.
		if (grant.role !== "mike") {
			log?.warn(`mcp tool refused for role=${grant.role}: ${name}`);
			return { isError: true, text: "that is not something this session can do" };
		}

		const session = store.get(grant.sessionId);
		if (!session) return { isError: true, text: "that conversation is gone; reconnect and try again" };

		const started = Date.now();
		try {
			const out = await toolset.run(name, args, { session, registry, log });

			// R2.3 — logged with arguments and result, and surfaced to every
			// attached client as an `event` so the user sees what Mike did and
			// not only what he said. emit(), not send(): this one IS for
			// everybody on the session and belongs in the transcript.
			session.emit(msg.event(out.kind, {
				tool: name, args, ok: true,
				summary: lensLine(out.text),
				...out.data
			}));
			log?.info(`mcp tool ${name} ${logArgs(args)} -> ok: ${lensLine(out.text)} (${Date.now() - started}ms) session=${session.id.slice(0, 8)}`);
			return { isError: false, text: out.text };

		} catch (e) {
			// A ToolError is a sentence for the user. Anything else is a bug, and
			// its stack goes to the log, never to the lens.
			const lens = e instanceof ToolError ? lensLine(e.message) : "that did not work";
			if (!(e instanceof ToolError)) log?.error(`mcp tool ${name} threw: ${e.stack || e.message}`);
			else log?.info(`mcp tool ${name} ${logArgs(args)} -> refused: ${lens}`);

			session.emit(msg.event("toolFailed", { tool: name, args, ok: false, summary: lens }));
			return { isError: true, text: lens };
		}
	};

	const handleRpc = async (grant, m) => {
		switch (m.method) {
			case "initialize":
				return rpcResult(m.id, {
					protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : DEFAULT_PROTOCOL,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "mike", title: "Mike", version: "1" }
				});

			case "tools/list":
				// The role gate is here as well as in callTool. A worker must not
				// even be able to enumerate what it is not allowed to do.
				return rpcResult(m.id, { tools: grant.role === "mike" ? toolset.definitions() : [] });

			case "tools/call": {
				const r = await callTool(grant, m.params);
				return rpcResult(m.id, { content: [{ type: "text", text: r.text }], isError: r.isError });
			}

			case "ping":
				return rpcResult(m.id, {});

			default:
				// Includes `server/discover`, which claude probes with first and
				// falls back from cleanly when it is not implemented.
				return rpcError(m.id, -32601, `no method ${String(m.method).slice(0, 40)}`);
		}
	};

	// ------------------------------------------------------------------ transport

	const readBody = (req) => new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (d) => {
			size += d.length;
			if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
			chunks.push(d);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});

	const json = (res, status, body) => {
		const payload = JSON.stringify(body);
		res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
		res.end(payload);
	};

	const onRequest = async (req, res) => {
		try {
			if (req.method !== "POST") return json(res, 405, { error: "POST only" });
			if ((req.url ?? "").split("?")[0] !== "/mcp") return json(res, 404, { error: "not found" });

			const auth = req.headers.authorization ?? "";
			const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
			sweep();
			const grant = grants.get(token);
			if (!grant) return json(res, 401, { error: "unknown or expired grant" });
			grant.calls++;

			let raw;
			try { raw = await readBody(req); }
			catch { return json(res, 413, { error: "too large" }); }

			let parsed;
			try { parsed = JSON.parse(raw); }
			catch { return json(res, 400, rpcError(null, -32700, "parse error")); }

			// A notification carries no id and gets no body — that is what claude
			// sends for notifications/initialized, and answering it with a
			// JSON-RPC response is a protocol error.
			const batch = Array.isArray(parsed) ? parsed : [parsed];
			const answers = [];
			for (const m of batch) {
				if (!m || typeof m !== "object") { answers.push(rpcError(null, -32600, "invalid request")); continue; }
				if (m.id === undefined || m.id === null) continue;
				answers.push(await handleRpc(grant, m));
			}
			if (!answers.length) { res.writeHead(202).end(); return; }
			return json(res, 200, Array.isArray(parsed) ? answers : answers[0]);

		} catch (e) {
			log?.error(`mcp request failed: ${e.stack || e.message}`);
			if (!res.headersSent) json(res, 500, { error: "internal error" });
		}
	};

	return {
		mintGrant,
		allowedToolNames,
		get port() { return boundPort; },
		get grantCount() { sweep(); return grants.size; },

		/** Bind the loopback listener. `port` 0 takes an ephemeral one, which is
		 *  the default: nothing outside this process needs to guess it, because
		 *  the grant carries the URL. */
		listen(port = 0) {
			return new Promise((resolve, reject) => {
				listener = http.createServer(onRequest);
				listener.on("error", reject);
				// 127.0.0.1 is not configurable on purpose. It is the security
				// property, not a preference.
				listener.listen(port, "127.0.0.1", () => {
					boundPort = listener.address().port;
					log?.info(`mcp tools on http://127.0.0.1:${boundPort}/mcp (loopback only)`);
					resolve(boundPort);
				});
			});
		},

		close() { try { listener?.close(); } catch { } }
	};
}
