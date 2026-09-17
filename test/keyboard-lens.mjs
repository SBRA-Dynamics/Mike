// The keyboard's text box on the lens — its bottom row, drawn by renderLens.
//
//   node test/keyboard-lens.mjs

import { check, failed, section } from "./harness.mjs";
// The client's own copy of the firmware's width table, the one render.ts measures with.
import { getTextWidth } from "../client/node_modules/@evenrealities/pretext/dist/font_measure.js";
import { renderLens, inputWindow, LENS, FRAME_PX, CARET } from "../client/src/lens/render.ts";

const view = { from: "Mike", text: "Hello, Man.", page: 0 };
const bottom = (f) => f.lines[LENS.rows - 1];
const bottomPx = (f) => f.content.split("\n")[LENS.rows - 1];

section("textruta — bara när ett tangentbord är anslutet");
const plain = renderLens(view);
check("utan tangentbord är nedersta raden ramens kant", bottom(plain).startsWith("╰─") && !bottom(plain).includes(CARET), bottom(plain));

const empty = renderLens({ ...view, input: { text: "", cursor: 0 } });
check("tom rad visar prompt och markör", bottom(empty).startsWith(`╰─ > ${CARET}`), bottom(empty));
check("raden slutar i hörnet", bottom(empty).endsWith("╯"));
check("lika många rader som annars", empty.lines.length === LENS.rows && empty.content.split("\n").length === LENS.rows);
check("brödtexten är orörd", empty.lines.slice(0, -1).join("\n") === plain.lines.slice(0, -1).join("\n"));

section("markören");
const mid = renderLens({ ...view, input: { text: "kör testerna", cursor: 3 } });
check("markören står där cursor säger", bottom(mid).includes(`kör${CARET} testerna`), bottom(mid));
check("markör i slutet", bottom(renderLens({ ...view, input: { text: "hej", cursor: 3 } })).includes(`hej${CARET}`));
check("cursor utanför raden kläms", bottom(renderLens({ ...view, input: { text: "hej", cursor: 99 } })).includes(`hej${CARET}`));
check("svenska tecken räknas som ett tecken", bottom(renderLens({ ...view, input: { text: "åäö", cursor: 2 } })).includes(`åä${CARET}ö`));

section("lång rad — fönster runt markören");
const long = "the quick brown fox jumps over the lazy dog and keeps running far past the edge of the lens";
const chars = Array.from(long);
for (const cursor of [0, 10, 45, chars.length]) {
	const f = renderLens({ ...view, input: { text: long, cursor } });
	const row = bottomPx(f);
	const before = chars.slice(Math.max(0, cursor - 3), cursor).join("");
	check(`cursor ${cursor}: markören syns med texten före`, row.includes(before + CARET), row);
	check(`cursor ${cursor}: ryms i pixlar`, getTextWidth(row) <= FRAME_PX + 5, `${getTextWidth(row)} px`);
	check(`cursor ${cursor}: ryms i kolumner`, bottom(f).length <= LENS.cols, `${bottom(f).length}`);
	check(`cursor ${cursor}: klippt sida har ellips`, (cursor > 20 ? row.includes("…" ) : true) && (cursor < chars.length - 10 ? row.includes("…") : true), row);
}
const w = inputWindow({ text: long, cursor: 20 }, 40, 400);
check("text efter markören lämnas synlig", /\|.{8}/u.test(w), w);

if (failed()) process.exit(1);
