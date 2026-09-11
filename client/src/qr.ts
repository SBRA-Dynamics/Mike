// Reading the server's link off a QR code instead of typing it.
//
// The settings panel asks for a server address and a 64-character hex token.
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

/** Decode one frame. Separated so a test can hand it pixels from a file. */
export const decodeFrame = (data: Uint8ClampedArray, width: number, height: number): string | null => {
	try {
		const found = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
		return found?.data ?? null;
	} catch {
		// A decoder that throws on a noisy frame must not end the scan — the
		// next frame is a fifteenth of a second away.
		return null;
	}
};

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
	#timer: ReturnType<typeof setTimeout> | null = null;
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
		if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
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
		this.#timer = setTimeout(() => this.#tick(generation), 120);
	}
}

const stopTracks = (stream: MediaStream): void => {
	for (const t of stream.getTracks()) { try { t.stop(); } catch { } }
};
