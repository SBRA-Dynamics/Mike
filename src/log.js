// Logging — PRD 1 R1.8.
//
// Writes to whatever stdout the service was given. The rule learned the hard
// way: never let this inherit a tty that can go away. A previous server wrote
// 69 GB of one stacktrace because console.log threw EIO into an uncaught
// handler on every request after its terminal closed. systemd's
// StandardOutput=append is the supported configuration.

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 23);

const write = (level, args) => {
	const line = `[${stamp()}] ${level} ` + args
		.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
		.join(" ");
	try { process.stdout.write(line + "\n"); }
	catch { /* a broken stdout must never throw into the request path */ }
};

export const log = {
	info: (...a) => write("INFO ", a),
	warn: (...a) => write("WARN ", a),
	error: (...a) => write("ERROR", a)
};
