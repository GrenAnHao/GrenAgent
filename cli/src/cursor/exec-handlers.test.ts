import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { createCursorExecHandlers, prepareCursorExec, registerCursorExecSession } from "./exec-handlers.ts";

interface ExecTool {
	name: string;
	execute: (toolCallId: string, args: Record<string, unknown>) => Promise<{
		content: Array<{ type: "text"; text: string }>;
	}>;
}

test("shell 调用名为 bash 的工具，返回值含 ran", async () => {
	let called: string | undefined;
	let args: Record<string, unknown> | undefined;
	const bash: ExecTool = {
		name: "bash",
		async execute(_toolCallId, toolArgs) {
			called = "bash";
			args = toolArgs;
			return { content: [{ type: "text", text: "ran" }] };
		},
	};
	const shell: ExecTool = {
		name: "shell",
		async execute() {
			called = "shell";
			return { content: [{ type: "text", text: "wrong" }] };
		},
	};
	const handlers = createCursorExecHandlers({
		cwd: "D:/work",
		getTools: () => [shell, bash],
	});
	const result = await handlers.shell({ command: "echo hi" });
	assert.equal(called, "bash");
	assert.equal(args?.command, "echo hi");
	assert.match(JSON.stringify(result), /ran/);
});

test("bash 抛出 disk full 时 shell 返回失败结果且不向外抛", async () => {
	const bash: ExecTool = {
		name: "bash",
		async execute() {
			throw new Error("disk full");
		},
	};
	const handlers = createCursorExecHandlers({
		cwd: "D:/work",
		getTools: () => [bash],
	});
	const result = await handlers.shell({ command: "echo hi" });
	assert.match(JSON.stringify(result), /disk full/);
});

test("getTools 为空时 read 返回失败结果且不抛", async () => {
	const handlers = createCursorExecHandlers({
		cwd: "D:/work",
		getTools: () => [],
	});
	const result = await handlers.read({ path: "missing.txt" });
	assert.match(JSON.stringify(result), /no handler|not available/i);
});

test("prepare 按 sessionId 选用会话，后注册的会话不会抢走前一个", async () => {
	let hit = "";
	const bash = (label: string) => ({
		name: "bash",
		async execute() {
			hit = label;
			return { content: [{ type: "text" as const, text: label }] };
		},
	});
	registerCursorExecSession("session-a", () =>
		createCursorExecHandlers({ cwd: "D:/a", getTools: () => [bash("A")] }),
	);
	registerCursorExecSession("session-b", () =>
		createCursorExecHandlers({ cwd: "D:/b", getTools: () => [bash("B")] }),
	);
	const prepared = prepareCursorExec({ sessionId: "session-a" });
	assert.ok(prepared.cursorExecHandlers);
	await prepared.cursorExecHandlers.shell({ command: "echo a" });
	assert.equal(hit, "A");

	assert.equal(prepareCursorExec({}).cursorExecHandlers, undefined);
	assert.equal(prepareCursorExec({ sessionId: "session-missing" }).cursorExecHandlers, undefined);
});

test("workingDirectory 逃出 session cwd 时拒绝且不调用 bash", async () => {
	let called = 0;
	const handlers = createCursorExecHandlers({
		cwd: "D:/work",
		getTools: () => [
			{
				name: "bash",
				async execute() {
					called += 1;
					return { content: [{ type: "text" as const, text: "ran" }] };
				},
			},
		],
	});
	const relative = await handlers.shell({ command: "echo hi", workingDirectory: "../outside" });
	const absolute = await handlers.shell({ command: "echo hi", workingDirectory: "D:/outside" });
	assert.equal(called, 0);
	assert.match(JSON.stringify(relative), /reject/i);
	assert.match(JSON.stringify(absolute), /reject/i);
});

test("workingDirectory 子目录落在 session cwd 下，并带上 sessionManager", async () => {
	const sessionCwd = "D:/work";
	const sessionManager = {
		getSessionId: () => "sess",
		getSessionFile: () => undefined as string | undefined,
	};
	let cwd = "";
	let seenManager: typeof sessionManager | undefined;
	const handlers = createCursorExecHandlers({
		cwd: sessionCwd,
		getTools: () => [
			{
				name: "bash",
				async execute(
					_toolCallId: string,
					_args: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: { cwd: string; sessionManager?: typeof sessionManager } | undefined,
				) {
					cwd = ctx?.cwd ?? "";
					seenManager = ctx?.sessionManager;
					return { content: [{ type: "text" as const, text: "ok" }] };
				},
			},
		],
		getContext: () => ({ cwd: sessionCwd, sessionManager }),
	});
	await handlers.shell({ command: "ls", workingDirectory: "pkg" });
	assert.equal(cwd, path.resolve(sessionCwd, "pkg"));
	assert.equal(seenManager, sessionManager);
	assert.notEqual(cwd, path.resolve(process.cwd(), "pkg"));
});
