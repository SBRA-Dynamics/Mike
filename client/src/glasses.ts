// The lens half of the plugin — R4.2, R4.3, R4.6.
//
// Everything that touches the Even Hub SDK lives here. The rest of the client
// renders strings; this file gets them onto a pair of glasses, or reports
// honestly that there are none.
//
// Host detection is the part worth reading twice. `waitForEvenAppBridge()`
// resolves in a plain browser too — the SDK's bridge singleton marks itself
// ready when the DOM is ready, with or without a host behind it — and the
// failure then surfaces much later, as a rejected createStartUpPageContainer,
// by which time the client has already told the user it has glasses. The host
// is the Flutter channel the Even App injects (`window.flutter_inappwebview`,
// with the `callHandler` the SDK posts every message through); the simulator
// injects the same object, which is why it is a faithful test of this path.

/** One container, full lens. R4.2: a nicer layout needs rebuildPageContainer,
 *  which flickers and costs a measured round trip, and ten rows have no space
 *  for chrome anyway. */
const CONTAINER = { id: 1, name: "jarvis" } as const;

/** A single BLE hop has been measured at ~61 ms warm and ~211 ms for a full
 *  1800-character replace, but a flaky one can hang for tens of seconds. Past
 *  this we give up on that update and let the next one try. */
const CALL_TIMEOUT_MS = 5000;

export type GlassesOptions = {
	callTimeoutMs?: number;
	/** How the SDK bridge is obtained. The default dynamic-imports the SDK,
	 *  which keeps it off the critical path of a page that has no glasses — and
	 *  is the seam the Node suite injects a stand-in bridge through, so gesture
	 *  routing and the exit mode are tested without a WebView. The host gate
	 *  above is NOT part of that seam: a test has to look like a host. */
	bridgeFactory?: () => Promise<any>;
};

/** The four gestures the touchpad reports, plus the two halves of a hold.
 *  SDK 0.0.15 reports LONG_PRESS_EVENT (9) and LONG_PRESS_RELEASE_EVENT (10)
 *  separately, which is what makes PRD 5's push-to-talk capture possible: the
 *  utterance is exactly the span between them. R4.3 reserves the gesture; this
 *  layer is where the reservation has to be real, so it is routed like any
 *  other and left unhandled above rather than dropped here. */
export type Gesture = "tap" | "doubleTap" | "swipeUp" | "swipeDown" | "holdStart" | "holdEnd";

export type GlassesHandlers = {
	onGesture?: (g: Gesture) => void;
	/** The app came back to the front: reconnect and repaint, do not sit on a
	 *  stale screen (R4.5). */
	onForeground?: () => void;
	onBackground?: () => void;
	/** The user confirmed the system exit dialog, or the host tore us down. */
	onExit?: (reason: string) => void;
};

/** Is a Flutter host actually behind this page? Polled rather than sampled
 *  once: the channel is injected by the host around document start, and a page
 *  that loaded from cache can win that race. */
export const waitForHost = async (timeoutMs = 2000, step = 50): Promise<boolean> => {
	const until = Date.now() + timeoutMs;
	for (;;) {
		if (hasHostChannel()) return true;
		if (Date.now() >= until) return false;
		await new Promise((r) => setTimeout(r, step));
	}
};

export const hasHostChannel = (): boolean =>
	typeof (globalThis as any).flutter_inappwebview?.callHandler === "function";

export class Glasses {
	handlers: GlassesHandlers;
	opts: GlassesOptions;
	bridge: any = null;
	/** The SDK module, when it is the real one. Kept for its own enum
	 *  normalizer — see #sysType. */
	sdk: any = null;
	attached = false;
	/** Last error, shown in the companion rather than thrown away. */
	error: string | null = null;

	#unsubscribe: (() => void) | null = null;
	#pending: string | null = null;
	#sending = false;
	#shown: string | null = null;

	constructor(handlers: GlassesHandlers = {}, opts: GlassesOptions = {}) {
		this.handlers = handlers;
		this.opts = opts;
	}

	/** Returns true when the lens is live. False is a normal state (R4.6), not
	 *  an error: no glasses means companion-only. */
	async attach(initialContent: string, hostTimeoutMs = 2000): Promise<boolean> {
		if (!(await waitForHost(hostTimeoutMs))) {
			this.error = "no Even App host";
			return false;
		}
		try {
			if (this.opts.bridgeFactory) {
				this.bridge = await this.opts.bridgeFactory();
			} else {
				this.sdk = await import("@evenrealities/even_hub_sdk");
				this.bridge = await this.sdk.waitForEvenAppBridge();
			}
			const result = await this.#call(this.bridge.createStartUpPageContainer({
				containerTotalNum: 1,
				textObject: [{
					xPosition: 0, yPosition: 0, width: 576, height: 288,
					// No padding and no border: ten rows of 27 px is exactly the
					// height of the lens, and any inset costs one of them.
					borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0,
					containerID: CONTAINER.id, containerName: CONTAINER.name,
					content: initialContent,
					isEventCapture: 1
				}]
			}));
			// 0 is success; 1 invalid, 2 oversize, 3 out of memory.
			if (result !== 0) { this.error = `page rejected (${result})`; return false; }

			this.#shown = initialContent;
			this.#listen();
			this.attached = true;
			this.error = null;
			return true;
		} catch (e) {
			this.error = (e as Error)?.message ?? String(e);
			return false;
		}
	}

	/**
	 * Put a frame on the lens.
	 *
	 * Coalescing, not queueing: while one update is in flight the newest frame
	 * replaces any frame waiting behind it. A turn that changes state three
	 * times in 200 ms should cost one round trip and show the third one, not
	 * cost three and end on the third anyway.
	 */
	show(content: string): void {
		if (!this.attached) return;
		this.#pending = content;
		void this.#drain();
	}

	async #drain(): Promise<void> {
		if (this.#sending) return;
		this.#sending = true;
		try {
			// The one guard against re-sending a frame that is already on the
			// lens: every hop costs measured milliseconds, and a repaint that
			// changes nothing is the easiest kind to trigger by accident.
			while (this.#pending !== null && this.#pending !== this.#shown) {
				const content = this.#pending;
				this.#pending = null;
				try {
					// textContainerUpgrade is the flicker-free path and the only
					// one that costs a single hop; offset/length 0 means "replace
					// the whole content".
					await this.#call(this.bridge.textContainerUpgrade({
						containerID: CONTAINER.id, containerName: CONTAINER.name,
						content, contentOffset: 0, contentLength: 0
					}));
					this.#shown = content;
				} catch (e) {
					// A dropped frame is survivable — the next state change
					// repaints — but it must not take the queue down with it.
					this.error = (e as Error)?.message ?? String(e);
					break;
				}
			}
		} finally {
			this.#sending = false;
		}
	}

	/** Every bridge call gets a deadline: one flaky BLE hop otherwise hangs the
	 *  update loop for as long as the host is willing to wait. */
	#call<T>(p: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		return Promise.race([
			p,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error("glasses call timed out")), this.opts.callTimeoutMs ?? CALL_TIMEOUT_MS);
			})
		// The loser of the race still holds a timer; without this a long-lived
		// page accumulates one per update.
		]).finally(() => clearTimeout(timer));
	}

	#listen(): void {
		this.#unsubscribe = this.bridge.onEvenHubEvent((event: any) => {
			// Scroll gestures on a text container arrive as textEvent; taps and
			// double taps arrive as sysEvent. Getting that backwards is the
			// documented first mistake, so both are handled explicitly.
			const text = event?.textEvent;
			if (text) {
				const type = text.eventType ?? 0;
				if (type === 1) this.handlers.onGesture?.("swipeUp");
				else if (type === 2) this.handlers.onGesture?.("swipeDown");
				return;
			}

			const sys = event?.sysEvent;
			if (!sys) return;
			const type = this.#sysType(sys.eventType);
			switch (type) {
				case 0: this.handlers.onGesture?.("tap"); return;
				case 9: this.handlers.onGesture?.("holdStart"); return;
				case 10: this.handlers.onGesture?.("holdEnd"); return;
				case 3:
					// R4.3: the system exit dialog, mode 1. Nothing is torn down
					// here — the user can still cancel, and an app that
					// unsubscribed first would stay on screen, deaf.
					this.handlers.onGesture?.("doubleTap");
					void this.#call(this.bridge.shutDownPageContainer(1)).catch(() => { });
					return;
				case 4: this.handlers.onForeground?.(); return;
				case 5: this.handlers.onBackground?.(); return;
				case 6: this.detach("abnormal exit"); return;
				case 7: this.detach("system exit"); return;
				default: return;
			}
		});
	}

	/** Protobuf drops zero values, so a single press arrives with no eventType at
	 *  all — reading that as "no gesture" is the documented first mistake. The
	 *  host may also send the enum's NAME instead of its ordinal, which is what
	 *  the SDK's own fromJson is for; mirroring that table here would be a second
	 *  copy of it going stale. */
	#sysType(raw: unknown): number {
		if (raw === undefined || raw === null) return 0;
		if (typeof raw === "number") return raw;
		return this.sdk?.OsEventTypeList?.fromJson?.(raw) ?? -1;
	}

	detach(reason = "detached"): void {
		if (!this.attached) return;
		this.attached = false;
		try { this.#unsubscribe?.(); } catch { /* already gone */ }
		this.#unsubscribe = null;
		this.handlers.onExit?.(reason);
	}
}
