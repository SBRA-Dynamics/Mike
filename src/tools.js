// The six tools from PRD 2, and nothing else.
//
// Each tool is a name, a description the model reads, a JSON schema, and a run
// function. They are declared here and served by mcp.js, which owns the
// transport, the auth and the event/log side effects — so this file stays
// readable as "what Mike can do".
//
// Two rules shape every handler:
//
//  * Errors are ToolError with a message written to be read out loud on a
//    50x10 lens (PRD 2 R2.5). Short, specific, no stack, no jargon. Anything
//    that escapes as a plain Error is a bug and mcp.js says so generically
//    rather than leaking it.
//  * Nothing is a filesystem path except `cwd`, which workers.js validates.
//    Names are matched, never joined onto a directory.
//
// Deliberately absent: a shell tool. Mike is a Claude Code session and has
// Bash already; a second path to the same capability only creates ambiguity
// about which one he should reach for (PRD 2, "Tools").

import { MODEL_LIST } from "./models.js";
import { msg } from "./protocol.js";
import { ToolError } from "./workers.js";

/** Largest transcript read_worker will return, whatever it is asked for.
 *  The cost of this lands in Mike's context, not in a log file. */
const MAX_READ_TURNS = 20;
const DEFAULT_READ_TURNS = 6;

// ------------------------------------------------------------------ argument checks
// Tool arguments come from a model. "It said it would send a string" is not a
// guarantee, and a TypeError deep in a handler reaches the user as
// "internal error", which tells them nothing they can act on.

const str = (v, field) => {
	if (typeof v !== "string" || !v.trim()) throw new ToolError(`${field} is missing`);
	return v;
};
const optStr = (v, field) => {
	if (v === undefined || v === null || v === "") return undefined;
	if (typeof v !== "string") throw new ToolError(`${field} must be text`);
	return v;
};
const optInt = (v, field) => {
	if (v === undefined || v === null) return undefined;
	const n = typeof v === "string" ? Number(v) : v;
	if (!Number.isFinite(n)) throw new ToolError(`${field} must be a number`);
	return Math.trunc(n);
};

// ------------------------------------------------------------------ rendering
// These strings are what Mike reads and then paraphrases onto the lens, so
// they are written as short facts rather than sentences.

const ago = (t) => {
	const s = Math.max(0, Math.round((Date.now() - t) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
};

const describe = (w, active) =>
	`${w.name} — ${w.model}, ${w.cwd}, ${w.busy ? "busy" : "idle"}, active ${ago(w.lastActivity)}` +
	(active === w.name ? "  [talking to]" : "");

/** The last thing a worker actually said, for a client that has just been put
 *  back in front of it. Switching to someone is not a new conversation — R3.6
 *  says it continues — so the lens has to show where it left off rather than
 *  the sentence announcing the switch, which is the one thing the user already
 *  knows. Null for a worker that has not spoken yet. */
const lastSaid = (engine, worker) => {
	try {
		const lines = engine.transcript(worker, 1) ?? [];
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i]?.role !== "user" && lines[i]?.text) return { from: worker.name, text: String(lines[i].text) };
		}
	} catch { /* a transcript we cannot read must not break the switch itself */ }
	return null;
};

/** The public shape of a worker record: the tool surface must not hand out the
 *  registry's internal fields (`key`, and whatever PRD 3 adds next to it). */
const publicWorker = (w) => ({
	name: w.name, id: w.id, model: w.model, cwd: w.cwd, systemPrompt: w.systemPrompt ?? "",
	busy: w.busy, created: w.createdAt, lastActivity: w.lastActivity
});

/**
 * Build the toolset.
 *
 * `ctx` per call is { session, registry, engine, log }. The session is the
 * conversation the tool call belongs to — that is what makes spawn_worker able
 * to switch "the active conversation" rather than some global.
 */
export function createToolset({ registry, engine, log, dirs }) {

	/** Setting the active worker is one operation with one event, because PRD 2
	 *  R2.2 says switching is part of spawning and not a second call. The
	 *  session stores the NAME: it is what `ready`/`state` carry and what PRD 3
	 *  injects as context, so rename and end have to keep it in step. */
	const setActive = (session, worker) => {
		session.worker = worker ? worker.name : null;
		session.store.touch(session);
		return session.worker;
	};

	/** A worker that ends or is renamed is not private to the session that did
	 *  it: any other session pointing at that name is left naming somebody who
	 *  does not exist. `ready` would then report a worker absent from its own
	 *  workers list, and PRD 3 routes on exactly this field — so the whole
	 *  store is brought along, and every affected session is told. */
	const retarget = (session, fromName, toName) => {
		for (const other of session.store.sessions.values()) {
			if (other === session || other.worker !== fromName) continue;
			other.worker = toName;
			session.store.touch(other);
			other.emit(msg.state({ worker: toName }));
		}
	};

	const tools = [
		{
			name: "list_workers",
			description: "List the workers that exist right now: name, model, working directory, whether they are busy, and when they were last active. Use this before guessing whether a worker exists.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			run: (_args, { session }) => {
				const all = registry.list();
				const active = session.worker;
				const text = all.length
					? all.map((w) => describe(w, active)).join("\n")
					: "no workers";
				return {
					kind: "workersListed",
					text,
					data: { workers: all.map(publicWorker), active }
				};
			}
		},

		{
			name: "spawn_worker",
			description: "Create a new worker and switch the conversation to it in one step. The user is talking to the new worker when this returns. Give it a `systemPrompt` saying what it is for — that is what it will still know on every later turn. Fails if the name is taken or the model is unknown.",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string", description: "What the user called it, as spoken. Omit when the user gave no name: one from the book is picked, and the reply says which." },
					systemPrompt: { type: "string", description: "Its system prompt — the worker-specific part, added to the standing instructions every session of this kind already gets. Written addressed to it, saying what it is responsible for: \"You are looking after the BLE firmware in MyLibrary.\" It is present on EVERY turn it ever takes, so it still knows its job an hour from now. Never mention workers, models or this orchestration — write the job, not the assignment." },
					model: { type: "string", description: `Which model to run: ${MODEL_LIST}. Omit to use the default.` },
					cwd: { type: "string", description: "Absolute path the worker works in, or one of the known names below. Omit to inherit the default." },
					prompt: { type: "string", description: "An optional first message, said to it once and then gone, like any other message. This is where a briefing goes — the state of play, what was just found, what to start on. Use it when the user wants work to begin now. Standing facts about what it IS belong in `systemPrompt`; put them here and they scroll out of reach." }
				},
				// `systemPrompt` is required, and that is a measured decision
				// rather than a taste one. With it optional, Mike wrote the
				// instructions he had been told to write — and put them in
				// `prompt` every single time, because "what it is" and "what to
				// do first" read as the same sentence from where he stands. The
				// difference is real: `prompt` is said once and scrolls away,
				// `systemPrompt` is present on every turn the worker ever takes.
				// Requiring it is what made him fill it in.
				required: ["systemPrompt"],
				additionalProperties: false
			},
			run: async (args, { session }) => {
				// No name is not an error: the worker gets one of the book's
				// names, free at the moment of asking (names.js).
				const name = optStr(args.name, "name")?.trim() || registry.freeName();
				const model = optStr(args.model, "model");
				const cwd = optStr(args.cwd, "cwd");
				const prompt = optStr(args.prompt, "prompt");
				const systemPrompt = optStr(args.systemPrompt, "systemPrompt");

				const worker = registry.create({ name, model, cwd, systemPrompt });
				try {
					const started = await engine.start(worker, { prompt });
					if (started?.engineSessionId) registry.touch(worker, { engineSessionId: started.engineSessionId });
				} catch (e) {
					// The record must not outlive a failed start, or the name is
					// taken by something that does not exist and the next attempt
					// fails with the wrong reason.
					registry.remove(worker.name);
					log?.error(`spawn ${worker.name}: engine start failed: ${e.stack || e.message}`);
					throw new ToolError(`could not start ${worker.name}`);
				}

				const active = setActive(session, worker);
				return {
					kind: "workerSpawned",
					text: `${worker.name} is running ${worker.model} in ${worker.cwd}. You are now talking to ${worker.name}.`,
					data: { worker: publicWorker(worker), active }
				};
			}
		},

		{
			name: "switch_worker",
			description: "Make an existing worker the one the user is talking to. Their transcript continues where it left off.",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string", description: "The worker's spoken name." } },
				required: ["name"],
				additionalProperties: false
			},
			run: (args, { session }) => {
				// `engine` is the closure's, not the call context's: the context
				// carries the session and nothing else about the machinery.
				const worker = registry.require(str(args.name, "name"));
				registry.touch(worker);
				const active = setActive(session, worker);
				return {
					kind: "workerSwitched",
					text: `Now talking to ${worker.name} (${worker.model}, ${worker.cwd}).`,
					data: { worker: publicWorker(worker), active, last: lastSaid(engine, worker) }
				};
			}
		},

		{
			name: "leave_worker",
			description: "Stop talking to the active worker and put the user back with you, without ending anything. The worker keeps running, keeps its transcript, and can be switched back to. Use this when the user wants to come back to you rather than to close something down.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			run: (_args, { session }) => {
				// Not an error when there is nobody to leave. The user asking to
				// come back to Mike while already with him has got what they
				// asked for, and a refusal would read as a fault they have to
				// understand before they can go on.
				const left = session.worker;
				if (!left) {
					return { kind: "workerSwitched", text: "You are already talking to Mike.", data: { active: null, left: null } };
				}
				setActive(session, null);
				// Deliberately only this session. Another device talking to that
				// worker is having its own conversation and did not ask to leave.
				return {
					kind: "workerSwitched",
					text: `Left ${left}. It keeps running. You are back with Mike.`,
					data: { active: null, left }
				};
			}
		},

		{
			name: "end_worker",
			description: "End a worker. Its transcript is kept but it is no longer listed and its name becomes free again.",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string", description: "The worker's spoken name." } },
				required: ["name"],
				additionalProperties: false
			},
			run: async (args, { session }) => {
				const worker = registry.require(str(args.name, "name"));
				await engine.stop(worker);
				registry.remove(worker.name);

				// Ending the worker you were talking to puts you back in front of
				// Mike rather than silently in front of somebody else.
				let active = session.worker;
				if (active && active === worker.name) active = setActive(session, null);
				retarget(session, worker.name, null);

				return {
					kind: "workerEnded",
					text: `${worker.name} has ended.${active ? "" : " You are back with Mike."}`,
					data: { worker: publicWorker(worker), active }
				};
			}
		},

		{
			name: "reset_worker",
			description: "Start a worker over from nothing: stop whatever it is doing and wipe its conversation, so it remembers nothing of what was said. It keeps its name, model, folder and system prompt, and stays the one the user is talking to if it was. Use this when the user wants to reset, clear or restart a worker, not end it.",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string", description: "The worker's spoken name." } },
				required: ["name"],
				additionalProperties: false
			},
			run: async (args, { session }) => {
				const worker = registry.require(str(args.name, "name"));
				const r = await engine.reset(worker);
				// Persisted in the same write as the new id: a restart between the
				// two would resume a session that was never created.
				registry.touch(worker, { engineSessionId: r?.engineSessionId ?? null, sessionCreated: false });
				return {
					kind: "workerReset",
					text: `${worker.name} starts over with a clean context.`,
					data: { worker: publicWorker(worker), active: session.worker }
				};
			}
		},

		{
			name: "read_worker",
			description: "Read the recent exchange from another worker, to answer a question about what it is doing. Returns a few turns, oldest first.",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string", description: "The worker's spoken name." },
					turns: { type: "integer", description: `How many exchanges to read. Default ${DEFAULT_READ_TURNS}, at most ${MAX_READ_TURNS}.` }
				},
				required: ["name"],
				additionalProperties: false
			},
			run: (args, { session }) => {
				const worker = registry.require(str(args.name, "name"));
				const asked = optInt(args.turns, "turns") ?? DEFAULT_READ_TURNS;
				const turns = Math.min(Math.max(1, asked), MAX_READ_TURNS);

				const lines = engine.transcript(worker, turns);
				const text = lines.length
					? lines.map((l) => `${l.role === "user" ? "user" : worker.name}: ${l.text}`).join("\n")
					: `${worker.name} has not said anything yet.`;
				return {
					kind: "workerRead",
					text,
					data: { worker: publicWorker(worker), turns: lines.length, active: session.worker }
				};
			}
		},

		{
			name: "rename_worker",
			description: "Give a worker a different spoken name. Fails if the new name is taken.",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string", description: "The worker's current name." },
					newName: { type: "string", description: "What to call it from now on." }
				},
				required: ["name", "newName"],
				additionalProperties: false
			},
			run: (args, { session }) => {
				const worker = registry.require(str(args.name, "name"));
				const wasActive = session.worker === worker.name;
				const before = worker.name;
				registry.rename(before, str(args.newName, "newName"));
				const active = wasActive ? setActive(session, worker) : session.worker;
				retarget(session, before, worker.name);
				return {
					kind: "workerRenamed",
					text: `${before} is now called ${worker.name}.`,
					data: { worker: publicWorker(worker), previousName: before, active }
				};
			}
		}
	];

	const byName = new Map(tools.map((t) => [t.name, t]));

	/** spawn_worker's `cwd` description, rebuilt on every call so an edit to
	 *  dirs.json is visible on the next tools/list without a restart — the same
	 *  mechanism that already keeps the model list current. */
	const cwdSchema = (base) => {
		const names = dirs?.names() ?? [];
		return { ...base, description: names.length ? `${base.description} Known names: ${names.join(", ")}.` : base.description };
	};

	return {
		/** What tools/list answers with — the schema half only. */
		definitions: () => tools.map(({ name, description, inputSchema }) => {
			if (name !== "spawn_worker") return { name, description, inputSchema };
			return {
				name, description,
				inputSchema: { ...inputSchema, properties: { ...inputSchema.properties, cwd: cwdSchema(inputSchema.properties.cwd) } }
			};
		}),
		has: (name) => byName.has(name),
		/** Run one tool. Throws ToolError for anything the user should hear. */
		run: async (name, args, ctx) => {
			const tool = byName.get(name);
			if (!tool) throw new ToolError(`there is no tool called "${String(name).slice(0, 30)}"`);
			if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
				throw new ToolError("the tool arguments were not an object");
			}

			// The schema's `required` is enforced here, because nothing else
			// enforces it. MCP hands the arguments straight through, so a schema
			// that says a field is required and a server that accepts the call
			// without it is a schema the model is free to ignore — which is
			// exactly what happened: spawn_worker asked for a system prompt, did
			// not get one, and said "ok".
			const supplied = args ?? {};
			for (const field of tool.inputSchema?.required ?? []) {
				const v = supplied[field];
				if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
					throw new ToolError(`${field} is missing`);
				}
			}
			return await tool.run(supplied, ctx);
		}
	};
}
