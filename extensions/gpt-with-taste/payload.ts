// 最终报文守卫：只补缺失，不改写已有内容。
//
// 为什么需要它：`before_agent_start` 返回整段 systemPrompt（forceSystemPrompt）的扩展会让
// Pi 用「一条 content 里塞满全文的 system 消息」顶掉结构化 sections，我们的段就丢了。
// 这里在报文真正发出前再看一眼，缺了才追加，并保留宿主指令、工具声明和结果内容。
//
// 支持三种线上格式：
//   - Responses / Codex Responses：`input` 数组 + `instructions` 字符串
//   - Anthropic Messages：`system` 字符串或 text block 数组（messages 里只有 user / assistant）
//   - Chat Completions：`messages` 数组里的 system / developer 消息
// 不认识的格式只报一次警告，不猜。
type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function instructionText(message: unknown): string {
  if (!isRecord(message)) return "";
  if (!["system", "developer"].includes(String(message.role))) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && ["text", "input_text"].includes(String(part.type)) && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}

function blockText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

export interface GuardResult {
  payload: unknown;
  /** false 表示这种报文格式看不懂，守卫没有生效（Pi 侧的系统段注入仍然有效）。 */
  supported: boolean;
}

export function ensurePayloadInstructions(payload: unknown, block: string): GuardResult {
  if (!isRecord(payload) || typeof payload.model !== "string") return { payload, supported: false };

  // Responses / Codex Responses：指令在顶层 instructions。
  if (Array.isArray(payload.input)) {
    const existing = payload.instructions;
    if (existing != null && typeof existing !== "string") return { payload, supported: false };
    const already =
      (typeof existing === "string" && existing.includes(block)) ||
      payload.input.some((message) => instructionText(message).includes(block));
    if (already) return { payload, supported: true };
    return {
      payload: { ...payload, instructions: existing ? `${existing}\n\n${block}` : block },
      supported: true,
    };
  }

  // Anthropic Messages：system 在顶层，messages 只有 user / assistant。
  if (payload.system !== undefined) {
    const system = payload.system;
    if (blockText(system).includes(block)) return { payload, supported: true };
    if (typeof system === "string") {
      return { payload: { ...payload, system: system ? `${system}\n\n${block}` : block }, supported: true };
    }
    if (Array.isArray(system)) {
      return { payload: { ...payload, system: [...system, { type: "text", text: block }] }, supported: true };
    }
    return { payload, supported: false };
  }

  // Chat Completions：指令在 messages 里的 system / developer 消息。
  if (Array.isArray(payload.messages)) {
    const messages = payload.messages;
    if (messages.some((message) => instructionText(message).includes(block))) {
      return { payload, supported: true };
    }
    const index = messages.findIndex(
      (message) => isRecord(message) && ["system", "developer"].includes(String(message.role)),
    );
    const message = messages[index];
    if (!isRecord(message)) return { payload, supported: false };
    let content: unknown;
    if (typeof message.content === "string") {
      content = message.content ? `${message.content}\n\n${block}` : block;
    } else if (Array.isArray(message.content)) {
      content = [...message.content, { type: "text", text: block }];
    } else {
      return { payload, supported: false };
    }
    const updated = messages.slice();
    updated[index] = { ...message, content };
    return { payload: { ...payload, messages: updated }, supported: true };
  }

  return { payload, supported: false };
}
