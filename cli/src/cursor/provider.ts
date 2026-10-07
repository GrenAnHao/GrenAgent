import {
	AssistantMessageEventStream,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getBundledModels } from "./vendor/catalog/models.ts";
import { streamCursor as vendorStreamCursor } from "./vendor/providers/cursor.ts";
import { resolveCursorWireModelId, type CursorWireModel } from "./wire-model.ts";

export interface CursorAgentStreamOptions extends SimpleStreamOptions {
	cursorExecHandlers?: unknown;
	cursorOnToolResult?: unknown;
}

export type CursorStreamCursor = (
	model: Model<"cursor-agent">,
	context: TranscriptContext,
	options?: CursorAgentStreamOptions & {
		execHandlers?: unknown;
		onToolResult?: unknown;
		wireModelId?: string;
	},
) => AssistantMessageEventStream;

interface CursorCatalog {
	models: readonly Model<"cursor-agent">[];
	wires: ReadonlyMap<string, CursorWireModel>;
}

const vendorStream: CursorStreamCursor = (model, context, options) =>
	vendorStreamCursor(model as never, context as never, options as never);

let openCursor: CursorStreamCursor = vendorStream;
let catalog: CursorCatalog | undefined;

export function bindCursorStream(streamCursor?: CursorStreamCursor): void {
	openCursor = streamCursor ?? vendorStream;
}

function cursorCatalog(): CursorCatalog {
	if (catalog) return catalog;
	const models: Model<"cursor-agent">[] = [];
	const wires = new Map<string, CursorWireModel>();
	for (const model of getBundledModels("cursor")) {
		if (model.api !== "cursor-agent" || typeof model.maxTokens !== "number") continue;
		models.push({
			id: model.id,
			name: model.name,
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: model.baseUrl,
			reasoning: model.reasoning,
			input: model.input.filter((item): item is "text" | "image" => item === "text" || item === "image"),
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		});
		wires.set(model.id, {
			id: model.id,
			requestModelId: model.requestModelId,
			thinking: model.thinking
				? {
						efforts: model.thinking.efforts,
						...(model.thinking.effortRouting ? { effortRouting: { ...model.thinking.effortRouting } } : {}),
					}
				: undefined,
		});
	}
	catalog = { models, wires };
	return catalog;
}

export function cursorChatModels(): readonly Model<"cursor-agent">[] {
	return cursorCatalog().models;
}

function rejectUnknownModel(id: string): AssistantMessageEventStream {
	const error = new Error(`unknown model: ${id}`);
	const stream = new AssistantMessageEventStream();
	stream.end();
	stream.result = () => Promise.reject(error);
	return stream;
}

function abortedAssistantStream(model: Model<"cursor-agent">): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		stopReason: "aborted",
		api: "cursor-agent",
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
	};
	stream.push({ type: "done", reason: "aborted", message });
	return stream;
}

function streamCursorAgent(
	model: Model<"cursor-agent">,
	context: TranscriptContext,
	options?: CursorAgentStreamOptions,
): AssistantMessageEventStream {
	const known = cursorCatalog().wires.get(model.id);
	if (!known) return rejectUnknownModel(model.id);
	if (options?.signal?.aborted) return abortedAssistantStream(model);
	const wireModelId = resolveCursorWireModelId(known, options?.reasoning ?? "off", model.id);
	return openCursor(model, context, {
		...options,
		signal: options?.signal,
		execHandlers: options?.cursorExecHandlers,
		onToolResult: options?.cursorOnToolResult,
		wireModelId,
	});
}

export const stream: StreamFunction<"cursor-agent", CursorAgentStreamOptions> = streamCursorAgent;
export const streamSimple: StreamFunction<"cursor-agent", CursorAgentStreamOptions> = streamCursorAgent;
