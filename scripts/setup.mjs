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
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
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

const run = (cmd, argv, opts = {}) => {
	say(`  $ ${cmd} ${argv.join(" ")}`);
	if (DRY) return { status: 0 };
	return spawnSync(cmd, argv, { stdio: "inherit", ...opts });
};
const which = (bin) => { const r = spawnSync("which", [bin], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

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
const cert = await ask("TLS certificate chain (blank for plain HTTP)", previous.MIKE_CERT ?? "");
const key = cert ? await ask("TLS private key", previous.MIKE_KEY ?? "") : "";
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
const scheme = cert ? "https" : "http";
const shownHost = host === "0.0.0.0" ? "<this machine's address>" : host;
say(`Pairing link (scan it from the app, or open it once in a browser):`);
say(`\n  ${scheme}://${shownHost}:${port}/?token=${token}\n`);
if (which("qrencode")) {
	const r = spawnSync("qrencode", ["-t", "ANSIUTF8", `${scheme}://${host === "0.0.0.0" ? "localhost" : host}:${port}/?token=${token}`], { encoding: "utf8" });
	if (r.status === 0) say(r.stdout);
} else say("(install qrencode to get the link as a QR code in the terminal)");
if (!wantSystemd) {
	say("To run by hand:");
	say("  npm start                     # the server, reading ~/.config/mike/env");
	if (wantWhisper || whisperInstalled) say("  npm run whisper               # the transcription service");
}
say(`Settings live in ${ENV_FILE}; run \`npm run setup\` again to change them.`);
rl?.close();
