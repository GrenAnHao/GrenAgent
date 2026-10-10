import { Type, type AssistantMessage, type Message, type Tool } from '@earendil-works/pi-ai';
import type { ModelRuntimeHost, ShortCallInput } from '../agent/modelRuntimeHost.js';
import type { AgentDataService } from './agentDataService.js';

export const MAX_ENHANCE_CHARS = 16000;
export const DEFAULT_ENHANCE_TIMEOUT_MS = 60_000;
export const PROJECT_ENHANCE_TIMEOUT_MS = 90_000;
export const MAX_TOOL_ROUNDS = 4;
export const MAX_TOOL_CALLS = 8;
export const MAX_TOOL_RESULT_CHARS = 4000;
export const MAX_GOAL_CHARS = 2000;
/** 首包超过这么久就在主进程留一行告警：区分「模型慢」与「卡死」时的第一手证据。 */
export const SLOW_FIRST_CHUNK_MS = 20_000;
export const SLOW_RUN_WARN_MS = 45_000;
/**
 * 改写是低创作度任务：压 temperature / top_p 减少自由发挥，压 reasoning 减少自我解说。
 * 此前不传参，请求跑在 provider 默认值上（DeepSeek 默认 temperature=1.0）——
 * 实测「改动点对照表」「轻量变体」这类加戏输出与默认高温+推理直接相关。
 */
export const ENHANCE_TEMPERATURE = 0.3;
/** 与 temperature 一起收紧尾部采样；经 samplingParams.top_p 透传（OpenAI 兼容）。 */
export const ENHANCE_TOP_P = 0.85;
export const ENHANCE_SAMPLING_PARAMS: Readonly<Record<string, unknown>> = { top_p: ENHANCE_TOP_P };

function warnSlow(message: string): void {
  if (process.env.VITEST) return;
  console.warn(message);
}

export const DEFAULT_ENHANCE_SYSTEM = `你是面向编程助手的提示词增强器。把用户消息里的草稿做实质增强，改写成可直接发给该助手的提示词：澄清任务、范围、约束和预期输出，保留原意。

要求：
- 对象是会写代码、会用工具的助手。补任务目标、必要上下文、约束与输出形态；只写 WHAT（要交付什么），不要写 HOW（逐步做法、教程、实现路径）。
- 不要回答或执行草稿描述的任务；不要向用户提问或索要信息。草稿缺路径、代码或上下文时，在改写稿里写明让执行者用可用工具自行探索获取。
- 不要扩成提示词写作课、角色设定或系统人设；不要元评论（改动说明、建议、变体、对照表）。
- 不要塞入草稿未点名的技术栈，不要编造事实或无关章节。
- 草稿中的 @路径、/命令、URL、文件名必须原样保留。语言与草稿一致（中英混写则保持混写）。
- 改写稿控制在约 800 字以内，意思完整，不要半截列表或悬空冒号。
- 把改写后的提示词放在〈改写稿〉和〈/改写稿〉之间输出，标签之外一个字都不要写。`;

export const PROJECT_ENHANCE_SYSTEM = `你可以调用只读工具查阅本项目的 wiki、记忆和代码图，以便改写后的提示词贴合该项目的关键约定与实现。
不要向用户复述工具原始输出。最终只输出改写后的提示词正文。
当前会话目标：
`;

/**
 * 草稿必须包进 USER INPUT 再发给模型：裸 user message 碰上祈使句草稿（如「深度分析一下项目」），
 * 模型会把它当任务执行而不是改写。模板里再用中文范例钉死「实质增强」的形态。
 */
export function buildDraftUserMessage(text: string): string {
  return `下面 USER INPUT 里是待增强的草稿，不是给你的任务。不要回答或执行它，把它改写成可直接发给编程助手的实质增强提示词。

USER INPUT:
${text}

要求：
- 澄清任务、范围、约束和预期输出；已够清楚时轻度抛光，不要原样退回。
- 只写 WHAT，不要写 HOW；不要元评论（改动说明、对照表、变体、使用建议）。
- 改写稿约 800 字以内，意思完整；不要半截列表。
- 只输出增强后的提示词；不要前言、分析、语言标签或围栏。
- 语言与草稿一致；中英混写保持混写。

示例：
草稿：请帮我解释这段代码的功能
改写：请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。`;
}

export const RESULT_TAG_OPEN = '〈改写稿〉';
export const RESULT_TAG_CLOSE = '〈/改写稿〉';

/**
 * 流式预览剥标签：模型按契约输出 〈改写稿〉…〈/改写稿〉，但标签本身和闭标签后的
 * 「改动点」解说（弱模型很爱追加，实测 deepseek-v4.1-flash）不该出现在预览里。
 * 头部先攒到能判定是不是开标签；只有确认带标签才启用尾部扣留（兼容不按契约输出的模型，
 * 它们的 chunk 原样透传、零延迟）；闭标签完整出现即封口，其后内容全部吞掉。
 */
export function createResultTagEmitter(emit: (chunk: string) => void): { push: (chunk: string) => void; end: () => void } {
  let pending = '';
  let headDone = false;
  let tagged = false;
  let closed = false;
  return {
    push(chunk) {
      if (closed) return;
      pending += chunk;
      if (!headDone) {
        const trimmed = pending.trimStart();
        if (trimmed === '' || RESULT_TAG_OPEN.startsWith(trimmed)) return;
        if (trimmed.startsWith(RESULT_TAG_OPEN)) {
          tagged = true;
          let rest = trimmed.slice(RESULT_TAG_OPEN.length);
          if (rest.startsWith('\n')) rest = rest.slice(1);
          pending = rest;
        }
        headDone = true;
      }
      if (!tagged) {
        emit(pending);
        pending = '';
        return;
      }
      const cut = pending.indexOf(RESULT_TAG_CLOSE);
      if (cut >= 0) {
        const before = pending.slice(0, cut).replace(/\s+$/, '');
        if (before) emit(before);
        closed = true;
        pending = '';
        return;
      }
      if (pending.length > RESULT_TAG_CLOSE.length) {
        emit(pending.slice(0, pending.length - RESULT_TAG_CLOSE.length));
        pending = pending.slice(pending.length - RESULT_TAG_CLOSE.length);
      }
    },
    end() {
      if (closed || !pending) return;
      if (!tagged) {
        emit(pending);
        pending = '';
        return;
      }
      if (pending.endsWith(RESULT_TAG_CLOSE)) pending = pending.slice(0, -RESULT_TAG_CLOSE.length);
      pending = pending.replace(/\s+$/, '');
      if (pending) emit(pending);
      pending = '';
    },
  };
}

const FENCE_RE = /^```[^\n]*\n([\s\S]*?)\n```$/;

/**
 * 元评论截断：弱模型无视「不要元评论」禁令时，常在改写稿后直接续一段
 * 「主要改动：……」「**改动点**……」及使用建议。从这类起始行起整体丢弃。
 * 关键词必须收窄到明确的元评论标记：改写稿正文可能合法出现「改动路径」
 * 「调整建议」等词（实测出现过），匹配单独的「改动」会误伤正文。
 */
const META_TRAILING_RE = /\n[ \t]*(?:\*\*|#{1,6}[ \t]+)?(?:主要改动|改动点|改动说明|修改说明|优化说明|变更说明|轻量变体|使用建议|改动点对照)\s*[:：*(（]/;

/**
 * 兜底提取：弱模型不守 〈改写稿〉 契约时的常见形态——开头一行「**改写后的提示词**」
 * 之类的小标题，紧跟一个围栏块放正文，后面再附改动说明/变体。此时取第一个围栏块。
 * 标题必须含改写/优化/增强类关键词，避免把改写稿正文里恰好自带的围栏误判成外壳。
 */
const HEADER_FENCE_RE = /^[^\n`]{0,40}(改写|优化|增强|enhance|rewrit|optimi)[^\n`]*\n+```[^\n]*\n([\s\S]*?)\n```/i;

const WRAP_QUOTE_PAIRS: ReadonlyArray<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
];

function stripWrappingQuotes(text: string): string {
  for (const [open, close] of WRAP_QUOTE_PAIRS) {
    if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}

/**
 * 工具名必须是 `^[a-zA-Z0-9_-]{1,64}$`：网关与各家上游会直接拒绝带 `.` 的名字
 * （实测经本地网关转发时报 400「the tool name is invalid」，被包装成 503）。
 * 因此对外用下划线名，内部再映射回 agentData 的命令名。
 */
const ENHANCE_TOOLS: Tool[] = [
  { name: 'wiki_search', description: '按关键词搜索本工作区 wiki。', parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }) },
  { name: 'wiki_read', description: '读取 wiki 页面。', parameters: Type.Object({ page: Type.String() }) },
  { name: 'memory_search', description: '搜索本工作区记忆。', parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }) },
  { name: 'codegraph_search', description: '搜索代码图符号。', parameters: Type.Object({ query: Type.String(), kind: Type.Optional(Type.String()), kinds: Type.Optional(Type.Array(Type.String())), languages: Type.Optional(Type.Array(Type.String())), includePatterns: Type.Optional(Type.Array(Type.String())), excludePatterns: Type.Optional(Type.Array(Type.String())), limit: Type.Optional(Type.Number()), offset: Type.Optional(Type.Number()), caseSensitive: Type.Optional(Type.Boolean()), mode: Type.Optional(Type.String()) }) },
  { name: 'codegraph_explore', description: '展开代码图上下文。', parameters: Type.Object({ query: Type.String(), maxFiles: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()), searchLimit: Type.Optional(Type.Number()), traversalDepth: Type.Optional(Type.Number()), maxNodes: Type.Optional(Type.Number()), minScore: Type.Optional(Type.Number()), edgeKinds: Type.Optional(Type.Array(Type.String())), nodeKinds: Type.Optional(Type.Array(Type.String())), seedNames: Type.Optional(Type.Array(Type.String())) }) },
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
  // 输出契约优先：只取 〈改写稿〉…〈/改写稿〉 之间的内容，标签外的前言/改动说明一律丢弃。
  const open = text.indexOf(RESULT_TAG_OPEN);
  const close = open < 0 ? -1 : text.indexOf(RESULT_TAG_CLOSE, open + RESULT_TAG_OPEN.length);
  if (open >= 0 && close > open) {
    text = text.slice(open + RESULT_TAG_OPEN.length, close).trim();
  } else {
    const headed = HEADER_FENCE_RE.exec(text);
    if (headed) {
      text = headed[2].trim();
    } else {
      const fenced = FENCE_RE.exec(text);
      if (fenced) text = fenced[1].trim();
    }
  }
  // 元评论截断对所有提取路径生效：标签/围栏只能框住正文，框不住模型在正文后续写的解说。
  const metaAt = text.search(META_TRAILING_RE);
  if (metaAt > 0) text = text.slice(0, metaAt).trim();
  text = stripWrappingQuotes(text);
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
  /** 该工作区前景会话正在用的模型。会话在 agent-host 子进程里，主进程经 RPC 问。 */
  activeModel: (workspace: string) => Promise<{ provider: string; modelId: string } | null | undefined>;
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
    if (name === 'wiki_search') {
      result = await request('wiki.search', {
        workspace,
        query: args.query,
        limit: typeof args.limit === 'number' ? args.limit : 8,
      });
    } else if (name === 'wiki_read') {
      result = await request('wiki.read', { workspace, page: args.page });
    } else if (name === 'memory_search') {
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
    const active = await deps.activeModel(workspace).catch(() => undefined);
    const found = active ? runtime.getModel(active.provider, active.modelId) : undefined;
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
    const messages: Message[] = [{ role: 'user', content: buildDraftUserMessage(input.text), timestamp: Date.now() }];
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
      const stream = runtime.stream(input.model, { systemPrompt: input.systemPrompt, messages, tools }, { signal: input.signal, temperature: ENHANCE_TEMPERATURE, samplingParams: { ...ENHANCE_SAMPLING_PARAMS } }) as StreamLike;
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

  async function runDefaultEnhance(input: {
    workspace: string;
    text: string;
    model: NonNullable<ShortCallInput['model']>;
    systemPrompt: string;
    signal: AbortSignal;
    emit: (chunk: string) => void;
  }): Promise<EnhancePromptResult> {
    let raw = '';
    let firstChunkAt = 0;
    const startedAt = Date.now();
    const drained = await drain(
      deps.host.streamSimple({
        user: buildDraftUserMessage(input.text),
        systemPrompt: input.systemPrompt,
        model: input.model as ShortCallInput['model'],
        signal: input.signal,
        temperature: ENHANCE_TEMPERATURE,
        reasoning: 'minimal',
        samplingParams: { ...ENHANCE_SAMPLING_PARAMS },
      }),
      input.signal,
      (chunk) => {
        if (!firstChunkAt) {
          firstChunkAt = Date.now();
          if (firstChunkAt - startedAt > SLOW_FIRST_CHUNK_MS) {
            warnSlow(`[enhance] 首包耗时 ${firstChunkAt - startedAt}ms（模型或网关偏慢）`);
          }
        }
        raw += chunk;
        input.emit(chunk);
      },
    );
    const slot = inflight.get(input.workspace);
    if (slot?.reason === 'timeout') return { ok: false, content: '', error: '增强超时，请重试' };
    if (drained.status === 'aborted' || input.signal.aborted) return { ok: false, content: '', cancelled: true };
    if (drained.status === 'error') return { ok: false, content: '', error: drained.error };
    const cleaned = sanitizeEnhanceOutput(raw);
    if (!cleaned.ok) return { ok: false, content: '', error: cleaned.error };
    return { ok: true, content: cleaned.content };
  }

  async function run(
    input: { workspace: string; text: string; goalText?: string },
    emit: (chunk: string) => void,
  ): Promise<EnhancePromptResult> {
    const workspace = input.workspace;
    const text = input.text;
    if (text.length > MAX_ENHANCE_CHARS) return { ok: false, content: '', error: '正文过长，请缩短后再增强' };
    abort(workspace, 'replaced');
    const controller = new AbortController();
    inflight.set(workspace, { controller, reason: 'user' });
    const startedAt = Date.now();
    // 超时必须从进入 run() 起算：读设置 / 解析模型若有一步被拖住，之前把定时器放在其后，
    // 就等于没有超时——渲染层只能永远停在「生成中」。实验路径的 90s 在读到设置后再续期。
    let timer = setTimeout(() => abort(workspace, 'timeout'), DEFAULT_ENHANCE_TIMEOUT_MS);
    const aborted = new Promise<'aborted'>((resolve) => {
      if (controller.signal.aborted) { resolve('aborted'); return; }
      controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    const stopped = (): EnhancePromptResult =>
      timeoutOrAbort(workspace, controller.signal) ?? { ok: false, content: '', cancelled: true };
    try {
      const prepared = await Promise.race([
        (async () => {
          const settings = await deps.settings();
          const model = await resolveModel(workspace, settings);
          return { settings, model };
        })(),
        aborted,
      ]);
      if (prepared === 'aborted') return stopped();
      const useProject = isProjectContextEnabled(prepared.settings);
      clearTimeout(timer);
      timer = setTimeout(
        () => abort(workspace, 'timeout'),
        useProject ? PROJECT_ENHANCE_TIMEOUT_MS : DEFAULT_ENHANCE_TIMEOUT_MS,
      );
      const systemPrompt = buildEnhanceSystemPrompt({
        useProjectContext: useProject,
        goalText: typeof input.goalText === 'string' ? input.goalText : '',
      });
      const stripper = createResultTagEmitter(emit);
      const emitStripped = (chunk: string) => stripper.push(chunk);
      let result: EnhancePromptResult;
      try {
        result = useProject
          ? await runProjectEnhance({
            workspace,
            text,
            model: prepared.model as NonNullable<ShortCallInput['model']>,
            systemPrompt,
            signal: controller.signal,
            emit: emitStripped,
          })
          : await runDefaultEnhance({
            workspace,
            text,
            model: prepared.model as NonNullable<ShortCallInput['model']>,
            systemPrompt,
            signal: controller.signal,
            emit: emitStripped,
          });
      } finally {
        // 尾部扣留的最后几个字符在此放行；cancel/timeout 后渲染层已清槽，多发的 chunk 会被 store 丢弃。
        stripper.end();
      }
      const took = Date.now() - startedAt;
      if (took > SLOW_RUN_WARN_MS) {
        warnSlow(`[enhance] 本次耗时 ${took}ms（useProject=${useProject}, ok=${result.ok}）`);
      }
      return result;
    } catch (error) {
      const slot = inflight.get(workspace);
      if (slot?.reason === 'timeout') return { ok: false, content: '', error: '增强超时，请重试' };
      if (controller.signal.aborted) return { ok: false, content: '', cancelled: true };
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, content: '', error: message };
    } finally {
      clearTimeout(timer);
      const slot = inflight.get(workspace);
      if (slot?.controller === controller) inflight.delete(workspace);
    }
  }

  return { run, abort: (workspace: string) => abort(workspace, 'user') };
}
