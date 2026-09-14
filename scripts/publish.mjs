#!/usr/bin/env node
// Upload the client to Even Hub — `npm run publish`.
//
// The evenhub CLI packs and logs in but cannot upload; the web portal does
// that. This does what the portal does, through the same API the portal's own
// page calls: the .ehpk goes to /versions/draft, and the draft becomes a
// version through /versions/create. Undocumented, so it may break when the
// portal changes — and when it does, uploading by hand still works.
//
// No account lives here. It uses whoever ran `evenhub login` on this machine,
// from the CLI's own credentials file, and refreshes the access token the way
// the CLI does (it lasts ten minutes). The upload is only accepted for an
// account that has the app named by client/app.json's package_id; a clone
// under somebody else's account needs its own package_id.
//
//   npm run publish                          pack, upload, create the version
//   npm run publish -- --no-pack             upload mike.ehpk as it is
//   npm run publish -- --changelog "text"    default: the last commit's subject
//   npm run publish -- --dry-run             log in and list versions, upload nothing

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.EVENHUB_BASE_URL || "https://hub.evenrealities.com";
const CREDENTIALS = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "evenhub", "credentials.yaml");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const fail = (message) => { console.error(`publish: ${message}`); process.exit(1); };

// ------------------------------------------------------------------ credentials
// The CLI writes flat YAML, with long values folded onto the next line (`>-`).
// Only that shape is read, and only that shape is written back.

const readCredentials = () => {
	if (!existsSync(CREDENTIALS)) fail("not logged in — run `evenhub login` first");
	const out = {};
	const lines = readFileSync(CREDENTIALS, "utf8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^([a-z_]+):\s*(.*)$/);
		if (!m) continue;
		let value = m[2].trim();
		if (value === ">-" || value === ">" || value === "|") {
			const folded = [];
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) folded.push(lines[++i].trim());
			value = folded.join(" ");
		}
		out[m[1]] = value.replace(/^["']|["']$/g, "");
	}
	if (!out.access_token || !out.refresh_token) fail(`no tokens in ${CREDENTIALS} — run \`evenhub login\``);
	return out;
};

const writeCredentials = (c) => {
	const body = Object.entries(c).map(([k, v]) => (String(v).length > 60 ? `${k}: >-\n  ${v}` : `${k}: ${v}`)).join("\n");
	writeFileSync(CREDENTIALS, body + "\n", { mode: 0o600 });
};

/** Seconds until a JWT expires; negative once it has. */
const expiresIn = (jwt) => {
	try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url")).exp - Date.now() / 1000; }
	catch { return -1; }
};

// ------------------------------------------------------------------ the API
// Every answer is { code, message, data }, and code 0 is success.

const call = async (method, path, { token, params, body } = {}) => {
	const url = new URL(path, BASE);
	for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
	const headers = token ? { "X-Even-Authorization": token } : {};
	if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
	const res = await fetch(url, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
	const text = await res.text();
	let json;
	try { json = JSON.parse(text); } catch { fail(`${path}: HTTP ${res.status}, not JSON: ${text.slice(0, 200)}`); }
	if (!res.ok || json.code !== 0) fail(`${path}: ${json.message ?? `HTTP ${res.status}`}${process.env.EVENHUB_API_DEBUG ? ` ${text}` : ""}`);
	return json.data;
};

const login = async () => {
	const c = readCredentials();
	// EVENHUB_FORCE_REFRESH exercises the path below without waiting ten minutes.
	if (expiresIn(c.access_token) > 30 && !process.env.EVENHUB_FORCE_REFRESH) return c.access_token;
	if (expiresIn(c.refresh_token) <= 0) fail("the login has expired — run `evenhub login` again");
	const data = await call("POST", "/api/v1/auth/refresh", { body: { refresh_token: c.refresh_token } });
	// Written back: the refresh may rotate the refresh token, and the CLI's
	// copy would then be the dead one.
	writeCredentials({ ...c, ...data });
	return data.access_token;
};

// ------------------------------------------------------------------ run

const app = JSON.parse(readFileSync(join(ROOT, "client", "app.json"), "utf8"));
const pkg = app.package_id;
const version = app.version;
const ehpk = join(ROOT, "mike.ehpk");

const token = await login();
await call("GET", "/api/v1/apps/check", { token, params: { package_id: pkg } });

const listed = await call("GET", "/api/v1/versions/list-private", { token, params: { package_id: pkg, page: 1, page_size: 20 } });
const versions = listed?.list ?? listed?.items ?? listed?.versions ?? (Array.isArray(listed) ? listed : []);
const known = versions.map((v) => v.version ?? v.version_name ?? v.name).filter(Boolean);
console.log(`${pkg}: ${known.length ? `latest uploaded ${known.slice(0, 3).join(", ")}` : "no versions listed"}; local ${version}`);
if (flag("dry-run")) {
	if (process.env.EVENHUB_API_DEBUG) console.log(JSON.stringify(listed, null, 2));
	process.exit(0);
}
if (known.includes(version)) fail(`${version} is already uploaded — bump the version in client/app.json and client/package.json`);

if (!flag("no-pack")) {
	const r = spawnSync("npm", ["--prefix", join(ROOT, "client"), "run", "pack"], { stdio: "inherit" });
	if (r.status !== 0) fail("pack failed");
}
if (!existsSync(ehpk)) fail(`no ${ehpk} — run without --no-pack`);

const changelog = option("changelog")
	?? spawnSync("git", ["-C", ROOT, "log", "-1", "--format=%s"], { encoding: "utf8" }).stdout.trim();

const form = new FormData();
form.append("ehpk", new Blob([readFileSync(ehpk)]), "mike.ehpk");
const draft = await call("POST", "/api/v1/versions/draft", { token, params: { package_id: pkg }, body: form });
const draftId = draft?.draft_id ?? draft?.id;
if (!draftId) fail(`the draft came back without an id: ${JSON.stringify(draft).slice(0, 200)}`);

const created = new FormData();
created.append("draft_id", String(draftId));
if (changelog) created.append("changelog", changelog);
await call("POST", "/api/v1/versions/create", { token, params: { package_id: pkg }, body: created });

console.log(`uploaded ${pkg} ${version}${changelog ? ` — ${changelog}` : ""}`);
