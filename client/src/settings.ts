// Settings and the little state that has to outlive a restart — R4.7.
//
// The Even App's WebView does not reliably keep browser localStorage across an
// app restart, so the SDK's own storage is the real store and localStorage is
// the development fallback. Both are behind one tiny async interface, because
// the difference must not leak into the rest of the client.

export type KeyValue = {
	get(key: string): Promise<string>;
	set(key: string, value: string): Promise<void>;
};

export type Settings = {
	/** The bearer token from PRD 1 R1.7. */
	token: string;
	/** Where to connect. Empty means "the origin this page came from", which is
	 *  R4.1's normal case; the settings panel fills it in to point elsewhere. */
	server: string;
	/** Which conversation to rejoin. Server-issued; only ever echoed back. */
	sessionId: string;
};

const KEY = "jarvis.settings";

export const EMPTY: Settings = { token: "", server: "", sessionId: "" };

/** Browser storage. Every call is wrapped: a WebView with site data disabled
 *  throws on access, and a client that cannot remember a token must still run. */
export const browserStorage = (): KeyValue => ({
	async get(key) { try { return globalThis.localStorage?.getItem(key) ?? ""; } catch { return ""; } },
	async set(key, value) { try { globalThis.localStorage?.setItem(key, value); } catch { /* private mode */ } }
});

/** The SDK's storage, which is what survives an app restart on the phone. */
export const bridgeStorage = (bridge: any): KeyValue => ({
	async get(key) { return (await bridge.getLocalStorage(key)) ?? ""; },
	async set(key, value) { await bridge.setLocalStorage(key, value); }
});

export class SettingsStore {
	#kv: KeyValue;
	#mirror: KeyValue | null;
	value: Settings = { ...EMPTY };

	/** `mirror` is written as well as `kv` — the browser copy is what makes a
	 *  desktop tab remember its token, and it costs nothing on the phone. */
	constructor(kv: KeyValue, mirror: KeyValue | null = null) {
		this.#kv = kv;
		this.#mirror = mirror;
	}

	async load(): Promise<Settings> {
		const raw = (await this.#kv.get(KEY)) || (this.#mirror ? await this.#mirror.get(KEY) : "");
		if (raw) {
			try { this.value = { ...EMPTY, ...JSON.parse(raw) }; }
			catch { /* corrupt or truncated: start clean rather than refuse to run */ }
		}
		return this.value;
	}

	async save(patch: Partial<Settings>): Promise<Settings> {
		this.value = { ...this.value, ...patch };
		const raw = JSON.stringify(this.value);
		await this.#kv.set(KEY, raw);
		if (this.#mirror) await this.#mirror.set(KEY, raw);
		return this.value;
	}
}

/**
 * What the URL says, if anything.
 *
 * R4.1 wants no token pasted in normal use, and R1.7 makes that token the one
 * credential in the system — so the server cannot hand it to an anonymous page
 * without giving it away. The compromise: it is supplied ONCE, in the link the
 * user opens (`https://host/?token=…`), and then lives in SDK storage. The
 * token is removed from the address bar immediately afterwards, so it does not
 * sit in the WebView's history or in a screenshot of the phone.
 */
export const readUrlSettings = (href: string): Partial<Settings> => {
	const out: Partial<Settings> = {};
	try {
		const u = new URL(href);
		const token = u.searchParams.get("token");
		const server = u.searchParams.get("server");
		const sessionId = u.searchParams.get("session");
		if (token) out.token = token;
		if (server) out.server = server;
		if (sessionId) out.sessionId = sessionId;
	} catch { /* not a URL we can parse; the settings panel still works */ }
	return out;
};

/** Strip the credential out of the address bar, keeping the rest of the URL. */
export const scrubUrl = (): void => {
	try {
		const u = new URL(globalThis.location?.href ?? "");
		if (!u.searchParams.has("token")) return;
		u.searchParams.delete("token");
		globalThis.history?.replaceState(null, "", u.pathname + (u.search === "?" ? "" : u.search) + u.hash);
	} catch { /* no history API, or not a browser */ }
};
