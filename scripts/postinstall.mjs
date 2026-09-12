// Runs after `npm install` in the repository root: the Even Hub client has its
// own package.json, so its dependencies are installed and it is built here,
// into ./public where the server serves it from. Nothing interactive — npm
// runs this without a terminal — so the questions live in `npm run setup`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A dependency of something else, or a CI that only wants the server: the
// client is skipped when its directory is not here or when asked to.
if (!existsSync(join(ROOT, "client", "package.json")) || process.env.MIKE_SKIP_CLIENT) process.exit(0);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const step = (argv) => {
	const r = spawnSync(npm, argv, { cwd: ROOT, stdio: "inherit" });
	if (r.status !== 0) process.exit(r.status ?? 1);
};
step(["--prefix", "client", "install", "--no-audit", "--no-fund"]);
step(["--prefix", "client", "run", "build"]);
console.log("\nClient built into ./public. Next: `npm run setup` for the token, Claude Code, voice and autostart.\n");
