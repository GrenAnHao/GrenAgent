import { Type, type AssistantMessage, type Message, type Tool } from '@earendil-works/pi-ai';
import { snapshotSessionModel } from '../agent/workspaceHandle.js';
import type { ModelRuntimeHost, ShortCallInput } from '../agent/modelRuntimeHost.js';
import type { AgentHost } from '../agent/agentHost.js';
import type { AgentDataService } from './agentDataService.js';

export const MAX_ENHANCE_CHARS = 16000;
export const DEFAULT_ENHANCE_TIMEOUT_MS = 60_000;
export const PROJECT_ENHANCE_TIMEOUT_MS = 90_000;
export const MAX_TOOL_ROUNDS = 4;
export const MAX_TOOL_CALLS = 8;
export const MAX_TOOL_RESULT_CHARS = 4000;
export const MAX_GOAL_CHARS = 2000;

export const DEFAULT_ENHANCE_SYSTEM = `你是提示词改写器。把用户的草稿改写成更清晰、更完整的提示词：保留原意，补上结构、约束和成功标准。
只输出改写后的提示词正文，不要开场白、不要解释、不要用代码围栏包住整段。
原文中的 @路径、/命令、URL、文件名必须原样保留。
使用与原文相同的语言。`;

export const PROJECT_ENHANCE_SYSTEM = `你可以调用只读工具查阅本项目的 wiki、记忆和代码图，以便改写后的提示词贴合该项目的关键约定与实现。
不要向用户复述工具原始输出。最终只输出改写后的提示词正文。
当前会话目标：
`;

const FENCE_RE = /^```[^\n]*\n([\s\S]*?)\n```$/;

const ENHANCE_TOOLS: Tool[] = [
  { name: 'wiki.search', description: '按关键词搜索本工作区 wiki。', parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }) },
  { name: 'wiki.read', description: '读取 wiki 页面。', parameters: Type.Object({ page: Type.String() }) },
  { name: 'memory.search', description: '搜索本工作区记忆。', parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }) },
  { name: 'codegraph_search', description: '搜索代码图符号。', parameters: Type.Object({ query: Type.String(), kind: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }) },
  { name: 'codegraph_explore', description: '展开代码图上下文。', parameters: Type.Object({ query: Type.String(), maxFiles: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }) },
];

type DrainEvent = {
  type: string;
  text?: string;
  delta?: string;
  error?: unknown;
  message?: unknown;
};

type ToolCallBlock = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };

type StreamLike = AsyncIterable<DrainEvent> & { result?: () => Promise<AssistantMessage> };

export function sanitizeEnhanceOutput(raw: string): { ok: true; content: string } | { ok: false; error: string } {
  let text = raw.trim();
  const fenced = FENCE_RE.exec(text);
  if (fenced) text = fenced[1].trim();
  if (!text) return { ok: false, error: '模型返回为空' };
  return { ok: true, content: text };
}

export function buildEnhanceSystemPrompt(input: { useProjectContext: boolean; goalText?: string }): string {
  if (!input.useProjectContext) return DEFAULT_ENHANCE_SYSTEM;
  const goal = input.goalText?.trim() ? input.goalText.trim() : '无';
  return `${DEFAULT_ENHANCE_SYSTEM}\n\n${PROJECT_ENHANCE_SYSTEM}${goal}`;
}

export interface EnhancePromptResult {
  ok: boolean;
  content: string;
  error?: string;
  cancelled?: boolean;
}

export interface EnhancePromptDeps {
  host: Pick<ModelRuntimeHost, 'streamSimple' | 'ensure'>;
  agentHost: Pick<AgentHost, 'get'>;
  settings: () => Promise<Record<string, string>>;
  agentData: Pick<AgentDataService, 'request'>;
}

function splitProviderId(value: string): { provider: string; id: string } | null {
  const cut = value.indexOf('/');
  if (cut <= 0 || cut === value.length - 1) return null;
  return { provider: value.slice(0, cut), id: value.slice(cut + 1) };
}

function isProjectContextEnabled(settings: Record<string, string>): boolean {
  return settings.enhancePromptUseProjectContext === '1';
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } =>
      !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('');
}

function toolCallsFromContent(content: unknown): ToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  const calls: ToolCallBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const rec = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (rec.type !== 'toolCall' || typeof rec.name !== 'string') continue;
    calls.push({
      type: 'toolCall',
      id: typeof rec.id === 'string' ? rec.id : '',
      name: rec.name,
      arguments: rec.arguments && typeof rec.arguments === 'object' && !Array.isArray(rec.arguments)
        ? rec.arguments as Record<string, unknown>
        : {},
    });
  }
  return calls;
}

function errorText(error: unknown): string {
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const rec = error as { errorMessage?: unknown; content?: unknown };
    if (typeof rec.errorMessage === 'string' && rec.errorMessage) return rec.errorMessage;
    const fromContent = textFromContent(rec.content);
    if (fromContent) return fromContent;
  }
  return '增强失败';
}

function messageOf(done: DrainEvent): { content?: unknown; errorMessage?: string } | undefined {
  if (!done.message || typeof done.message !== 'object') return undefined;
  return done.message as { content?: unknown; errorMessage?: string };
}

/**
 * 迭代 + 可被 abort 打断。不能直接 `for await`：abort 不会让挂起的 next() 返回，
 * run() 会永远挂着（超时用例 hang、切工作区漏 promise）。必须 race，并在 finally 收 iterator。
 */
async function drain(
  source: AsyncIterable<DrainEvent>,
  signal: AbortSignal,
  onDelta: (chunk: string) => void,
): Promise<{ status: 'done' | 'aborted' | 'error'; error: string; dones: DrainEvent[] }> {
  const iterator = source[Symbol.asyncIterator]();
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) { resolve('aborted'); return; }
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  const dones: DrainEvent[] = [];
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next === 'aborted') return { status: 'aborted', error: '', dones };
      if (next.done) return { status: 'done', error: '', dones };
      const ev = next.value;
      if (ev.type === 'delta' && ev.text) onDelta(ev.text);
      else if (ev.type === 'text_delta' && ev.delta) onDelta(ev.delta);
      else if (ev.type === 'done') dones.push(ev);
      else if (ev.type === 'error') return { status: 'error', error: errorText(ev.error), dones };
    }
  } finally {
    // hang 的 next() 不会结束；await return() 会跟着挂死。abort 已 settle 时立刻脱身。
    try {
      await Promise.race([iterator.return?.() ?? Promise.resolve(), aborted]);
    } catch { /* 关闭挂起的 iterator 失败不阻断 */ }
  }
}

function pickRoundFromDones(dones: DrainEvent[], buffered: string): { message: unknown; toolCalls: ToolCallBlock[]; text: string } {
  const messages = dones.map(messageOf).filter((msg): msg is { content?: unknown; errorMessage?: string } => !!msg);

  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
    const text = textFromContent(content);
    if (text && toolCallsFromContent(content).length === 0) {
      return { message: messages[i], toolCalls: [], text };
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const calls = toolCallsFromContent(messages[i]!.content);
    if (calls.length) return { message: messages[i], toolCalls: calls, text: textFromContent(messages[i]!.content) || buffered };
  }

  const last = messages[messages.length - 1];
  return {
    message: last,
    toolCalls: [],
    text: (last ? textFromContent(last.content) : '') || buffered,
  };
}

async function resolveRoundAssistant(
  stream: StreamLike,
  dones: DrainEvent[],
  buffered: string,
): Promise<{ message: unknown; toolCalls: ToolCallBlock[]; text: string }> {
  const picked = pickRoundFromDones(dones, buffered);
  if (dones.length > 1 && (picked.text || picked.toolCalls.length)) return picked;
  if (typeof stream.result === 'function') {
    try {
      const message = await stream.result();
      if (message) {
        return {
          message,
          toolCalls: toolCallsFromContent(message.content),
          text: textFromContent(message.content) || buffered,
        };
      }
    } catch { /* 测试 mock 没有 result()，或 result 失败，回退 dones */ }
  }
  return picked;
}

async function executeEnhanceTool(
  request: AgentDataService['request'],
  workspace: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  try {
    let result: unknown;
    if (name === 'wiki.search') {
      result = await request('wiki.search', {
        workspace,
        query: args.query,
        limit: typeof args.limit === 'number' ? args.limit : 8,
      });
    } else if (name === 'wiki.read') {
      result = await request('wiki.read', { workspace, page: args.page });
    } else if (name === 'memory.search') {
      // userId 第一版直接 'local'：与 memoryService.ts:153 一致的回退
      result = await request('memory.search', {
        userId: 'local',
        workspace,
        query: args.query,
        limit: typeof args.limit === 'number' ? args.limit : 8,
      });
    } else if (name === 'codegraph_search' || name === 'codegraph_explore') {
      result = await request('codeRetrieval.call', { workspace, tool: name, args });
    } else {
      return { isError: true, text: '不允许的工具' };
    }
    const serialized = JSON.stringify(result);
    let text = typeof serialized === 'string' ? serialized : '';
    if (text.length > MAX_TOOL_RESULT_CHARS) text = text.slice(0, MAX_TOOL_RESULT_CHARS);
    return { isError: false, text };
  } catch (error) {
    return { isError: true, text: error instanceof Error ? error.message : String(error) };
  }
}

export function createEnhancePrompt(deps: EnhancePromptDeps) {
  const inflight = new Map<string, { controller: AbortController; reason: 'user' | 'timeout' | 'replaced' }>();

  function abort(workspace: string, reason: 'user' | 'timeout' | 'replaced' = 'user'): void {
    const current = inflight.get(workspace);
    if (!current) return;
    current.reason = reason;
    current.controller.abort();
  }

  function timeoutOrAbort(workspace: string, signal: AbortSignal): EnhancePromptResult | undefined {
    const slot = inflight.get(workspace);
    if (slot?.reason === 'timeout') return { ok: false, content: '', error: '增强超时，请重试' };
    if (signal.aborted) return { ok: false, content: '', cancelled: true };
    return undefined;
  }

  async function resolveModel(workspace: string, settings: Record<string, string>) {
    const runtime = await deps.host.ensure();
    const configured = (settings.enhancePromptModel ?? '').trim();
    if (configured) {
      const split = splitProviderId(configured);
      const found = split ? runtime.getModel(split.provider, split.id) : undefined;
      if (!found) throw new Error('增强提示词模型不可用，请在设置中重选或留空');
      return found;
    }
    const handle = deps.agentHost.get(workspace);
    const snap = snapshotSessionModel(handle?.session.model);
    const provider = typeof snap?.provider === 'string' ? snap.provider : '';
    const id = typeof snap?.id === 'string' ? snap.id : '';
    const found = provider && id ? runtime.getModel(provider, id) : undefined;
    if (!found) throw new Error('没有可用模型');
    return found;
  }

  async function runProjectEnhance(input: {
    workspace: string;
    text: string;
    model: NonNullable<ShortCallInput['model']>;
    systemPrompt: string;
    signal: AbortSignal;
    emit: (chunk: string) => void;
  }): Promise<EnhancePromptResult> {
    const messages: Message[] = [{ role: 'user', content: input.text, timestamp: Date.now() }];
    let executed = 0;
    let round = 0;
    const runtime = await deps.host.ensure();
    const aborted = new Promise<'aborted'>((resolve) => {
      if (input.signal.aborted) { resolve('aborted'); return; }
      input.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });

    for (;;) {
      const stopped = timeoutOrAbort(input.workspace, input.signal);
      if (stopped) return stopped;
      const tools = executed >= MAX_TOOL_CALLS || round >= MAX_TOOL_ROUNDS ? [] : ENHANCE_TOOLS;
      let buffered = '';
      let liveEmitted = false;
      const stream = runtime.stream(input.model, { systemPrompt: input.systemPrompt, messages, tools }, { signal: input.signal }) as StreamLike;
      const drained = await drain(stream, input.signal, (chunk) => {
        buffered += chunk;
        if (tools.length === 0) {
          liveEmitted = true;
          input.emit(chunk);
        }
      });
      const afterDrain = timeoutOrAbort(input.workspace, input.signal);
      if (afterDrain) return afterDrain;
      if (drained.status === 'aborted') return { ok: false, content: '', cancelled: true };
      if (drained.status === 'error') return { ok: false, content: '', error: drained.error };

      const resolved = await resolveRoundAssistant(stream, drained.dones, buffered);
      const finish = (raw: string): EnhancePromptResult => {
        if (!liveEmitted && raw) input.emit(raw);
        const cleaned = sanitizeEnhanceOutput(raw);
        if (!cleaned.ok) return { ok: false, content: '', error: cleaned.error };
        return { ok: true, content: cleaned.content };
      };
      if (resolved.toolCalls.length === 0) return finish(resolved.text || buffered);
      // 本轮已不带 tools：不再执行、不再 round++，避免模型仍只回 toolCall 时 for(;;) 挂死。
      if (tools.length === 0) return finish(resolved.text || buffered);

      const toolResults: Message[] = [];
      for (const call of resolved.toolCalls) {
        if (executed >= MAX_TOOL_CALLS) {
          toolResults.push({
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: '已达到工具次数上限' }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }
        executed += 1;
        const raced = await Promise.race([
          executeEnhanceTool(deps.agentData.request, input.workspace, call.name, call.arguments)
            .then((result) => ({ kind: 'ok' as const, result })),
          aborted.then(() => ({ kind: 'stop' as const })),
        ]);
        if (raced.kind === 'stop') {
          return timeoutOrAbort(input.workspace, input.signal) ?? { ok: false, content: '', cancelled: true };
        }
        const result = raced.result;
        toolResults.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: result.text }],
          isError: result.isError,
          timestamp: Date.now(),
        });
      }

      const assistant = (resolved.message && typeof resolved.message === 'object')
        ? resolved.message as AssistantMessage
        : { role: 'assistant' as const, content: resolved.toolCalls, timestamp: Date.now() };
      messages.push(assistant as Message, ...toolResults);
      round += 1;
    }
  }

  async function run(
    input: { workspace: string; text: string; goalText?: string },
    emit: (chunk: string) => void,
  ): Promise<EnhancePromptResult> {
    const text = input.text;
    if (text.length > MAX_ENHANCE_CHARS) return { ok: false, content: '', error: '正文过长，请缩短后再增强' };
    abort(input.workspace, 'replaced');
    const controller = new AbortController();
    inflight.set(input.workspace, { controller, reason: 'user' });
    const settings = await deps.settings();
    const useProject = isProjectContextEnabled(settings);
    const timeoutMs = useProject ? PROJECT_ENHANCE_TIMEOUT_MS : DEFAULT_ENHANCE_TIMEOUT_MS;
    const timer = setTimeout(() => abort(input.workspace, 'timeout'), timeoutMs);
    try {
      const model = await resolveModel(input.workspace, settings);
      const systemPrompt = buildEnhanceSystemPrompt({
        useProjectContext: useProject,
        goalText: typeof input.goalText === 'string' ? input.goalText : '',
      });
      if (useProject) {
        return await runProjectEnhance({
          workspace: input.workspace,
          text,
          model: model as NonNullable<ShortCallInput['model']>,
          systemPrompt,
          signal: controller.signal,
          emit,
        });
      }
      let raw = '';
      const drained = await drain(
        deps.host.streamSimple({
          user: text, systemPrompt, model: model as ShortCallInput['model'], signal: controller.signal,
        }),
        controller.signal,
        (chunk) => { raw += chunk; emit(chunk); },
      );
      const slot = inflight.get(input.workspace);
      if (slot?.reason === 'timeout') return { ok: false, content: '', error: '增强超时，请重试' };
      if (drained.status === 'aborted' || controller.signal.aborted) return { ok: false, content: '', cancelled: true };
      if (drained.status === 'error') return { ok: false, content: '', error: drained.error };
      const cleaned = sanitizeEnhanceOutput(raw);
      if (!cleaned.ok) return { ok: false, content: '', error: cleaned.error };
      return { ok: true, content: cleaned.content };
    } catch (error) {
      const slot = inflight.get(input.workspace);
      if (slot?.reason === 'timeout') return { ok: false, content: '', error: '增强超时，请重试' };
      if (controller.signal.aborted) return { ok: false, content: '', cancelled: true };
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, content: '', error: message };
    } finally {
      clearTimeout(timer);
      const slot = inflight.get(input.workspace);
      if (slot?.controller === controller) inflight.delete(input.workspace);
    }
  }

  return { run, abort: (workspace: string) => abort(workspace, 'user') };
}
