// codemode 脚本的 timeout_ms 到点时，sandbox 会中止脚本里所有在途的嵌套调用。脚本里跑着的
// spawn_agent 随之被取消：子代理干到一半，产出和 token 全丢。子代理自带空闲 / 硬超时
// （embedded-runner），脚本级时限对它们只有破坏，所以脚本调用 spawn_agent 时去掉 timeout_ms。

const OPTIONS_PREFIX = "// @options:";

/**
 * 脚本引用了 spawn_agent 且首行 `// @options:` 带 timeout_ms 时，返回去掉 timeout_ms 的脚本；
 * 其余情况（没调子代理、没有时限、options 不是合法 JSON）返回 undefined，原样交给 codemode。
 */
export function withoutSubagentDeadline(source: string): string | undefined {
  if (!/\bspawn_agent\b/.test(source)) return undefined;
  const newline = source.indexOf("\n");
  if (newline === -1) return undefined;
  const firstLine = source.slice(0, newline).replace(/\r$/, "");
  const trimmed = firstLine.trimStart();
  if (!trimmed.startsWith(OPTIONS_PREFIX)) return undefined;
  let options: unknown;
  try {
    options = JSON.parse(trimmed.slice(OPTIONS_PREFIX.length).trim());
  } catch {
    return undefined;
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(options, "timeout_ms")) return undefined;
  const { timeout_ms: _deadline, ...rest } = options as Record<string, unknown>;
  const body = source.slice(newline + 1);
  // 只剩空对象时整行去掉；codemode 要求 options 行后面必须还有代码，body 原样保留即可。
  if (Object.keys(rest).length === 0) return body;
  const eol = source.charAt(newline - 1) === "\r" ? "\r\n" : "\n";
  return `${OPTIONS_PREFIX} ${JSON.stringify(rest)}${eol}${body}`;
}
