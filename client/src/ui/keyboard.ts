// Keeping the composer reachable while the on-screen keyboard is up.
//
// On iOS the keyboard shrinks nothing that CSS can see. The layout viewport
// keeps its height, so 100dvh is still the whole screen; the page becomes
// scrollable behind the keyboard; and WebKit brings the focused input into
// view by moving the VISUAL viewport, which pushes the header off the top and
// leaves the keyboard over the composer anyway. The visual viewport is where
// the truth is, and it is only readable from script.
//
// Shrinking the root to the visible height is necessary but not enough: the
// bar, the lens preview and the microphone row together are taller than what a
// keyboard leaves of a phone, so a shorter column simply overflows and the
// composer ends up under the keys all the same. So while the keyboard is up
// the root also carries a class the stylesheet uses to fold the lens preview
// away — nobody reads the lens while typing on the phone — and to let the
// column scroll, with the composer scrolled to the bottom of it.
//
// Two signals say the keyboard is up, because one host may report neither:
// the visual viewport being materially shorter than the window, and the
// input having focus on a device with a coarse pointer, which is a phone with
// a keyboard that only exists on screen. When both are quiet the inline styles
// go and the stylesheet's own rules apply, so nothing here leaves a trace on
// a desktop.

/** More than an address bar, less than a keyboard: below this the viewport is
 *  taken to be whole. */
const COVERED_PX = 80;

export type FitOptions = {
	/** The composer's input: its focus is the second signal. */
	input?: HTMLElement;
	/** Called before the height changes, to read anything that depends on it. */
	before?: () => void;
	/** Called after, to restore what `before` read. */
	after?: () => void;
};

/** The part of VisualViewport this reads — named so a test can hand in a
 *  viewport that shrinks on command, which a desktop browser's never does. */
export type Viewport = Pick<VisualViewport, "height" | "offsetTop" | "addEventListener">;

const coarsePointer = (): boolean => {
	try { return globalThis.matchMedia?.("(pointer: coarse)").matches ?? false; } catch { return false; }
};

export const fitToKeyboard = (root: HTMLElement, opts: FitOptions = {}, vv: Viewport | null = globalThis.visualViewport): void => {
	let focused = false;
	const fit = (): void => {
		const shrunk = vv !== null && window.innerHeight - vv.height > COVERED_PX;
		const covered = shrunk || (focused && coarsePointer());
		opts.before?.();
		root.style.height = shrunk && vv ? `${Math.round(vv.height)}px` : "";
		root.style.transform = shrunk && vv && vv.offsetTop > 0 ? `translateY(${Math.round(vv.offsetTop)}px)` : "";
		root.classList.toggle("keyboard", covered);
		// The composer is the last thing in the column and the reason for all
		// of this: whatever else had to give, it is on screen.
		if (covered) root.scrollTop = root.scrollHeight;
		opts.after?.();
	};
	vv?.addEventListener("resize", fit);
	vv?.addEventListener("scroll", fit);
	opts.input?.addEventListener("focus", () => { focused = true; fit(); });
	opts.input?.addEventListener("blur", () => { focused = false; fit(); });
};
