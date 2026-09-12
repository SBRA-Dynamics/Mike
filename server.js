#!/usr/bin/env node
/**
 * Jarvis server — PRD 1.
 *
 * One process: TLS, static hosting of the client, one WebSocket per connection,
 * a durable session store, and the operations surface.
 *
 *   node server.js                                   # plain HTTP on :3460
 *   node server.js --cert fullchain.pem --key privkey.pem --port 443
 *   node server.js --dev-proxy http://localhost:5190 # client from Vite
 *
 * Deployment note (PRD 1 R1.4): terminating TLS here is supported, but the
 * previous system measured Node's own https.Server cutting long-lived streams
 * at exactly 30 s on this network path, where a raw TCP TLS bridge in front did
 * not. Run test/longevity.mjs through whichever topology you deploy before
 * trusting it.
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";

import { log } from "./src/log.js";
import { SessionStore } from "./src/sessions.js";
import { attachConnection } from "./src/connection.js";
import { createEchoHandler, createJarvisHandler, DEFAULT_HOLD_MS } from "./src/handler.js";
import { PROTOCOL_VERSION } from "./src/protocol.js";
import { WorkerRegistry } from "./src/workers.js";
import { NamedDirs } from "./src/namedDirs.js";
import { createStubWorkerEngine, createClaudeWorkerEngine } from "./src/workerEngine.js";
import { createToolset } from "./src/tools.js";
import { createClassifier } from "./src/classify.js";
import { createClaudeRunner } from "./src/claudeCli.js";
import { createMcpServer } from "./src/mcp.js";
import { isKnownModel, MODEL_LIST, resolveModel } from "./src/models.js";
import { createJarvis, DEFAULT_CONTEXT_TURNS, DEFAULT_CONTEXT_BUDGET_TOKENS } from "./src/jarvis.js";
import { DEFAULT_MODE, isMode, MODES } from "./src/routing.js";
import { createWhisperClient, createNullTranscriber } from "./src/whisper.js";
import { DEFAULT_MAX_AUDIO_BYTES } from "./src/audio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "0.3.1";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const has = (n) => argv.includes("--" + n);

if (has("help")) {
	console.log(`jarvis-server ${VERSION} (protocol ${PROTOCOL_VERSION})

  --port <n>           listen port (default 3460)
  --host <addr>        bind address (default 0.0.0.0)
  --token <hex>        auth token (default $JARVIS_TOKEN, else generated)
  --cert <file>        TLS chain; with --key, serves HTTPS
  --key <file>         TLS private key
  --static <dir>       directory to serve the client from (default ./public)
  --dev-proxy <url>    serve the client from a dev server instead of --static
  --data <dir>         session storage (default ~/.local/share/jarvis)
  --ping <ms>          keepalive interval (default 20000)
  --mcp-port <n>       loopback port for the MCP tool surface (default: ephemeral)
  --worker-model <m>   default model for a new worker (default sonnet)
  --worker-cwd <dir>   default working directory for a new worker
  --dirs <file>        spoken names for directories, e.g. "MyProject" (default ./dirs.json)
  --handler <h>        jarvis (default) or echo, which pins PRD 1's transport
  --engine <e>         claude (default) or stub, which spends no money
  --claude-bin <path>  the Claude Code binary to drive (default: claude)
  --worker-perms <p>   readonly (default), edits, or full — what a worker may do
  --worker-prompt <f>  the worker system prompt template (default ./prompts/worker.md)
  --jarvis-model <m>   the model Jarvis runs (default opus)
  --jarvis-cwd <dir>   where Jarvis's own Bash runs (default: --worker-cwd)
  --jarvis-prompt <f>  his system prompt file (default ./prompts/jarvis.md)
  --context-turns <n>  worker turns quoted to Jarvis when addressed (default 6)
  --context-budget <n> token budget for that quote (default 1200)
  --turn-timeout <ms>  how long one model turn may take (default 600000)
  --mode <m>           addressing mode for a fresh session (default byname)
  --hold <ms>          how long an utterance waits for the rest of the
                       sentence before it becomes a turn (default 2000, 0 off)
  --whisper <url|off>  the transcription service (default http://127.0.0.1:3461)
  --whisper-timeout <ms>  how long one transcription may take (default 20000)
  --audio-max-bytes <n>   biggest accepted audio segment (default 1000000)
  --help
`);
	process.exit(0);
}

const config = {
	port: parseInt(flag("port", process.env.JARVIS_PORT ?? "3460"), 10),
	host: flag("host", "0.0.0.0"),
	token: flag("token", process.env.JARVIS_TOKEN || randomBytes(16).toString("hex")),
	cert: flag("cert", process.env.JARVIS_CERT),
	key: flag("key", process.env.JARVIS_KEY),
	staticDir: path.resolve(flag("static", path.join(HERE, "public"))),
	devProxy: flag("dev-proxy", process.env.JARVIS_DEV_PROXY || null),
	dataDir: flag("data", process.env.JARVIS_DATA || path.join(homedir(), ".local", "share", "jarvis")),
	pingIntervalMs: parseInt(flag("ping", "20000"), 10),
	// The MCP listener is loopback-only and its port is not a contract: the
	// grant handed to each Claude Code invocation carries the URL. A fixed port
	// is only useful when something outside has to be pointed at it by hand.
	mcpPort: parseInt(flag("mcp-port", process.env.JARVIS_MCP_PORT ?? "0"), 10),
	// What a worker gets when the user does not name a model. Named here rather
	// than buried in the registry because it is a product decision: Jarvis is
	// the expensive one, workers are many and long-lived.
	workerModel: flag("worker-model", process.env.JARVIS_WORKER_MODEL || "sonnet"),
	workerCwd: flag("worker-cwd", process.env.JARVIS_WORKER_CWD || process.cwd()),
	dirsFile: path.resolve(flag("dirs", process.env.JARVIS_DIRS || path.join(HERE, "dirs.json"))),
	// What a worker turn may do. `full` means --dangerously-skip-permissions,
	// and since this server is reachable from the internet behind one bearer
	// token, that makes the token the ability to run code here. Deliberate
	// setting, made in the unit file, never a default.
	workerPerms: flag("worker-perms", process.env.JARVIS_WORKER_PERMS ?? "readonly"),
	workerPrompt: flag("worker-prompt", null),

	// PRD 3. Two seams, both named on the command line rather than inferred:
	// `--handler echo` is how the PRD 1 suites still pin the transport without a
	// model in the path, and `--engine stub` is how everything above the engine
	// is tested without spending money. Production is the default of both.
	handler: flag("handler", process.env.JARVIS_HANDLER || "jarvis"),
	engine: flag("engine", process.env.JARVIS_ENGINE || "claude"),
	claudeBin: flag("claude-bin", process.env.JARVIS_CLAUDE_BIN || "claude"),
	jarvisModel: flag("jarvis-model", process.env.JARVIS_MODEL || "opus"),
	jarvisCwd: flag("jarvis-cwd", process.env.JARVIS_CWD || null),
	jarvisPrompt: flag("jarvis-prompt", process.env.JARVIS_PROMPT || path.join(HERE, "prompts", "jarvis.md")),
	contextTurns: parseInt(flag("context-turns", process.env.JARVIS_CONTEXT_TURNS ?? String(DEFAULT_CONTEXT_TURNS)), 10),
	contextBudget: parseInt(flag("context-budget", process.env.JARVIS_CONTEXT_BUDGET ?? String(DEFAULT_CONTEXT_BUDGET_TOKENS)), 10),
	turnTimeoutMs: parseInt(flag("turn-timeout", process.env.JARVIS_TURN_TIMEOUT ?? "600000"), 10),
	defaultMode: flag("mode", process.env.JARVIS_MODE || DEFAULT_MODE),
	// PRD 6. Dictation arrives in fragments; this is how long one waits for the
	// rest of itself. Tunable because the right number is a fact about how the
	// person speaks, not about the software.
	holdMs: parseInt(flag("hold", process.env.JARVIS_HOLD_MS ?? String(DEFAULT_HOLD_MS)), 10),

	// PRD 5a. The service is a separate process on loopback (see
	// services/whisper/serve.py); this is where it is, not something this
	// process starts. `off` is a real configuration: a server with no GPU
	// behind it should still run, and say plainly that it cannot hear.
	whisper: flag("whisper", process.env.JARVIS_WHISPER || "http://127.0.0.1:3461"),
	whisperTimeoutMs: parseInt(flag("whisper-timeout", process.env.JARVIS_WHISPER_TIMEOUT ?? "20000"), 10),
	audioMaxBytes: parseInt(flag("audio-max-bytes", process.env.JARVIS_AUDIO_MAX_BYTES ?? String(DEFAULT_MAX_AUDIO_BYTES)), 10),
	version: VERSION
};
config.jarvisCwd = config.jarvisCwd || config.workerCwd;

const tokenWasGenerated = !flag("token", null) && !process.env.JARVIS_TOKEN;

if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) { log.error(`--port must be a number, got "${flag("port", "")}"`); process.exit(1); }
if (!Number.isInteger(config.pingIntervalMs) || config.pingIntervalMs < 1000) { log.error(`--ping must be at least 1000 ms`); process.exit(1); }
if (!Number.isInteger(config.holdMs) || config.holdMs < 0 || config.holdMs > 30_000) { log.error(`--hold must be 0-30000 ms, got "${flag("hold", "")}"`); process.exit(1); }
if (!Number.isInteger(config.mcpPort) || config.mcpPort < 0 || config.mcpPort > 65535) { log.error(`--mcp-port must be a port number`); process.exit(1); }
if (!["readonly", "edits", "full"].includes(config.workerPerms)) { log.error(`--worker-perms must be readonly, edits or full, got "${config.workerPerms}"`); process.exit(1); }
// Checked at startup, not at the first spawn_worker, because at the first
// spawn the user is waiting on a lens for an answer about their own typo.
if (!isKnownModel(config.workerModel)) { log.error(`--worker-model "${config.workerModel}" is unknown; use ${MODEL_LIST}`); process.exit(1); }
if (!isKnownModel(config.jarvisModel)) { log.error(`--jarvis-model "${config.jarvisModel}" is unknown; use ${MODEL_LIST}`); process.exit(1); }
if (!isMode(config.defaultMode)) { log.error(`--mode must be one of ${Object.values(MODES).join(", ")}`); process.exit(1); }
if (!["jarvis", "echo"].includes(config.handler)) { log.error(`--handler must be jarvis or echo`); process.exit(1); }
if (!["claude", "stub"].includes(config.engine)) { log.error(`--engine must be claude or stub`); process.exit(1); }
if (config.whisper !== "off" && !/^https?:\/\//.test(config.whisper)) { log.error(`--whisper must be a URL or "off", got "${config.whisper}"`); process.exit(1); }
for (const [name, v] of [["--context-turns", config.contextTurns], ["--context-budget", config.contextBudget], ["--turn-timeout", config.turnTimeoutMs],
	["--whisper-timeout", config.whisperTimeoutMs], ["--audio-max-bytes", config.audioMaxBytes]]) {
	if (!Number.isInteger(v) || v <= 0) { log.error(`${name} must be a positive number`); process.exit(1); }
}

const store = new SessionStore(path.join(config.dataDir, "sessions"), { defaultMode: config.defaultMode });

// ------------------------------------------------------------- workers + tools
// PRD 2. The registry is the state the tools mutate; the engine is the seam
// PRD 3 replaces with real Claude Code sessions. Everything above the engine —
// registry, tools, MCP transport — is finished work either way.
const dirs = new NamedDirs(config.dirsFile, log);
const registry = new WorkerRegistry({
	file: path.join(config.dataDir, "workers.json"),
	log, defaultModel: config.workerModel, defaultCwd: config.workerCwd, dirs
});
const engine = config.engine === "stub"
	? createStubWorkerEngine({ log })
	: createClaudeWorkerEngine({ permissions: config.workerPerms, promptFile: config.workerPrompt, log, dataDir: config.dataDir, bin: config.claudeBin, timeoutMs: config.turnTimeoutMs });
const toolset = createToolset({ registry, engine, log, dirs });
const mcp = createMcpServer({ store, toolset, registry, log });

// ------------------------------------------------------------------- jarvis
// PRD 3. He is built even when `--handler echo` pins the transport, because
// building him is what proves his identity file survived the restart, and it
// costs nothing until something says a word to him.
const jarvis = createJarvis({
	log, dataDir: config.dataDir, mcp, registry, engine,
	bin: config.claudeBin,
	// The resolved id, not the spoken label. models.js pins full model names on
	// purpose — an alias silently follows whatever is promoted to "latest", and
	// Jarvis's model should not change under him between two restarts.
	model: resolveModel(config.jarvisModel).id,
	cwd: config.jarvisCwd,
	promptFile: config.jarvisPrompt,
	contextTurns: config.contextTurns,
	contextBudgetTokens: config.contextBudget,
	timeoutMs: config.turnTimeoutMs
});

// The one-word judgement behind a background notice (handler.js). Its own CLI
// runner: a worker's turn timeout is ten minutes and this must never sit that
// long, and it borrows nothing from the engine but the binary.
const classifier = config.engine === "stub" ? null : createClassifier({ cli: createClaudeRunner({ bin: config.claudeBin, log }), log });

// ---------------------------------------------------------------- listening
// PRD 5a R5a.5. Built either way, because the client decides when to open a
// microphone and the answer to "can you hear me" has to be a sentence rather
// than a crash. Whether the service is actually up is asked below, once, for
// the log — never per utterance, which would put a round trip in front of
// every segment.
const transcriber = config.whisper === "off"
	? createNullTranscriber()
	: createWhisperClient({ url: config.whisper, log, timeoutMs: config.whisperTimeoutMs });

const handler = config.handler === "echo"
	? createEchoHandler({ log, transcriber, audioMaxBytes: config.audioMaxBytes })
	: createJarvisHandler({ classifier, log, jarvis, registry, engine, transcriber, audioMaxBytes: config.audioMaxBytes, holdMs: config.holdMs });

// ----------------------------------------------------------------- TLS certs
// Re-read on mtime change so a certbot renewal lands without a restart
// (PRD 1 R1.1). Cached so this is not a disk hit per handshake.
let certCache = { mtime: 0, ctx: null };
const secureContext = () => {
	const m = Math.max(fs.statSync(config.cert).mtimeMs, fs.statSync(config.key).mtimeMs);
	if (certCache.ctx && m === certCache.mtime) return certCache.ctx;
	certCache = {
		mtime: m,
		ctx: createSecureContext({
			cert: fs.readFileSync(config.cert),
			key: fs.readFileSync(config.key),
			minVersion: "TLSv1.2"
		})
	};
	log.info("certificate loaded");
	return certCache.ctx;
};

// -------------------------------------------------------------- static files
const MIME = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
	".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
	".woff2": "font/woff2", ".map": "application/json"
};

const serveStatic = (req, res, url) => {
	// Resolve inside the root and verify: a request for ../../etc/passwd must
	// not escape, and normalising alone is not enough to prove it did not.
	let decoded;
	try {
		decoded = decodeURIComponent(url.pathname);
	} catch {
		// A malformed escape like "/%" throws. Unhandled, it left the request
		// unanswered and the socket open, before any authentication.
		res.writeHead(400, { "Content-Type": "text/plain" }).end("bad request path");
		return;
	}
	// A NUL byte can truncate a path inside a syscall; nothing legitimate has one.
	if (decoded.includes("\0")) { res.writeHead(400, { "Content-Type": "text/plain" }).end("bad request path"); return; }
	const rel = decoded.replace(/^\/+/, "") || "index.html";
	const full = path.resolve(config.staticDir, rel);
	if (full !== config.staticDir && !full.startsWith(config.staticDir + path.sep)) {
		res.writeHead(403).end("forbidden");
		return;
	}

	let target = full;
	try { if (fs.statSync(target).isDirectory()) target = path.join(target, "index.html"); }
	catch { /* fall through to the 404 below */ }

	if (!fs.existsSync(target)) {
		// Single-page client: unknown paths fall back to index.html when it exists.
		const index = path.join(config.staticDir, "index.html");
		if (fs.existsSync(index)) target = index;
		else { res.writeHead(404, { "Content-Type": "text/plain" }).end("no client built yet"); return; }
	}

	const body = fs.readFileSync(target);
	res.writeHead(200, {
		"Content-Type": MIME[path.extname(target)] ?? "application/octet-stream",
		"Content-Length": body.length,
		"Cache-Control": "no-cache"
	});
	res.end(body);
};

const proxyToDev = (req, res, url) => {
	const target = new URL(url.pathname + url.search, config.devProxy);
	const mod = target.protocol === "https:" ? https : http;
	const upstream = mod.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (up) => {
		res.writeHead(up.statusCode ?? 502, up.headers);
		up.pipe(res);
	});
	upstream.on("error", (e) => { res.writeHead(502, { "Content-Type": "text/plain" }).end(`dev proxy: ${e.message}`); });
	req.pipe(upstream);
};

// ------------------------------------------------------------------ requests
const onRequest = (req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

	if (url.pathname === "/healthz") {
		const body = JSON.stringify({
			ok: true, version: VERSION, protocol: PROTOCOL_VERSION,
			uptime: process.uptime(), sessions: store.sessions.size,
			connections: [...store.sessions.values()].reduce((n, s) => n + s.connectionCount, 0),
			workers: registry.size, mcpPort: mcp.port,
			// Enough to tell, from outside, which build is running and whether
			// Jarvis is the same conversation he was before the restart (R3.7).
			handler: config.handler, engine: engine.name,
			// Enough for an operator to tell "it cannot hear" from "it did not
			// understand" without reading the log.
			transcription: { service: transcriber.name, url: transcriber.url, maxBytes: config.audioMaxBytes },
			jarvis: { sessionId: jarvis.sessionId, model: jarvis.model, turns: jarvis.turns }
		});
		res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
		return res.end(body);
	}

	if (config.devProxy) return proxyToDev(req, res, url);
	return serveStatic(req, res, url);
};

// -------------------------------------------------------------------- server
let server;
if (config.cert && config.key) {
	secureContext();
	server = https.createServer({
		ALPNProtocols: ["http/1.1"],
		SNICallback: (_n, cb) => { try { cb(null, secureContext()); } catch (e) { cb(e); } },
		cert: fs.readFileSync(config.cert),
		key: fs.readFileSync(config.key)
	}, onRequest);
} else {
	server = http.createServer(onRequest);
}

// Nagle off: this carries short interactive messages where a coalescing delay
// is felt, and the same setting was needed on the previous system's hot path.
server.on("connection", (socket) => socket.setNoDelay(true));

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4 * 1024 * 1024 });
wss.on("connection", (ws, req) => attachConnection({ ws, req, store, config, handler, log, registry, mcp }));

server.on("clientError", (err, socket) => {
	log.warn(`client error: ${err.code || err.message}`);
	if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
server.on("error", (e) => {
	log.error(`server error: ${e.message}`);
	if (e.code === "EACCES") log.error("  ports below 1024 need CAP_NET_BIND_SERVICE");
	if (e.code === "EADDRINUSE") log.error("  something already listens there");
	process.exit(1);
});

// Bound before the public listener so a client that connects in the first
// millisecond cannot ask for a grant carrying port 0.
try {
	await mcp.listen(config.mcpPort);
} catch (e) {
	// Without the tool surface Jarvis can answer but not act, which is a
	// half-working system that looks whole. Refuse to start instead.
	log.error(`could not bind the MCP listener on 127.0.0.1:${config.mcpPort}: ${e.message}`);
	process.exit(1);
}

server.listen(config.port, config.host, () => {
	const scheme = config.cert ? "https" : "http";
	// The bound port, not the requested one: --port 0 asks the OS to pick, and a
	// log line claiming port 0 is useless to anything trying to connect.
	config.port = server.address().port;
	log.info(`jarvis-server ${VERSION} protocol ${PROTOCOL_VERSION} on ${scheme}://${config.host}:${config.port}`);
	log.info(`ws ${scheme === "https" ? "wss" : "ws"}://${config.host}:${config.port}/ws`);
	log.info(`client: ${config.devProxy ? `dev proxy ${config.devProxy}` : config.staticDir}`);
	log.info(`sessions: ${store.sessions.size} loaded from ${config.dataDir}`);
	log.info(`workers: default model ${config.workerModel}, default cwd ${config.workerCwd}`);
	log.info(`handler ${config.handler}, engine ${engine.name} (${config.claudeBin}), jarvis ${config.jarvisModel} session ${jarvis.sessionId.slice(0, 8)} cwd ${config.jarvisCwd}`);
	log.info(`routing: default mode ${config.defaultMode}, ${config.contextTurns} worker turns quoted to Jarvis`);
	// Asked once, after the listener is up so a slow answer delays nothing.
	// Not fatal either way: the whisper service can be started or restarted
	// under a running server, and the next segment will simply work.
	void transcriber.health().then((h) => {
		if (h.ok) log.info(`whisper: ${h.model ?? "?"} on ${h.device ?? "?"} at ${transcriber.url}`);
		else if (config.whisper === "off") log.warn("whisper: off — spoken input will be refused with a message");
		else log.warn(`whisper: ${transcriber.url} is not answering (${h.error}) — spoken input will say so until it is`);
	});
	if (tokenWasGenerated) log.info(`token (generated): ${config.token}`);
	if (scheme === "http") log.warn("no --cert/--key: serving plain HTTP");
});

// ----------------------------------------------------------------- lifecycle
let shuttingDown = false;
const shutdown = (signal) => {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info(`${signal} — shutting down`);
	for (const client of wss.clients) { try { client.close(4004, "server restarting"); } catch { } }
	// Before the listener, not after: a `claude` child outliving this process is
	// a model session nobody is reading and, on a restart loop, money.
	try { jarvis.dispose(); } catch { }
	try { engine.dispose?.(); } catch { }
	mcp.close();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// A bug in one connection must never take the process down with it.
process.on("uncaughtException", (e) => log.error(`UNCAUGHT: ${e.stack || e.message}`));
process.on("unhandledRejection", (r) => log.error(`UNHANDLED REJECTION: ${r?.stack || r}`));

export { config, store, wss, server, registry, mcp, jarvis, engine };
