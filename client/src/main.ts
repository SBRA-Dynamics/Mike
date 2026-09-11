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
import { CONTROL } from "./protocol.ts";
import { SettingsStore, browserStorage, bridgeStorage, readUrlSettings, scrubUrl } from "./settings.ts";
import { Companion } from "./ui/companion.ts";

const store = new Store();
let connection: Connection | null = null;
let frame: LensFrame = renderLens({ from: "Jarvis", text: "Connecting…", page: 0 });

const root = document.getElementById("app")!;

/** The microphone and everything the addressing mode does with it — PRD 5a,
 *  and PRD 5b's second source behind the same policy. Built before the glasses,
 *  because the touchpad's hold routes into it. */
const voice = new Voice({
	// One message per segment. `connection` may be null (the page has not
	// connected yet, or the token is missing), and a segment that cannot be sent
	// is dropped with a note rather than queued — an utterance that arrives four
	// minutes late lands in a conversation that has moved on.
	//
	// This is the single place a segment leaves the client, and PRD 5b did not
	// add a second one. A segment from the glasses and a segment from a laptop
	// are the same `audio` message on the same socket — acceptance criterion 7,
	// which is a property of there being nothing here to branch on.
	send: (pcm, info) => connection?.audio(pcmToBase64(pcm), { durationMs: info.durationMs }) ?? false,
	onChange: (status) => store.setVoice(status),
	onNote: (text) => companion.note(text),
	// PRD 5b. `glasses` is declared below and is only ever CALLED from an open,
	// long after this module has finished evaluating.
	glassesControl: (open, source) => glasses.audioControl(open, source),
	hostReady: () => glasses.attached,
	// R5b.1's sequencing constraint, as a question rather than an assumption:
	// the glasses array needs the startup page, the phone microphone does not.
	pageReady: () => glasses.attached
});

const glasses = new Glasses({
	onGesture: (g) => {
		// One touchpad, one finger: any gesture that is not the hold itself means
		// the hold is over. The case that matters is the double tap — the system
		// exit dialog was measured swallowing the release that should have
		// followed, and a hold whose release never arrives is a microphone left
		// running on hardware, which R5b.1 calls the worse of its two problems.
		if (g !== "holdStart" && g !== "holdEnd" && voice.held) voice.holdEnd();
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
				// PRD 5b R5b.3 is the same requirement on the touchpad, and this
				// is now where it is kept: a `case` with one statement in it and
				// nothing to fail first. The microphone it opens is the glasses'
				// own (the phone's when the lens page is not up); nothing
				// downstream of the segment changes, which is the point.
				void voice.holdStart();
				return;
			case "holdEnd":
				voice.holdEnd();
				return;
		}
	},
	// One AudioEvent — ten a second per open microphone. Straight through, with
	// nothing in between: the speaker filter and the segmenter are one layer
	// down, and a repaint here would cost one per frame.
	onAudio: (audio) => voice.glassesFrame(audio),
	onForeground: () => {
		connection?.poke("glasses foreground");
		// R5b.1: what was stopped when we went away comes back only if the mode
		// asks for it, so returning in PushToTalk does not open a microphone.
		void voice.resume();
		repaint(true);
	},
	// R5b.1: "Audio must stop on exit, on backgrounding and on error." The
	// glasses are still on the user's face while the app is in the background,
	// which is exactly when a microphone left running stops being a battery
	// problem and starts being a trust problem.
	onBackground: () => { voice.suspend("close"); },
	onExit: (reason) => {
		voice.suspend("close");
		store.setGlasses("absent");
		companion.note(`Glasses: ${reason}.`);
	}
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
	frame = renderLens({ from: s.lens.from, text: s.lens.text, status: store.lensStatus(), page: s.lens.page });
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

/**
 * One line, every time the microphone changes what it is doing — PRD 5b.
 *
 * The browser suite reads `globalThis.jarvis`; a WebView on somebody's phone
 * has no such reader, and the numbers PRD 5b's risk table asks for (the open
 * cost and lead-in of R5b.3, the byte rate of R5b.4, the speaker-role ratio of
 * R5b.2) are measurable only while the glasses are actually on a face. So they
 * are printed where the Even App's console and the simulator's `/api/console`
 * can both be read, and a hardware session becomes "hold the touchpad and read
 * the line" rather than an instrumented build.
 *
 * Keyed on the STATE plus a coarse bucket of captured audio — every change of
 * what the microphone is doing, and one more line per ten seconds of audio
 * while it is open. Never one per frame, and the second half is what makes
 * R5b.4's byte rate readable as a rate rather than as a total.
 */
const BYTES_PER_LINE = 320_000;                 // 10 s at 16 kHz x 16 bit mono
let lastMicKey = "";
store.subscribe((s) => {
	const v = s.voice;
	if (!v) return;
	const stats = (voice.glasses as { stats?: Record<string, number> } | null)?.stats;
	const key = `${v.mic}|${v.device}|${v.held}|${v.live}|${Math.floor((stats?.bytes ?? 0) / BYTES_PER_LINE)}`;
	if (key === lastMicKey) return;
	lastMicKey = key;
	const g = stats;
	console.log(`[jarvis] mic ${v.mic} ${v.device} held=${v.held} live=${v.live} tracks=${voice.source.liveTracks} sent=${v.sent}`
		+ (g ? ` frames=${g.frames} bytes=${g.bytes} openMs=${g.openMs} leadInMs=${g.leadInMs} roles=${g.self}/${g.other}/${g.unknown} dropped=${g.dropped}` : ""));
});

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
	/** Live microphones this page holds open, on whichever device is in use.
	 *  Zero is the whole promise of PushToTalk when the control is not held, and
	 *  PRD 5b did not weaken it: the glasses count in the same units. */
	tracks: () => voice.source.liveTracks,
	mic: () => ({ state: voice.source.state, detail: voice.source.detail, device: voice.device, levelDb: Math.round(voice.source.levelDb), ...voice.source.stats }),
	/** The glasses microphone's own numbers — PRD 5b's whole risk table, read
	 *  off a running system instead of guessed at. `bytes` over the time the
	 *  microphone was open is R5b.4's bandwidth; `openMs` and `leadInMs` are the
	 *  lead-in R5b.3 says to measure before promising a hold-to-talk; the role
	 *  counts are R5b.2's "the ratio is logged". */
	glasses: () => (voice.glasses ? { attached: glasses.attached, error: glasses.error, ...(voice.glasses as { stats: object }).stats } : null),
	connection: () => (connection ? { status: connection.status, detail: connection.detail, ...connection.stats } : null)
};

// R4.5: a backgrounded WebView's socket is usually gone by the time it comes
// back. Both of these mean "the condition the backoff is waiting out may have
// changed", and both are cheap to answer.
document.addEventListener("visibilitychange", () => { if (!document.hidden) connection?.poke("visible"); });
// R5b.1's third case. A WebView that is being torn down gets no SDK event, and
// a microphone opened on the glasses outlives the page that opened it — so the
// last thing this page does is ask for it to be closed. `pagehide` rather than
// `beforeunload`: it is the one that fires on mobile.
globalThis.addEventListener?.("pagehide", () => voice.suspend("close"));
globalThis.addEventListener?.("online", () => connection?.poke("network up"));
globalThis.addEventListener?.("pageshow", () => connection?.poke("pageshow"));

void start();
