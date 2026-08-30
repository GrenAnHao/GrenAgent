import { messagesFromTranscript, type ChatMessage } from '../../stores/agentReducer';

/** 从 spawn_agent 工具入参里取一个人类可读的任务标签（主对话内联块与右侧面板 tab 共用）。 */
export function taskLabel(args: unknown): string {
  const a = (args ?? {}) as {
    task?: string;
    tasks?: Array<string | { task?: string }>;
    chain?: Array<{ task?: string }>;
    agent?: string;
  };
  const agent = a.agent?.trim();
  if (a.task?.trim()) return agent ? `${agent}: ${a.task.trim()}` : a.task.trim();
  if (a.chain?.length) return `${a.chain.length} 步链式`;
  if (a.tasks?.length) return `${a.tasks.length} 个并行任务`;
  return '子代理任务';
}

/** 从子代理任务文本提取简短角色：识别「角色 ... **X**」，回退首个非空行剥 markdown 截断。 */
export function subAgentRoleLabel(task: string): string {
  const t = (task ?? '').trim();
  if (!t) return '子代理任务';
  const m = t.match(/角色[^\n]*?\*\*(.+?)\*\*/);
  if (m && m[1].trim()) return m[1].trim();
  const firstLine = t.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? t;
  const plain = firstLine.replace(/^#{1,6}\s*/, '').replace(/[*_`>]/g, '').trim();
  return plain.length > 40 ? `${plain.slice(0, 40)}…` : plain;
}

/** 从已解析消息列表取「第 N 步 + 当前动作」（step 计 assistant+tool）。 */
export function latestStepFromMessages(msgs: ChatMessage[]): { step: number; action: string } | null {
  const steps = msgs.filter((m) => m.kind === 'assistant' || m.kind === 'tool');
  if (steps.length === 0) return null;
  const last = steps[steps.length - 1];
  const action = last.kind === 'tool' ? `调用 ${last.toolName}` : '生成回复中…';
  return { step: steps.length, action };
}

/** 从运行中子代理增量 transcript 取最新一步摘要，供折叠态第二行实时显示。 */
export function latestSubAgentStep(transcript: string): { step: number; action: string } | null {
  if (!transcript) return null;
  return latestStepFromMessages(messagesFromTranscript(transcript));
}

/**
 * 终态兜底：运行中 transcript 的末步可能只有 tool_execution_start 而缺 tool_execution_end
 * （子代理进程结束时最后一步的结果事件尚未写入 transcript），回放会把该步一直停在 running、转圈不停。
 * 整体已进入终态（done/error）时据此把残留的「运行中」步骤收尾：工具置为对应终态、流式助手收流。
 * 运行中不动（末步确实在跑，保留 running 才是对的）。纯函数，便于单测。
 */
export function finalizeSubAgentMessages(
  messages: ChatMessage[],
  status: 'running' | 'done' | 'error',
): ChatMessage[] {
  if (status === 'running') return messages;
  return messages.map((m) => {
    if (m.kind === 'tool' && m.status === 'running') {
      return { ...m, status: status === 'error' ? 'error' : 'done' };
    }
    if (m.kind === 'assistant' && m.streaming) {
      return { ...m, streaming: false };
    }
    return m;
  });
}

function detailsOf(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const details = (result as { details?: unknown }).details;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : null;
}

/** spawn_agent 工具结果里的 agentId（前台/后台子代理均有）。 */
export function subAgentId(result: unknown): string | null {
  const id = detailsOf(result)?.agentId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** 后台 spawn：工具调用已返回但子代理仍在 registry 中运行。 */
export function isBackgroundSpawn(result: unknown): boolean {
  const d = detailsOf(result);
  return d?.status === 'running' && typeof d?.transcript !== 'string';
}

/** registry 状态字符串 → 会话视图三态（cancelled 归入 error）。 */
export function mapSubAgentStatus(status: string): 'running' | 'done' | 'error' {
  if (status === 'running') return 'running';
  if (status === 'error' || status === 'cancelled') return 'error';
  return 'done';
}

function transcriptOf(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return '';
  const t = (details as { transcript?: unknown }).transcript;
  return typeof t === 'string' ? t : '';
}

/** 子代理已执行步数（transcript 里的 assistant + tool 消息数）；无 transcript 返回 0。 */
export function subAgentStepCount(result: unknown): number {
  const transcript = transcriptOf(result);
  if (!transcript) return 0;
  return messagesFromTranscript(transcript).filter(
    (m) => m.kind === 'assistant' || m.kind === 'tool',
  ).length;
}

/** 子代理最终输出文本（取工具结果的 content 文本块）；用于内联展开的「结果」预览。 */
export function subAgentFinalText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: string }).type === 'text',
    )
    .map((b) => b.text)
    .join('');
}

export interface SubAgentStatsData {
  model?: string;
  totalToolCalls?: number;
  totalTokens?: number;
}

/** token 数紧凑显示（对齐 lobehub）：<1k 原样，<1m 用 k，≥1m 用 m。 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** 从各种 usage 形状里尽力取一个总 token 数；取不到返回 undefined。 */
function pickTokenTotal(usage: unknown): number | undefined {
  const u = asRecord(usage);
  if (!u) return undefined;
  const direct = u.totalTokens ?? u.total_tokens ?? u.tokens;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct;
  const input = u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens;
  const output = u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens;
  const sum = (typeof input === 'number' ? input : 0) + (typeof output === 'number' ? output : 0);
  return sum > 0 ? sum : undefined;
}

/**
 * 防御式解析子代理 transcript（`--mode json` 的 JSONL）抽取一行统计：模型 / 工具调用数 / token 数。
 * 字段形状由 pi 包决定、可能变动，故逐项「拿得到就用、拿不到就略过」（对齐 lobehub：无数据不渲染）。
 * 仅终态调用（运行中频繁变动的 transcript 不在主对话里反复解析，避免卡顿）。
 */
export function subAgentStats(result: unknown): SubAgentStatsData | null {
  const transcript = transcriptOf(result);
  if (!transcript) return null;
  let model: string | undefined;
  let toolCalls = 0;
  let totalTokens: number | undefined;
  for (const line of transcript.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    const obj = asRecord(ev);
    if (!obj) continue;
    if (obj.type === 'tool_execution_start') toolCalls++;
    if (!model) {
      const m = asRecord(obj.message)?.model ?? obj.model;
      if (typeof m === 'string' && m.trim()) model = m.trim();
    }
    const t =
      pickTokenTotal(obj.usage) ??
      pickTokenTotal(asRecord(obj.message)?.usage) ??
      pickTokenTotal(obj.contextUsage);
    if (typeof t === 'number' && t > 0) totalTokens = t; // 取最后一次出现的总量
  }
  const out: SubAgentStatsData = {};
  // 模型去掉 provider 前缀更紧凑（如 deepseek/deepseek-v4-flash → deepseek-v4-flash）。
  if (model) out.model = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  if (toolCalls > 0) out.totalToolCalls = toolCalls;
  if (typeof totalTokens === 'number' && totalTokens > 0) out.totalTokens = totalTokens;
  return Object.keys(out).length > 0 ? out : null;
}

interface SpawnArgs {
  task?: string;
  tasks?: Array<string | { task?: string }>;
  chain?: Array<{ task?: string }>;
  agent?: string;
}

interface UnitResult {
  task?: string;
  ok?: boolean;
  output?: string;
  error?: string;
}

/** 一次 spawn_agent 调用展开出的逐个子代理任务文本（单任务 1 条；并行/链式 N 条）。 */
function unitTasks(args: unknown): string[] {
  const a = (args ?? {}) as SpawnArgs;
  if (Array.isArray(a.chain) && a.chain.length > 0) {
    return a.chain.map((s) => s?.task?.trim() || '子代理任务');
  }
  const out: string[] = [];
  const single = a.task?.trim();
  if (single) out.push(single);
  for (const t of a.tasks ?? []) {
    if (typeof t === 'string') {
      const v = t.trim();
      if (v) out.push(v);
    } else if (t && typeof t.task === 'string' && t.task.trim()) {
      out.push(t.task.trim());
    }
  }
  if (out.length === 0) out.push('子代理任务');
  return out;
}

/** 后端结果里逐个子代理的结果数组（chain / parallel 的 details.results）；无则 null。 */
function resultsOf(result: unknown): UnitResult[] | null {
  const r = detailsOf(result)?.results;
  return Array.isArray(r) ? (r as UnitResult[]) : null;
}

export type SubAgentMode = 'single' | 'parallel' | 'chain';

/** 调用模式：单任务 / 并行 / 链式（按 args 判断）。 */
export function subAgentMode(args: unknown): SubAgentMode {
  const a = (args ?? {}) as SpawnArgs;
  if (Array.isArray(a.chain) && a.chain.length > 0) return 'chain';
  if (unitTasks(args).length > 1) return 'parallel';
  return 'single';
}

export type SubAgentUnitStatus = 'running' | 'done' | 'error' | 'pending';

export interface SubAgentUnit {
  /** 稳定 key：单任务用 messageId，多任务用 `${messageId}#${subIndex}`。 */
  key: string;
  /** null = 整条消息（单任务）；否则是并行/链式里的下标。 */
  subIndex: number | null;
  task: string;
  status: SubAgentUnitStatus;
}

/**
 * 把一次 spawn_agent 调用展开成「每个子代理一项」。单任务返回 1 项（subIndex=null，
 * 复用整条消息的 transcript）；并行/链式返回 N 项，逐个状态来自后端 details.results
 * （运行中统一显示 running；链式提前中止的后续步骤为 pending）。
 */
export function expandSubAgents(
  messageId: string,
  args: unknown,
  result: unknown,
  status: 'running' | 'done' | 'error',
): SubAgentUnit[] {
  const tasks = unitTasks(args);
  if (tasks.length <= 1) {
    return [{ key: messageId, subIndex: null, task: tasks[0], status }];
  }
  const results = resultsOf(result);
  return tasks.map((task, i) => {
    let st: SubAgentUnitStatus;
    if (status === 'running') {
      st = 'running';
    } else if (results) {
      const r = results[i];
      st = r ? (r.ok ? 'done' : 'error') : 'pending';
    } else {
      // 整条调用在产出 results 前就失败（如旧数据/抛错）：回退到调用级状态。
      st = status;
    }
    return { key: `${messageId}#${i}`, subIndex: i, task, status: st };
  });
}

export interface SubAgentUnitView {
  task: string;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

/**
 * 右坞单个子代理的会话视图入参：单任务（subIndex=null）复用整条消息结果（含完整 transcript）；
 * 并行/链式取对应下标的最终输出文本（无逐字流式，符合「逐个状态 + 最终输出」口径）。
 */
export function subAgentUnitView(
  args: unknown,
  result: unknown,
  status: 'running' | 'done' | 'error',
  subIndex: number | null,
): SubAgentUnitView {
  if (subIndex == null) {
    return { task: taskLabel(args), result, status };
  }
  const task = unitTasks(args)[subIndex] ?? '子代理任务';
  if (status === 'running') {
    return { task, result: undefined, status: 'running' };
  }
  const r = resultsOf(result)?.[subIndex];
  if (r) {
    const text = r.ok ? r.output || '(no output)' : r.error || r.output || '(failed)';
    return { task, result: { content: [{ type: 'text', text }] }, status: r.ok ? 'done' : 'error' };
  }
  return {
    task,
    result: { content: [{ type: 'text', text: '该步骤未执行：上游步骤失败或链路中止。' }] },
    status: 'done',
  };
}
