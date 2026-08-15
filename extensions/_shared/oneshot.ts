// 一次性 LLM 调用（`pi oneshot` 子命令的实现）：走 pi-ai 同一套 dispatch，不进对话、不要 session。
// 供 Tauri 侧的辅助调用（mermaid 修复 / 模型健康检查）统一收敛，替代 Rust 里重抄的 provider 实现。
// 放在 _shared（而非 cli/）是因为 pi-ai 是 extensions 的依赖、能在此解析；cli 仅经 main.ts dispatch，
// 与既有 probe-mcp（逻辑在 extensions/mcp/probe.ts、cli 转发）同构。鉴权范式对齐 _shared/summarize.ts。

export interface OneshotRequest {
  provider: string;
  modelId: string;
  user: string;
  system?: string;
  stream?: boolean;
}

export function parseOneshotRequest(
  raw: string,
): { ok: true; req: OneshotRequest } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const o = v as Partial<OneshotRequest>;
  if (!o || typeof o.provider !== "string" || typeof o.modelId !== "string" || typeof o.user !== "string") {
    return { ok: false, error: "provider, modelId, user are required strings" };
  }
  return {
    ok: true,
    req: { provider: o.provider, modelId: o.modelId, user: o.user, system: o.system, stream: o.stream === true },
  };
}

interface AssistantLike {
  content?: Array<{ type?: string; text?: string }>;
  usage?: unknown;
}

export function formatNonStream(
  msg: AssistantLike,
): { ok: true; content: string; usage?: unknown } | { ok: false; error: string } {
  const text = (msg.content ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) return { ok: false, error: "empty content" };
  return { ok: true, content: text, usage: msg.usage };
}

const emit = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);

export async function runOneshot(): Promise<void> {
  const parsed = parseOneshotRequest(process.env.ONESHOT_REQUEST ?? process.argv[3] ?? "");
  if (!parsed.ok) {
    emit({ ok: false, error: parsed.error });
    return;
  }
  const { req } = parsed;
  try {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    const model = modelRuntime.getModel(req.provider, req.modelId);
    if (!model) {
      emit({ ok: false, error: `model not found: ${req.provider}/${req.modelId}` });
      return;
    }
    const context = {
      systemPrompt: req.system,
      messages: [{ role: "user", content: req.user, timestamp: Date.now() }],
    } as Parameters<typeof modelRuntime.completeSimple>[1];

    if (req.stream) {
      // 精简 JSONL：仅吐 delta + 末尾 done/error(usage)，避免每事件夹带整个 partial 消息。
      for await (const ev of modelRuntime.streamSimple(model, context)) {
        if (ev.type === "text_delta" && ev.delta) {
          emit({ type: "delta", text: ev.delta });
        } else if (ev.type === "done") {
          emit({ type: "done", usage: ev.message.usage });
        } else if (ev.type === "error") {
          emit({ type: "error", usage: ev.error.usage, error: ev.error.errorMessage });
        }
      }
      return;
    }
    const msg = await modelRuntime.completeSimple(model, context);
    emit(formatNonStream(msg as AssistantLike));
  } catch (e) {
    emit({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
