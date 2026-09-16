// Keeping the page inside the part of the screen the keyboard leaves.
//
// On iOS the on-screen keyboard shrinks nothing that CSS can see. The layout
// viewport keeps its height, so 100dvh is still the whole screen; the page
// becomes scrollable behind the keyboard; and WebKit brings the focused input
// into view by moving the VISUAL viewport, which pushes the header off the top
// and leaves the keyboard over the composer anyway. The visual viewport is
// where the truth is, and it is only readable from script.
//
// So while the visual viewport is materially shorter than the window, the app
// root is given that height and moved down by however far WebKit scrolled,
// which puts the whole column — header, transcript, composer — into the
// visible part. When the keyboard goes, the inline styles go with it and the
// stylesheet's own rules apply, so nothing here leaves a trace on a desktop.

/** More than an address bar, less than a keyboard: below this the viewport is
 *  taken to be whole and the page is left alone. */
const COVERED_PX = 80;

export type FitHooks = {
	/** Called before the height changes, to read anything that depends on it. */
	before?: () => void;
	/** Called after, to restore what `before` read. */
	after?: () => void;
};

/** The part of VisualViewport this reads — named so a test can hand in a
 *  viewport that shrinks on command, which a desktop browser's never does. */
export type Viewport = Pick<VisualViewport, "height" | "offsetTop" | "addEventListener">;

export const fitToKeyboard = (root: HTMLElement, hooks: FitHooks = {}, vv: Viewport | null = globalThis.visualViewport): void => {
	if (!vv) return;
	const fit = (): void => {
		const covered = window.innerHeight - vv.height > COVERED_PX;
		hooks.before?.();
		root.style.height = covered ? `${Math.round(vv.height)}px` : "";
		root.style.transform = covered && vv.offsetTop > 0 ? `translateY(${Math.round(vv.offsetTop)}px)` : "";
		root.classList.toggle("keyboard", covered);
		hooks.after?.();
	};
	vv.addEventListener("resize", fit);
	vv.addEventListener("scroll", fit);
};
