// im-platforms: bring the Pi agent to WeChat via the official ilink/clawbot
// AI-bot interface (ilinkai.weixin.qq.com).
//
// Design — WeChat does NOT share the owner's interactive session. The gateway
// owns a bounded per-conversation history (last IM_CTX_MAX messages, default 20)
// and runs each inbound message through an ISOLATED one-shot agent (a separate
// `pi` process, reusing the sub-agent runner). This guarantees:
//   - full isolation: the owner's IDE session and the WeChat conversation never
//     leak into each other;
//   - bounded context: the window can't blow up — only the last N messages are
//     ever sent to the model;
//   - exactly one reply per inbound message (no per-step forwarding);
//   - no self-spam: auto drivers (goal re-entry, memory) are forced OFF in the
//     isolated agent, so it can never loop itself into a message flood.
//
// Capability is owner-gated: with WECHAT_OC_OWNER set, wechat.ts only forwards
// the owner's messages, so the agent runs with full built-in tools (read/write,
// code search, code exec, web). With NO owner ("留空不限"), anyone can reach the
// bot, so it runs in a restricted "chat only" mode (read + answer, but writes /
// code execution / shell are disabled) — no nagging, just safe by default. No
// MCP either way (kept lightweight + isolated).
//
// Hot-reloadable: a process-level watchConfig subscription reconciles the WeChat
// client whenever WECHAT_OC_* changes — enable/disable/reconnect take effect
// without restarting the sidecar.
//
// Config: WECHAT_OC_ENABLE, WECHAT_OC_TOKEN, WECHAT_OC_OWNER, WECHAT_OC_BOT_TYPE,
//         WECHAT_OC_BASE_URL, IM_CTX_MAX, IM_MODEL, IM_TIMEOUT_MS

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApprovalPolicy } from "../_shared/approval.js";
import { getConfig, watchConfig } from "../_shared/runtime-config.js";
import { CODE_EXEC_TOOLS, WRITE_TOOLS } from "../_shared/tool-groups.js";
import { spawnPiAgent } from "../multi-agent/runner.js";
import { createImContextStore, type ImContextStore, renderPrompt } from "./context.js";
import { acquireLock, refreshLock, releaseLock } from "./lock.js";
import { startWeixinOc, type WeixinOcHandle } from "./wechat.js";

// Personas for the isolated WeChat agent (bounded transcript passed as the task).
// No emoji (project rule).
const IM_SYSTEM_PROMPT_FULL =
  "你是通过微信接入、与主人私聊的 AI 助手。请用简洁、自然的中文回答；" +
  "需要时可使用内置工具（读写文件、搜索代码、执行代码、抓取网页等）完成请求。" +
  "只回复用户最新的问题，不要主动寒暄、不要复述历史、不要使用 emoji。";

// Restricted (no-owner) persona: chat + read/answer only.
const IM_SYSTEM_PROMPT_RESTRICTED =
  "你是通过微信接入、与一位访客私聊的 AI 助手，当前为受限模式：可以正常对话、" +
  "读取与检索信息来回答问题，但不能修改文件、执行代码或运行命令（这些已被禁用）。" +
  "若对方要求做这些，简短说明当前为受限模式、需主人配置 ID 后才可用。" +
  "只回复用户最新的问题，不要主动寒暄、不要复述历史、不要使用 emoji。";

// 受限（无主人）会话的 deny 清单。SAFETY_READONLY 已锁内置 write/edit + mutating bash；
// 这里再禁会绕过隔离的宿主副作用工具——受限访客一律「只对话 + 读取检索」，不执行任何代码 / 命令。
// 仅 owner（WECHAT_OC_OWNER）拥有完整能力。
//
// 禁：
// - 内置 bash —— 受限会话一律不给，由 safety ① 按工具名硬禁（任何审批策略含 full 都不可越过）。
// - 宿主写盘工具（ast_edit/hl_edit，绕过写白名单）、全部代码执行（py_run/js_run/dap_*，在宿主跑可逃逸）、
//   py_reset/js_reset、github（gh CLI 需 auth、可访问私有仓库）。
// 保留联网查询（web_search/search/fetch_*）：受限会话靠它读取信息回答问题（见 RESTRICTED persona）。
const RESTRICTED_DENY = ["bash", ...WRITE_TOOLS, ...CODE_EXEC_TOOLS, "py_reset", "js_reset", "github"];

/**
 * SAFETY_DENY_TOOLS for a restricted (no-owner) IM session: built-in bash, host
 * write/exec bypass tools, all code execution, and github are denied by name
 * (enforced in safety ①, which no approval policy — including full — can override).
 * Exported for unit testing the capability floor.
 */
export function restrictedDenyTools(): string[] {
  return [...new Set(RESTRICTED_DENY)];
}

interface WechatStatus {
  enabled: boolean;
  loggedIn: boolean;
  status: string;
  qrLink?: string;
}

interface ImState {
  watching: boolean;
  lastSig?: string;
  notifiedLogin?: boolean;
  cwd: string;
  ctx?: ImContextStore;
  /** Per-conversation promise chain: serialize turns so the bounded history stays consistent. */
  queues: Map<string, Promise<void>>;
  /** Per-user inbound timestamps for the sliding-window rate limit (accept-all anti-spam). */
  rate: Map<string, number[]>;
  /** Guards one-time replay of crash-interrupted turns per login session. */
  replayed?: boolean;
  wechat?: WeixinOcHandle;
  /** 本 sidecar 是否持有微信单实例锁（多 workspace 各一 sidecar，仅持锁者真正连微信）。 */
  holdsLock?: boolean;
  /** 未持锁时的接管重试定时器（持锁者退出后由它接手连微信）。 */
  lockTimer?: ReturnType<typeof setInterval>;
  /** 持锁时的心跳定时器：定期刷新锁文件 mtime，向其它进程表明仍存活（防 pid 复用误判）。 */
  lockHeartbeat?: ReturnType<typeof setInterval>;
  /** 进程退出释放锁的 hook 是否已注册（每进程一次）。 */
  exitHooked?: boolean;
  notify?: (msg: string, level: "info" | "warning" | "error") => void;
  pushStatus?: (key: string, text: string) => void;
  status: WechatStatus;
}

function imState(): ImState {
  const g = globalThis as { __grenImState?: ImState };
  return (g.__grenImState ??= {
    watching: false,
    cwd: process.cwd(),
    queues: new Map(),
    rate: new Map(),
    status: { enabled: false, loggedIn: false, status: "idle" },
  });
}

function bool(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "off" && s !== "no";
}

function ctxMax(): number {
  return Math.max(2, Number(getConfig("IM_CTX_MAX") ?? "20") || 20);
}

// 上限：同时跟踪的会话数（每个 from_user 一个 key）。accept-all（无主人）模式下不同陌生人会
// 无限新增 key（落盘 im_context.json + 内存），用 LRU 上限兜底。非法/0 回退默认 200。
function maxConversations(): number {
  return Math.max(1, Number(getConfig("IM_MAX_CONVERSATIONS") ?? "200") || 200);
}

// 每用户每分钟最多处理的入站消息数（防 accept-all 模式被刷爆 LLM 调用 / 成本）。0 = 关闭限流。
function ratePerMin(): number {
  const n = Number(getConfig("IM_RATE_LIMIT_PER_MIN") ?? "20");
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20;
}

function contextPath(): string {
  return join(homedir(), ".pi", "agent", "im_context.json");
}

function weixinStatePath(): string {
  return join(homedir(), ".pi", "agent", "weixin_oc_state.json");
}

function weixinLockPath(): string {
  return join(homedir(), ".pi", "agent", "weixin_oc.lock");
}

function wechatConfig() {
  return {
    enable: bool(getConfig("WECHAT_OC_ENABLE")),
    token: getConfig("WECHAT_OC_TOKEN") || "",
    baseUrl: getConfig("WECHAT_OC_BASE_URL") || "",
    botType: getConfig("WECHAT_OC_BOT_TYPE") || "",
    // Empty owner is a documented, intentional mode ("留空不限"): single-owner
    // remote control that trusts whoever can reach the bot. We surface a hint in
    // /im but never block startup on it.
    owner: getConfig("WECHAT_OC_OWNER") || "",
  };
}

function emitStatus(): void {
  const st = imState();
  st.pushStatus?.("wechat", JSON.stringify(st.status));
}

function setStatus(partial: Partial<WechatStatus>): void {
  const st = imState();
  st.status = { ...st.status, ...partial };
  emitStatus();
}

/**
 * Push every WeChat conversation's bounded history to the frontend (rendered as
 * chat bubbles under the WeChat card in the 连接 panel). The owner's isolated
 * session never shows IM traffic, so this read-only mirror is the only way the
 * desktop UI surfaces what was said over WeChat. Snapshot/overwrite semantics
 * (like the other setStatus keys): each push carries the full current state.
 */
function emitMessages(): void {
  const st = imState();
  if (!st.ctx) return;
  const conversations = Object.entries(st.ctx.toJSON()).map(([key, messages]) => ({
    user: key.replace(/^wechat:/, ""),
    messages,
  }));
  st.pushStatus?.("wechat-messages", JSON.stringify(conversations));
}

/**
 * Re-emit the current status now plus a few delayed retries. The frontend
 * attaches its Tauri `listen('pi://ui-request')` AFTER session_start fires, and
 * Tauri does not buffer events for late listeners — a single emit is often
 * missed, leaving the UI stuck on "连接中" while the backend is actually logged
 * in and polling with the persisted token. The retries win that attach race.
 * The conversation mirror rides the same retries so a reloaded UI re-reads the
 * persisted history too.
 */
function rebroadcastStatus(): void {
  emitStatus();
  emitMessages();
  for (const ms of [500, 1500, 3500, 7000, 12000]) {
    setTimeout(() => {
      emitStatus();
      emitMessages();
    }, ms);
  }
}

function ensureContext(): ImContextStore {
  const st = imState();
  if (st.ctx) {
    st.ctx.setMax(ctxMax(), maxConversations());
    return st.ctx;
  }
  const store = createImContextStore({ maxMessages: ctxMax(), maxConversations: maxConversations() });
  try {
    store.loadJSON(JSON.parse(readFileSync(contextPath(), "utf8")));
  } catch {
    /* no prior context */
  }
  st.ctx = store;
  return store;
}

function persistContext(): void {
  const st = imState();
  if (!st.ctx) return;
  try {
    const p = contextPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(st.ctx.toJSON()));
  } catch (e) {
    st.notify?.(`微信上下文落盘失败：${(e as Error).message}`, "warning");
  }
}

/** Record + persist the inbound user turn, then process it. */
async function runImTurn(fromUser: string, text: string): Promise<void> {
  const store = ensureContext();
  store.append(`wechat:${fromUser}`, "user", text);
  persistContext(); // durable BEFORE the (slow) reply so a crash mid-turn can be replayed
  emitMessages(); // surface the inbound message immediately (the reply may take a while)
  await processTurn(fromUser);
}

/**
 * Generate + deliver a reply for a conversation whose tail is the user's message.
 * Used for fresh turns and for startup replay of turns interrupted by a crash.
 *
 * Delivery-first ordering: we send the reply and only record the assistant turn
 * on success. If generation or delivery fails, the user turn stays as the tail,
 * so the message is retried on the next inbound / restart instead of persisting
 * a reply the user never received (at-least-once delivery).
 */
async function processTurn(fromUser: string): Promise<void> {
  const st = imState();
  const store = ensureContext();
  const key = `wechat:${fromUser}`;
  const history = store.history(key);
  if (history.length === 0 || history[history.length - 1].role !== "user") return;

  // Owner-gated capability: no owner configured → restricted "chat only" (read +
  // answer; no writes / code exec / shell). With an owner set, wechat.ts only
  // forwards the owner's messages, so reaching here means full capability is
  // authorized. Either way auto drivers stay OFF so the agent can't self-spam.
  const restricted = !wechatConfig().owner;
  const env: Record<string, string> = { GOAL_ENABLED: "0", LOOP_GUARD: "1" };
  if (restricted) {
    env.SAFETY_READONLY = "1"; // 宿主 write/edit 锁
    // 受限访客会话绝不继承 owner 的「完全访问」：full 会让 safety ② 直接放行（跳过 ③④），且
    // headless 子进程无法做 ask 的 UI 确认。把 full 降到 auto（与 multi-agent 自主子代理一致），
    // 保证 ④ 危险命令/受保护路径等门控仍生效；能力硬限（① deny/readonly）本就不受策略影响。
    const ownerPolicy = getApprovalPolicy();
    env.APPROVAL_POLICY = ownerPolicy === "full" ? "auto" : ownerPolicy;
    env.SAFETY_DENY_TOOLS = restrictedDenyTools().join(",");
  }
  const result = await spawnPiAgent(st.cwd, renderPrompt(history), {
    systemPrompt: restricted ? IM_SYSTEM_PROMPT_RESTRICTED : IM_SYSTEM_PROMPT_FULL,
    model: getConfig("IM_MODEL") || undefined,
    timeoutMs: Number(getConfig("IM_TIMEOUT_MS")) || undefined,
    env,
  });

  const reply = (result.output ?? "").trim();
  if (!reply) {
    st.notify?.(`微信回复生成失败：${result.error ?? "空回复"}`, "warning");
    // Don't ghost the user: send a generic fallback (never the raw error, to
    // avoid leaking internals). The user turn stays as the tail so the next turn
    // still has context.
    await st.wechat?.sendToUser(fromUser, "（处理出错了，请稍后再发一次）").catch(() => {});
    return;
  }
  if (!st.wechat) {
    // Not connected yet: leave the user turn as the tail → replayed once the
    // client (re)connects, rather than dropping a generated-but-undelivered reply.
    st.notify?.("微信未连接，回复暂存，将在重连后补发", "warning");
    return;
  }
  try {
    await st.wechat.sendToUser(fromUser, reply); // retries transient errors internally
  } catch (e) {
    st.notify?.(`微信发送失败：${(e as Error).message}`, "warning");
    return; // do NOT record an assistant turn we failed to deliver
  }
  store.append(key, "assistant", reply);
  persistContext();
  emitMessages();
}

/** Serialize jobs per conversation so each user's turns / history stay ordered. */
function enqueue(fromUser: string, job: () => Promise<void>): void {
  const st = imState();
  const prev = st.queues.get(fromUser) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(job)
    .catch((e) => st.notify?.(`微信处理出错：${(e as Error).message}`, "warning"))
    .finally(() => {
      // Drain the entry once settled so the map keeps at most one promise per
      // active conversation (skip if a newer turn already replaced this tail).
      if (st.queues.get(fromUser) === next) st.queues.delete(fromUser);
    });
  st.queues.set(fromUser, next);
}

/** Sliding-window per-user rate limit; true = over budget → drop this inbound. */
function overRateLimit(fromUser: string): boolean {
  const perMin = ratePerMin();
  if (perMin <= 0) return false; // limiter disabled
  const st = imState();
  const now = Date.now();
  const recent = (st.rate.get(fromUser) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMin) {
    st.rate.set(fromUser, recent); // keep the pruned window so it recovers over time
    return true;
  }
  recent.push(now);
  st.rate.set(fromUser, recent);
  // Opportunistic sweep so the rate map can't grow unbounded with one-off senders.
  if (st.rate.size > 2000) {
    for (const [k, ts] of st.rate) {
      if (ts.length === 0 || now - ts[ts.length - 1] >= 60_000) st.rate.delete(k);
    }
  }
  return false;
}

/** Enqueue a fresh inbound turn (rate-limited, serialized per conversation). */
function enqueueImTurn(fromUser: string, text: string): void {
  if (overRateLimit(fromUser)) return; // silently drop floods (no LLM spend)
  enqueue(fromUser, () => runImTurn(fromUser, text));
}

/**
 * Replay turns left unfinished by a crash: any conversation whose tail is a user
 * message had no delivered reply (the assistant turn is recorded only after a
 * successful send). Re-process them once per login session so a mid-turn crash
 * doesn't silently drop the user's message. Only the lock holder replays, and
 * only when it can actually send (logged in).
 */
function replayPending(): void {
  const st = imState();
  if (st.replayed || !st.ctx || !st.holdsLock || !st.wechat?.loggedIn()) return;
  st.replayed = true;
  for (const [key, msgs] of Object.entries(st.ctx.toJSON())) {
    if (msgs[msgs.length - 1]?.role !== "user") continue;
    const fromUser = key.replace(/^wechat:/, "");
    enqueue(fromUser, () => processTurn(fromUser));
  }
}

// 非持锁进程：从共享 state 文件读 token 反映真实登录态，让本 workspace 的 UI 与持锁窗口一致。
function reflectSharedStatus(): void {
  let loggedIn = false;
  try {
    const s = JSON.parse(readFileSync(weixinStatePath(), "utf8")) as { token?: string };
    loggedIn = !!s.token;
  } catch {
    /* 还没有共享 state */
  }
  setStatus({
    enabled: true,
    loggedIn,
    status: loggedIn ? "confirmed" : "active-elsewhere",
    qrLink: undefined,
  });
}

// 未持锁时定期重试抢锁：持锁的 sidecar 退出后，由其它窗口接手连微信（故障转移）。
function scheduleLockRetry(): void {
  const st = imState();
  if (st.lockTimer) return;
  st.lockTimer = setInterval(() => {
    const cur = imState();
    if (cur.holdsLock || !wechatConfig().enable) return;
    if (acquireLock(weixinLockPath())) {
      cur.holdsLock = true;
      if (cur.lockTimer) {
        clearInterval(cur.lockTimer);
        cur.lockTimer = undefined;
      }
      startWechat(); // 接管：真正连微信
    } else {
      reflectSharedStatus(); // 仍由别的窗口持有：持续反映共享状态
    }
  }, 15_000);
}

// 进程退出释放锁（每进程一次），避免崩溃/退出留下陈旧锁挡住其它窗口接管。
function hookExitRelease(): void {
  const st = imState();
  if (st.exitHooked) return;
  st.exitHooked = true;
  process.on("exit", () => {
    if (imState().holdsLock) releaseLock(weixinLockPath());
  });
}

function stopWechat(): void {
  const st = imState();
  st.wechat?.close();
  st.wechat = undefined;
  st.notifiedLogin = false;
  st.replayed = false;
  if (st.lockTimer) {
    clearInterval(st.lockTimer);
    st.lockTimer = undefined;
  }
  if (st.lockHeartbeat) {
    clearInterval(st.lockHeartbeat);
    st.lockHeartbeat = undefined;
  }
  if (st.holdsLock) {
    releaseLock(weixinLockPath());
    st.holdsLock = false;
  }
}

function startWechat(): void {
  const st = imState();
  // 跨进程单实例：多 workspace 各一 sidecar，仅一个能真正连微信，否则同一条消息会被多实例各自
  // 收到并回复（"发给所有会话"）。抢不到锁就待命 + 反映共享状态，并定期重试接管。
  if (!acquireLock(weixinLockPath())) {
    st.holdsLock = false;
    reflectSharedStatus();
    scheduleLockRetry();
    return;
  }
  st.holdsLock = true;
  if (st.lockTimer) {
    clearInterval(st.lockTimer);
    st.lockTimer = undefined;
  }
  // Heartbeat: refresh the lock's mtime so peers can tell a crashed holder (or a
  // reused pid) apart from a live one and take over only after LOCK_STALE_MS.
  if (st.lockHeartbeat) clearInterval(st.lockHeartbeat);
  st.lockHeartbeat = setInterval(() => refreshLock(weixinLockPath()), 20_000);
  const cfg = wechatConfig();
  const statePath = weixinStatePath();
  const handle = startWeixinOc({
    baseUrl: cfg.baseUrl || undefined,
    token: cfg.token || undefined,
    botType: cfg.botType || undefined,
    ownerUserId: cfg.owner || undefined,
    maxContexts: maxConversations(),
    statePath,
    onInbound: (text, fromUser) => enqueueImTurn(fromUser, text),
    onQr: ({ qrLink }) => {
      // Panel/modal renders the QR from this status; no toast (avoids noise).
      setStatus({ status: "waiting-scan", qrLink, loggedIn: false });
    },
    onStatus: (s) => {
      if (s === "confirmed") {
        setStatus({ status: "confirmed", loggedIn: true, qrLink: undefined });
        const cur = imState();
        if (!cur.notifiedLogin) {
          cur.notifiedLogin = true;
          cur.notify?.("微信(ilink) 登录成功", "info");
        }
        replayPending(); // fresh login: flush turns interrupted by a prior crash
        return;
      }
      if (s === "session-expired") {
        // Dead token: the poller cleared it and will emit a fresh QR. Reflect
        // logged-out so the UI shows the scan flow, and re-arm the login toast.
        const cur = imState();
        cur.notifiedLogin = false;
        cur.replayed = false; // re-arm replay for the next successful login
        setStatus({ loggedIn: false, status: "session-expired" });
        cur.notify?.("微信登录已过期，正在重新生成二维码，请重新扫码", "warning");
        return;
      }
      setStatus({ status: s });
    },
  });
  st.wechat = handle;
  // Already-logged-in (persisted token) restart: don't re-toast on next login.
  st.notifiedLogin = handle.loggedIn();
  setStatus({
    enabled: true,
    loggedIn: handle.loggedIn(),
    status: handle.loggedIn() ? "confirmed" : "starting",
    qrLink: undefined,
  });
  // Persisted-token restart: replay any turn interrupted by a prior crash.
  if (handle.loggedIn()) replayPending();
}

/** Bring the running WeChat client in line with the current config (hot). */
function reconcile(): void {
  const st = imState();
  const cfg = wechatConfig();
  const sig = JSON.stringify(cfg);
  if (sig === st.lastSig) return;
  st.lastSig = sig;

  if (!cfg.enable) {
    stopWechat(); // 无条件：顺带清理待命重试定时器与持有的锁
    setStatus({ enabled: false, loggedIn: false, status: "disabled", qrLink: undefined });
    return;
  }
  // Enabled (possibly with changed token/url/owner): (re)start cleanly. We do
  // NOT block on a missing owner — empty owner is the documented "留空不限" mode.
  // The /im command surfaces a security hint when no owner is set.
  if (st.wechat) stopWechat();
  startWechat();
}

export default function (pi: ExtensionAPI) {
  // A one-shot sub-agent (PI_IS_SUBAGENT=1) must NOT open its own WeChat
  // connection: the gateway lives only in the long-running interactive sidecar.
  // Because runImTurn spawns children that load every compiled extension
  // (including this one), without this guard each turn would spin up a duplicate
  // ilink long-poll client fighting over the same state file — an infinite fan-out.
  if (bool(getConfig("PI_IS_SUBAGENT"))) return;

  hookExitRelease();

  pi.on("session_start", (_event, ctx) => {
    const st = imState();
    st.cwd = ctx.cwd || st.cwd;
    st.notify = (msg, level) => {
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(msg, level);
        } catch {
          /* best-effort */
        }
      }
    };
    st.pushStatus = (key, text) => {
      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus(key, text);
        } catch {
          /* best-effort */
        }
      }
    };
    ensureContext();
    if (!st.watching) {
      st.watching = true;
      watchConfig(() => reconcile());
    }
    reconcile(); // apply current config (start/stop as needed)
    // Sync status to the (re)loaded UI. Retried because the frontend listener
    // attaches after this fires and Tauri drops events sent before it is ready.
    rebroadcastStatus();
  });

  pi.registerCommand("im", {
    description: "微信(ilink) 平台状态: /im",
    handler: async (_args, ctx) => {
      const s = imState().status;
      const line = !s.enabled
        ? "微信(ilink): 未启用"
        : s.loggedIn
          ? "微信(ilink): 已登录"
          : s.qrLink
            ? `微信(ilink): 待扫码 → ${s.qrLink}`
            : "微信(ilink): 启动中";
      // On-demand mode hint (no toast nagging): owner set = full capability;
      // empty owner = restricted chat-only (safe by default).
      const modeHint = !s.enabled
        ? ""
        : wechatConfig().owner
          ? "\n模式: 完整能力（已设主人 ID）"
          : "\n模式: 受限（仅对话/只读，不能改文件或执行代码）；设「主人 ID」WECHAT_OC_OWNER 解锁完整能力";
      ctx.ui.notify(`IM 平台:\n${line}${modeHint}\n上下文窗口: 每会话最多 ${ctxMax()} 条`, "info");
    },
  });
}
