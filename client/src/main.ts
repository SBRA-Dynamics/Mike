// The client, wired together — PRD 4.
//
// Order matters here and nowhere else: the host is detected first, because the
// answer decides where settings are stored (R4.7), and the settings decide what
// the connection is opened with. Everything after that is one loop — a message
// changes the store, the store repaints both faces from the same frame.

import { Connection, wsUrlFrom } from "./connection.ts";
import { Glasses } from "./glasses.ts";
import { renderLens } from "./lens/render.ts";
import type { LensFrame } from "./lens/render.ts";
import { Store } from "./state.ts";
import type { AppState } from "./state.ts";
import { CONTROL } from "./protocol.ts";
import { MODES, MODE_LABEL } from "../../src/routing.js";
import { SettingsStore, browserStorage, bridgeStorage, readUrlSettings, scrubUrl } from "./settings.ts";
import { Companion } from "./ui/companion.ts";

const store = new Store();
let connection: Connection | null = null;
let frame: LensFrame = renderLens({ from: "Jarvis", text: "Connecting…", page: 0 });

const root = document.getElementById("app")!;

/** The one line of status the lens can afford. Order is by urgency: a dead
 *  socket outranks a running turn, because an answer that will never arrive
 *  must not read as one that is on its way. */
const lensStatus = (s: AppState): string | null => {
	if (s.connection === "fatal") return "stopped";
	if (s.connection !== "online") return "offline";
	// Somebody the user is not talking to is waiting on them. It outranks
	// "thinking", which says something is happening that they already know about,
	// and it is the only status that carries a name worth acting on.
	const waiting = store.notice();
	if (waiting) return waiting;
	if (s.busy) return "thinking";
	if (s.mode === MODES.IGNORE) return MODE_LABEL[MODES.IGNORE];
	return null;
};

const glasses = new Glasses({
	onGesture: (g) => {
		switch (g) {
			case "swipeUp": store.turnPage(-1, frame.pages); return;
			case "swipeDown": store.turnPage(1, frame.pages); return;
			case "tap":
				// R4.3: show more of a truncated reply, else repeat the last —
				// which here means going back to its first page. When the reply
				// already fits on one page that is deliberately nothing: the lens
				// is showing it, and re-sending identical content costs a measured
				// round trip to change no pixels.
				if (!store.turnPage(1, frame.pages)) store.setPage(0);
				return;
			case "doubleTap": return;   // the exit dialog is the SDK's, not ours
			case "holdStart":
			case "holdEnd":
				// R4.3 reserves the hold for push-to-talk. PRD 5's PushToTalk mode
				// captures exactly the span between these two, so they are routed
				// and named here rather than being a gap to find later. They reach
				// this point unconditionally — no page state, no active worker and
				// no connection status gates them — because in that mode the hold
				// is the only way to speak a mode command back out again.
				return;
		}
	},
	onForeground: () => { connection?.poke("glasses foreground"); repaint(true); },
	onExit: (reason) => { store.setGlasses("absent"); companion.note(`Glasses: ${reason}.`); }
});

const companion = new Companion(root, {
	say: (text) => {
		// PRD 3: typed, explicitly. Without it the server treats a keyboard line
		// as speech and the addressing mode drops it unless it names someone.
		const sent = connection?.say(text, "typed") ?? false;
		if (sent) store.applyLocal(text);
		return sent;
	},
	interrupt: () => { connection?.interrupt(); },
	setMode: (mode) => { connection?.control(CONTROL.SET_MODE, { mode }); },
	switchWorker: (name) => { connection?.control(CONTROL.SWITCH_WORKER, { name: name || null }); },
	whoIs: () => { connection?.control(CONTROL.WHO_IS, {}); },
	reconnect: () => { connection?.poke("manual"); },
	newSession: () => { void newSession(); },
	saveSettings: (patch) => { void applySettings(patch); }
});

// ------------------------------------------------------------------ painting

let scheduled = false;

/** Both faces, from one frame. Batched through a microtask so a burst of
 *  messages inside one turn costs one repaint and one BLE hop. */
const repaint = (immediate = false): void => {
	if (!immediate) {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => { scheduled = false; paint(); });
		return;
	}
	scheduled = false;
	paint();
};

/** A fading notice has to disappear on its own, so a repaint is scheduled for
 *  the moment it expires rather than polled for. Identical frames are not
 *  re-sent to the glasses, so an extra repaint costs nothing over BLE. */
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

const paint = (): void => {
	const s = store.state;
	frame = renderLens({ from: s.lens.from, text: s.lens.text, status: lensStatus(s), page: s.lens.page });
	companion.render(s, frame);
	glasses.show(frame.content);

	if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
	const due = store.nextNoticeExpiry();
	if (due !== null) expiryTimer = setTimeout(() => { expiryTimer = null; paint(); }, due + 50);
};

store.subscribe(() => repaint());

// ---------------------------------------------------------------- connecting

// Reassigned once, in start(), when the host is known: on the phone the SDK's
// storage is the real one, and until the answer is in there is nothing to load.
let settingsStore = new SettingsStore(browserStorage());

const openConnection = (): void => {
	connection?.stop("reconnecting with new settings");
	const { token, server, sessionId } = settingsStore.value;
	if (!token) {
		store.setConnection("fatal", "no token");
		companion.note("No token yet. Open the server's link with ?token=… once, or paste one in Settings.");
		return;
	}
	connection = new Connection({
		url: server || wsUrlFrom(location.href),
		token,
		sessionId: sessionId || null,
		handlers: {
			onStatus: (status, detail) => store.setConnection(status, detail),
			onReady: (ready) => {
				store.applyReady(ready);
				// The session id is the conversation. Persisting it is what makes
				// closing the app and opening it again a continuation rather than
				// a new start (PRD 1 R1.5).
				if (ready.sessionId !== settingsStore.value.sessionId) void settingsStore.save({ sessionId: ready.sessionId });
			},
			onHistory: (messages) => store.applyHistory(messages),
			onMessage: (m) => store.apply(m)
		}
	});
	connection.start();
};

const applySettings = async (patch: { token?: string; server?: string }): Promise<void> => {
	await settingsStore.save(patch);
	openConnection();
};

const newSession = async (): Promise<void> => {
	await settingsStore.save({ sessionId: "" });
	openConnection();
};

// --------------------------------------------------------------------- start

const start = async (): Promise<void> => {
	repaint(true);

	// R4.6: detect the host through the Flutter channel, not through
	// waitForEvenAppBridge(), which resolves with a stub in a plain browser and
	// then fails when asked to create a page. No glasses is a normal state.
	const attached = await glasses.attach(frame.content);
	store.setGlasses(attached ? "attached" : "absent");
	if (!attached) companion.note(`No glasses attached — companion only (${glasses.error ?? "no host"}).`);
	// One line, at startup. On a phone this is the only way to see which half of
	// the app came up, and it is what the simulator test waits for.
	console.log(`[jarvis] client up — glasses ${attached ? "attached" : "absent"}`);

	// R4.7: the SDK's storage is the only one that survives an app restart on
	// the phone; the browser copy is the development fallback and the desktop's
	// real store.
	settingsStore = attached && glasses.bridge
		? new SettingsStore(bridgeStorage(glasses.bridge), browserStorage())
		: new SettingsStore(browserStorage());

	await settingsStore.load();
	const fromUrl = readUrlSettings(location.href);
	if (Object.keys(fromUrl).length) await settingsStore.save(fromUrl);
	scrubUrl();

	companion.fillSettings(settingsStore.value.server, settingsStore.value.token);
	openConnection();
	companion.focusInput();
};

// R4.5: a backgrounded WebView's socket is usually gone by the time it comes
// back. Both of these mean "the condition the backoff is waiting out may have
// changed", and both are cheap to answer.
document.addEventListener("visibilitychange", () => { if (!document.hidden) connection?.poke("visible"); });
globalThis.addEventListener?.("online", () => connection?.poke("network up"));
globalThis.addEventListener?.("pageshow", () => connection?.poke("pageshow"));

void start();
