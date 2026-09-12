import { defineConfig } from "vite";

// The version comes from the one file `npm run pack` already checks against
// app.json, so the number on the glasses cannot disagree with the number in the
// package. Imported rather than read with node:fs: this config is type-checked
// with the client's own tsconfig, which has the DOM and not Node.
import pkg from "./package.json";

/** The built client says which build it is. It matters because the one device
 *  that cannot be inspected is the phone: "install the new one" and "the new
 *  one is running" are two different claims, and only the second is worth
 *  anything when a crash is being chased. */
const VERSION = pkg.version;

// R4.1 and PRD 1 R1.2: the Jarvis server serves the built client from `--static`,
// which defaults to <repo>/public. Building straight into it means there is no
// copy step to forget and no second place a stale build can hide.
//
// `base: "./"` keeps every asset reference relative, so the same build works at
// the server root, behind a path prefix, and from the file:// preview the
// simulator sometimes gets pointed at.
export default defineConfig({
	root: ".",
	base: "./",
	build: {
		outDir: "../public",
		emptyOutDir: true,
		target: "es2022",
		sourcemap: true
	},
	server: { host: true, port: 5190, strictPort: true },
	define: { __JARVIS_VERSION__: JSON.stringify(VERSION) }
});
