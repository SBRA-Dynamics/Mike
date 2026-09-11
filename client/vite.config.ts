import { defineConfig } from "vite";

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
	server: { host: true, port: 5190, strictPort: true }
});
