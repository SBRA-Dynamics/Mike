// The client, wired together — PRD 4.
//
// Order matters here and nowhere else: the host is detected first, because the
// answer decides where settings are stored (R4.7), and the settings decide what
// the connection is opened with. Everything after that is one loop — a message
// changes the store, the store repaints both faces from the same frame.

import { pcmToBase64, Voice } from "./audio/voice.ts";
import { decodeImage, Scanner, settingsFromScan } from "./qr.ts";

/** What a scanned code does, wherever the pixels came from. Straight into the
 *  path the ?token= link already uses: scanning is an input device, not a
 *  second way of being configured. */
const applyScan = (text: string): void => {
	const read = settingsFromScan(text);
	if (!read.ok) { companion.note(read.error); return; }
	companion.note(`Scanned ${read.host}. Connecting…`);
	void applySettings({ server: read.settings.server, token: read.settings.token });
};

/** The camera, while it is reading a code. Null the rest of the time — a
 *  scanner left alive is a camera light left on. */
let scanner: Scanner | null = null;
import { Connection, wsUrlFrom } from "./connection.ts";
import { Glasses, hasHostChannel } from "./glasses.ts";
import { renderLens } from "./lens/render.ts";
import type { LensFrame } from "./lens/render.ts";
import { Store } from "./state.ts";
import { after, cancel, looksNative, natives } from "./timers.ts";
import type { Timer } from "./timers.ts";
import { CONTROL } from "./protocol.ts";
import { SettingsStore, browserStorage, bridgeStorage, readUrlSettings, scrubUrl } from "./settings.ts";
import { Companion } from "./ui/companion.ts";

/** Stamped into the bundle at build time (vite.config.ts). Not read from a
 *  file at runtime: the question it answers is which BUILD this is. */
declare const __JARVIS_VERSION__: string;
const VERSION = typeof __JARVIS_VERSION__ === "string" ? __JARVIS_VERSION__ : "dev";

const store = new Store();
let connection: Connection | null = null;

/**
 * The black box — because the client that most needs a console has none.
 *
 * In the Even App the page is a WebView on a phone: when it dies it takes every
 * line it ever printed with it, and what the user sees is the app closing.
 * Restarting shows the reply that was arriving when it went, which says the
 * death is somewhere between a message landing and the frame reaching the
 * glasses — and says nothing at all about where.
 *
 * So the last thing that was attempted is kept in a variable, and anything
 * thrown is sent to the server, which has a log file that survives. Bounded to
 * one short string: this is a breadcrumb, not telemetry.
 *
 * The first thing it found was itself.
 *
 * PRD 6 called the hang "the client dies when a reply lands". It does not die,
 * it spins, and the log says so plainly: 588 identical lines in one second —
 * `unhandled rejection at "painted": The object does not support the operation
 * or argument. @user-script:350:24:30` — and then the socket goes. Nothing in
 * this client produces 588 of anything per second. A paint is once a second, a
 * heartbeat is once every fifteen; the only path in the whole page that can
 * feed itself is this function, and it feeds itself through the console.
 *
 * In the Even App the console is bridged: `flutter_inappwebview` replaces
 * console.error with one that ships the line to the host through
 * `callHandler`, which returns a promise — and that promise is nobody's. When
 * it rejects, the rejection is unhandled, which arrives here, which calls
 * console.error, which bridges, which rejects. `user-script:N` is that injected
 * script and not our bundle, which is why every line reports the identical
 * source position, and why N moves by fifteen between app restarts and never
 * within one.
 *
 * So a report is rate limited, and the FIRST thing it does is decide whether to
 * stay quiet. Nothing may be moved above that decision — not the console call
 * least of all — because staying quiet is the entire mechanism: the loop's
 * second turn produces a line identical to its first, is counted instead of
 * said, and there is no third.
 *
 * That loop was real, and closing it was not the end of the hang. The hang was
 * a second loop, inside the timers the SDK puts in place of the browser's, and
 * it is described in timers.ts. The heartbeat below is what pointed there.
 */
let step = "boot";
const mark = (s: string): void => { step = s; };

/** Five in two seconds is enough to read a cascade — one failure knocking over
 *  three others is a shape worth having — and few enough that nothing built on
 *  top of it can spend the main thread. The total is the backstop for a loop
 *  that alternates between two messages and so slips the duplicate check: a
 *  page that has reported a hundred times is not going to be debugged by the
 *  hundred and first. */
const REPORT_BURST = 5;
const REPORT_WINDOW_MS = 2000;
const REPORT_TOTAL = 100;

let reportWindowAt = 0;
let reportsInWindow = 0;
let reportsTotal = 0;
let reportedLast = "";
let reportsSuppressed = 0;

const report = (what: string, e: unknown): void => {
	// Two frames rather than one. The line that mattered here was the second,
	// and knowing it was the second only helped because the first was guessable;
	// the next unexplained one will not be.
	const detail = e instanceof Error
		? `${e.message} ${(e.stack ?? "").split("\n").slice(0, 2).join(" ").trim()}`
		: String(e);
	const line = `${VERSION} ${what} at "${step}": ${detail}`;

	// Before the console, always. See above.
	const now = Date.now();
	if (now - reportWindowAt > REPORT_WINDOW_MS) { reportWindowAt = now; reportsInWindow = 0; }
	if (line === reportedLast || reportsInWindow >= REPORT_BURST || reportsTotal >= REPORT_TOTAL) { reportsSuppressed++; return; }
	reportedLast = line;
	reportsInWindow++;
	reportsTotal++;

	// What was swallowed is said by the next one that gets through, so a quiet
	// log never means a quiet page.
	const text = reportsSuppressed ? `${line} (+${reportsSuppressed} suppressed)` : line;
	reportsSuppressed = 0;
	console.error(`[jarvis] ${text}`);
	// Best effort, and never able to throw on its own account: the thing being
	// reported may well be the socket.
	try { connection?.control(CONTROL.CLIENT_LOG, { level: "error", text }); } catch { }
};

globalThis.addEventListener?.("error", (ev) => report("uncaught", (ev as ErrorEvent).error ?? (ev as ErrorEvent).message));
globalThis.addEventListener?.("unhandledrejection", (ev) => report("unhandled rejection", (ev as PromiseRejectionEvent).reason));
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

	scanQr: (ui) => {
		// In the Even app, page script has no camera: the microphone reaches us
		// through the SDK and getUserMedia is not granted at all. The host has
		// its own picker, so there the code is photographed and decoded; only a
		// real browser gets the live scanner.
		if (hasHostChannel()) {
			void (async () => {
				companion.note("Opening the camera…");
				const image = await glasses.captureImage("camera");
				if (!image) { companion.note("No picture taken."); return; }
				const text = await decodeImage(image);
				if (!text) { companion.note("No QR code in that picture. Try again, closer."); return; }
				applyScan(text);
			})();
			return;
		}
		scanner?.stop();
		scanner = new Scanner({
			video: ui.video,
			canvas: ui.canvas,
			onError: (message) => { ui.show(false); companion.note(message); },
			onResult: (text) => {
				scanner?.stop();
				ui.show(false);
				applyScan(text);
			}
		});
		ui.show(true);
		void scanner.start().then((ok) => { if (!ok) ui.show(false); });
	},
	cancelScan: () => { scanner?.stop(); scanner = null; },
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
let expiryTimer: Timer | null = null;

const paint = (): void => {
	const s = store.state;
	mark("render");
	const view = store.lensView();
	frame = renderLens({ from: view.from, text: view.text, status: store.lensStatus(), page: view.page, blank: store.lensDark() });
	mark("companion");
	companion.render(s, frame, store.listening());
	mark(`glasses ${frame.content.length}c`);
	glasses.show(frame.content);
	mark("painted");

	cancel(expiryTimer);
	expiryTimer = null;
	// Two things fade on their own now: a background notice and "heard". The
	// nearer of the two decides when to repaint, so neither is left on screen
	// after it stopped being true.
	//
	// This is the chain that hung the page: once a second for as long as a
	// turn runs, re-armed from inside its own callback. On the SDK's shadow
	// timers that shape is a loop that never returns (timers.ts); on the
	// host's own it is a timer.
	//
	// The third is the lens going dark after ten quiet seconds (LENS_IDLE_MS).
	// It arms once per utterance and does not re-arm from its own callback: once
	// the lens is blank nextIdleExpiry is null, so this is not a chain.
	const due = [store.nextNoticeExpiry(), store.nextListeningExpiry(), store.nextIdleExpiry()]
		.filter((v): v is number => v !== null);
	if (due.length) expiryTimer = after(() => { expiryTimer = null; paint(); }, Math.min(...due) + 50);
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

/**
 * A pulse while the microphone is open, and the only thing it really measures
 * is its own lateness.
 *
 * The suspicion is starvation rather than a thrown error: every EvenHub event
 * is narrated to the console by the SDK with the whole PCM array serialised
 * into the string (see glasses.ts), ten of them a second for as long as
 * somebody is listening, and the building of those strings happens before
 * anything a plugin can patch. A page dying of that does not throw — it stops
 * keeping up, and then it stops.
 *
 * So this is a timer that says how far behind schedule it woke up. A healthy
 * page answers "late=3ms" every fifteen seconds; a starving one drifts and then
 * goes quiet, and the last line before the silence says how much audio had gone
 * through and how big the heap had got. It writes to the server's log, which is
 * the only surface that survives the page.
 *
 * Only while the microphone is live: that is the condition under discussion,
 * and a heartbeat the rest of the time would be noise in a log somebody has to
 * read.
 */
const HEARTBEAT_MS = 15_000;
let beatAt = Date.now();
let beatTimer: Timer | null = null;

/**
 * One chain, however many times this is armed.
 *
 * The log the crash came out of had the heartbeat multiplying: beats half a
 * second apart, each saying it woke a full interval early, all of them sharing
 * one `beatAt` and one set of frame counters — one page with many chains. It
 * grew by roughly half again every interval, and by the end there were dozens.
 *
 * That was the breadcrumb, and timers.ts is where it led: the SDK's shadow
 * timers fire a one-shot twice, once from the host's tick and once natively,
 * and a chain that re-arms on every firing doubles. The heartbeat now runs on
 * the host's own timers and fires once. The cancel is kept as the belt to
 * that brace — a page that somehow arms twice still only has one outstanding.
 */
const armBeat = (): void => {
	cancel(beatTimer);
	beatTimer = after(beat, HEARTBEAT_MS);
};

const beat = (): void => {
	const now = Date.now();
	const late = now - beatAt - HEARTBEAT_MS;
	beatAt = now;
	const v = store.state.voice;
	if (v?.live) {
		const g = (voice.glasses as { stats?: Record<string, number> } | null)?.stats;
		const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
		try {
			connection?.control(CONTROL.CLIENT_LOG, {
				text: `beat ${VERSION} late=${late}ms mic=${v.mic}/${v.device} sent=${v.sent}`
					+ ` frames=${g?.frames ?? 0} bytes=${g?.bytes ?? 0} dropped=${g?.dropped ?? 0}`
					+ (heap ? ` heap=${Math.round(heap / 1e6)}MB` : "")
					+ ` step="${step}"`
			});
		} catch { }
	}
	armBeat();
};
armBeat();

// The mode is the server's to decide — it can be changed by speaking, from
// another device, or by the picker here — and the microphone has to follow it:
// switching into PushToTalk closes the microphone, and out of it opens one.
store.subscribe((s) => { if (s.mode !== voice.mode) void voice.setMode(s.mode); });

// The microphone switch, said out loud. Turning it ON from a voice command can
// only have reached us through an open microphone or a hold, so the browser has
// already granted permission and this cannot be the call that asks for it
// (R5a.1 keeps that on the control).
store.onMicRequest = (on) => { if (on !== voice.enabled) void voice.setEnabled(on); };

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
				// Which build is actually on the glasses, written where it
				// survives the glasses: installing a package and running it are
				// two different claims, and only the server's log can settle the
				// second one.
				try {
					connection?.control(CONTROL.CLIENT_LOG, {
						text: `client ${VERSION} attached — glasses ${store.state.glasses}, ${navigator.userAgent.slice(0, 80)}`
					});
				} catch { }
				// The session id is the conversation. Persisting it is what makes
				// closing the app and opening it again a continuation rather than
				// a new start (PRD 1 R1.5).
				if (ready.sessionId !== settingsStore.value.sessionId) void settingsStore.save({ sessionId: ready.sessionId });
			},
			onHistory: (messages) => { mark(`history ${messages.length}`); store.applyHistory(messages); },
			// Named before it is applied, so a breadcrumb says which message the
			// client was holding when it went — the whole question here is which
			// one of them it cannot survive.
			onMessage: (m) => { mark(`${m.type}${(m as { kind?: string }).kind ? `:${(m as { kind?: string }).kind}` : ""}`); store.apply(m); }
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
	// "native" is the claim timers.ts makes; on a phone this line is the only
	// place it can be checked. (Node's timers are JavaScript and print as not
	// native there, which is expected and meaningless.)
	console.log(`[jarvis] client up ${VERSION} — glasses ${attached ? "attached" : "absent"}, timers ${looksNative(natives.setTimeout) ? "native" : "not native"}`);

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
	connection: () => (connection ? { status: connection.status, detail: connection.detail, ...connection.stats } : null),
	/** How much the black box has said, and how much it decided not to. The
	 *  property the suite holds it to is that the first number stops growing
	 *  while the second one does not. */
	reports: () => ({ total: reportsTotal, suppressed: reportsSuppressed })
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
