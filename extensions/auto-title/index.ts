// auto-title: 会话还没有名字时，模型第一条回复结束（message_end）就用标题模型在进程内生成简短标题并写回。
// 不等整轮跑完：首轮长任务动辄十几分钟，侧栏这段时间只能显示首条消息。agent_end 只是兜底触发。
// 标题只看会话的第一条用户消息（从会话条目取，不是本轮的 event.messages），技能 / 命令 / 粘贴块先拆开再给模型，
// 输出经 cleanGeneratedTitle 清洗，拒绝句、回答式输出不写。见 .agents/notes/implemented/feature/2026-10-19-session-title-quality.md
//
// 取代 Tauri 侧起一次性冷 `pi -p` 子进程的老做法——那种冷进程要加载全局 MCP
// （deepwiki 等需 OAuth/网络）、且对 token-plan provider 无法在一次性进程里鉴权，
// 会卡在 agent_start 之前永不返回。这里在已鉴权的常驻 sidecar 内直接用标题模型
// 生成（无子进程、无 MCP 冷启动），经 pi.setSessionName 写回——其内部会
// appendSessionInfo + 广播 session_info_changed，Tauri 侧边栏据此刷新。
//
// 标题生成本身复用 `_shared/summarize`（进程内摘要原语，生成物标题等也用它）。
//
// 生成是后台的，期间用户可能新开、切换、fork 或 reload。官方会作废旧 pi / ctx，
// 再调 setSessionName 会抛 "extension ctx is stale"。标题仍属于开头那个会话：
// reload 交给新实例的 pi.setSessionName（侧栏照常收到 session_info_changed）；
// 其余替换则 appendSessionInfo 写回原会话文件，并由宿主广播一次同名事件刷新侧栏。
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { firstUserMessage, titleModelInput } from "../_shared/session-title.js";
import { resolveSummaryModel, summarize } from "../_shared/summarize.js";
import { __resetAutoTitleListenersForTest, notifySessionTitleWritten } from "./notify.js";
import { chainSummaryTitle, cleanGeneratedTitle, TITLE_MAX_TOKENS, titleLocale } from "./title.js";

export { subscribeSessionTitleWritten } from "./notify.js";

type SummaryModel = { provider: string; id: string };

function sameModel(left: SummaryModel, right: SummaryModel): boolean {
  return left.provider === right.provider && left.id === right.id;
}

async function generateTitle(
  ctx: ExtensionContext,
  input: string,
  primaryModel: SummaryModel,
): Promise<string> {
  const wrapped = chainSummaryTitle(input, titleLocale());
  // 不带 ctx.signal：那是当前回合的中止信号，第一条回复后就起标题时，用户停掉这一轮不该连标题一起丢掉。
  const options = { systemPrompt: wrapped.system, maxTokens: TITLE_MAX_TOKENS, raw: true };
  let primaryError: unknown;
  try {
    const title = cleanGeneratedTitle(await summarize(ctx, wrapped.user, options));
    if (title) return title;
  } catch (err) {
    primaryError = err;
  }

  const currentModel = ctx.model as SummaryModel | undefined;
  if (currentModel && !sameModel(primaryModel, currentModel)) {
    try {
      const title = cleanGeneratedTitle(await summarize(ctx, wrapped.user, {
        ...options,
        modelSpec: `${currentModel.provider}/${currentModel.id}`,
      }));
      if (title) return title;
    } catch (err) {
      if (!primaryError) primaryError = err;
    }
  }
  if (primaryError && !isStaleCtx(primaryError)) logError(primaryError);
  if (primaryError && isStaleCtx(primaryError)) throw primaryError;
  return "";
}

/**
 * 给标题模型的输入：会话当前分支上的第一条用户消息。不用本轮的 event.messages：
 * 首轮没起成名字时，那里的第一条是后来的「继续吧」，模型只能回「无法生成有意义的标题」。
 * 读不到会话条目（测试桩）时才退回 event.messages。
 */
function titleInput(ctx: ExtensionContext, eventMessages: unknown[]): string {
  let entries: unknown[] = [];
  try {
    const manager = ctx.sessionManager as { getBranch?: () => unknown[]; getEntries: () => unknown[] };
    entries = (manager.getBranch?.() ?? manager.getEntries()) ?? [];
  } catch {
    entries = [];
  }
  const fromEvent = eventMessages.map((m) => {
    const obj = (m ?? {}) as { role?: string; message?: unknown };
    return obj.message ? { type: "message", ...(obj as object) } : { type: "message", message: m };
  });
  const first = firstUserMessage(entries) ?? firstUserMessage(fromEvent);
  return first ? titleModelInput(first.text, first.images) : "";
}

type SessionInfoEntry = { type?: string; name?: unknown };

type SessionNameTarget = {
  getSessionFile?: () => string | undefined;
  getEntries?: () => SessionInfoEntry[];
  appendSessionInfo?: (name: string) => void;
};

type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

type TitleJob = {
  ready: boolean;
  title: string;
  done: boolean;
  deliver?: (title: string) => void;
};

/** 同一份会话最多试几次：模型一直给不出能用的标题时，不能每条回复都再花一次调用。 */
const MAX_ATTEMPTS = 2;

type CapturedSession = {
  file?: string;
  entries?: () => SessionInfoEntry[];
  writeName?: (name: string) => void;
};

const STALE_CTX = "This extension ctx is stale";

function titleJobs(): Map<string, TitleJob> {
  const g = globalThis as { __piAutoTitleJobs?: Map<string, TitleJob> };
  return (g.__piAutoTitleJobs ??= new Map());
}

/** 按会话文件（没有文件时按会话 id）记试过几次，放在 globalThis 上，reload 后的新实例接着计。 */
function titleAttempts(): Map<string, number> {
  const g = globalThis as { __piAutoTitleAttempts?: Map<string, number> };
  return (g.__piAutoTitleAttempts ??= new Map());
}

export function __resetAutoTitleForTest(): void {
  const g = globalThis as { __piAutoTitleJobs?: Map<string, TitleJob>; __piAutoTitleAttempts?: Map<string, number> };
  g.__piAutoTitleJobs = new Map();
  g.__piAutoTitleAttempts = new Map();
  __resetAutoTitleListenersForTest();
}

function isStaleCtx(err: unknown): boolean {
  return err instanceof Error && err.message.includes(STALE_CTX);
}

function logError(err: unknown): void {
  console.error("[auto-title] error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
}

function entriesNamed(entries: SessionInfoEntry[]): boolean {
  return entries.some(
    (e) => e?.type === "session_info" && typeof e.name === "string" && e.name.trim().length > 0,
  );
}

/**
 * 子代理的会话（JSONL 里有 subagent_meta）。进程内的子代理跑在 agent-host 里，没有 PI_IS_SUBAGENT，
 * 只看环境变量会给每个子代理白花一次模型调用起标题；子会话卸载后这个后台任务还可能经旧的会话管理器往它的 JSONL 写一条。
 */
function isSubagentSession(ctx: ExtensionContext): boolean {
  try {
    return (ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string }>).some(
      (e) => e?.type === "custom" && e.customType === "subagent_meta",
    );
  } catch {
    return false;
  }
}

/** 会话是否已有名字（用户手动命名或此前已生成）。扫描 session_info entry。 */
function alreadyNamed(ctx: ExtensionContext): boolean {
  try {
    return entriesNamed(ctx.sessionManager.getEntries() as SessionInfoEntry[]);
  } catch {
    return false;
  }
}

function readEntries(entries: (() => SessionInfoEntry[]) | undefined): SessionInfoEntry[] {
  if (!entries) return [];
  try {
    return entries() ?? [];
  } catch {
    return [];
  }
}

/** 在 ctx 仍有效时取出会话文件和 SessionManager 本体。之后走本体，避开失效代理。 */
function captureSession(ctx: ExtensionContext): CapturedSession {
  try {
    const manager = ctx.sessionManager as unknown as SessionNameTarget;
    const file = manager.getSessionFile?.();
    const writeName = typeof manager.appendSessionInfo === "function"
      ? (name: string) => manager.appendSessionInfo!(name)
      : undefined;
    return {
      file: file || undefined,
      entries: typeof manager.getEntries === "function" ? () => manager.getEntries!() : undefined,
      writeName,
    };
  } catch (err) {
    if (isStaleCtx(err)) return {};
    throw err;
  }
}

function writeIfUnnamed(captured: CapturedSession, title: string): void {
  if (!captured.writeName || !title) return;
  // 会话已经换走、文件也没了，只可能是被删了。SessionManager 会 appendFileSync 把它重建成只有标题的无头文件，
  // 侧栏按路径推断 cwd 会把这份空会话列回来。
  if (captured.file && !existsSync(captured.file)) return;
  try {
    if (entriesNamed(readEntries(captured.entries))) return;
    captured.writeName(title);
    notifySessionTitleWritten(captured.file);
  } catch (err) {
    if (!isStaleCtx(err)) logError(err);
  }
}

function dropJob(file: string | undefined, job: TitleJob): void {
  if (!file) return;
  const jobs = titleJobs();
  if (jobs.get(file) === job) jobs.delete(file);
}

export default function (pi: ExtensionAPI) {
  const retired: { current: boolean; reason?: ShutdownReason } = { current: false };

  pi.on("session_shutdown", (event) => {
    retired.current = true;
    retired.reason = event.reason;
  });

  pi.on("session_start", (_event, ctx) => {
    const captured = captureSession(ctx);
    if (!captured.file) return;
    const job = titleJobs().get(captured.file);
    if (!job || job.done) return;
    job.deliver = (title) => {
      try {
        if (entriesNamed(readEntries(captured.entries))) return;
        pi.setSessionName(title);
      } catch (err) {
        if (isStaleCtx(err)) writeIfUnnamed(captured, title);
        else logError(err);
      }
    };
    if (!job.ready || !job.title) return;
    job.done = true;
    dropJob(captured.file, job);
    job.deliver(job.title);
  });

  // 已经有名字、或者试够次数的会话记在这里，之后每条回复直接返回，不再扫会话条目。
  const settled = new Set<string>();
  // 正在生成的会话。有文件的会话还有 titleJobs 挡着，这里主要管没有文件的（内存会话）。
  const pending = new Set<string>();

  const maybeTitle = (eventMessages: unknown[], ctx: ExtensionContext): void => {
    try {
      if ((getConfig("AUTO_TITLE") ?? "1") === "0") return;
      // 子代理(--no-session, PI_IS_SUBAGENT)不需要标题，跳过以省一次模型调用。
      if (process.env.PI_IS_SUBAGENT === "1") return;
      const captured = captureSession(ctx);
      let key = captured.file;
      if (!key) {
        try {
          key = ctx.sessionManager.getSessionId() || undefined;
        } catch {
          key = undefined;
        }
      }
      if (key && (settled.has(key) || pending.has(key))) return;
      if (captured.file && titleJobs().has(captured.file)) return;
      if (isSubagentSession(ctx) || alreadyNamed(ctx)) {
        // 已命名（用户手动 / 此前已生成）则不覆盖。
        if (key) settled.add(key);
        return;
      }
      // 无可用标题模型（titleModel 未配且 ctx.model 为空）则放弃。
      const primaryModel = resolveSummaryModel(ctx) as SummaryModel | undefined;
      if (!primaryModel) return;
      const input = titleInput(ctx, eventMessages);
      if (!input) return;
      if (key) {
        const attempts = (titleAttempts().get(key) ?? 0) + 1;
        titleAttempts().set(key, attempts);
        if (attempts >= MAX_ATTEMPTS) settled.add(key);
        if (attempts > MAX_ATTEMPTS) return;
      }

      const job: TitleJob = { ready: false, title: "", done: false };
      if (captured.file) titleJobs().set(captured.file, job);
      if (key) pending.add(key);

      // 后台非阻塞：标题生成是一次额外模型调用，不该拖住回合 / UI「运行中」。
      void (async () => {
        try {
          job.title = (await generateTitle(ctx, input, primaryModel)) || "";
          if (job.title && key) settled.add(key);
        } catch (err) {
          job.title = "";
          if (!isStaleCtx(err)) logError(err);
        }
        if (key) pending.delete(key);
        job.ready = true;
        if (captured.file && titleJobs().get(captured.file) !== job) return;
        if (!job.title) {
          job.done = true;
          dropJob(captured.file, job);
          return;
        }
        if (job.deliver) {
          job.done = true;
          dropJob(captured.file, job);
          job.deliver(job.title);
          return;
        }
        // reload 会换一个新 pi，但会话文件不变。等新实例的 session_start 来写。
        if (retired.current && retired.reason === "reload" && captured.file) return;
        job.done = true;
        dropJob(captured.file, job);
        if (!retired.current) {
          try {
            if (!alreadyNamed(ctx)) pi.setSessionName(job.title);
          } catch (err) {
            if (isStaleCtx(err)) writeIfUnnamed(captured, job.title);
            else logError(err);
          }
          return;
        }
        writeIfUnnamed(captured, job.title);
      })();
    } catch (err) {
      if (!isStaleCtx(err)) logError(err);
    }
  };

  // 第一条助手消息结束时会话文件已经落盘（用户消息一进来就写），标题写回后侧栏重读就能看到。
  // 不用 turn_end：那是边界事件，挂了处理器 pi 每一步都要把整条分支复制一份来建上下文。
  pi.on("message_end", (event, ctx) => {
    if ((event as { message?: { role?: string } }).message?.role !== "assistant") return;
    maybeTitle([], ctx);
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = Array.isArray((event as { messages?: unknown[] })?.messages)
      ? (event as { messages: unknown[] }).messages
      : [];
    maybeTitle(messages, ctx);
  });
}
