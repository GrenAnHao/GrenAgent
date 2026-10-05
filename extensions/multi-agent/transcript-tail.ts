// 子代理 `--mode json` 的 stdout 随 message_update 呈 O(n^2) 膨胀。运行中若把全量 transcript 每帧经
// IPC 推给前端、或每 tick 全量写进 registry，会压垮 IPC 反序列化 / state 存储（卡爆/OOM），DB 也会写入
// 超大 TEXT。内存里的累积串和落库共用 LIVE_TRANSCRIPT_TAIL：先剥掉 message_update 的累积快照，再只留尾部。
// 终态完整 transcript 也设上限，防极端超大串写进 registry / session 后重开历史再次卡爆。
//
// 注：与 _shared/transcript.ts（AgentMessage[] → role:text 扁平化）职责不同——这里处理的是
// `--mode json` 的 JSONL 字符串尾部截断，仅 multi-agent 的内联流 / registry 写入使用，故就近放置。
export const LIVE_TRANSCRIPT_TAIL = 65536; // 运行中实时预览 transcript 尾部上限（字符）
export const TRANSCRIPT_CAP = 4_000_000; // 终态完整 transcript 上限（字符）

/** 取尾部至多 maxLen 字符，并丢弃因截断产生的首个半行，保持 JSONL 行完整。 */
export function tailLines(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(s.length - maxLen);
  const nl = cut.indexOf("\n");
  return nl >= 0 ? cut.slice(nl + 1) : cut;
}

function omitPartial(ame: Record<string, unknown>): Record<string, unknown> {
  if (!("partial" in ame)) return ame;
  const { partial, ...rest } = ame;
  if (ame.type !== "toolcall_start" || !partial || typeof partial !== "object") return rest;
  const content = (partial as { content?: unknown }).content;
  const index = ame.contentIndex;
  const block = Array.isArray(content) && typeof index === "number" ? content[index] : undefined;
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "toolCall") return rest;
  const call = block as { id?: unknown; name?: unknown };
  return {
    ...rest,
    ...(typeof call.id === "string" ? { id: call.id } : {}),
    ...(typeof call.name === "string" ? { toolName: call.name } : {}),
  };
}

/** message_update 只留 delta。整份 message / partial 快照是按输出长度平方涨的那一份。 */
function slimMessageUpdate(raw: Record<string, unknown>): Record<string, unknown> {
  const message = raw.message;
  const usage = message && typeof message === "object" && "usage" in (message as object)
    ? (message as { usage?: unknown }).usage
    : undefined;
  const ame = raw.assistantMessageEvent;
  const slimAme = ame && typeof ame === "object" ? omitPartial(ame as Record<string, unknown>) : undefined;
  return {
    type: "message_update",
    ...(usage !== undefined ? { usage } : {}),
    ...(slimAme ? { assistantMessageEvent: slimAme } : {}),
  };
}

/** 内嵌会话事件 → 一行 JSONL。失败返回空串，记 transcript 不能打断子代理。 */
export function transcriptLineFromEvent(event: object): string {
  try {
    const raw = event as Record<string, unknown>;
    const payload = raw.type === "message_update" ? slimMessageUpdate(raw) : raw;
    return `${JSON.stringify(payload)}\n`;
  } catch {
    return "";
  }
}

/**
 * 子进程 stdout 的一行。message_update 剥掉快照；其它事件保持原行（message_end、工具起止各一次）。
 * 解析失败时原样保留，避免把半行误改成别的内容。
 */
export function slimTranscriptJsonLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  try {
    const ev = JSON.parse(trimmed) as Record<string, unknown>;
    if (!ev || typeof ev !== "object" || ev.type !== "message_update") {
      return line.endsWith("\n") ? line : `${line}\n`;
    }
    return `${JSON.stringify(slimMessageUpdate(ev))}\n`;
  } catch {
    return line.endsWith("\n") ? line : `${line}\n`;
  }
}

/** 拷出独立字符串，避免 tail 的切片把截掉的前缀钉在堆上。 */
function detach(s: string): string {
  return Buffer.from(s, "utf8").toString("utf8");
}

/** 把一行接进尾部缓冲。超过 maxLen 只留完整行组成的尾部。 */
export function appendTranscriptTail(current: string, line: string, maxLen = LIVE_TRANSCRIPT_TAIL): string {
  if (!line) return current;
  if (current.length + line.length <= maxLen) return current + line;
  return detach(tailLines(current + line, maxLen));
}
