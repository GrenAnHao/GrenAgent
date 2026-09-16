# SP-2 一次性 LLM 统一（oneshot）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把"一次性、不进对话"的辅助 LLM 调用统一走 `pi-ai`，并删除 `providers.rs` 里约 600 行 Rust 平行 provider 实现。

**架构：** sidecar 加 `oneshot` 子命令（`pi-ai` 的 `completeSimple`/`streamSimple`）；Tauri 的 `fix_mermaid_diagram` / `diagnose_provider_model` 改为 spawn `oneshot`；删除 Rust 自实现的 HTTP/SSE/usage 解析。

**技术栈：** TypeScript（cli）、Rust（Tauri）、`pi-ai`（`completeSimple`/`streamSimple`）、`ModelRegistry`、vitest、cargo test。

设计来源：`docs/superpowers/specs/2026-06-26-oneshot-llm-design.md`。

---

## 文件结构

- 创建：`cli/src/oneshot.ts` —— `parseOneshotRequest()`（纯校验）、`formatNonStream()`（纯格式化）、`runOneshot()`（CLI 入口，调 pi-ai）。
- 创建：`cli/src/oneshot.test.ts` —— `parseOneshotRequest` / `formatNonStream` 单测。
- 修改：`cli/src/main.ts` —— 加 `oneshot` 分支。
- 修改：`tauri-agent/src-tauri/src/commands/providers.rs` —— `fix_mermaid_diagram` / `diagnose_provider_model` 改 spawn；删除 `call_llm_oneshot`、`diagnose_openai_stream`、`diagnose_anthropic_stream`、`diagnose_google_stream` 及其私有 helper。

---

## 任务 1：`parseOneshotRequest` + `formatNonStream` 纯逻辑

**文件：**
- 创建：`cli/src/oneshot.ts`
- 测试：`cli/src/oneshot.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// cli/src/oneshot.test.ts
import { describe, expect, it } from "vitest";
import { formatNonStream, parseOneshotRequest } from "./oneshot.js";

describe("parseOneshotRequest", () => {
  it("accepts a valid request", () => {
    const r = parseOneshotRequest('{"provider":"anthropic","modelId":"claude","user":"hi"}');
    expect(r).toEqual({ ok: true, req: { provider: "anthropic", modelId: "claude", user: "hi" } });
  });
  it("rejects missing user", () => {
    const r = parseOneshotRequest('{"provider":"anthropic","modelId":"claude"}');
    expect(r.ok).toBe(false);
  });
  it("rejects invalid json", () => {
    expect(parseOneshotRequest("not json").ok).toBe(false);
  });
});

describe("formatNonStream", () => {
  it("extracts text + usage from an assistant message", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      usage: { input: 10, output: 3 },
    };
    expect(formatNonStream(msg)).toEqual({ ok: true, content: "hello", usage: { input: 10, output: 3 } });
  });
  it("errors on empty content", () => {
    expect(formatNonStream({ role: "assistant", content: [] }).ok).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd cli && npx vitest run src/oneshot.test.ts`
预期：FAIL，"Cannot find module './oneshot.js'"。

- [ ] **步骤 3：编写实现**

```ts
// cli/src/oneshot.ts
// 一次性 LLM 调用子命令：走 pi-ai 同一套 dispatch，不进对话、不要 session。
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeSimple, streamSimple } from "@earendil-works/pi-ai";

export interface OneshotRequest {
  provider: string;
  modelId: string;
  user: string;
  system?: string;
  stream?: boolean;
}

export function parseOneshotRequest(raw: string): { ok: true; req: OneshotRequest } | { ok: false; error: string } {
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
  return { ok: true, req: { provider: o.provider, modelId: o.modelId, user: o.user, system: o.system, stream: o.stream } };
}

interface AssistantLike {
  content?: Array<{ type?: string; text?: string }>;
  usage?: unknown;
}

export function formatNonStream(msg: AssistantLike): { ok: boolean; content: string; usage?: unknown; error?: string } {
  const text = (msg.content ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) return { ok: false, content: "", error: "empty content" };
  return { ok: true, content: text, usage: msg.usage };
}

export async function runOneshot(): Promise<void> {
  const parsed = parseOneshotRequest(process.env.ONESHOT_REQUEST ?? process.argv[3] ?? "");
  if (!parsed.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: parsed.error })}\n`);
    return;
  }
  const { req } = parsed;
  const registry = ModelRegistry.create(AuthStorage.create());
  const model = registry.resolve(req.provider, req.modelId); // 名称以 d.ts 为准
  const context = {
    messages: [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.user },
    ],
  } as unknown as Parameters<typeof completeSimple>[1];

  if (req.stream) {
    for await (const ev of streamSimple(model, context)) {
      process.stdout.write(`${JSON.stringify(ev)}\n`); // JSONL：逐事件
    }
    return;
  }
  const msg = await completeSimple(model, context);
  process.stdout.write(`${JSON.stringify(formatNonStream(msg as AssistantLike))}\n`);
}
```

> 注：`ModelRegistry.resolve(provider, id)` 与 `Context` 形状以上游 d.ts 为准——实现前 `grep -rn "resolve\|getModel" model-registry.d.ts` 与查 `pi-ai` 的 `Context` 类型确认；`parseOneshotRequest`/`formatNonStream`（被测纯函数）契约不随之变。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd cli && npx vitest run src/oneshot.test.ts`
预期：PASS（5 passed）。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/oneshot.ts cli/src/oneshot.test.ts
git commit -m "feat(sp2): oneshot request parsing + pi-ai dispatch"
```

## 任务 2：接入 sidecar 子命令

**文件：**
- 修改：`cli/src/main.ts`

- [ ] **步骤 1：加 `oneshot` 分支**（在 `probe-mcp` 分支附近）

```ts
  if (argv[0] === "oneshot") {
    const { runOneshot } = await import("./oneshot.js");
    await runOneshot();
    return;
  }
```

- [ ] **步骤 2：typecheck + build + 手测**

运行：`cd cli && npm run typecheck && npm run build`
手测：`ONESHOT_REQUEST='{"provider":"<p>","modelId":"<m>","user":"say hi"}' node dist/main.js oneshot`
预期：一行 JSON，`{"ok":true,"content":"..."}`。

- [ ] **步骤 3：Commit**

```bash
git add cli/src/main.ts
git commit -m "feat(sp2): wire oneshot subcommand"
```

## 任务 3：Tauri 改 spawn + 删 Rust 平行实现

**文件：**
- 修改：`tauri-agent/src-tauri/src/commands/providers.rs`

- [ ] **步骤 1：`fix_mermaid_diagram` 改 spawn oneshot**

把 `fix_mermaid_diagram`（:544）的"取当前模型 → call_llm_oneshot"替换为：取当前会话模型（provider/id 仍经 `GetState`）→ 构造 `ONESHOT_REQUEST`（system=现有 mermaid 修复 prompt，:592；user=现有拼接）→ spawn `pi oneshot` → 读 stdout JSON 的 `content` → `extract_mermaid`（:331，保留）。

```rust
let req = serde_json::json!({ "provider": provider_key, "modelId": model_id, "system": system, "user": user });
let out = tokio::process::Command::new(crate::pi::sidecar::resolve_pi_binary(&app)?)
    .arg("oneshot")
    .env("ONESHOT_REQUEST", req.to_string())
    .output().await.map_err(|e| e.to_string())?;
let line = String::from_utf8_lossy(&out.stdout); let line = line.lines().last().unwrap_or("").trim();
#[derive(serde::Deserialize)] struct OneshotOut { ok: bool, #[serde(default)] content: String, #[serde(default)] error: Option<String> }
let parsed: OneshotOut = serde_json::from_str(line).map_err(|e| e.to_string())?;
if !parsed.ok { return Err(parsed.error.unwrap_or_default()); }
let fixed = extract_mermaid(&parsed.content);
```

- [ ] **步骤 2：`diagnose_provider_model` 改 spawn oneshot --stream**

把 `diagnose_provider_model`（:877）改为：构造 `ONESHOT_REQUEST`（`stream:true`）→ spawn `pi oneshot`，逐行读 JSONL，计 TTFT（首个含文本的事件）/total/usage/速率，填回现有 `DiagnoseResult`（:611，形状不变）；`on_chunk` Channel 仍推增量文本。

- [ ] **步骤 3：删除 Rust 平行实现**

删除 `call_llm_oneshot`（:374）、`diagnose_openai_stream`（:647）、`diagnose_anthropic_stream`（:779）、`diagnose_google_stream`（:830）及仅被它们使用的私有 helper（如 `extract_openai_message_content`，确认无其他引用后删）。保留 `extract_mermaid`、`truncate_body`、`parse_id_list`/`fetch_provider_models`（SP-1 降级用）。

- [ ] **步骤 4：编译 + 测试**

运行：`cd tauri-agent/src-tauri && cargo build && cargo test`
预期：通过；保留的 `extract_mermaid_*` 测试仍 PASS；无悬挂引用。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/providers.rs
git commit -m "refactor(sp2): route aux LLM calls through pi-ai oneshot, drop ~600 lines of Rust provider code"
```

---

## 自检

- 规格覆盖：oneshot 子命令流/非流（任务1-2）✓、mermaid 改写（任务3步1）✓、健康检查改写（任务3步2）✓、删 Rust 平行实现（任务3步3）✓。
- 占位符：无；`resolve`/`Context`/`resolve_pi_binary` 三处标注"以现有代码为准"并给确认命令。
- 类型一致：`OneshotRequest`（任务1）↔ Rust `serde_json::json!` 字段名（provider/modelId/system/user/stream）一致；`OneshotOut.content` ↔ `formatNonStream` 输出键一致。
