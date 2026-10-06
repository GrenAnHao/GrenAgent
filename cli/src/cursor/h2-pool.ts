import http2 from "node:http2";

const cursorHttp2Sessions = new Map<string, http2.ClientHttp2Session>();

export function acquireCursorHttp2Session(
	origin: string,
	options: {
		proxied: boolean;
		connect?: () => http2.ClientHttp2Session;
	},
): http2.ClientHttp2Session {
	if (!options.proxied) {
		const existing = cursorHttp2Sessions.get(origin);
		if (existing && !existing.closed && !existing.destroyed) return existing;
	}
	const client = options.connect ? options.connect() : http2.connect(origin);
	if (options.proxied) return client;
	cursorHttp2Sessions.set(origin, client);
	const drop = () => {
		if (cursorHttp2Sessions.get(origin) === client) cursorHttp2Sessions.delete(origin);
	};
	client.once("close", drop);
	client.once("goaway", drop);
	return client;
}

export function discardCursorHttp2Session(client: http2.ClientHttp2Session | null): void {
	if (!client) return;
	for (const [origin, pooled] of cursorHttp2Sessions) {
		if (pooled === client) cursorHttp2Sessions.delete(origin);
	}
	if (!client.closed && !client.destroyed) client.close();
}
