import type { McpServerConfig } from "./config.js";

export interface ConnectionDiagnostics {
  attemptedAt: string;
  attemptId?: string;
  handshake?: string[];
  stderr: string[];
  exit?: string;
}

export function diagnosticText(config: Pick<McpServerConfig, "env" | "headers" | "oauth">, text: string): string {
  const values = [...Object.entries(config.env ?? {}), ...Object.entries(config.headers ?? {})]
    .filter(([key]) => /key|token|secret|authorization|password|credential|cookie/i.test(key)).map(([, value]) => value);
  const clientSecret = (config.oauth as { clientSecret?: string } | undefined)?.clientSecret;
  if (typeof clientSecret === "string") values.push(clientSecret);
  for (const value of [...values]) if (typeof value === "string" && /^Bearer\s+\S+$/i.test(value)) values.push(value.replace(/^Bearer\s+/i, ""));
  for (const value of values.filter(v => typeof v === "string" && v.length > 0).sort((a, b) => b.length - a.length)) text = text.split(value).join("••••••••");
  return text.replace(/(Bearer\s+)[^\s"',}]+/gi, "$1••••••••")
    .replace(/((?:[\w-]*(?:key|token|secret|authorization|password|credential|cookie)[\w-]*)["']?\s*[:=]\s*["']?)[^"'\s,;&}]+/gi, "$1••••••••")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1••••••••@");
}

export function connectionError(config: McpServerConfig, error: unknown): string {
  const messages: string[] = [];
  const pending: unknown[] = [error];
  for (let i = 0; i < pending.length && i < 6; i++) {
    const item = pending[i];
    const text = item instanceof Error ? item.message : String(item);
    if (text) messages.push(text);
    if (item instanceof Error && item.cause) pending.push(item.cause);
    if (item instanceof AggregateError) pending.push(...item.errors.slice(0, 4));
  }
  return diagnosticText(config, [...new Set(messages)].join(" · ")).slice(0, 2000);
}

// Keep raw fragments local until a complete line can be redacted. Oversize lines are
// omitted (rather than retaining a suffix that might start halfway through a credential).
export function stderrTail(config: McpServerConfig) {
  const lines: string[] = [];
  let partial = "", overflow = false;
  return {
    append(chunk: string) {
      const parts = chunk.split("\n");
      for (const [i, part] of parts.entries()) {
        if (!overflow) {
          if (partial.length + part.length > 4096) { partial = ""; overflow = true; }
          else partial += part;
        }
        if (i < parts.length - 1) {
          lines.push(overflow ? "（过长日志行已省略）" : diagnosticText(config, partial.trimEnd()));
          if (lines.length > 10) lines.shift();
          partial = ""; overflow = false;
        }
      }
    },
    read(final = false) {
      return final && (partial || overflow)
        ? [...lines, overflow ? "（过长日志行已省略）" : diagnosticText(config, partial)].slice(-10) : [...lines];
    },
  };
}
