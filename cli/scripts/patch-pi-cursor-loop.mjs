/**
 * Keep Cursor stream-executed tool calls from running a second time.
 *
 * agent-loop skips toolCall blocks marked with globalThis.__grenCursorExecResolved
 * and emits the paired results already buffered during the stream.
 * Run after npm install. Missing targets are skipped; patched files are left alone.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const helpers = `function unresolvedToolCalls(content) {
    const mark = globalThis.__grenCursorExecResolved;
    const blocks = Array.isArray(content) ? content : [];
    return blocks.filter((block) => {
        if (!block || block.type !== "toolCall") return false;
        return !(typeof mark === "symbol" && block[mark] === true);
    });
}
function takePairedResults(buffer, ids) {
    if (!Array.isArray(buffer) || buffer.length === 0) return [];
    const wanted = new Set(ids ?? []);
    const taken = [];
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
        const entry = buffer[index];
        const result = entry && entry.role === "toolResult"
            ? entry
            : entry && entry.toolResult && entry.toolResult.role === "toolResult"
                ? entry.toolResult
                : entry && typeof entry.toolCallId === "string"
                    ? entry
                    : undefined;
        if (result && wanted.has(result.toolCallId)) {
            taken.push(result);
            buffer.splice(index, 1);
        }
    }
    taken.reverse();
    return taken;
}
`;

const resolvedDrain = `            const resolvedToolCallIds = message.content.filter((block) => block.type === "toolCall" && unresolvedToolCalls([block]).length === 0).map((block) => block.id);
            const pairedToolResults = takePairedResults(config.cursorToolResultBuffer ?? [], resolvedToolCallIds);
            for (const pairedToolResult of pairedToolResults) {
                currentContext.messages.push(pairedToolResult);
                newMessages.push(pairedToolResult);
                await emit({ type: "message_end", message: pairedToolResult });
            }
            if (Array.isArray(config.cursorToolResultBuffer)) config.cursorToolResultBuffer.splice(0);
`;

export function unresolvedToolCalls(content) {
	const mark = globalThis.__grenCursorExecResolved;
	const blocks = Array.isArray(content) ? content : [];
	return blocks.filter((block) => {
		if (!block || block.type !== "toolCall") return false;
		return !(typeof mark === "symbol" && block[mark] === true);
	});
}

export function takePairedResults(buffer, ids) {
	if (!Array.isArray(buffer) || buffer.length === 0) return [];
	const wanted = new Set(ids ?? []);
	const taken = [];
	for (let index = buffer.length - 1; index >= 0; index -= 1) {
		const entry = buffer[index];
		const result = entry && entry.role === "toolResult"
			? entry
			: entry && entry.toolResult && entry.toolResult.role === "toolResult"
				? entry.toolResult
				: entry && typeof entry.toolCallId === "string"
					? entry
					: undefined;
		if (result && wanted.has(result.toolCallId)) {
			taken.push(result);
			buffer.splice(index, 1);
		}
	}
	taken.reverse();
	return taken;
}

export function patchAgentLoopSource(source) {
	if (source.includes("__grenCursorExecResolved")) return source;
	const filter = /(\w+)\.content\.filter\(\(c\) => c\.type === "toolCall"\)/g;
	const found = source.match(filter);
	if (!found || found.length !== 2) {
		throw new Error(`patch-pi-cursor-loop: expected 2 toolCall filters, found ${found?.length ?? 0}`);
	}
	let patched = source.replace(filter, "unresolvedToolCalls($1.content)");
	const checkpoint = "            // Check for tool calls\n";
	if (!patched.includes(checkpoint)) {
		throw new Error("patch-pi-cursor-loop: agent-loop.js has no tool-call checkpoint");
	}
	patched = patched.replace(checkpoint, `${resolvedDrain}${checkpoint}`);
	const importAnchor = 'import { getDefaultStreamFn } from "./stream-fn.js";\n';
	if (patched.includes(importAnchor)) {
		patched = patched.replace(importAnchor, `${importAnchor}${helpers}`);
	} else {
		patched = `${helpers}${patched}`;
	}
	return patched;
}

function replaceOnce(source, needle, replacement, label) {
	const first = source.indexOf(needle);
	if (first < 0) throw new Error(`patch-pi-cursor-loop: ${label} anchor missing`);
	if (source.indexOf(needle, first + needle.length) >= 0) {
		throw new Error(`patch-pi-cursor-loop: ${label} anchor is not unique`);
	}
	return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function patchAgentSource(source) {
	if (source.includes("__grenCursorExecResolved") || source.includes("this.cursorToolResultBuffer")) return source;
	let patched = replaceOnce(
		source,
		'        this.toolExecution = runtimeOptions.toolExecution ?? "parallel";',
		'        this.toolExecution = runtimeOptions.toolExecution ?? "parallel";\n        this.cursorExecHandlers = runtimeOptions.cursorExecHandlers;\n        this.cursorToolResultBuffer = [];',
		"agent constructor",
	);
	patched = replaceOnce(
		patched,
		`        if (this.activeRun) {
            throw new Error("Agent is already processing.");
        }
        const abortController = new AbortController();`,
		`        if (this.activeRun) {
            throw new Error("Agent is already processing.");
        }
        this.cursorToolResultBuffer = [];
        const abortController = new AbortController();`,
		"agent runWithLifecycle",
	);
	patched = replaceOnce(
		patched,
		`            getFollowUpMessages: async () => this.followUpQueue.drain(),
        };`,
		`            getFollowUpMessages: async () => this.followUpQueue.drain(),
            cursorExecHandlers: this.cursorExecHandlers,
            cursorToolResultBuffer: this.cursorToolResultBuffer,
            cursorOnToolResult: (result) => {
                this.cursorToolResultBuffer.push(result);
                return result;
            },
        };`,
		"agent createLoopConfig",
	);
	return patched;
}

export function patchSdkSource(source) {
	if (source.includes("__grenCursorPrepare") || source.includes("__grenCursorExecResolved")) return source;
	let patched = replaceOnce(
		source,
		"            return modelRuntime.streamSimple(model, context, requestOptions);",
		`            if (model.api === "cursor-agent" && globalThis.__grenCursorPrepare) {
                Object.assign(requestOptions, globalThis.__grenCursorPrepare(requestOptions));
            }
            return modelRuntime.streamSimple(model, context, requestOptions);`,
		"sdk streamFn",
	);
	patched = replaceOnce(
		patched,
		`        maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
    });`,
		`        maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
        ...(options.cursorExecHandlers ? { cursorExecHandlers: options.cursorExecHandlers } : {}),
    });`,
		"sdk Agent constructor",
	);
	return patched;
}

function writePatch(path, transform, label) {
	if (!existsSync(path)) {
		console.warn(`patch-pi-cursor-loop: ${label} not found, skip`);
		return;
	}
	const source = readFileSync(path, "utf8");
	const patched = transform(source);
	if (patched === source) {
		console.log(`patch-pi-cursor-loop: ${label} already patched`);
		return;
	}
	writeFileSync(path, patched);
	console.log("patch-pi-cursor-loop: patched", path);
}

function rememberDist(found, distDir) {
	const loop = join(distDir, "agent-loop.js");
	if (!existsSync(loop)) return;
	let real;
	try {
		real = realpathSync(loop);
	} catch {
		return;
	}
	if (found.some((item) => item.real === real)) return;
	found.push({ real, loop, agent: join(distDir, "agent.js") });
}

function findExtensionLoops(dir, found, depth) {
	if (depth > 6 || !existsSync(dir)) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === ".git" || entry.name === "dist" || entry.name === "coverage") continue;
		const full = join(dir, entry.name);
		if (entry.name === "pi-agent-core") {
			rememberDist(found, join(full, "dist"));
			continue;
		}
		if (entry.name === "node_modules") {
			rememberDist(found, join(full, "@earendil-works", "pi-agent-core", "dist"));
			continue;
		}
		findExtensionLoops(full, found, depth + 1);
	}
}

function installedDists(cliRoot) {
	const found = [];
	rememberDist(found, join(cliRoot, "node_modules", "@earendil-works", "pi-agent-core", "dist"));
	const pnpm = join(cliRoot, "node_modules", ".pnpm");
	if (existsSync(pnpm)) {
		for (const name of readdirSync(pnpm)) {
			rememberDist(found, join(pnpm, name, "node_modules", "@earendil-works", "pi-agent-core", "dist"));
		}
	}
	findExtensionLoops(join(cliRoot, "..", "extensions"), found, 0);
	return found;
}

function patchInstalledPackages(cliRoot) {
	const dists = installedDists(cliRoot);
	if (dists.length === 0) {
		console.warn("patch-pi-cursor-loop: agent-loop.js not found, skip");
	}
	for (const dist of dists) {
		writePatch(dist.loop, patchAgentLoopSource, "agent-loop.js");
		writePatch(dist.agent, patchAgentSource, "agent.js");
	}
	writePatch(
		join(cliRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "sdk.js"),
		patchSdkSource,
		"sdk.js",
	);
}

function isDirectRun() {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	try {
		patchInstalledPackages(join(dirname(fileURLToPath(import.meta.url)), ".."));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
