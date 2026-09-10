// im-gateway: expose the agent over a simple HTTP webhook so IM platforms
// (Slack / Feishu / Telegram / ...) can talk to it via a thin adapter.
//
// Flow: POST /message { text, replyUrl? } -> pi.sendUserMessage(text);
// the next assistant message is POSTed back to replyUrl (if provided).
//
// Hot-reloadable: a process-level watchConfig subscription reconciles the HTTP
// server whenever IM_GATEWAY* changes — enable/disable/port/token take effect
// without restarting the sidecar. Off by default (it opens a port).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claimImBinding } from "../_shared/im-binding.js";
import { getConfig, watchConfig } from "../_shared/runtime-config.js";
import { type GatewayHandle, postReply, startGateway } from "./gateway.js";

interface GwState {
  watching: boolean;
  lastSig?: string;
  handle?: GatewayHandle;
  /** FIFO of reply URLs awaiting the next assistant message (one per pending request). */
  pendingReplies: string[];
  sendUserMessage?: (text: string, opts?: { deliverAs?: "steer" | "followUp" }) => void;
  notify?: (msg: string, level: "info" | "warning" | "error") => void;
}

function gwState(): GwState {
  const g = globalThis as { __grenImGateway?: GwState };
  return (g.__grenImGateway ??= { watching: false, pendingReplies: [] });
}

function bool(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "off" && s !== "no";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text: string } => !!p && typeof p === "object" && (p as { type?: string }).type === "text")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

/** Bring the running gateway in line with the current config (hot). */
function reconcile(): void {
  const st = gwState();
  const enabled = bool(getConfig("IM_GATEWAY"));
  const port = Number(getConfig("IM_GATEWAY_PORT")) || 8765;
  const token = getConfig("IM_GATEWAY_TOKEN") ?? "";
  let host = getConfig("IM_GATEWAY_HOST")?.trim() || "127.0.0.1";
  // Inbound gateway text is injected straight into the owner's full-capability
  // session. Refuse to expose that beyond loopback without a token: otherwise any
  // host on the LAN could POST /message and run arbitrary commands as the owner.
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const forcedLocal = enabled && !token && !loopback;
  if (forcedLocal) host = "127.0.0.1";
  const sig = JSON.stringify({ enabled, port, token, host });
  if (sig === st.lastSig) return;
  st.lastSig = sig;

  if (st.handle) {
    void st.handle.close();
    st.handle = undefined;
  }
  st.pendingReplies = []; // drop stale reply correlations across restarts
  if (!enabled) return;

  void startGateway({
    port,
    host,
    token: token || undefined,
    onMessage: ({ text, replyUrl }) => {
      let delivered = false;
      try {
        st.sendUserMessage?.(text);
        delivered = true;
      } catch {
        try {
          st.sendUserMessage?.(text, { deliverAs: "followUp" });
          delivered = true;
        } catch {
          /* drop */
        }
      }
      // Correlate replies FIFO instead of a single overwrite var, so concurrent
      // requests don't clobber each other's replyUrl. Only queue when the message
      // was accepted, and cap the queue so stalled replies can't grow it unbounded.
      if (delivered && replyUrl) {
        st.pendingReplies.push(replyUrl);
        if (st.pendingReplies.length > 100) st.pendingReplies.shift();
      }
    },
  })
    .then((handle) => {
      st.handle = handle;
      const note = forcedLocal
        ? "（未设 token，已强制仅监听 127.0.0.1）"
        : token
          ? "（需 token）"
          : "（仅本机，对外暴露前请先设 IM_GATEWAY_TOKEN）";
      st.notify?.(`IM 网关监听 ${host}:${handle.port}${note}`, forcedLocal ? "warning" : "info");
    })
    .catch((e) => {
      st.notify?.(`IM 网关启动失败: ${(e as Error).message}`, "error");
    });
}

export default function (pi: ExtensionAPI) {
  // A one-shot sub-agent (PI_IS_SUBAGENT=1) must NOT open the gateway port: it
  // lives only in the long-running interactive sidecar. Sub-agents load every
  // compiled extension, so without this guard each spawned child would try to
  // bind the same port and fail (or fight the parent for it).
  if (bool(getConfig("PI_IS_SUBAGENT"))) return;

  pi.on("session_start", (_event, ctx) => {
    const workspace = typeof ctx.cwd === "string" ? ctx.cwd : "";
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
    const claim = claimImBinding(workspace, sessionId);
    if (!claim.claimed) {
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(`IM 已绑定到 ${claim.owner.workspace}`, "warning");
        } catch {
          /* best-effort */
        }
      }
      return;
    }
    const st = gwState();
    st.sendUserMessage = (text, opts) => pi.sendUserMessage(text, opts);
    st.notify = (msg, level) => {
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(msg, level);
        } catch {
          /* best-effort */
        }
      }
    };
    if (!st.watching) {
      st.watching = true;
      watchConfig(() => reconcile());
    }
    reconcile();
  });

  pi.on("message_end", async (event) => {
    const st = gwState();
    if (!st.handle || st.pendingReplies.length === 0) return;
    const msg = (event as { message?: { role?: string; content?: unknown } })?.message;
    if (msg?.role !== "assistant") return;
    const text = extractText(msg.content);
    if (!text) return;
    const url = st.pendingReplies.shift();
    if (!url) return;
    await postReply(url, text);
  });

  pi.registerCommand("imgateway", {
    description: "IM 网关状态: /imgateway",
    handler: async (_args, ctx) => {
      const st = gwState();
      ctx.ui.notify(
        st.handle ? `IM 网关监听 :${st.handle.port}` : "IM 网关未运行（在「连接」面板启用即可，热生效）",
        "info",
      );
    },
  });
}
