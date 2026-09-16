#!/usr/bin/env node
// Mike's setup wizard — `npm run setup`.
//
// A fresh clone needs four things that `npm install` cannot do on its own: a
// token, a few answers about where Claude Code should work and what a worker
// may do, optionally the transcription service (a Python venv with
// faster-whisper and the CUDA libraries, a couple of gigabytes), and optionally
// two systemd units so the whole thing starts at boot. This asks for each,
// with the sensible answer as the default, and writes one env file that both
// `npm start` and the units read: ~/.config/mike/env.
//
// Not part of `npm install` on purpose: npm runs lifecycle scripts without a
// terminal, so a question asked there is a hang, and a clone that needs
// building on a CI box must not stop to ask about GPUs.
//
//   npm run setup               ask everything
//   npm run setup -- --defaults answer every question with its default; no
//                               whisper, no systemd — what a script would want
//   npm run setup -- --dry-run  show the files it would write, write nothing
//
// No dependencies beyond Node: it has to run on a machine that has only just
// cloned the repository.

import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, readdirSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, userInfo, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const CONFIG_DIR = join(HOME, ".config", "mike");
const ENV_FILE = join(CONFIG_DIR, "env");
const DATA_DIR = join(HOME, ".local", "share", "mike");
const VENV = join(DATA_DIR, "venv");

const args = new Set(process.argv.slice(2));
const DEFAULTS = args.has("--defaults");
const DRY = args.has("--dry-run");

// ---------------------------------------------------------------- talking

const say = (s = "") => console.log(s);
const head = (s) => say(`\n${s}\n${"-".repeat(s.length)}`);

// Answers are read as lines, queued as they arrive. readline's own
// `question` loses lines that arrive before it is asked — which is every line
// when the answers are piped in (`printf 'a\nb\n' | npm run setup`), and a
// scripted install is exactly where that happens.
const rl = DEFAULTS ? null : createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
const queued = [];
const waiting = [];
let closed = false;
rl?.on("line", (l) => { const w = waiting.shift(); if (w) w(l); else queued.push(l); });
rl?.on("close", () => { closed = true; for (const w of waiting.splice(0)) w(""); });
const nextLine = () => queued.length ? Promise.resolve(queued.shift()) : closed ? Promise.resolve("") : new Promise((r) => waiting.push(r));

/** One question with a default. Enter takes the default; --defaults takes it
 *  without asking. */
const ask = async (question, def = "") => {
	if (DEFAULTS) return def;
	stdout.write(`${question}${def ? ` [${def}]` : ""}: `);
	const a = (await nextLine()).trim();
	if (!stdin.isTTY) stdout.write(`${a || def}\n`);
	return a || def;
};
const yes = async (question, def = true) => {
	const a = await ask(`${question} (${def ? "Y/n" : "y/N"})`, def ? "y" : "n");
	return /^y/i.test(a);
};
const pick = async (question, options, def) => {
	for (;;) {
		const a = (await ask(`${question} (${options.join("/")})`, def)).toLowerCase();
		if (options.includes(a)) return a;
		say(`  one of: ${options.join(", ")}`);
	}
};

/**
 * The pairing URL, made into one the app can actually read.
 *
 * The app parses a scanned link with `new URL()` and takes the ORIGIN as the
 * server address (client/src/qr.ts). So a typed answer that is only a hostname
 * is not a link at all — `kontoret.onvo.se/?token=…` throws there and the scan
 * fails with "That is not a link" — and one with no port silently points the
 * phone at 443 while the server listens somewhere else. Both were possible to
 * type here and neither showed up until a phone was held to the screen, so
 * they are fixed where they are typed:
 *
 *   - a missing scheme becomes https when there is a certificate, http without
 *   - a missing port becomes the port this server was just told to listen on,
 *     unless the scheme's own default (443/80) is that port
 *
 * Nothing is assumed silently: what it made of the answer is printed, and
 * anything it cannot parse at all is asked again rather than written to the
 * env file for the phone to fail on.
 */
const normalizePublicUrl = (raw, { cert, port }) => {
	// Trimmed but NOT stripped of its trailing slash yet: "http://" ends in one,
	// and stripping it first turns it into "http:", which then reads as a host
	// called "http" instead of the nonsense it is. The path is tidied at the end
	// instead, once URL has had its say about what is a host and what is not.
	const typed = String(raw ?? "").trim();
	if (!typed) return { error: "an address is needed — a hostname or an IP, with the port the phone reaches" };

	const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed);
	const withScheme = scheme ? typed : `${cert ? "https" : "http"}://${typed}`;

	let u;
	try { u = new URL(withScheme); }
	catch { return { error: `"${typed}" is not an address the app can read` }; }
	if (u.protocol !== "https:" && u.protocol !== "http:") {
		return { error: `the app only follows http and https links, not ${u.protocol.replace(":", "")}` };
	}
	if (!u.hostname) return { error: `"${typed}" has no host in it` };

	// `u.port` is empty both when none was typed and when the one typed is the
	// scheme's default, which is the case where leaving it off is correct.
	const implied = u.protocol === "https:" ? "443" : "80";
	if (!u.port && String(port) !== implied) u.port = String(port);

	const url = `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "")}`;
	const notes = [];
	if (!scheme) notes.push(`assumed ${u.protocol.replace(":", "")} (${cert ? "a certificate was given" : "no certificate was given"})`);
	if (u.port === String(port) && !new RegExp(`:${port}(/|$)`).test(typed)) notes.push(`added port ${port}`);
	if (u.protocol === "https:" && !cert) notes.push("https with no certificate here, so something in front of the server has to terminate TLS");
	if (u.protocol === "http:" && cert) notes.push("http, but this server has a certificate and will speak https — nothing will answer on an http link");
	else if (u.protocol === "http:") notes.push("plain http — the Even app needs https to reach this from a phone that is not on your LAN");
	return { url, notes };
};

/** Ask until the answer is one the phone can use. */
const askPublicUrl = async (def, opts) => {
	for (;;) {
		const { url, error, notes } = normalizePublicUrl(await ask("Public URL", def), opts);
		if (error) {
			say(`  ${error}`);
			// --defaults never reads a line, so a bad default must not spin.
			if (DEFAULTS) throw new Error(`MIKE_PUBLIC_URL: ${error}`);
			continue;
		}
		for (const n of notes) say(`  (${n})`);
		say(`  the phone will be sent to ${url}`);
		return url;
	}
};

const run = (cmd, argv, opts = {}) => {
	say(`  $ ${cmd} ${argv.join(" ")}`);
	if (DRY) return { status: 0 };
	return spawnSync(cmd, argv, { stdio: "inherit", ...opts });
};
const which = (bin) => { const r = spawnSync("which", [bin], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const canRead = (p) => { try { accessSync(p, constants.R_OK); return true; } catch { return false; } };

/**
 * Certificates certbot has already put on this machine.
 *
 * Asked for as a path because that is what the server takes, but nobody
 * remembers the path — it is six directories down and the answer was typed
 * once, months ago, into a systemd unit rather than into this file. So the
 * ones that are there are found and offered.
 *
 * Only pairs THIS user can read are offered, because the server runs as this
 * user and a path it cannot open is worse than no path at all: it starts,
 * and then fails at the first connection. certbot's own permissions keep
 * `privkey.pem` to root, so a readable one means somebody has already granted
 * access (an ACL, a group) and meant it.
 */
const letsencryptPairs = () => {
	const root = "/etc/letsencrypt/live";
	let names;
	try { names = readdirSync(root); }
	catch { return []; }
	return names.sort()
		.map((name) => ({ name, cert: join(root, name, "fullchain.pem"), key: join(root, name, "privkey.pem") }))
		.filter((c) => canRead(c.cert) && canRead(c.key));
};

/** ~/.config/mike/env as it is now, so a second run keeps the token and offers
 *  the previous answers as defaults. */
const readEnv = () => {
	const out = {};
	if (!existsSync(ENV_FILE)) return out;
	for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
		const m = line.match(/^([A-Z_]+)=(.*)$/);
		if (m) out[m[1]] = m[2];
	}
	return out;
};

const write = (file, text, mode) => {
	say(`  writing ${file}`);
	if (DRY) { say(text.split("\n").map((l) => `    | ${l}`).join("\n")); return; }
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	if (mode) chmodSync(file, mode);
};

// ------------------------------------------------------------------ checks

say("Mike setup");
say("==========");
say(`Repository: ${ROOT}`);

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
	say(`Node ${process.versions.node} is too old; Mike needs 22.18 or later.`);
	process.exit(1);
}
if (!existsSync(join(ROOT, "node_modules", "ws"))) say("\nnode_modules is missing — run `npm install` first.\n");

const previous = readEnv();
const claudeFound = which("claude") ?? join(HOME, ".local", "bin", "claude");
const gpu = which("nvidia-smi") !== null;

// --------------------------------------------------------------- questions

head("Claude Code");
say("Mike and every worker are Claude Code sessions. They need the `claude`");
say("binary, a directory to work in, and a decision about what a worker may do.");
const claudeBin = await ask("Path to the claude binary", previous.MIKE_CLAUDE_BIN ?? claudeFound);
if (!existsSync(claudeBin)) say(`  (not found at ${claudeBin} — install Claude Code first: https://claude.com/claude-code)`);

let workerCwd;
for (;;) {
	workerCwd = resolve(await ask("Directory workers start in", previous.MIKE_WORKER_CWD ?? ROOT));
	if (isDir(workerCwd)) break;
	say(`  ${workerCwd} is not a directory`);
	if (DEFAULTS) { workerCwd = ROOT; break; }
}
const mikeCwd = resolve(await ask("Directory Mike's own commands run in", previous.MIKE_CWD ?? workerCwd));

say("\nWhat a worker may do. `readonly` can read and run read-only commands;");
say("`edits` can change files in its directory; `full` runs with the same");
say("power as your user — with a listener on the internet, the token is then");
say("the ability to run code on this machine.");
const perms = await pick("Worker permissions", ["readonly", "edits", "full"], previous.MIKE_WORKER_PERMS ?? "readonly");
const mikeModel = await ask("Model for Mike", previous.MIKE_MODEL ?? "opus");
const workerModel = await ask("Default model for a worker", previous.MIKE_WORKER_MODEL ?? "sonnet");

head("Network");
const port = await ask("Port", previous.MIKE_PORT ?? "3460");
const host = await ask("Bind address (0.0.0.0 for every interface, 127.0.0.1 for this machine only)", previous.MIKE_HOST ?? "0.0.0.0");
say("\nTLS is optional. With a certificate and key the server speaks HTTPS, which");
say("the Even app needs to reach it from a phone that is not on your LAN.");
// What is already on the machine, unless the env file already names one — an
// answer given before beats a guess made now.
const found = previous.MIKE_CERT ? [] : letsencryptPairs();
if (found.length === 1) say(`\nFound a certificate for ${found[0].name} that this user can read; it is the default below.`);
else if (found.length > 1) {
	say(`\nCertificates this user can read, under /etc/letsencrypt/live:`);
	for (const c of found) say(`  ${c.name} — ${c.cert}`);
	say(`The first is the default below; paste another path to use it instead.`);
}
const cert = await ask("TLS certificate chain (blank for plain HTTP)", previous.MIKE_CERT ?? found[0]?.cert ?? "");
// The key that goes with the certificate just chosen, not the first one found:
// answering the cert prompt with a path from the list above should not then
// offer somebody else's key.
const chosenPair = letsencryptPairs().find((c) => c.cert === cert);
const pairedKey = chosenPair?.key;
const key = cert ? await ask("TLS private key", previous.MIKE_KEY ?? pairedKey ?? "") : "";

// The address the PHONE uses, which is not the bind address: a router that
// forwards an outside port, a hostname with a certificate, or just this
// machine's LAN address. It goes into the pairing link and nowhere else.
const lanIp = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "localhost";
say("\nThe public URL is what the phone connects to — through a router, a");
say("hostname, or straight to this machine on the LAN. It goes into the pairing link.");
// A previous answer is the best default there is, except in one case: it was
// given when there was no certificate, says http, and there is a certificate
// now. Offered as https then — as a DEFAULT, still shown and still editable,
// because the scheme is a fact about what the server will speak and the old
// answer is simply out of date.
const storedUrl = previous.MIKE_PUBLIC_URL;
const defaultUrl = cert && storedUrl?.startsWith("http://")
	? storedUrl.replace(/^http:\/\//, "https://")
	// The host a certificate is FOR beats the address of the machine it sits on.
	// A certificate for kontoret.onvo.se on a link to 192.168.1.177 is a name
	// mismatch, and the phone rejects it before the token is ever read — which
	// is a first run that took every default and still could not connect.
	: storedUrl ?? `${cert ? "https" : "http"}://${chosenPair?.name ?? lanIp}:${port}`;
if (defaultUrl !== storedUrl && storedUrl) say(`(${storedUrl} was saved before the certificate was; offering it as https)`);
const publicUrl = await askPublicUrl(defaultUrl, { cert, port });
const token = previous.MIKE_TOKEN || randomBytes(16).toString("hex");
if (previous.MIKE_TOKEN) say("\nKeeping the existing token from ~/.config/mike/env.");

head("Transcription (voice)");
say("Voice needs faster-whisper in a Python venv under ~/.local/share/mike/venv,");
say(`about 2.5 GB with the CUDA libraries. ${gpu ? "An NVIDIA GPU was found." : "No NVIDIA GPU was found; CPU works, slower."}`);
const whisperInstalled = existsSync(join(VENV, "bin", "python"));
const wantWhisper = DEFAULTS ? false : await yes(whisperInstalled ? "Reinstall the transcription service" : "Install the transcription service", !whisperInstalled);
let device = previous.MIKE_WHISPER_DEVICE ?? (gpu ? "cuda" : "cpu");
let compute = previous.MIKE_WHISPER_COMPUTE ?? (gpu ? "float16" : "int8");
if (wantWhisper || whisperInstalled) {
	device = await pick("Whisper device", ["cuda", "cpu"], device);
	compute = await ask("Compute type", device === "cuda" ? "float16" : "int8");
}

head("Starting at boot");
say("Two systemd units, one for the server and one for the transcription service,");
say("run as your user and read the same env file. Installing them needs sudo.");
const wantSystemd = DEFAULTS ? false : await yes("Install systemd units and start them now", which("systemctl") !== null);

// ------------------------------------------------------------------ writing

head("Writing");
const env = {
	MIKE_TOKEN: token,
	MIKE_PORT: port,
	MIKE_HOST: host,
	...(cert ? { MIKE_CERT: cert, MIKE_KEY: key } : {}),
	MIKE_PUBLIC_URL: publicUrl,
	MIKE_CLAUDE_BIN: claudeBin,
	MIKE_WORKER_CWD: workerCwd,
	MIKE_CWD: mikeCwd,
	MIKE_WORKER_PERMS: perms,
	MIKE_MODEL: mikeModel,
	MIKE_WORKER_MODEL: workerModel,
	MIKE_WHISPER_DEVICE: device,
	MIKE_WHISPER_COMPUTE: compute
};
write(ENV_FILE, [
	"# Mike — written by `npm run setup`. Read by `npm start` and the systemd units.",
	"# The token is the whole of the authentication: keep this file to yourself.",
	...Object.entries(env).map(([k, v]) => `${k}=${v}`),
	""
].join("\n"), 0o600);

if (wantWhisper) {
	head("Installing the transcription service");
	const python = which("python3");
	if (!python) say("  python3 is not installed — on Debian/Ubuntu: sudo apt install python3 python3-venv");
	else {
		const steps = [
			[python, ["-m", "venv", VENV]],
			[join(VENV, "bin", "pip"), ["install", "--upgrade", "pip", "faster-whisper"]],
			...(device === "cuda" ? [[join(VENV, "bin", "pip"), ["install", "nvidia-cublas-cu12", "nvidia-cudnn-cu12"]]] : []),
			[join(VENV, "bin", "python"), [join(ROOT, "services", "whisper", "serve.py"), "--warm-only", "--device", device, "--compute-type", compute]]
		];
		for (const [cmd, argv] of steps) {
			const r = run(cmd, argv, { env: { ...process.env, ...env } });
			if (r.status !== 0) { say(`  failed: ${cmd} ${argv.join(" ")}`); break; }
		}
	}
}

const user = userInfo().username;
const unitDir = join(CONFIG_DIR, "systemd");
const serverUnit = `[Unit]
# Mike server — written by \`npm run setup\` in ${ROOT}.
Description=Mike server (transport, sessions, client hosting)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${ROOT}
Environment=PATH=${dirname(process.execPath)}:${dirname(claudeBin)}:/usr/local/bin:/usr/bin:/bin
Environment=HOME=${HOME}
EnvironmentFile=${ENV_FILE}
ExecStart=${process.execPath} ${join(ROOT, "server.js")}
Restart=always
RestartSec=5
# The server reaps its own claude children on SIGTERM; this is the backstop.
KillMode=control-group
TimeoutStopSec=15
# A real file, never an inherited tty: a console.log into a closed terminal
# throws EIO into an uncaught handler and requests silently stop completing.
StandardOutput=append:${HOME}/mike-server.log
StandardError=append:${HOME}/mike-server.log

[Install]
WantedBy=multi-user.target
`;
const whisperUnit = `[Unit]
# Mike transcription service — written by \`npm run setup\` in ${ROOT}.
Description=Mike transcription service (faster-whisper)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${ROOT}
Environment=HOME=${HOME}
EnvironmentFile=${ENV_FILE}
ExecStart=${join(VENV, "bin", "python")} ${join(ROOT, "services", "whisper", "serve.py")} --port 3461 --host 127.0.0.1
Restart=always
RestartSec=5
TimeoutStartSec=120
TimeoutStopSec=15
StandardOutput=append:${HOME}/mike-whisper.log
StandardError=append:${HOME}/mike-whisper.log

[Install]
WantedBy=multi-user.target
`;
write(join(unitDir, "mike-server.service"), serverUnit);
write(join(unitDir, "mike-whisper.service"), whisperUnit);

if (wantSystemd) {
	head("Installing the systemd units (sudo)");
	const units = ["mike-server"];
	if (wantWhisper || whisperInstalled) units.push("mike-whisper");
	const files = units.map((u) => join(unitDir, `${u}.service`));
	const r1 = run("sudo", ["cp", ...files, "/etc/systemd/system/"]);
	if (r1.status === 0) {
		run("sudo", ["systemctl", "daemon-reload"]);
		run("sudo", ["systemctl", "enable", "--now", ...units]);
	}
}

// ------------------------------------------------------------------- done

head("Done");
const link = `${publicUrl}/?token=${token}`;
say("Scan this from the Mike app on the phone (Scan QR), or open the link once in a browser:");
say(`\n  ${link}\n`);
// A QR in the terminal, from the one dependency this script has; it is
// installed by `npm install`, and a clone that skipped that gets the link.
try {
	const { default: qr } = await import("qrcode-terminal");
	qr.generate(link, { small: true }, (code) => say(code));
} catch {
	say("(npm install first, and the link comes as a QR code here too)");
}
if (!wantSystemd) {
	say("To run by hand:");
	say("  npm start                     # the server, reading ~/.config/mike/env");
	if (wantWhisper || whisperInstalled) say("  npm run whisper               # the transcription service");
}
say(`Settings live in ${ENV_FILE}; run \`npm run setup\` again to change them.`);
rl?.close();
