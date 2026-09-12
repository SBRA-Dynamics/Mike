// Timers that are ours — because the ones on `window` are not.
//
// @evenrealities/even_hub_sdk 0.0.15 replaces window.setTimeout, clearTimeout,
// setInterval and clearInterval the moment it is imported, with "shadow
// timers": every timer is kept in a Map beside a real one, and the host can
// call window.__tickShadowTimers(elapsedMs) to advance the Map itself, for the
// case where a backgrounded WebView's own timers stop. Three properties of that
// layer, each measured against the shipped SDK in test/prd6-timers.mjs:
//
//   * A timer the tick fires is deleted from the Map, but its native twin is
//     not cancelled. A one-shot fires twice.
//
//   * The tick iterates the Map while the callbacks run, and a Map visits
//     entries added during iteration. A callback that re-arms itself with a
//     delay no longer than the tick's elapsedMs is visited, fired, re-armed,
//     visited again — inside ONE call, and the call never returns. That was
//     the hang. The lens repaints once a second while a turn runs, so the
//     chain exists from the moment a sentence is heard, and the first host
//     tick after that never came back: the phone got hot, the page was killed,
//     the socket closed with 1001 (going away). It began with the counter in
//     the header, which is why it began with PRD 6.
//
//   * clearTimeout(id) for an id no longer in the Map falls through to the
//     native clearTimeout with the SHADOW id — a small integer counted from 1,
//     exactly as native ids are — and so can cancel somebody else's timer.
//
// So nothing in this client calls window.setTimeout. The natives are taken
// here, at module evaluation, which is before glasses.ts dynamically imports
// the SDK; a timer armed through them is invisible to the tick, fires once,
// and is cleared by its own id. What is given up is the tick's one service —
// timers advancing while the host has frozen the page — and nothing here
// wants it: the paint chain has nothing to paint for while the app is away,
// and the connection is poked when it comes back (R4.5).
//
// Grep-able on purpose: `setTimeout(` should match nothing under client/src
// except this file.

type Global = {
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (id: unknown) => void;
};

const g = globalThis as unknown as Global;

/** The functions as found at evaluation, unbound, so a test can check they
 *  are the host's own and not the SDK's replacements. */
export const natives = Object.freeze({ setTimeout: g.setTimeout, clearTimeout: g.clearTimeout });

/** Whether they look native. Browsers print `[native code]` for their own
 *  functions and the SDK's replacements are arrow functions; Node's timers are
 *  JavaScript, so the answer there is false and means nothing. */
export const looksNative = (fn: unknown): boolean =>
	typeof fn === "function" && /\[native code\]/.test(Function.prototype.toString.call(fn));

export type Timer = unknown;

const setTimeoutNative = natives.setTimeout.bind(g);
const clearTimeoutNative = natives.clearTimeout.bind(g);

/**
 * The third property above is a hazard to native timers from OUTSIDE this
 * file: a fallback clear from the SDK's own code names a shadow id, and when
 * that number is one of our pending native ids the timer dies silently — a
 * reconnect that never happens, a paint chain that stops. Native ids and
 * shadow ids both count from 1. Spending a few thousand native ids now keeps
 * every id we will ever hold ahead of any shadow id issued while it is
 * pending: for the two to meet, the SDK would have to create this many timers
 * inside one of ours, and the longest of ours is fifteen seconds.
 */
const ID_HEADROOM = 4096;
for (let i = 0; i < ID_HEADROOM; i++) clearTimeoutNative(setTimeoutNative(() => { }, 0));

/** `setTimeout`, on the host's own timers. */
export const after = (fn: () => void, ms: number): Timer => setTimeoutNative(fn, ms);

/** `clearTimeout`, likewise. Safe on null. */
export const cancel = (timer: Timer | null | undefined): void => {
	if (timer !== null && timer !== undefined) clearTimeoutNative(timer);
};
