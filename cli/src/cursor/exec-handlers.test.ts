import assert from "node:assert/strict";
import test from "node:test";
import { createCursorExecHandlers } from "./exec-handlers.ts";

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
