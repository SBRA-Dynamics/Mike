// The client, wired together — PRD 4.
//
// Order matters here and nowhere else: the host is detected first, because the
// answer decides where settings are stored (R4.7), and the settings decide what
// the connection is opened with. Everything after that is one loop — a message
// changes the store, the store repaints both faces from the same frame.

import { pcmToBase64, Voice } from "./audio/voice.ts";
import { Connection, wsUrlFrom } from "./connection.ts";
import { Glasses } from "./glasses.ts";
import { renderLens } from "./lens/render.ts";
import type { LensFrame } from "./lens/render.ts";
import { Store } from "./state.ts";
import type { AppState } from "./state.ts";
import { CONTROL } from "./protocol.ts";
import { DEFAULT_MODE, MODES, MODE_LABEL } from "../../src/routing.js";
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
	// R5a.8: idle, listening, heard, thinking — on the lens this is one short
	// line sharing the slot the background notices use. "heard" is shown as the
	// state rather than the words: the fifty-column line has no room for a
	// sentence, and the companion shows the sentence.
	const listening = store.listening();
	if (listening === "thinking") return "thinking";
	if (listening === "heard") return "heard";
	// The mode matters more than "listening" when it is not the default one:
	// paused is what the user most needs to know, and hold-to-talk explains why
	// nothing is happening when they speak.
	if (s.mode === MODES.IGNORE) return MODE_LABEL[MODES.IGNORE];
	if (listening === "listening") return s.voice?.held ? "held" : "listening";
	// R5a.4: a mode other than the default is shown on the lens, because "a mode
	// the user cannot see is a mode they will be surprised by". The default one
	// is not: it would spend the status line on the ordinary case.
	if (s.mode !== DEFAULT_MODE) return MODE_LABEL[s.mode] ?? s.mode;
	return null;
};

/** The microphone and everything the addressing mode does with it — PRD 5a.
 *  Built before the glasses, because the touchpad's hold routes into it. */
const voice = new Voice({
	// One message per segment. `connection` may be null (the page has not
	// connected yet, or the token is missing), and a segment that cannot be sent
	// is dropped with a note rather than queued — an utterance that arrives four
	// minutes late lands in a conversation that has moved on.
	send: (pcm, info) => connection?.audio(pcmToBase64(pcm), { durationMs: info.durationMs }) ?? false,
	onChange: (status) => store.setVoice(status),
	onNote: (text) => companion.note(text)
});

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
				// R4.3 reserves the hold for push-to-talk, and R5a.4 makes it
				// unconditional: no page state, no active worker and no connection
				// status may stop it, because in PushToTalk it is the only way to
				// speak a mode command back out again.
				//
				// In this phase it opens the BROWSER's microphone, which is what
				// the phone has. PRD 5b swaps in the glasses' own, and nothing
				// downstream of the segment changes.
				void voice.holdStart();
				return;
			case "holdEnd":
				voice.holdEnd();
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
	saveSettings: (patch) => { void applySettings(patch); },
	// R5a.1: the microphone is asked for when the user turns it on, never at
	// page load. This is the only path to getUserMedia in the client.
	setMic: (on) => { void voice.setEnabled(on); },
	holdStart: () => { void voice.holdStart(); },
	holdEnd: () => { voice.holdEnd(); }
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
	companion.render(s, frame, store.listening());
	glasses.show(frame.content);

	if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
	// Two things fade on their own now: a background notice and "heard". The
	// nearer of the two decides when to repaint, so neither is left on screen
	// after it stopped being true.
	const due = [store.nextNoticeExpiry(), store.nextListeningExpiry()].filter((v): v is number => v !== null);
	if (due.length) expiryTimer = setTimeout(() => { expiryTimer = null; paint(); }, Math.min(...due) + 50);
};

store.subscribe(() => repaint());

// The mode is the server's to decide — it can be changed by speaking, from
// another device, or by the picker here — and the microphone has to follow it:
// switching into PushToTalk closes the microphone, and out of it opens one.
store.subscribe((s) => { if (s.mode !== voice.mode) void voice.setMode(s.mode); });

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

/**
 * A read-only window onto the running client.
 *
 * It exists because some of what this phase promises is not visible in the DOM:
 * how many microphone tracks the page is holding open is the difference between
 * PushToTalk keeping its promise and only claiming to (R5a.4), and a test that
 * asserted it from a button's colour would pass with the microphone on. Reading
 * only, and nothing here changes anything.
 */
(globalThis as unknown as { jarvis: unknown }).jarvis = {
	state: () => store.state,
	listening: () => store.listening(),
	voice: () => voice.status,
	/** Live microphone tracks this page holds. Zero is the whole promise of
	 *  PushToTalk when the control is not held. */
	tracks: () => voice.mic.liveTracks,
	mic: () => ({ state: voice.mic.state, detail: voice.mic.detail, levelDb: Math.round(voice.mic.levelDb), ...voice.mic.stats }),
	connection: () => (connection ? { status: connection.status, detail: connection.detail, ...connection.stats } : null)
};

// R4.5: a backgrounded WebView's socket is usually gone by the time it comes
// back. Both of these mean "the condition the backoff is waiting out may have
// changed", and both are cheap to answer.
document.addEventListener("visibilitychange", () => { if (!document.hidden) connection?.poke("visible"); });
globalThis.addEventListener?.("online", () => connection?.poke("network up"));
globalThis.addEventListener?.("pageshow", () => connection?.poke("pageshow"));

void start();
