/**
 * 嵌入式子代理会话（extensions/multi-agent/embedded-runner 以 `SessionManager.create(cwd, …)` 创建）
 * 与父会话落在同一 `sessions/<encoded-cwd>/` 目录，且比父会话新；侧栏 / 自动选中不得把它当主会话。
 * 判据是 embedded-runner 写入的 `subagent_meta` custom entry；fork 种子在前时它不在文件开头，
 * header 的 `parentSession` 用户手动 fork 也会带，故不能作为判据。
 */
export interface SubagentSessionMeta {
  agentId: string | null;
  /** 父会话 JSONL 路径（SDK 落盘写法）；父会话被删时按它级联。 */
  parentSession: string | null;
}

/** 最后一条 subagent_meta 为准：writeTornDown 会整体继承字段再追加一条带 tornDown 的。 */
export function readSubagentSessionMeta(lines: string[]): SubagentSessionMeta | undefined {
  let found: SubagentSessionMeta | undefined;
  for (const line of lines) {
    if (!line.includes('subagent_meta')) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; customType?: unknown; data?: unknown } | null;
      if (entry?.type !== 'custom' || entry.customType !== 'subagent_meta') continue;
      const data = entry.data && typeof entry.data === 'object' ? (entry.data as Record<string, unknown>) : {};
      found = { agentId: nonEmptyString(data.agentId), parentSession: nonEmptyString(data.parentSession) };
    } catch {
      /* 忽略坏行 */
    }
  }
  return found;
}

export function isSubagentSessionLines(lines: string[]): boolean {
  return readSubagentSessionMeta(lines) !== undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
