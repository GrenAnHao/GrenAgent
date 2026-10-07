import type { Provider, ProviderAuth } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import {
	bindCursorStream,
	cursorChatModels,
	stream,
	streamSimple,
	type CursorStreamCursor,
} from "./provider.ts";
import { prepareCursorExec } from "./exec-handlers.ts";
import { kCursorExecResolved } from "./vendor/utils/block-symbols.ts";

export interface InstallCursorProviderOptions {
	streamCursor?: CursorStreamCursor;
	registerNativeProvider?: (provider: Provider) => void;
}

interface GrenCursorGlobals {
	__grenCursorExecResolved?: symbol;
	__grenCursorPrepare?: typeof prepareCursorExec;
}

const cursorAuth: ProviderAuth = {
	apiKey: {
		name: "Cursor",
		async resolve(input) {
			const key = input.credential?.key;
			if (!key) return undefined;
			return { auth: { apiKey: key }, source: "Cursor" };
		},
	},
};

export function createCursorNativeProvider(): Provider {
	return {
		id: "cursor",
		name: "Cursor",
		baseUrl: "https://api2.cursor.sh",
		auth: cursorAuth,
		getModels() {
			return cursorChatModels();
		},
		stream,
		streamSimple,
	};
}

/**
 * 注册 cursor-agent API，并挂上执行标记符号。
 * cli/src/main.ts 在 bootstrap 时还没有 ModelRuntime，这里不会为了注册原生供应商去创建会话。
 * 原生供应商要在 ModelRuntime 创建之后再注册，调用 registerCursorNativeProvider。
 * sidecar 的扩展工厂能拿到 pi.registerProvider，它在 runner bind 后转到 ModelRuntime.registerNativeProvider。
 */
export function installCursorProvider(options: InstallCursorProviderOptions = {}): void {
	bindCursorStream(options.streamCursor);
	const globals = globalThis as GrenCursorGlobals;
	globals.__grenCursorExecResolved = kCursorExecResolved;
	globals.__grenCursorPrepare = prepareCursorExec;
	registerApiProvider({
		api: "cursor-agent",
		stream,
		streamSimple,
	});
	options.registerNativeProvider?.(createCursorNativeProvider());
}

export function registerCursorNativeProvider(registerNativeProvider: (provider: Provider) => void): void {
	registerNativeProvider(createCursorNativeProvider());
}
