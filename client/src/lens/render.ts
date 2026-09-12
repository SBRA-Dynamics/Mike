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

/** Glyphs used as chrome. Checked against the firmware font table, not
 *  guessed: `▾` and `✓` measure 0 px there, which means "no glyph", and a
 *  missing glyph is a box on the user's eye. `·`, `↑` and `↓` all exist. */
const SEP = " · ";
const UP = "↑";
const DOWN = "↓";
const ELLIPSIS = "…";

/**
 * The frame — a window, with the header as its title bar.
 *
 * Drawn in text rather than with the container's own border, because a border
 * is part of the container and would stay lit when the lens is meant to be
 * dark (LENS_IDLE_MS, and "display off"); a frame made of glyphs goes away
 * with the rest of the content. The rounded corners and the lines all exist in
 * the firmware font and all measure 20 px, which is what makes the arithmetic
 * below exact: a frame 28 glyphs wide is 560 px, and every row is padded to
 * that width so the right edge lines up. The microphone marks likewise — the
 * emoji everybody reaches for first measures as a missing glyph.
 */
const CORNER_TL = "╭";
const CORNER_TR = "╮";
const CORNER_BL = "╰";
const CORNER_BR = "╯";
const EDGE_H = "─";
const EDGE_V = "│";
/** The microphone, at the right end of the title bar: open and hearing, or
 *  not. Its own slot, so it is there whatever the status word is saying —
 *  "thinking 12s" used to hide whether anyone was listening. */
export const MIC_LIVE = "●";
export const MIC_OFF = "○";

/** Twenty-eight glyphs of 20 px. Sixteen pixels of the lens are left unused
 *  at the right, which is the price of an edge that is straight. */
export const FRAME_PX = 560;
const SIDE_L = `${EDGE_V} `;
const SIDE_R = ` ${EDGE_V}`;
const TITLE_L = `${CORNER_TL}${EDGE_H} `;

/** The title bar and the bottom edge each take a row; the rest is the reply. */
export const BODY_ROWS = LENS.rows - 2;
/** What a body row can hold between the two edges, in both budgets. */
export const BODY_COLS = LENS.cols - SIDE_L.length - SIDE_R.length;
export const BODY_PX = FRAME_PX - getTextWidth(SIDE_L) - getTextWidth(SIDE_R);

export type LensMic = "live" | "off" | null;

export type LensView = {
	/** Who is speaking: "Mike", a worker's name, or a system label. */
	from: string;
	text: string;
	/** Short status shown next to the name — "thinking", "offline", "paused". */
	status?: string | null;
	/** The microphone: hearing, not hearing, or there is none to speak of. */
	mic?: LensMic;
	/** Which page of an overflowing reply to show. Clamped, never trusted. */
	page?: number;
	/** Nothing at all — the idle lens (LENS_IDLE_MS). A frame rather than a
	 *  caller-side special case, so the companion preview shows the dark lens
	 *  too and the two faces cannot disagree about what is on the glass. */
	blank?: boolean;
};

export type LensFrame = {
	/** The title text alone: who is speaking and the status, without the frame
	 *  around it. What the tests read; the glasses get it inside the bar. */
	header: string;
	/** Exactly LENS.rows lines, padded with "" — what the preview renders,
	 *  padded by columns because the preview is monospace. */
	lines: string[];
	/** The same rows padded by pixels for the firmware's proportional font —
	 *  what the glasses get. */
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

/** Greedy wrap of one paragraph (no newlines) to the body's budgets. */
export const wrapParagraph = (text: string, cols = BODY_COLS, px = BODY_PX): string[] => {
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
export const wrapText = (text: string, cols = BODY_COLS, px = BODY_PX): string[] => {
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
 * The header: who is speaking, then status, then the page counter and the
 * arrows that say there is more. Built suffix-first — if something has to be
 * cut it is the name, because a name cut to "Bosse…" is still legible and a
 * missing "2/3 ↓" hides the existence of the rest of the reply.
 *
 * The budgets default to what the title bar has room for once its own glyphs
 * and the microphone slot are taken out.
 */
export const buildHeader = (from: string, status: string | null | undefined, page: number, pages: number,
	cols = titleBudget().cols, px = titleBudget().px): string => {
	const marks = [
		pages > 1 ? `${page + 1}/${pages}` : "",
		pages > 1 && page > 0 ? UP : "",
		pages > 1 && page < pages - 1 ? DOWN : ""
	].filter(Boolean).join(" ");

	const tail = [status ?? "", marks].filter(Boolean).join(SEP);
	const suffix = tail ? SEP + tail : "";

	const name = String(from || "").trim() || "Mike";
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

/** The right end of the title bar: the microphone mark and the corner. */
const titleRight = (mic: LensMic | undefined): string => {
	const mark = mic === "live" ? MIC_LIVE : mic === "off" ? MIC_OFF : "";
	return mark ? ` ${mark} ${CORNER_TR}` : CORNER_TR;
};

/** What the header text may take up: the bar minus its own glyphs, the widest
 *  microphone slot, and at least one stretch of edge after the name. */
const titleBudget = () => {
	const right = titleRight("off");
	return {
		cols: LENS.cols - TITLE_L.length - 1 - right.length - 1,
		px: FRAME_PX - getTextWidth(TITLE_L) - getTextWidth(" ") - getTextWidth(right) - getTextWidth(EDGE_H)
	};
};

type Row = { cols: string; px: string };

/**
 * One row of the frame: `left`, filler, `right`, filled to the edge twice
 * over. Once by columns, for the monospace preview, and once by pixels for
 * the glasses, whose font is proportional. When the filler is the edge glyph
 * the pixel version tops the run up with spaces so the right edge still lands
 * where every other row's does — a space is 5 px, so the error is under half
 * of one.
 */
const fillRow = (left: string, right: string, filler = " "): Row => {
	const gapCols = Math.max(0, LENS.cols - left.length - right.length);
	const gapPx = Math.max(0, FRAME_PX - getTextWidth(left) - getTextWidth(right));
	const fillerPx = getTextWidth(filler);
	const spacePx = getTextWidth(" ");
	const n = Math.floor(gapPx / fillerPx);
	const rest = filler === " " ? 0 : Math.floor((gapPx - n * fillerPx) / spacePx);
	return {
		cols: left + filler.repeat(gapCols) + right,
		px: left + filler.repeat(n) + " ".repeat(rest) + right
	};
};

/** The whole frame. `page` is clamped, so a stale page index from a previous,
 *  longer reply cannot show an empty lens. */
export const renderLens = (view: LensView): LensFrame => {
	// One page of nothing. `content` is the empty string, which is what the
	// firmware is asked to draw: a container with no text is a dark lens. The
	// frame goes with it — a window drawn round nothing is still a thing in
	// the eye.
	if (view.blank) {
		return { header: "", lines: Array(LENS.rows).fill(""), content: "", page: 0, pages: 1, overflow: false };
	}
	const body = wrapText(view.text ?? "");
	const pages = paginate(body);
	const page = Math.max(0, Math.min(view.page ?? 0, pages.length - 1));
	const header = buildHeader(view.from, view.status, page, pages.length);

	const rows: Row[] = [fillRow(`${TITLE_L}${header} `, titleRight(view.mic), EDGE_H)];
	const shown = pages[page];
	for (let i = 0; i < BODY_ROWS; i++) rows.push(fillRow(`${SIDE_L}${shown[i] ?? ""}`, SIDE_R));
	rows.push(fillRow(CORNER_BL, CORNER_BR, EDGE_H));

	return {
		header,
		lines: rows.map((r) => r.cols),
		content: rows.map((r) => r.px).join("\n"),
		page,
		pages: pages.length,
		overflow: pages.length > 1
	};
};
