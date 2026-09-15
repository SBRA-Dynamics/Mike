// Extra MCP servers, from a file the operator owns.
//
// Every Claude Code session this server starts runs with `--strict-mcp-config`
// (claudeCli.js), which is deliberate: Mike and the workers are driven by
// voice, nobody is watching a permission prompt, and whatever servers the
// account happens to have configured with `claude mcp add` must not appear in
// them by accident. The price of that rule is that there was no way to give
// Mike a server on purpose either, which is what this file is.
//
// The format is Claude Code's own, so a block can be moved here from
// `~/.claude.json` unchanged:
//
//   { "mcpServers": { "example": { "type": "http", "url": "https://...",
//                               "headers": { "Authorization": "Bearer ..." } } } }
//
// Read once, at startup, and never re-read: the tokens in it are handed to
// child processes on a command line, and a file that changed under a running
// server would mean two turns of the same conversation had different tools
// with nothing in the log to say why. Editing it is a restart.
//
// Nothing here logs a server's `headers`. That value is a bearer token for
// somebody else's system, the server's log runs for months, and a log line is
// the easiest place in the whole system to leak one from.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the file lives, unless MIKE_MCP_SERVERS says otherwise. Resolved on
 *  each call rather than at import, so a test can set the variable before it
 *  starts a server in-process. */
export const extraMcpFile = () =>
	(process.env.MIKE_MCP_SERVERS ?? "").trim() || join(homedir(), ".config", "mike", "mcp.json");

/** A server's name becomes `mcp__<name>__<tool>` in Claude Code, which splits
 *  that back apart on "__". So a name containing "__" would produce tool names
 *  nothing can match, and one with a space or a quote in it would produce an
 *  --allowedTools entry that is not the word it looks like. Refused rather than
 *  mangled. */
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Mike's own tool server is added under this name (MCP_SERVER_NAME in
 *  mcp.js). An extra server may not take it: his tools are how the user's
 *  words reach the workers, and a name clash that silently won would take the
 *  orchestration away. */
const RESERVED = new Set(["mike"]);

/** What a whole server's tools are called in --allowedTools. Verified against
 *  claude 2.1.271: `mcp__example__*` allows every tool of the `example` server, and
 *  it does not restrict the built-in tools that are not named alongside it. */
export const mcpWildcard = (name) => `mcp__${name}__*`;

/** Log-safe: a name that failed validation is still going into a log line. */
const safe = (s) => String(s).replace(/\s+/g, " ").slice(0, 40);

/**
 * Read the file. Returns a plain `{ name: definition }` map, empty when there
 * is nothing to load or when the file cannot be understood.
 *
 * Every failure is one log line and an empty result. A server that will not
 * start because somebody left a comma in a JSON file is a worse outcome than a
 * server that starts without the extra tools and says so.
 */
export function loadExtraMcpServers({ file = extraMcpFile(), log } = {}) {
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch (e) {
		// No file is the ordinary case, not a fault: most installs have none.
		if (e.code === "ENOENT") log?.info(`mcp: no extra servers (${file} does not exist)`);
		else log?.warn(`mcp: could not read ${file} (${e.code ?? e.message}); no extra servers`);
		return {};
	}

	let parsed;
	try { parsed = JSON.parse(raw); }
	catch (e) { log?.warn(`mcp: ${file} is not valid JSON (${e.message}); no extra servers`); return {}; }

	const servers = parsed?.mcpServers;
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
		log?.warn(`mcp: ${file} has no "mcpServers" object; no extra servers`);
		return {};
	}

	const out = {};
	for (const [name, def] of Object.entries(servers)) {
		if (!NAME_OK.test(name) || name.includes("__")) {
			log?.warn(`mcp: ignoring server "${safe(name)}" from ${file}: the name cannot become an mcp__name__tool`);
			continue;
		}
		if (RESERVED.has(name)) {
			log?.warn(`mcp: ignoring server "${name}" from ${file}: that name belongs to mike's own tool server`);
			continue;
		}
		if (!def || typeof def !== "object" || Array.isArray(def)) {
			log?.warn(`mcp: ignoring server "${safe(name)}" from ${file}: its value is not an object`);
			continue;
		}
		out[name] = def;
	}

	const names = Object.keys(out);
	// Names only. See the header: the headers of these entries are credentials.
	if (names.length) log?.info(`mcp: ${names.length} extra server${names.length === 1 ? "" : "s"} from ${file}: ${names.join(", ")}`);
	else log?.info(`mcp: ${file} defines no usable servers`);
	return out;
}

let cached = null;

/**
 * The loaded set, read on the first call and kept.
 *
 * Two places need it (the grant mcp.js mints for Mike, and the config
 * workerEngine.js hands a worker) and they are built at different moments of
 * startup, so this is memoised: one read, one log line, and both of them see
 * exactly the same servers.
 */
export function extraMcpServers({ file, log } = {}) {
	if (!cached) cached = loadExtraMcpServers({ file, log });
	return cached;
}

/** Tests only: forget what was loaded, so one can be run against a file the
 *  previous one did not have. */
export function resetExtraMcpServers() { cached = null; }
