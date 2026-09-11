// A TCP proxy the tests can cut — acceptance criterion 4's "kill the network".
//
// Pulling a cable is the honest version of that test and nothing else
// reproduces it: closing the client's socket from inside the client exercises
// the reconnect path but not the part that matters, which is that the SERVER
// kept going and the client has to find out what it missed.
//
// `cut()` destroys every live connection and makes new ones fail immediately,
// the way a dead network does. The listener stays bound the whole time, so the
// port cannot be stolen by something else between the cut and the restore —
// which is the bug the harness's port-0 comment warns about, in another shape.

import net from "node:net";

export async function startProxy(targetPort, targetHost = "127.0.0.1") {
	const live = new Set();
	let cutting = false;

	const server = net.createServer((client) => {
		if (cutting) { client.destroy(); return; }

		const upstream = net.connect(targetPort, targetHost);
		live.add(client);
		live.add(upstream);

		client.setNoDelay(true);
		upstream.setNoDelay(true);
		client.pipe(upstream);
		upstream.pipe(client);

		const bothDown = () => {
			live.delete(client); live.delete(upstream);
			client.destroy(); upstream.destroy();
		};
		// Errors are expected here on every cut; unhandled they would take the
		// whole test process down through the ECONNRESET nobody listened to.
		client.on("error", bothDown);
		upstream.on("error", bothDown);
		client.on("close", bothDown);
		upstream.on("close", bothDown);
	});

	// Port 0, then read it back. Never a guessed port.
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;

	return {
		port,
		url: `ws://127.0.0.1:${port}/ws`,
		cut() {
			cutting = true;
			for (const s of [...live]) { try { s.destroy(); } catch { } }
			live.clear();
		},
		restore() { cutting = false; },
		async close() {
			this.cut();
			await new Promise((r) => server.close(r));
		}
	};
}
