// A minimal PNG reader, so the lens test can look at the simulator's real
// framebuffer without pulling in an image library for four assertions.
//
// Handles what the simulator produces and nothing else: 8-bit truecolour,
// non-interlaced, with or without alpha (the glasses framebuffer carries alpha
// and the WebView capture does not). Anything else throws rather than returning
// plausible nonsense — a decoder that quietly mis-reads a format would turn a
// red test green, which is the one outcome worth engineering against here.

import { inflateSync } from "node:zlib";

const PAETH = (a, b, c) => {
	const p = a + b - c;
	const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Returns { width, height, data } where data is RGBA, 4 bytes per pixel. */
export function decodePng(buffer) {
	const buf = Buffer.from(buffer);
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");

	let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
	const idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const body = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			bitDepth = body[8];
			colorType = body[9];
			interlace = body[12];
		} else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		pos += 12 + len;
	}

	if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
		throw new Error(`unsupported PNG: depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}`);
	}

	const raw = inflateSync(Buffer.concat(idat));
	const bpp = colorType === 6 ? 4 : 3;
	const stride = width * bpp;
	const out = Buffer.alloc(height * stride);

	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
		const cur = out.subarray(y * stride, (y + 1) * stride);
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? cur[x - bpp] : 0;
			const b = prev ? prev[x] : 0;
			const c = x >= bpp && prev ? prev[x - bpp] : 0;
			const v = line[x];
			switch (filter) {
				case 0: cur[x] = v; break;
				case 1: cur[x] = (v + a) & 0xff; break;
				case 2: cur[x] = (v + b) & 0xff; break;
				case 3: cur[x] = (v + ((a + b) >> 1)) & 0xff; break;
				case 4: cur[x] = (v + PAETH(a, b, c)) & 0xff; break;
				default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
			}
		}
	}

	// Everything downstream works in RGBA. An image without an alpha channel is
	// opaque by definition, so the expansion is lossless and keeps `litPixels`
	// from reading a missing channel as "nothing is lit".
	if (bpp === 4) return { width, height, data: out };
	const rgba = Buffer.alloc(width * height * 4);
	for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
		rgba[j] = out[i]; rgba[j + 1] = out[i + 1]; rgba[j + 2] = out[i + 2]; rgba[j + 3] = 255;
	}
	return { width, height, data: rgba };
}

/**
 * Which rows of the glasses framebuffer have anything lit.
 *
 * The simulator's glasses screenshot is RGBA where an unlit pixel is
 * (0,255,0,0) — green with zero alpha. Converting to RGB makes background and
 * text identical, which is the documented way to get a test that cannot fail.
 * So: alpha, and only alpha.
 */
export function litRows(img) {
	const rows = [];
	for (let y = 0; y < img.height; y++) {
		let n = 0;
		for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3] > 0) n++;
		rows.push(n);
	}
	return rows;
}

/** Contiguous bands of lit rows — one per rendered line of text. */
export function textBands(img, minPixels = 1) {
	const rows = litRows(img);
	const bands = [];
	let start = -1;
	for (let y = 0; y < rows.length; y++) {
		const on = rows[y] >= minPixels;
		if (on && start < 0) start = y;
		if (!on && start >= 0) { bands.push({ top: start, bottom: y - 1 }); start = -1; }
	}
	if (start >= 0) bands.push({ top: start, bottom: rows.length - 1 });
	return bands;
}

export const litPixels = (img) => litRows(img).reduce((a, b) => a + b, 0);

/** How many pixels differ, so "the lens repainted" is a measurement. */
export function differingPixels(a, b) {
	if (a.width !== b.width || a.height !== b.height) return Infinity;
	let n = 0;
	for (let i = 0; i < a.data.length; i += 4) {
		if (a.data[i + 3] !== b.data[i + 3] || a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
	}
	return n;
}

/** Pixels within `tol` of a colour — used on the companion screenshot, which is
 *  an opaque render and cannot be measured by alpha. */
export function countNear(img, [r, g, b], tol = 24) {
	let n = 0;
	for (let i = 0; i < img.data.length; i += 4) {
		if (img.data[i + 3] === 0) continue;
		if (Math.abs(img.data[i] - r) <= tol && Math.abs(img.data[i + 1] - g) <= tol && Math.abs(img.data[i + 2] - b) <= tol) n++;
	}
	return n;
}
