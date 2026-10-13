// 有界面的顶层会话把自己登记成审批路由的终点（_shared/approval-route.ts）：它派出的子代理需要人批准时，
// 请求一层层转上来，最后用这个会话自己的 ctx.ui.select 问人（Electron 里是输入框上方的审批卡，CLI 里是 TUI）。
// 子会话（JSONL 里有 subagent_meta）和 worker 进程不登记：它们的路由由打开子会话的地方登记。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTopApprovalRoute } from "../_shared/approval-route.js";
import { resolveToolOrigin } from "../_shared/workspace-context.js";
import { lastSubagentMeta } from "./subagent-meta.js";

function isTopLevelSession(ctx: ExtensionContext): boolean {
  if (process.env.PI_IS_SUBAGENT === "1" || resolveToolOrigin() === "subagent") return false;
  try {
    return lastSubagentMeta(ctx.sessionManager.getEntries()) === undefined;
  } catch {
    return false;
  }
}

export function registerTopApprovalLifecycle(pi: ExtensionAPI): void {
  let detach: (() => void) | undefined;
  const release = () => {
    detach?.();
    detach = undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    release();
    if (!ctx.hasUI || !isTopLevelSession(ctx)) return;
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionPath) return;
    // 每次现取 ctx.ui：宿主重新绑定界面后用新的那份。
    detach = registerTopApprovalRoute(sessionPath, {
      select: (title, options, opts) => ctx.ui.select(title, options, opts),
    });
  });
  pi.on("session_shutdown", release);
}
