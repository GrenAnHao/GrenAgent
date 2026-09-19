// 自定义请求头值里的 {sessionId}：在真正发供应商请求前换成当前会话 ID。
// OpenCode Go 等服务要求每条请求带稳定 session 头；用户在设置里写
// x-opencode-session = {sessionId} 即可，不必手填。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { interpolateHeaderPlaceholders } from "../_shared/header-placeholders.js";

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_headers", (event, ctx) => {
    interpolateHeaderPlaceholders(event.headers, {
      sessionId: ctx.sessionManager?.getSessionId?.(),
    });
  });
}
