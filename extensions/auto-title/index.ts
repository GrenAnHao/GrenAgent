// auto-title: 首轮结束(agent_end)时用「当前模型、进程内」生成一个简短会话标题并写回。
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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { resolveSummaryModel, summarize } from "../_shared/summarize.js";
import { extractTextFromContent } from "../_shared/transcript.js";
import { __resetAutoTitleListenersForTest, notifySessionTitleWritten } from "./notify.js";
import { chainSummaryTitle, TITLE_MAX_TOKENS, titleLocale } from "./title.js";

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
  const options = { systemPrompt: wrapped.system, signal: ctx.signal, maxTokens: TITLE_MAX_TOKENS };
  let primaryError: unknown;
  try {
    const title = await summarize(ctx, wrapped.user, options);
    if (title) return title;
  } catch (err) {
    primaryError = err;
  }

  const currentModel = ctx.model as SummaryModel | undefined;
  if (currentModel && !sameModel(primaryModel, currentModel)) {
    try {
      const title = await summarize(ctx, wrapped.user, {
        ...options,
        modelSpec: `${currentModel.provider}/${currentModel.id}`,
      });
      if (title) return title;
    } catch (err) {
      if (!primaryError) primaryError = err;
    }
  }
  if (primaryError && !isStaleCtx(primaryError)) logError(primaryError);
  if (primaryError && isStaleCtx(primaryError)) throw primaryError;
  return "";
}

/** 首条 user 消息的纯文本。messages 形如 {role,content} 或 {message:{role,content}}。 */
function firstUserText(messages: unknown[]): string {
  for (const m of messages) {
    const obj = (m ?? {}) as { role?: string; content?: unknown; message?: { role?: string; content?: unknown } };
    const role = obj.role ?? obj.message?.role ?? "";
    if (role !== "user") continue;
    const text = extractTextFromContent(obj.content ?? obj.message?.content).trim();
    if (text) return text;
  }
  return "";
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

export function __resetAutoTitleForTest(): void {
  const g = globalThis as { __piAutoTitleJobs?: Map<string, TitleJob> };
  g.__piAutoTitleJobs = new Map();
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

  pi.on("agent_end", async (event, ctx) => {
    try {
      if ((getConfig("AUTO_TITLE") ?? "1") === "0") return;
      // 子代理(--no-session, PI_IS_SUBAGENT)不需要标题，跳过以省一次模型调用。
      if (process.env.PI_IS_SUBAGENT === "1") return;
      // 已命名（用户手动 / 此前已生成）则不覆盖。
      if (alreadyNamed(ctx)) return;
      // 无可用标题模型（titleModel 未配且 ctx.model 为空）则放弃。
      const primaryModel = resolveSummaryModel(ctx) as SummaryModel | undefined;
      if (!primaryModel) return;

      const messages = Array.isArray((event as { messages?: unknown[] })?.messages)
        ? (event as { messages: unknown[] }).messages
        : [];
      const firstUser = firstUserText(messages);
      if (!firstUser) return;

      const captured = captureSession(ctx);
      if (captured.file && titleJobs().has(captured.file)) return;
      const job: TitleJob = { ready: false, title: "", done: false };
      if (captured.file) titleJobs().set(captured.file, job);

      // 后台非阻塞：标题生成是一次额外模型调用，不该拖住首轮 agent_end / UI「运行中」。
      void (async () => {
        try {
          job.title = (await generateTitle(ctx, firstUser, primaryModel)) || "";
        } catch (err) {
          job.title = "";
          if (!isStaleCtx(err)) logError(err);
        }
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
      logError(err);
    }
  });
}
