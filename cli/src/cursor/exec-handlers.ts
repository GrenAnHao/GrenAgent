import { omitUndefinedArgs, shellTimeoutSeconds } from "./vendor/providers/cursor-pi-args.ts";

/** Session tool the exec bridge can invoke. `execute` matches the pi agent tool. */
interface RunnableTool {
	name: string;
	execute: (
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
		ctx?: { cwd: string },
	) => Promise<ToolExecutionResult>;
}

interface ToolExecutionResult {
	content?: ReadonlyArray<{ type?: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

export interface CursorExecHandlerOptions {
	cwd: string;
	/** Read on every exec call so a later tool loadout is visible. */
	getTools: () => readonly { name: string }[];
}

export interface CursorExecToolResult {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

interface ShellExecArgs {
	command: string;
	workingDirectory?: string;
	timeout?: number;
	toolCallId?: string;
}

interface ReadExecArgs {
	path: string;
	offset?: number;
	limit?: number;
	toolCallId?: string;
}

interface GrepExecArgs {
	pattern: string;
	path?: string;
	glob?: string;
	caseInsensitive?: boolean;
	toolCallId?: string;
}

interface WriteExecArgs {
	path: string;
	fileText?: string;
	fileBytes?: Uint8Array;
	toolCallId?: string;
}

function callId(toolCallId: string | undefined): string {
	return toolCallId && toolCallId.length > 0 ? toolCallId : crypto.randomUUID();
}

function resultText(result: ToolExecutionResult): string {
	return (result.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text ?? "")
		.join("");
}

function toolResult(
	toolCallId: string,
	toolName: string,
	text: string,
	isError: boolean,
	details?: unknown,
): CursorExecToolResult {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		...(details !== undefined ? { details } : {}),
		isError,
		timestamp: Date.now(),
	};
}

function runnable(tools: readonly { name: string }[]): readonly RunnableTool[] {
	return tools as readonly RunnableTool[];
}

async function runTool(
	options: CursorExecHandlerOptions,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
	cwd: string,
): Promise<CursorExecToolResult> {
	const tool = runnable(options.getTools()).find((candidate) => candidate.name === toolName);
	if (!tool) return toolResult(toolCallId, toolName, `Tool "${toolName}" not available`, true);
	try {
		const result = await tool.execute(toolCallId, omitUndefinedArgs(args), undefined, undefined, { cwd });
		return toolResult(toolCallId, toolName, resultText(result), result.isError === true, result.details);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return toolResult(toolCallId, toolName, message, true);
	}
}

/**
 * Handlers `streamCursor` calls for legacy exec frames.
 * `shell` runs the session `bash` tool; `read` / `grep` / `write` use the same names.
 */
export function createCursorExecHandlers(options: CursorExecHandlerOptions) {
	return {
		async shell(args: ShellExecArgs): Promise<CursorExecToolResult> {
			return runTool(
				options,
				"bash",
				callId(args.toolCallId),
				{ command: args.command, timeout: shellTimeoutSeconds(args.timeout) },
				args.workingDirectory || options.cwd,
			);
		},
		async read(args: ReadExecArgs): Promise<CursorExecToolResult> {
			return runTool(
				options,
				"read",
				callId(args.toolCallId),
				{ path: args.path, offset: args.offset, limit: args.limit },
				options.cwd,
			);
		},
		async grep(args: GrepExecArgs): Promise<CursorExecToolResult> {
			return runTool(
				options,
				"grep",
				callId(args.toolCallId),
				{
					pattern: args.pattern,
					path: args.path,
					glob: args.glob,
					ignoreCase: args.caseInsensitive === true ? true : undefined,
				},
				options.cwd,
			);
		},
		async write(args: WriteExecArgs): Promise<CursorExecToolResult> {
			const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
			return runTool(
				options,
				"write",
				callId(args.toolCallId),
				{ path: args.path, content },
				options.cwd,
			);
		},
	};
}
