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
import { createEchoHandler } from "./src/handler.js";
import { PROTOCOL_VERSION } from "./src/protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "0.1.0";

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
	version: VERSION
};

const tokenWasGenerated = !flag("token", null) && !process.env.JARVIS_TOKEN;

const store = new SessionStore(path.join(config.dataDir, "sessions"));
const handler = createEchoHandler({ log });

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
	const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
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
			connections: [...store.sessions.values()].reduce((n, s) => n + s.connectionCount, 0)
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
wss.on("connection", (ws, req) => attachConnection({ ws, req, store, config, handler, log }));

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

server.listen(config.port, config.host, () => {
	const scheme = config.cert ? "https" : "http";
	log.info(`jarvis-server ${VERSION} protocol ${PROTOCOL_VERSION} on ${scheme}://${config.host}:${config.port}`);
	log.info(`ws ${scheme === "https" ? "wss" : "ws"}://${config.host}:${config.port}/ws`);
	log.info(`client: ${config.devProxy ? `dev proxy ${config.devProxy}` : config.staticDir}`);
	log.info(`sessions: ${store.sessions.size} loaded from ${config.dataDir}`);
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
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// A bug in one connection must never take the process down with it.
process.on("uncaughtException", (e) => log.error(`UNCAUGHT: ${e.stack || e.message}`));
process.on("unhandledRejection", (r) => log.error(`UNHANDLED REJECTION: ${r?.stack || r}`));

export { config, store, wss, server };
