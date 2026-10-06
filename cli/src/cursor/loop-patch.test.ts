import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { patchAgentLoopSource, takePairedResults, unresolvedToolCalls } from "../../scripts/patch-pi-cursor-loop.mjs";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ContentBlock {
	type: string;
	id?: string;
	[key: symbol]: true | undefined;
}

interface BufferedToolResult {
	role: string;
	toolCallId: string;
}

const loopFixture = [
	'import { getDefaultStreamFn } from "./stream-fn.js";',
	"export function agentLoop(prompts, context, config, signal, streamFn) {",
	"    return streamFn;",
	"}",
	"            // Check for tool calls",
	'            const toolCalls = message.content.filter((c) => c.type === "toolCall");',
	'    const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");',
	"",
].join("\n");

test("unresolvedToolCalls 滤掉已标记执行的 toolCall", () => {
	const symbol = Symbol("provider.block.cursorExecResolved");
	const globals = globalThis as { __grenCursorExecResolved?: symbol };
	const previous = globals.__grenCursorExecResolved;
	globals.__grenCursorExecResolved = symbol;
	try {
		const content: ContentBlock[] = [
			{ type: "text" },
			{ type: "toolCall", id: "call-1", [symbol]: true },
			{ type: "toolCall", id: "call-2" },
		];
		const unresolved = unresolvedToolCalls(content) as ContentBlock[];
		assert.deepEqual(
			unresolved.map((block) => block.id),
			["call-2"],
		);
	} finally {
		globals.__grenCursorExecResolved = previous;
	}
});

test("takePairedResults 按 toolCallId 取回结果", () => {
	const call1: BufferedToolResult = { role: "toolResult", toolCallId: "call-1" };
	const call2: BufferedToolResult = { role: "toolResult", toolCallId: "call-2" };
	const buffer = [call1, call2];
	const taken = takePairedResults(buffer, ["call-1"]) as BufferedToolResult[];
	assert.deepEqual(
		taken.map((result) => result.toolCallId),
		["call-1"],
	);
	assert.deepEqual(
		buffer.map((result) => result.toolCallId),
		["call-2"],
	);
});

test("patchAgentLoopSource 的输出包含跳过和配对函数", () => {
	const patched = patchAgentLoopSource(loopFixture);
	assert.match(patched, /unresolvedToolCalls/);
	assert.match(patched, /takePairedResults/);
	assert.match(patched, /const toolCalls = unresolvedToolCalls\(message\.content\)/);
	assert.match(patched, /const toolCalls = unresolvedToolCalls\(assistantMessage\.content\)/);
});

function agentLoopFile(): string {
	const candidates = [
		join(cliRoot, "node_modules", "@earendil-works", "pi-agent-core", "dist", "agent-loop.js"),
		join(
			cliRoot,
			"node_modules",
			".pnpm",
			"node_modules",
			"@earendil-works",
			"pi-agent-core",
			"dist",
			"agent-loop.js",
		),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) throw new Error("agent-loop.js not found");
	return found;
}

const childSource = `
import { Type } from "typebox";
import { pathToFileURL } from "node:url";

const agentLoopPath = process.argv[2];
const marked = process.argv[3] === "marked";
const agentLoop = await import(pathToFileURL(agentLoopPath).href);
const runAgentLoop = agentLoop.runAgentLoop;

const symbol = Symbol("provider.block.cursorExecResolved");
globalThis.__grenCursorExecResolved = symbol;

let executions = 0;
const bash = {
	name: "bash",
	label: "Bash",
	description: "Run a command",
	parameters: Type.Object({ command: Type.String() }),
	async execute() {
		executions += 1;
		return { content: [{ type: "text", text: "local" }], details: {} };
	},
};

const toolCall = {
	type: "toolCall",
	id: "call-1",
	name: "bash",
	arguments: { command: "echo hi" },
};
if (marked) toolCall[symbol] = true;

const buffer = [{
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "bash",
	content: [{ type: "text", text: "already" }],
	isError: false,
	timestamp: Date.now(),
}];

let turns = 0;
function streamOf(message) {
	const events = [{ type: "done", reason: message.stopReason, message }];
	return {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
		result() {
			return Promise.resolve(message);
		},
	};
}

const streamFn = () => {
	turns += 1;
	const message = turns === 1
		? {
			role: "assistant",
			content: [toolCall],
			stopReason: "stop",
			api: "cursor-agent",
			provider: "cursor",
			model: "composer-2.5",
			timestamp: Date.now(),
		}
		: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
			api: "cursor-agent",
			provider: "cursor",
			model: "composer-2.5",
			timestamp: Date.now(),
		};
	return streamOf(message);
};

const messages = await runAgentLoop(
	[{ role: "user", content: [{ type: "text", text: "run" }], timestamp: Date.now() }],
	{ messages: [], tools: [bash] },
	{
		model: {
			id: "composer-2.5",
			name: "Composer",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		},
		convertToLlm: (items) => items,
		cursorToolResultBuffer: buffer,
		toolExecution: "sequential",
	},
	async () => {},
	undefined,
	streamFn,
);

const toolResult = messages.find((message) => message && message.role === "toolResult" && message.toolCallId === "call-1");
process.stdout.write(JSON.stringify({ executions, hasToolResult: Boolean(toolResult) }));
`;

interface LoopReport {
	executions: number;
	hasToolResult: boolean;
}

function runScenario(mode: "marked" | "plain"): LoopReport {
	const dir = mkdtempSync(join(cliRoot, ".tmp-loop-patch-"));
	const script = join(dir, "child.mjs");
	writeFileSync(script, childSource);
	try {
		const result = spawnSync(process.execPath, [script, agentLoopFile(), mode], {
			cwd: cliRoot,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
		const line = result.stdout.trim().split(/\r?\n/).at(-1);
		assert.ok(line, "child produced no report");
		return JSON.parse(line) as LoopReport;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("已执行的工具不再跑第二次", { concurrency: false }, () => {
	test("补丁脚本能改写已安装的 agent-loop", () => {
		const result = spawnSync(process.execPath, ["scripts/patch-pi-cursor-loop.mjs"], {
			cwd: cliRoot,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
		assert.match(readFileSync(agentLoopFile(), "utf8"), /__grenCursorExecResolved/);
	});

	test("带标记的 bash 不再执行，并带回 call-1 的 toolResult", () => {
		const report = runScenario("marked");
		assert.equal(report.executions, 0);
		assert.equal(report.hasToolResult, true);
	});

	test("没有标记时 bash 执行一次", () => {
		const report = runScenario("plain");
		assert.equal(report.executions, 1);
	});
});
