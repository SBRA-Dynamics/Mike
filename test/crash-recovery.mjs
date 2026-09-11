// Regression for the seq-reuse bug QA found: a crash between the log append and
// the meta rewrite must not let the server hand out a sequence number twice.
import { startServer, connect, check, failed, section, sleep } from "/home/robin/jarvis/test/harness.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const server = await startServer();
section("seq återanvänds inte efter en krasch");
const c = await connect(server);
const id = c.readyMsg.sessionId;
// sayAndSettle, not send-then-waitFor: waiting on a repeated message type
// without a mark matches the previous turn's and races ahead, which is how
// this test first "passed" while comparing against a stale sequence number.
for (const t of ["ett", "två", "tre"]) await c.sayAndSettle(t);
const seqBefore = Math.max(...c.messages.filter((m) => m.seq).map((m) => m.seq));
c.close();
await sleep(300);

// Rewind the meta as a crash between append and rewrite would.
const metaPath = join(server.dataDir, "sessions", `${id}.meta.json`);
const meta = JSON.parse(readFileSync(metaPath, "utf8"));
const rewound = Math.max(1, meta.seq - 2);
writeFileSync(metaPath, JSON.stringify({ ...meta, seq: rewound }));
console.log(`  meta bakåtspolad ${meta.seq} -> ${rewound}, loggen har ${seqBefore}`);

await server.restart();
const c2 = await connect(server, { sessionId: id });
check("servern litar på loggen, inte den bakåtspolade metan", c2.readyMsg.cursor >= seqBefore,
  `cursor=${c2.readyMsg.cursor} < ${seqBefore}`);
c2.send({ type: "say", text: "efter kraschen" });
const after = await c2.waitFor((m) => m.type === "text" && m.text.includes("efter kraschen"), 5000, "eko");
check("nya meddelanden får nummer ovanför loggen", after.seq > seqBefore, `${after.seq} <= ${seqBefore}`);

const lines = readFileSync(join(server.dataDir, "sessions", `${id}.jsonl`), "utf8").split("\n").filter(Boolean).map(JSON.parse);
const seqs = lines.map((l) => l.seq);
check("inget seq förekommer två gånger i transkriptet", new Set(seqs).size === seqs.length,
  JSON.stringify(seqs.filter((v, i) => seqs.indexOf(v) !== i)));
server.stop();
console.log(failed() === 0 ? "\nPASS\n" : `\nFAIL (${failed()})\n`);
process.exit(failed() === 0 ? 0 : 1);
