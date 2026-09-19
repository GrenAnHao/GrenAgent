/** 自定义请求头值里的会话占位符：发出去之前换成当前 Pi sessionId。 */
export const SESSION_ID_PLACEHOLDER = "{sessionId}";

/** 设置页「同步模型」没有对话会话，用稳定占位避免 OpenCode Go 因缺 session 头拒探。 */
export const SETTINGS_PROBE_SESSION_ID = "settings-probe";

export function interpolateHeaderPlaceholders(
  headers: Record<string, string | null | undefined>,
  vars: { sessionId?: string },
): void {
  const sessionId = vars.sessionId?.trim();
  if (!sessionId) return;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string" || !value.includes(SESSION_ID_PLACEHOLDER)) continue;
    headers[key] = value.replaceAll(SESSION_ID_PLACEHOLDER, sessionId);
  }
}
