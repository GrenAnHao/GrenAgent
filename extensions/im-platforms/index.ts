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
import { getConfig, watchConfig } from "../_shared/runtime-config.js";
import { getSandbox } from "../_shared/sandbox/index.js";
import { spawnPiAgent } from "../multi-agent/runner.js";
import { createImContextStore, type ImContextStore, renderPrompt } from "./context.js";
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

// Restricted + sandbox-available persona: chat AND sandboxed execution.
const IM_SYSTEM_PROMPT_RESTRICTED_SANDBOXED =
  "你是通过微信接入、与一位访客私聊的 AI 助手，当前为沙箱受限模式：可以正常对话，" +
  "也可在隔离沙箱内执行（用 sandbox_sh 跑 shell，或 py_run/js_run 跑代码）——" +
  "但写文件仅限当前 workspace、网络默认禁、不能用内置 bash。" +
  "只回复用户最新的问题，不要主动寒暄、不要复述历史、不要使用 emoji。";

// Restricted mode tool deny-list (on top of SAFETY_READONLY, which blocks
// write/edit + mutating bash): all code execution, ast writes, shell, and gh
// (which can push/mutate). Only the owner (WECHAT_OC_OWNER) gets full capability.
const RESTRICTED_DENY_TOOLS = "bash,py_run,py_reset,js_run,js_reset,ast_edit,github";

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
  wechat?: WeixinOcHandle;
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

function contextPath(): string {
  return join(homedir(), ".pi", "agent", "im_context.json");
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
 * Re-emit the current status now plus a few delayed retries. The frontend
 * attaches its Tauri `listen('pi://ui-request')` AFTER session_start fires, and
 * Tauri does not buffer events for late listeners — a single emit is often
 * missed, leaving the UI stuck on "连接中" while the backend is actually logged
 * in and polling with the persisted token. The retries win that attach race.
 */
function rebroadcastStatus(): void {
  emitStatus();
  for (const ms of [500, 1500, 3500, 7000, 12000]) {
    setTimeout(() => emitStatus(), ms);
  }
}

function ensureContext(): ImContextStore {
  const st = imState();
  if (st.ctx) {
    st.ctx.setMax(ctxMax());
    return st.ctx;
  }
  const store = createImContextStore({ maxMessages: ctxMax() });
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

/** Run one WeChat turn through an isolated, bounded-context one-shot agent. */
async function runImTurn(fromUser: string, text: string): Promise<void> {
  const st = imState();
  const store = ensureContext();
  const key = `wechat:${fromUser}`;
  store.append(key, "user", text);

  // Owner-gated capability: no owner configured → restricted "chat only" (read +
  // answer; no writes / code exec / shell). With an owner set, wechat.ts only
  // forwards the owner's messages, so reaching here means full capability is
  // authorized. Either way auto drivers stay OFF so the agent can't self-spam.
  const restricted = !wechatConfig().owner;
  // 无主人 + 沙箱可用 → 升级为"沙箱内可执行"；不可用 → 维持纯 deny 兜底。
  const sandboxed = restricted && (await getSandbox().isAvailable());
  const env: Record<string, string> = { GOAL_ENABLED: "0", LOOP_GUARD: "1" };
  if (restricted) {
    env.SAFETY_READONLY = "1"; // 宿主 write/edit 锁；写只能经 sandbox_sh（沙箱内、限 workspace）
    if (sandboxed) {
      env.SANDBOX_ENABLE = "on"; // 子进程 code-exec/sandbox_sh 走沙箱；safety 禁内置 bash
    } else {
      env.SAFETY_DENY_TOOLS = RESTRICTED_DENY_TOOLS; // 无沙箱兜底 → 纯禁执行
    }
  }
  const result = await spawnPiAgent(st.cwd, renderPrompt(store.history(key)), {
    systemPrompt: restricted
      ? sandboxed
        ? IM_SYSTEM_PROMPT_RESTRICTED_SANDBOXED
        : IM_SYSTEM_PROMPT_RESTRICTED
      : IM_SYSTEM_PROMPT_FULL,
    model: getConfig("IM_MODEL") || undefined,
    timeoutMs: Number(getConfig("IM_TIMEOUT_MS")) || undefined,
    env,
  });

  const reply = (result.output ?? "").trim();
  if (!reply) {
    st.notify?.(`微信回复生成失败：${result.error ?? "空回复"}`, "warning");
    // Don't ghost the user: send a generic fallback (never the raw error, to
    // avoid leaking internals). The failed user turn stays in history so the
    // next turn still has context.
    await st.wechat?.sendToUser(fromUser, "（处理出错了，请稍后再发一次）").catch(() => {});
    return;
  }
  store.append(key, "assistant", reply);
  persistContext();
  await st.wechat
    ?.sendToUser(fromUser, reply)
    .catch((e) => st.notify?.(`微信发送失败：${(e as Error).message}`, "warning"));
}

/** Enqueue an inbound turn, serialized per conversation to keep history ordered. */
function enqueueImTurn(fromUser: string, text: string): void {
  const st = imState();
  const prev = st.queues.get(fromUser) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => runImTurn(fromUser, text))
    .catch((e) => st.notify?.(`微信处理出错：${(e as Error).message}`, "warning"))
    .finally(() => {
      // Drain the entry once settled so the map keeps at most one promise per
      // active conversation (skip if a newer turn already replaced this tail).
      if (st.queues.get(fromUser) === next) st.queues.delete(fromUser);
    });
  st.queues.set(fromUser, next);
}

function stopWechat(): void {
  const st = imState();
  st.wechat?.close();
  st.wechat = undefined;
  st.notifiedLogin = false;
}

function startWechat(): void {
  const st = imState();
  const cfg = wechatConfig();
  const statePath = join(homedir(), ".pi", "agent", "weixin_oc_state.json");
  const handle = startWeixinOc({
    baseUrl: cfg.baseUrl || undefined,
    token: cfg.token || undefined,
    botType: cfg.botType || undefined,
    ownerUserId: cfg.owner || undefined,
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
        return;
      }
      if (s === "session-expired") {
        // Dead token: the poller cleared it and will emit a fresh QR. Reflect
        // logged-out so the UI shows the scan flow, and re-arm the login toast.
        const cur = imState();
        cur.notifiedLogin = false;
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
}

/** Bring the running WeChat client in line with the current config (hot). */
function reconcile(): void {
  const st = imState();
  const cfg = wechatConfig();
  const sig = JSON.stringify(cfg);
  if (sig === st.lastSig) return;
  st.lastSig = sig;

  if (!cfg.enable) {
    if (st.wechat) stopWechat();
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
