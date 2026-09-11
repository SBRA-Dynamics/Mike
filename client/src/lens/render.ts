// The lens frame — PRD 4 R4.2.
//
// Pure: no DOM, no SDK, no clock. Everything the glasses show and everything
// the companion's preview shows comes out of renderLens(), so the two cannot
// disagree about a line break, a page number or a truncation. The simulator
// test screenshots what this produces; the unit suite asserts on the same
// strings.
//
// Two budgets, both enforced, and the reason is the firmware font:
//
//   * 50 columns, because that is the number the PRD and the preview box are
//     written against, and the preview is monospace.
//   * 576 pixels, because the firmware font is PROPORTIONAL. Fifty 'i's are
//     249 px and fifty 'W's are 800 px — a column count alone would let a wide
//     line wrap on the glasses at a place the preview never showed, which is
//     exactly the class of layout surprise R4.4 says the preview exists to
//     prevent. @evenrealities/pretext carries the firmware's own advance-width
//     table, so this is measurement, not estimation.

import { getTextWidth } from "@evenrealities/pretext";

/** The lens, as the firmware defines it. 288 / 27 = 10 whole rows. */
export const LENS = {
	width: 576,
	height: 288,
	lineHeight: 27,
	cols: 50,
	rows: 10
} as const;

/** One row is spent on who is speaking (R4.2); the rest is the reply. */
export const BODY_ROWS = LENS.rows - 1;

/** Glyphs used as chrome. Checked against the firmware font table, not
 *  guessed: `▾` and `✓` measure 0 px there, which means "no glyph", and a
 *  missing glyph is a box on the user's eye. `·`, `↑` and `↓` all exist. */
const SEP = " · ";
const UP = "↑";
const DOWN = "↓";
const ELLIPSIS = "…";

export type LensView = {
	/** Who is speaking: "Jarvis", a worker's name, or a system label. */
	from: string;
	text: string;
	/** Short status shown next to the name — "thinking", "offline", "paused". */
	status?: string | null;
	/** Which page of an overflowing reply to show. Clamped, never trusted. */
	page?: number;
};

export type LensFrame = {
	header: string;
	/** Exactly LENS.rows lines, padded with "" — what the preview renders. */
	lines: string[];
	/** The same text with trailing blank rows dropped — what the glasses get. */
	content: string;
	page: number;
	pages: number;
	/** True when the reply did not fit on this page. R4.2: never a silent cut. */
	overflow: boolean;
};

/** Does this candidate line fit both budgets? */
const fits = (s: string, cols: number, px: number) => s.length <= cols && getTextWidth(s) <= px;

/**
 * Break a word that does not fit on a line of its own — a URL, a path, a hash.
 * Walks forward one character at a time rather than binary-searching: a line is
 * at most fifty characters, and the linear version is the one that is obviously
 * right about surrogate pairs.
 */
const breakWord = (word: string, cols: number, px: number): string[] => {
	const out: string[] = [];
	let cur = "";
	for (const ch of word) {
		const next = cur + ch;
		if (cur && !fits(next, cols, px)) { out.push(cur); cur = ch; }
		else cur = next;
	}
	if (cur) out.push(cur);
	return out;
};

/** Greedy wrap of one paragraph (no newlines) to the lens budgets. */
export const wrapParagraph = (text: string, cols = LENS.cols, px = LENS.width): string[] => {
	const words = text.split(/[ \t]+/).filter((w) => w.length > 0);
	if (!words.length) return [""];

	const lines: string[] = [];
	let cur = "";
	for (const word of words) {
		const candidate = cur ? `${cur} ${word}` : word;
		if (fits(candidate, cols, px)) { cur = candidate; continue; }

		if (cur) { lines.push(cur); cur = ""; }
		if (fits(word, cols, px)) { cur = word; continue; }

		// A single word wider than the lens. Break it rather than let the
		// firmware do it: the firmware's break point is not visible in the
		// preview, and a broken URL the user can read is better than one that
		// vanishes past the right edge.
		const pieces = breakWord(word, cols, px);
		lines.push(...pieces.slice(0, -1));
		cur = pieces[pieces.length - 1] ?? "";
	}
	if (cur) lines.push(cur);
	return lines;
};

/** Wrap text that may already contain line breaks. */
export const wrapText = (text: string, cols = LENS.cols, px = LENS.width): string[] => {
	const normalized = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
	const out: string[] = [];
	for (const para of normalized.split("\n")) out.push(...wrapParagraph(para, cols, px));
	// A reply that is only whitespace still has to occupy the lens with
	// something, or the user sees the previous answer and thinks it is the new one.
	return out.length ? out : [""];
};

/** Split wrapped lines into pages of `rows` rows. */
export const paginate = (lines: string[], rows = BODY_ROWS): string[][] => {
	if (rows < 1) return [lines];
	const pages: string[][] = [];
	for (let i = 0; i < lines.length; i += rows) pages.push(lines.slice(i, i + rows));
	return pages.length ? pages : [[]];
};

/**
 * The header row: who is speaking, then status, then the page counter and the
 * arrows that say there is more. Built suffix-first — if something has to be
 * cut it is the name, because a name cut to "Bosse…" is still legible and a
 * missing "2/3 ↓" hides the existence of the rest of the reply.
 */
export const buildHeader = (from: string, status: string | null | undefined, page: number, pages: number,
	cols = LENS.cols, px = LENS.width): string => {
	const marks = [
		pages > 1 ? `${page + 1}/${pages}` : "",
		pages > 1 && page > 0 ? UP : "",
		pages > 1 && page < pages - 1 ? DOWN : ""
	].filter(Boolean).join(" ");

	const tail = [status ?? "", marks].filter(Boolean).join(SEP);
	const suffix = tail ? SEP + tail : "";

	const name = String(from || "").trim() || "Jarvis";
	const budgetCols = cols - suffix.length;
	const budgetPx = px - getTextWidth(suffix);
	if (fits(name, budgetCols, budgetPx)) return name + suffix;

	// Trim to whichever budget bites first. pxTruncate would only honour the
	// pixel one, and the preview box counts columns.
	let cut = "";
	for (const ch of name) {
		const next = cut + ch + ELLIPSIS;
		if (!fits(next, budgetCols, budgetPx)) break;
		cut += ch;
	}
	return (cut ? cut + ELLIPSIS : ELLIPSIS) + suffix;
};

/** The whole frame. `page` is clamped, so a stale page index from a previous,
 *  longer reply cannot show an empty lens. */
export const renderLens = (view: LensView): LensFrame => {
	const body = wrapText(view.text ?? "");
	const pages = paginate(body);
	const page = Math.max(0, Math.min(view.page ?? 0, pages.length - 1));
	const header = buildHeader(view.from, view.status, page, pages.length);

	const lines = [header, ...pages[page]];
	while (lines.length < LENS.rows) lines.push("");

	// Trailing blank rows are bytes over BLE that change nothing on the lens.
	let last = lines.length;
	while (last > 1 && lines[last - 1] === "") last--;

	return {
		header,
		lines: lines.slice(0, LENS.rows),
		content: lines.slice(0, last).join("\n"),
		page,
		pages: pages.length,
		overflow: pages.length > 1
	};
};
