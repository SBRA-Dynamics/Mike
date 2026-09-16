// Reading the server's link off a QR code instead of typing it.
//
// The settings panel asks for a server address and a 32-character hex token.
// Both are unreasonable to type on a phone: the address needs a keyboard the
// field then hides behind, and one wrong character in the token reads as
// "unauthorized" with nothing to say which character it was. The link already
// exists — it is what the server prints — so the honest input device is the
// camera.
//
// Two halves, kept apart so the half that matters can be tested without one:
// `settingsFromScan` is a pure function from scanned text to settings, and
// `Scanner` is the camera loop that produces that text.

import jsQR from "jsqr";

import { wsUrlFrom } from "./connection.ts";
import type { Settings } from "./settings.ts";
import { after, cancel } from "./timers.ts";
import type { Timer } from "./timers.ts";

export type ScanResult =
	| { ok: true; settings: Partial<Settings>; host: string }
	| { ok: false; error: string };

/**
 * What a scanned code means.
 *
 * The link the server hands out is `https://host:port/?token=…`, and the server
 * it points at is its own origin — which is exactly the fact a packaged app
 * cannot work out for itself, because it was loaded from somewhere else. So the
 * origin becomes the server address unless the link says otherwise.
 *
 * Errors are written to be read on a phone by somebody holding it up to a
 * screen: what was scanned, and what is missing from it.
 */
export const settingsFromScan = (text: string): ScanResult => {
	const raw = String(text ?? "").trim();
	if (!raw) return { ok: false, error: "Nothing scanned." };

	let u: URL;
	try { u = new URL(raw); }
	catch { return { ok: false, error: "That is not a link." }; }

	if (u.protocol !== "https:" && u.protocol !== "http:") {
		return { ok: false, error: `That link is ${u.protocol.replace(":", "")}, not a web address.` };
	}

	const token = u.searchParams.get("token");
	if (!token) return { ok: false, error: "That link carries no token." };

	// An explicit server wins: a link may point the app at one host while being
	// served from another. Otherwise the code's own origin is the server, which
	// is the ordinary case and the one the QR in the terminal produces.
	const explicit = u.searchParams.get("server");
	const server = explicit || wsUrlFrom(u.origin + "/");

	const settings: Partial<Settings> = { token, server };
	const session = u.searchParams.get("session");
	if (session) settings.sessionId = session;

	return { ok: true, settings, host: u.host };
};

/**
 * Decode one frame. Separated so a test can hand it pixels from a file.
 *
 * `both` tries the inverted image as well, at roughly twice the work. The live
 * loop does not: it has sixty chances a second and wants each one cheap. A
 * still photograph has exactly one chance, and the thing being photographed is
 * very often a QR code printed in a TERMINAL — where a dark colour scheme
 * renders it light-on-dark, which is inverted, which "dontInvert" will not read
 * at any distance or focus. That is not an exotic case; it is the default
 * terminal on most machines.
 */
export const decodeFrame = (data: Uint8ClampedArray, width: number, height: number, both = false): string | null => {
	try {
		const found = jsQR(data, width, height, { inversionAttempts: both ? "attemptBoth" : "dontInvert" });
		return found?.data ?? null;
	} catch {
		// A decoder that throws on a noisy frame must not end the scan — the
		// next frame is a fifteenth of a second away.
		return null;
	}
};

/**
 * Decode a still image — what the host's camera and album hand back.
 *
 * Drawn through an <img> and a canvas rather than decoded by hand: the host
 * returns a JPEG, and writing a JPEG decoder to avoid one canvas would be a
 * strange way to spend an evening.
 */
export const decodeImage = (dataUrl: string): Promise<string | null> => new Promise((resolve) => {
	const img = new Image();
	img.onload = () => {
		try {
			// Several long edges rather than one.
			//
			// A single 1400 px pass was a guess that a code fills the frame. It
			// does not when the picture is of a screen across a desk, and the
			// downscale that makes a 12-megapixel photograph quick to decode is
			// the same downscale that smears a module three pixels wide into its
			// neighbour. Full size reads the small code; the reductions read the
			// large blurry one, which jsQR prefers with fewer pixels. Whichever
			// answers first wins, and nothing is decoded twice if the first does.
			const longest = Math.max(img.width, img.height);
			// SMALLEST FIRST, and the smallest is small. A photograph of a QR
			// code on a SCREEN carries the display's pixel grid beating against
			// the sensor's — moire, fine banding across every light module —
			// and at full resolution the binariser reads that banding as
			// structure and gives up. Scaling down averages it away, and the
			// canvas downscale a browser does is a cheap one: measured in
			// Chrome on a real 12-megapixel photograph of a real terminal, the
			// SAME picture that Node's jsQR reads at 640 px, the browser's
			// drawImage reads it at every size from 240 to 500 px and at
			// nothing above 640. The first ladder started at 640 and sat in the
			// dead band, which is why photographing the code never once
			// worked on the phone. So the ladder starts where a large code is
			// three or four pixels a module and climbs; the large passes stay
			// for the opposite case, a small code far away in the frame, and
			// cost nothing when an early one succeeds.
			const edges = [320, 400, 480, 640, 800, 1000, 1600, longest].filter((e, i, a) => e <= longest && a.indexOf(e) === i);
			const ctxOf = (edge: number) => {
				const canvas = document.createElement("canvas");
				const scale = Math.min(1, edge / longest);
				canvas.width = Math.max(1, Math.round(img.width * scale));
				canvas.height = Math.max(1, Math.round(img.height * scale));
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				if (!ctx) return null;
				ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
				return { ctx, w: canvas.width, h: canvas.height };
			};
			for (const edge of edges) {
				const c = ctxOf(edge);
				if (!c) continue;
				const found = decodeFrame(c.ctx.getImageData(0, 0, c.w, c.h).data, c.w, c.h, true);
				if (found) return resolve(found);
			}
			resolve(null);
		} catch { resolve(null); }
	};
	img.onerror = () => resolve(null);
	img.src = dataUrl;
});

export type ScannerOptions = {
	video: HTMLVideoElement;
	canvas: HTMLCanvasElement;
	onResult: (text: string) => void;
	onError: (message: string) => void;
};

/**
 * The camera loop.
 *
 * Deliberately modest: the back camera, one decode per animation frame, and a
 * stop() that really stops — a scanner left running is a camera light left on,
 * which is the kind of thing that makes people uninstall an app.
 */
export class Scanner {
	#opts: ScannerOptions;
	#stream: MediaStream | null = null;
	#timer: Timer | null = null;
	#generation = 0;

	constructor(opts: ScannerOptions) { this.#opts = opts; }

	get running(): boolean { return this.#stream !== null; }

	async start(): Promise<boolean> {
		if (this.#stream) return true;
		const generation = ++this.#generation;
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: "environment" } }, audio: false
			});
		} catch (e) {
			this.#opts.onError(`No camera: ${(e as Error).message ?? e}`);
			return false;
		}
		// Stopped while the permission dialog was up. The stream that arrives
		// afterwards has no owner, and without this it stays live — the same
		// race the microphone had on a quick tap.
		if (generation !== this.#generation) { stopTracks(stream); return false; }

		this.#stream = stream;
		const v = this.#opts.video;
		v.srcObject = stream;
		v.setAttribute("playsinline", "");
		v.muted = true;
		try { await v.play(); } catch { /* some hosts autoplay anyway */ }
		this.#tick(generation);
		return true;
	}

	stop(): void {
		this.#generation++;
		cancel(this.#timer);
		this.#timer = null;
		if (this.#stream) { stopTracks(this.#stream); this.#stream = null; }
		const v = this.#opts.video;
		try { v.pause(); } catch { }
		v.srcObject = null;
	}

	#tick(generation: number): void {
		if (generation !== this.#generation || !this.#stream) return;
		const { video, canvas, onResult } = this.#opts;
		const w = video.videoWidth;
		const h = video.videoHeight;
		if (w && h) {
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			if (ctx) {
				ctx.drawImage(video, 0, 0, w, h);
				const found = decodeFrame(ctx.getImageData(0, 0, w, h).data, w, h);
				if (found) { onResult(found); return; }
			}
		}
		// Not requestAnimationFrame: a backgrounded WebView stops calling it, and
		// a scanner that silently stops when the phone locks is worse than one
		// that costs a few timer wakeups.
		this.#timer = after(() => this.#tick(generation), 120);
	}
}

const stopTracks = (stream: MediaStream): void => {
	for (const t of stream.getTracks()) { try { t.stop(); } catch { } }
};
