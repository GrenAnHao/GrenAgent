import { messagesFromTranscript, type ChatMessage } from '../../stores/agentReducer';

/** 从 spawn_agent 工具入参里取一个人类可读的任务标签（主对话内联块与右侧面板 tab 共用）。 */
/** 展示用的模型名：去掉 provider 前缀。 */
export function displayModel(model: string | undefined): string | undefined {
  const text = model?.trim();
  if (!text) return undefined;
  return text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text;
}

export function modelFromResult(result: unknown): string | undefined {
  const details = result && typeof result === 'object' ? (result as { details?: unknown }).details : undefined;
  if (!details || typeof details !== 'object') return undefined;
  const model = (details as { model?: unknown }).model;
  return typeof model === 'string' && model.trim() ? model.trim() : undefined;
}

export function argsLookParallel(args: unknown): boolean {
  return Array.isArray((args as { tasks?: unknown } | null)?.tasks);
}

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

const CARD_TITLE_MAX = 24;

/** 卡片名：主代理提交的 title 优先；没有则从任务原文截一句。 */
export function subAgentCardTitle(title: string | undefined, task: string): string {
  const explicit = title?.replace(/\s+/g, ' ').trim();
  if (explicit) return explicit.length > CARD_TITLE_MAX ? `${explicit.slice(0, CARD_TITLE_MAX)}…` : explicit;
  return taskTitle(task);
}

/** 标题用的短任务名：去掉开头的角色句，留下要做的事。完整提示词不放在横条上。 */
export function taskTitle(task: string): string {
  const raw = (task ?? '').trim();
  if (!raw) return '子代理任务';
  let text = raw.replace(/\s+/g, ' ');
  text = text.replace(/^你(?:这次)?(?:的角色)?是[^。！？]*[。！？]\s*/, '');
  text = text.replace(/^请/, '');
  text = text.replace(/[*_`>#]/g, '').trim();
  const clause = text.split(/[。！？，,]/)[0]?.trim() || text;
  if (!clause) return '子代理任务';
  return clause.length > 24 ? `${clause.slice(0, 24)}…` : clause;
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
 * 子代理详情气泡：有可回放的 assistant/tool 用 transcript；否则退回工具结果正文。
 * transcript 只有 session 头时回放为空，旧逻辑会因此只显示任务、永远看不到回复。
 */
export function buildSubAgentConversationMessages(
  task: string,
  result: unknown,
  status: 'running' | 'done' | 'error',
  transcriptMessages: ChatMessage[],
): ChatMessage[] {
  const hasReplay = transcriptMessages.some((m) => m.kind === 'assistant' || m.kind === 'tool');
  // 真会话回放已经含用户消息。再前置一条任务气泡会把同一次派发画成两条发送。
  const replayHasUser = transcriptMessages.some((m) => m.kind === 'user');
  const out: ChatMessage[] = replayHasUser ? [] : [{ kind: 'user', id: 'sa-task', text: task, promptFrame: true }];
  if (hasReplay || replayHasUser) {
    out.push(...(replayHasUser ? frameTaskPrompt(transcriptMessages) : transcriptMessages));
  } else {
    const text = subAgentFinalText(result);
    if (text && text !== '(no output)') {
      out.push({
        kind: 'assistant',
        id: 'sa-out',
        text,
        thinking: '',
        streaming: status === 'running',
      });
    }
  }
  return finalizeSubAgentMessages(out, status);
}

/** 右坞里的任务提示词仍是一条用户消息，只在这条气泡里限高。 */
function frameTaskPrompt(messages: ChatMessage[]): ChatMessage[] {
  const index = messages.findIndex((m) => m.kind === 'user');
  if (index < 0) return messages;
  const message = messages[index];
  if (!message || message.kind !== 'user' || message.promptFrame) return messages;
  const next = messages.slice();
  next[index] = { ...message, promptFrame: true };
  return next;
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

/** 进程内真会话子代理的 JSONL 路径（embedded runner 写入 details.sessionPath）。 */
export function subAgentSessionPath(result: unknown): string | null {
  const path = detailsOf(result)?.sessionPath;
  return typeof path === 'string' && path.trim() ? path.trim() : null;
}

/** 有 sessionPath 走真会话绑定；没有则走旧 JSONL / registry 回放。 */
export function shouldBindChildSession(result: unknown): boolean {
  return subAgentSessionPath(result) != null;
}

/** 子会话流式事件是否属于这个绑定（按 sessionPath，不吃父会话 interactive 事件）。 */
export function isEmbeddedChildEvent(
  env: { source?: string; sessionPath?: string },
  sessionPath: string,
): boolean {
  return !!sessionPath && env.sessionPath === sessionPath;
}

/** 进程重启时，可续聊子代理被收成 done，但任务并没有跑完。 */
export const SIDECAR_RESTARTED = 'sidecar restarted';

function isBackgroundStartText(text: string): boolean {
  return text.startsWith('Background sub-agent started.');
}

/** 后台 spawn：工具调用已返回但子代理仍在 registry 中运行。历史里详情丢了时，启动回执同样算。 */
export function isBackgroundSpawn(result: unknown): boolean {
  const d = detailsOf(result);
  if (d?.status === 'running' && typeof d?.transcript !== 'string') return true;
  if (d?.status === 'done' || d?.status === 'error' || d?.status === 'cancelled') return false;
  return isBackgroundStartText(subAgentFinalText(result));
}

/**
 * 后台卡片该显示的注册表状态。
 * 重启把可续聊行收成 done 只是为了不通知父模型；界面不能把它画成已完成。
 * 列表里已经找不到时，同样不能当成成功结束。
 */
export function backgroundRegistryStatus(row: { status?: string; error?: string | null } | undefined): string {
  if (!row?.status) return 'interrupted';
  if (row.status === 'done' && row.error === SIDECAR_RESTARTED) return 'interrupted';
  return row.status;
}

/** 跟进结果里登记的子代理状态。没有则 null。 */
export function subAgentRecordStatus(result: unknown): string | null {
  const status = detailsOf(result)?.status;
  return typeof status === 'string' && status.trim() ? status.trim() : null;
}

const TIMEOUT_MARK = /stuck: no activity|idle timeout|startup timeout|hard timeout/;

/** 卡死或运行时限到了。界面标「超时」，不标「已完成」或笼统的「出错」。 */
export function subAgentTimeoutText(text: string | null | undefined): boolean {
  return typeof text === 'string' && TIMEOUT_MARK.test(text);
}

export function subAgentResultIndicatesTimeout(result: unknown): boolean {
  const error = detailsOf(result)?.error;
  if (subAgentTimeoutText(typeof error === 'string' ? error : '')) return true;
  return subAgentTimeoutText(subAgentFinalText(result));
}

/**
 * 跟进调用的工具状态是「这次 wait/status 成功返回了」。
 * 子代理自己卡死或失败时，卡片要跟子代理状态走。
 */
export function followUpCardStatus(
  toolStatus: 'running' | 'done' | 'error',
  result: unknown,
): 'running' | 'done' | 'error' {
  if (toolStatus === 'running' || toolStatus === 'error') return toolStatus;
  const child = subAgentRecordStatus(result);
  if (child === 'error' || child === 'cancelled') return 'error';
  return 'done';
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

const FOLLOW_UP_ACTIONS = new Set(['status', 'wait', 'cancel', 'remove']);

export interface SpawnTaskCarrier {
  id?: string;
  kind: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

function spawnAction(args: unknown): string | undefined {
  const action = (args as { action?: unknown } | null)?.action;
  return typeof action === 'string' ? action : undefined;
}

function isSpawnFollowUp(args: unknown): boolean {
  const action = spawnAction(args);
  return action != null && FOLLOW_UP_ACTIONS.has(action);
}

function argAgentId(args: unknown): string | null {
  const id = (args as { agentId?: unknown } | null)?.agentId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

function taskAt(args: unknown, index: number): string | null {
  const a = (args ?? {}) as SpawnArgs;
  if (index === 0) {
    const single = a.task?.trim();
    if (single) return single;
  }
  const chained = a.chain?.[index]?.task?.trim();
  if (chained) return chained;
  const item = a.tasks?.[index];
  if (typeof item === 'string' && item.trim()) return item.trim();
  if (item && typeof item.task === 'string' && item.task.trim()) return item.task.trim();
  return null;
}

/** 这次调用自己带的任务。wait/status/cancel/remove 只带 agentId，这里返回空。 */
function directSpawnTask(args: unknown): string | null {
  if (isSpawnFollowUp(args)) return null;
  return taskAt(args, 0);
}

/**
 * wait/status 结果里的登记任务。
 * `details.task` 是全文；旧结果只有正文，且仅在「agent … / Task: …」这个状态头下采信第一行，
 * 避免把子代理自己写出的 Task: 当成标题。
 */
export function taskFromAgentResult(result: unknown): string | null {
  const fromDetails = detailsOf(result)?.task;
  if (typeof fromDetails === 'string' && fromDetails.trim()) return fromDetails.trim();
  const lines = subAgentFinalText(result).split(/\r?\n/);
  if (!/^agent \S+: \S+/.test(lines[0] ?? '')) return null;
  const line = lines[1];
  if (!line?.startsWith('Task: ')) return null;
  const task = line.slice('Task: '.length).trim();
  return task || null;
}

/** 按出现顺序记下每个 agentId 对应的任务。已有全文时，后面的状态行不会覆盖。 */
export function noteSpawnTask(map: Map<string, string>, msg: SpawnTaskCarrier): void {
  if (msg.kind !== 'tool' || msg.toolName !== 'spawn_agent') return;
  const results = resultsOf(msg.result);
  if (results && results.length > 0) {
    results.forEach((row, i) => {
      const id = typeof row.agentId === 'string' ? row.agentId.trim() : '';
      if (!id || map.has(id)) return;
      const task = (typeof row.task === 'string' && row.task.trim()) || taskAt(msg.args, i);
      if (task) map.set(id, task);
    });
    return;
  }
  const id = subAgentId(msg.result) ?? argAgentId(msg.args);
  if (!id || map.has(id)) return;
  const task = directSpawnTask(msg.args) ?? taskFromAgentResult(msg.result);
  if (task) map.set(id, task);
}

/** 收集 untilId 之前的 spawn 任务。不传 untilId 时收集全部。 */
export function rememberedSpawnTasks(messages: readonly SpawnTaskCarrier[], untilId?: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (untilId && msg.id === untilId) break;
    noteSpawnTask(map, msg);
  }
  return map;
}

/**
 * wait/status/cancel/remove 没有自己的任务文本。
 * 优先用先前同 agentId 的启动任务，其次用本条结果里的登记任务。
 * 普通 spawn/run 返回 null，调用方继续用参数里的任务。
 */
export function resolveSpawnTask(
  args: unknown,
  result: unknown,
  remembered: ReadonlyMap<string, string>,
): string | null {
  if (!isSpawnFollowUp(args)) return null;
  const explicit = taskAt(args, 0);
  if (explicit) return explicit;
  const id = argAgentId(args) ?? subAgentId(result);
  if (id) {
    const known = remembered.get(id);
    if (known) return known;
  }
  return taskFromAgentResult(result);
}

/** wait/status/cancel/remove 指向的 agentId。普通启动返回 null。 */
export function followUpAgentId(args: unknown, result: unknown): string | null {
  if (!isSpawnFollowUp(args)) return null;
  return argAgentId(args) ?? subAgentId(result);
}

/** 这次启动实际拉起的 agentId。跟进调用和还没写上 id 的启动都是空。 */
export function startedAgentIds(args: unknown, result: unknown): string[] {
  if (isSpawnFollowUp(args)) return [];
  const results = resultsOf(result);
  if (results && results.length > 0) {
    const ids = results
      .map((row) => (typeof row.agentId === 'string' ? row.agentId.trim() : ''))
      .filter((id) => id.length > 0);
    if (ids.length > 0) return ids;
  }
  const id = subAgentId(result);
  return id ? [id] : [];
}

/**
 * 把跟进调用的正文贴回启动结果。保留启动详情里的 sessionPath，
 * 右坞仍绑到原来的子会话。
 */
export function mergeFollowUpResult(origin: unknown, followUp: unknown): unknown {
  const text = subAgentFinalText(followUp);
  if (!text) return origin;
  const originDetails = detailsOf(origin);
  const followDetails = detailsOf(followUp);
  const sessionPath = originDetails?.sessionPath;
  const base = origin && typeof origin === 'object' ? { ...(origin as Record<string, unknown>) } : {};
  return {
    ...base,
    content: [{ type: 'text', text }],
    details: {
      ...(originDetails ?? {}),
      ...(followDetails ?? {}),
      ...(typeof sessionPath === 'string' ? { sessionPath } : {}),
    },
  };
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
  title?: string;
  task?: string;
  tasks?: Array<string | { title?: string; task?: string; model?: string }>;
  chain?: Array<{ title?: string; task?: string; model?: string }>;
  agent?: string;
}

function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

/** 单任务用顶层 title；并行/链式用对应下标那一项的 title。 */
export function spawnUnitTitle(args: unknown, subIndex: number | null): string | undefined {
  const a = (args ?? {}) as SpawnArgs;
  if (subIndex == null) {
    const top = cleanTitle(a.title);
    if (top) return top;
    const only = a.tasks?.length === 1 ? a.tasks[0] : undefined;
    if (only && typeof only === 'object') return cleanTitle(only.title);
    return undefined;
  }
  const step = a.chain?.[subIndex];
  if (step) return cleanTitle(step.title);
  const item = a.tasks?.[subIndex];
  if (item && typeof item === 'object') return cleanTitle(item.title);
  return undefined;
}

interface UnitResult {
  task?: string;
  ok?: boolean;
  status?: string;
  output?: string;
  error?: string;
  agentId?: string;
  sessionPath?: string;
  stopReason?: string;
  model?: string;
}

interface UnitWork {
  task: string;
  title?: string;
}

function withTitle(task: string, title: string | undefined): UnitWork {
  return title ? { task, title } : { task };
}

/** 一次 spawn_agent 调用展开出的逐个子代理任务（单任务 1 条；并行/链式 N 条）。 */
function unitWorks(args: unknown): UnitWork[] {
  const a = (args ?? {}) as SpawnArgs;
  if (Array.isArray(a.chain) && a.chain.length > 0) {
    return a.chain.map((s) => withTitle(s?.task?.trim() || '子代理任务', cleanTitle(s?.title)));
  }
  const out: UnitWork[] = [];
  const single = a.task?.trim();
  if (single) out.push(withTitle(single, cleanTitle(a.title)));
  for (const t of a.tasks ?? []) {
    if (typeof t === 'string') {
      const v = t.trim();
      if (v) out.push({ task: v });
    } else if (t && typeof t.task === 'string' && t.task.trim()) {
      out.push(withTitle(t.task.trim(), cleanTitle(t.title)));
    }
  }
  if (out.length === 0) out.push({ task: '子代理任务' });
  return out;
}

function unitTasks(args: unknown): string[] {
  return unitWorks(args).map((item) => item.task);
}

/** 并行组在参数还没写完时不要补一条假任务。 */
function explicitWorks(args: unknown): UnitWork[] {
  const a = (args ?? {}) as SpawnArgs;
  const out: UnitWork[] = [];
  for (const t of a.tasks ?? []) {
    if (typeof t === 'string') {
      const v = t.trim();
      if (v) out.push({ task: v });
    } else if (t && typeof t.task === 'string' && t.task.trim()) {
      out.push(withTitle(t.task.trim(), cleanTitle(t.title)));
    }
  }
  return out;
}

/** 后端结果里逐个子代理的结果数组（chain / parallel 的 details.results）；无则 null。 */
function resultsOf(result: unknown): UnitResult[] | null {
  const r = detailsOf(result)?.results;
  return Array.isArray(r) ? (r as UnitResult[]) : null;
}

function modelOf(row: UnitResult | undefined): string | undefined {
  return typeof row?.model === 'string' && row.model.trim() ? row.model.trim() : undefined;
}

/** 任务对象里写明的模型。启动阶段结果还没回来时，行上先用这个。 */
function modelFromTaskArgs(args: unknown, index: number): string | undefined {
  const tasks = (args as SpawnArgs | null)?.tasks;
  const item = tasks?.[index];
  if (!item || typeof item === 'string') return undefined;
  const model = item.model?.trim();
  return model || undefined;
}

/** 参数里已经写明的模型：链式看 chain[i].model，并行看 tasks[i].model。 */
function modelFromUnitArgs(args: unknown, index: number): string | undefined {
  const step = (args as SpawnArgs | null)?.chain?.[index];
  const fromChain = step?.model?.trim();
  if (fromChain) return fromChain;
  return modelFromTaskArgs(args, index);
}

function rowTerminal(row: UnitResult | undefined): boolean {
  if (!row || row.status === 'waiting' || row.status === 'starting' || row.status === 'running') return false;
  return row.ok === true || row.status === 'done' || row.ok === false || row.status === 'error' || row.status === 'cancelled';
}

/** 链式里还没轮到的步。没有逐步快照时，只有当前开放的那一步不算等待。 */
function chainStepWaiting(args: unknown, results: UnitResult[] | null, index: number, row: UnitResult | undefined): boolean {
  if (subAgentMode(args) !== 'chain') return false;
  if (row?.status === 'waiting') return true;
  if (row) return false;
  if (!results || results.length === 0) return index > 0;
  const openAt = results.findIndex((item) => !rowTerminal(item));
  return index !== (openAt < 0 ? results.length : openAt);
}

export type SubAgentMode = 'single' | 'parallel' | 'chain';

/** 调用模式：单任务 / 并行 / 链式（按 args 判断）。 */
export function subAgentMode(args: unknown): SubAgentMode {
  const a = (args ?? {}) as SpawnArgs;
  if (Array.isArray(a.chain) && a.chain.length > 0) return 'chain';
  if (unitTasks(args).length > 1) return 'parallel';
  return 'single';
}

export type SubAgentUnitStatus = 'starting' | 'running' | 'done' | 'error' | 'pending' | 'waiting';

export interface SubAgentUnit {
  /** 稳定 key：单任务用 messageId，多任务用 `${messageId}#${subIndex}`。 */
  key: string;
  /** null = 整条消息（单任务）；否则是并行/链式里的下标。 */
  subIndex: number | null;
  task: string;
  /** 主代理提交的短任务名。缺省时界面从 task 截一句。 */
  title?: string;
  status: SubAgentUnitStatus;
  model?: string;
}

/**
 * 把一次 spawn_agent 调用展开成「每个子代理一项」。单任务返回 1 项（subIndex=null，
 * 复用整条消息的 transcript）；并行/链式返回 N 项，逐个状态来自后端 details.results。
 * 工具还在跑、子进程还没写出 session 时是 starting（启动中）；sessionPath 出现后才是 running。
 * 链式里还没轮到的步是 waiting，不跟并行组一起标成启动中。
 */
export function expandSubAgents(
  messageId: string,
  args: unknown,
  result: unknown,
  status: 'running' | 'done' | 'error',
  asGroup = false,
): SubAgentUnit[] {
  const tasks = unitWorks(args);
  if (tasks.length <= 1 && !asGroup) {
    const only = tasks[0] ?? { task: '子代理任务' };
    return [{ key: messageId, subIndex: null, task: only.task, ...(only.title ? { title: only.title } : {}), status }];
  }
  const grouped = asGroup ? explicitWorks(args) : tasks;
  if (grouped.length === 0) return [];
  const results = resultsOf(result);
  return grouped.map((work, i) => {
    const row = results?.[i];
    const model = modelOf(row) ?? modelFromUnitArgs(args, i);
    let st: SubAgentUnitStatus;
    if (status === 'running') {
      if (chainStepWaiting(args, results, i, row)) st = 'waiting';
      else if (row?.ok === true || row?.status === 'done') st = 'done';
      else if (row?.ok === false || row?.status === 'error' || row?.status === 'cancelled') st = 'error';
      else if (row?.sessionPath || row?.status === 'running') st = 'running';
      else st = 'starting';
    } else if (results) {
      const r = results[i];
      st = r ? (r.ok ? 'done' : 'error') : 'pending';
    } else {
      // 整条调用在产出 results 前就失败（如旧数据/抛错）：回退到调用级状态。
      st = status;
    }
    return {
      key: `${messageId}#${i}`,
      subIndex: i,
      task: work.task,
      ...(work.title ? { title: work.title } : {}),
      status: st,
      ...(model ? { model } : {}),
    };
  });
}

export interface SubAgentUnitView {
  task: string;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

/**
 * 右坞单个子代理的会话视图入参：单任务（subIndex=null）复用整条消息结果（含完整 transcript）；
 * 并行/链式在运行中也带上该子项的 agentId / sessionPath，右坞才能绑到真会话而不是只画任务原文。
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
  const live = resultsOf(result)?.[subIndex];
  if (status === 'running' && chainStepWaiting(args, resultsOf(result), subIndex, live)) {
    return {
      task,
      result: { content: [{ type: 'text', text: '等待上一步完成。' }] },
      status: 'running',
    };
  }
  if (status === 'running') {
    if (live && (live.agentId || live.sessionPath)) {
      return {
        task,
        result: {
          details: {
            ...(live.agentId ? { agentId: live.agentId } : {}),
            ...(live.sessionPath ? { sessionPath: live.sessionPath } : {}),
            streaming: true,
          },
        },
        status: 'running',
      };
    }
    return { task, result: undefined, status: 'running' };
  }
  const r = resultsOf(result)?.[subIndex];
  if (r) {
    const text = r.ok ? r.output || '(no output)' : r.error || r.output || '(failed)';
    return {
      task,
      result: {
        content: [{ type: 'text', text }],
        details: {
          ...(r.agentId ? { agentId: r.agentId } : {}),
          ...(r.sessionPath ? { sessionPath: r.sessionPath } : {}),
          ...(r.stopReason ? { stopReason: r.stopReason } : {}),
        },
      },
      status: r.ok ? 'done' : 'error',
    };
  }
  return {
    task,
    result: { content: [{ type: 'text', text: '该步骤未执行：上游步骤失败或链路中止。' }] },
    status: 'done',
  };
}
