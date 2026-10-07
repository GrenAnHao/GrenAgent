import * as path from "node:path";
import { omitUndefinedArgs, shellTimeoutSeconds } from "./vendor/providers/cursor-pi-args.ts";

/** Session tool the exec bridge can invoke. `execute` matches the pi agent tool. */
interface RunnableTool {
	name: string;
	execute: (
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
		ctx?: CursorExecToolContext,
	) => Promise<ToolExecutionResult>;
}

/** Fifth argument real bash reads. `sessionManager` supplies PI_SESSION_ID. */
export interface CursorExecToolContext {
	cwd: string;
	sessionManager?: {
		getSessionId(): string;
		getSessionFile(): string | undefined;
	};
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
	/** Read on every exec call. `cwd` is this session's cwd, not a captured copy. */
	getContext?: () => CursorExecToolContext;
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

function sessionContext(options: CursorExecHandlerOptions): CursorExecToolContext {
	return options.getContext?.() ?? { cwd: options.cwd };
}

/**
 * Resolve `workingDirectory` against the session cwd.
 * An absolute path is checked the same way: the result must stay inside that cwd.
 */
function resolveSessionWorkingDirectory(
	sessionCwd: string,
	workingDirectory: string | undefined,
): { ok: true; cwd: string } | { ok: false; reason: string } {
	const root = path.resolve(sessionCwd);
	const target = workingDirectory ? path.resolve(root, workingDirectory) : root;
	const relative = path.relative(root, target);
	if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
		return { ok: false, reason: "Working directory rejected: outside the session" };
	}
	return { ok: true, cwd: target };
}

async function runTool(
	options: CursorExecHandlerOptions,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
	ctx: CursorExecToolContext,
): Promise<CursorExecToolResult> {
	const tool = runnable(options.getTools()).find((candidate) => candidate.name === toolName);
	if (!tool) return toolResult(toolCallId, toolName, `Tool "${toolName}" not available`, true);
	try {
		const result = await tool.execute(toolCallId, omitUndefinedArgs(args), undefined, undefined, ctx);
		return toolResult(toolCallId, toolName, resultText(result), result.isError === true, result.details);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return toolResult(toolCallId, toolName, message, true);
	}
}

export interface CursorExecHandlers {
	shell(args: ShellExecArgs): Promise<CursorExecToolResult>;
	read(args: ReadExecArgs): Promise<CursorExecToolResult>;
	grep(args: GrepExecArgs): Promise<CursorExecToolResult>;
	write(args: WriteExecArgs): Promise<CursorExecToolResult>;
}

export interface CursorExecPrepareOptions {
	sessionId?: string;
	cursorExecHandlers?: CursorExecHandlers;
}

const execSessions = new Map<string, () => CursorExecHandlers>();

/** Keep one factory per session. A later session must not replace an earlier one. */
export function registerCursorExecSession(sessionId: string, createHandlers: () => CursorExecHandlers): void {
	execSessions.set(sessionId, createHandlers);
}

/**
 * Attach the factory for `options.sessionId`.
 * An explicit `cursorExecHandlers` is kept. With no session id and no handlers, nothing is filled in.
 */
export function prepareCursorExec<T extends CursorExecPrepareOptions>(
	options: T,
): T & { cursorExecHandlers?: CursorExecHandlers } {
	const sessionId = options.sessionId;
	const registered =
		typeof sessionId === "string" && sessionId.length > 0 ? execSessions.get(sessionId)?.() : undefined;
	return {
		...options,
		cursorExecHandlers: options.cursorExecHandlers ?? registered,
	};
}

/**
 * Handlers `streamCursor` calls for legacy exec frames.
 * `shell` runs the session `bash` tool; `read` / `grep` / `write` use the same names.
 */
export function createCursorExecHandlers(options: CursorExecHandlerOptions): CursorExecHandlers {
	return {
		async shell(args: ShellExecArgs): Promise<CursorExecToolResult> {
			const toolCallId = callId(args.toolCallId);
			const base = sessionContext(options);
			const resolved = resolveSessionWorkingDirectory(base.cwd || options.cwd, args.workingDirectory);
			if (!resolved.ok) return toolResult(toolCallId, "bash", resolved.reason, true);
			return runTool(
				options,
				"bash",
				toolCallId,
				{ command: args.command, timeout: shellTimeoutSeconds(args.timeout) },
				{ ...base, cwd: resolved.cwd },
			);
		},
		async read(args: ReadExecArgs): Promise<CursorExecToolResult> {
			const base = sessionContext(options);
			return runTool(
				options,
				"read",
				callId(args.toolCallId),
				{ path: args.path, offset: args.offset, limit: args.limit },
				{ ...base, cwd: base.cwd || options.cwd },
			);
		},
		async grep(args: GrepExecArgs): Promise<CursorExecToolResult> {
			const base = sessionContext(options);
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
				{ ...base, cwd: base.cwd || options.cwd },
			);
		},
		async write(args: WriteExecArgs): Promise<CursorExecToolResult> {
			const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
			const base = sessionContext(options);
			return runTool(
				options,
				"write",
				callId(args.toolCallId),
				{ path: args.path, content },
				{ ...base, cwd: base.cwd || options.cwd },
			);
		},
	};
}
