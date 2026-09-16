# SP-3 真对话模式（项目无关常驻对话）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 一个不绑项目、即开即聊、无延迟的独立对话面。

**架构：** PiManager 用一个特殊 workspace key（`__chat__`，中性 cwd）起常驻进程；app 启动 prewarm；按 profile 加载精简扩展集（聊天不载 lsp/dap/code-intel 等重扩展）；模型经 SP-1 `list_models_global`；前端独立对话入口。

**技术栈：** Rust（PiManager/spawn）、TypeScript（扩展 profile 过滤、prewarm）、React 前端、vitest。

设计来源：`docs/superpowers/specs/2026-06-26-real-chat-mode-design.md`（依赖 SP-1）。

---

## 文件结构

- 创建：`cli/src/extension-profile.ts` —— `filterExtensionsByProfile()`（纯：按 profile 过滤扩展名集）。
- 创建：`cli/src/extension-profile.test.ts`。
- 修改：`cli/src/main.ts` —— RPC 模式按 `EXTENSIONS_PROFILE` 过滤编入的扩展。
- 修改：`tauri-agent/src-tauri/src/commands/agent.rs` —— 暴露 `__chat__` 的中性 cwd 解析（或新 `chat_workspace_dir`）。
- 修改：`tauri-agent/src/lib/prewarm.ts` + 启动处 —— 启动预热 `__chat__`。
- 创建/修改：前端对话入口（`tauri-agent/src/features/chat/...` 复用聊天 UI，workspace 固定 `__chat__`）。

---

## 任务 1：`filterExtensionsByProfile` 纯逻辑

**文件：**
- 创建：`cli/src/extension-profile.ts`
- 测试：`cli/src/extension-profile.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// cli/src/extension-profile.test.ts
import { describe, expect, it } from "vitest";
import { CHAT_EXCLUDED, filterExtensionsByProfile } from "./extension-profile.js";

const has = (arr: { name: string }[], n: string) => arr.some((e) => e.name === n);

describe("filterExtensionsByProfile", () => {
  const all = [
    { name: "safety" }, { name: "approval" }, { name: "agent-mode" },
    { name: "lsp" }, { name: "dap" }, { name: "code-intel" }, { name: "long-term-memory" },
  ];
  it("project profile keeps everything", () => {
    expect(filterExtensionsByProfile(all, "project").length).toBe(all.length);
  });
  it("chat profile drops heavy code extensions but keeps safety", () => {
    const chat = filterExtensionsByProfile(all, "chat");
    expect(has(chat, "safety")).toBe(true);
    expect(has(chat, "agent-mode")).toBe(true);
    expect(has(chat, "lsp")).toBe(false);
    expect(has(chat, "dap")).toBe(false);
    expect(has(chat, "code-intel")).toBe(false);
  });
  it("safety is never dropped even if listed", () => {
    expect(CHAT_EXCLUDED.has("safety")).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd cli && npx vitest run src/extension-profile.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：编写实现**

```ts
// cli/src/extension-profile.ts
// 聊天模式精简扩展集：聊天不需要重代码智能扩展，缩短加载、降低开销。safety 永不剔除。
export const CHAT_EXCLUDED = new Set<string>([
  "lsp", "dap", "code-intel", "code-search", "ast-tools", "hashline", "code-exec",
  "debug-tools", "diagnostics", "code-review", "after-tool-feedback",
]);

export type ExtensionProfile = "project" | "chat";

export function filterExtensionsByProfile<T extends { name: string }>(exts: T[], profile: ExtensionProfile): T[] {
  if (profile !== "chat") return exts;
  return exts.filter((e) => !CHAT_EXCLUDED.has(e.name));
}
```

> 注：扩展工厂是否带稳定 `name` 字段需确认（`grep -n "name" extensions/*/index.ts` 或看 `allExtensions` 元素结构）。若工厂无 name，则改为在 `extensions/index.ts` 维护"名→工厂"映射，本函数对该映射的键过滤；测试契约（按 name 过滤）不变。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd cli && npx vitest run src/extension-profile.test.ts`
预期：PASS（3 passed）。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/extension-profile.ts cli/src/extension-profile.test.ts
git commit -m "feat(sp3): chat-profile extension filter"
```

## 任务 2：sidecar 按 profile 过滤扩展

**文件：**
- 修改：`cli/src/main.ts:88`（`extensionFactories: allExtensions` 处）

- [ ] **步骤 1：按 EXTENSIONS_PROFILE 过滤**

```ts
import { filterExtensionsByProfile, type ExtensionProfile } from "./extension-profile.js";
// ...
const profile = (getConfig("EXTENSIONS_PROFILE") as ExtensionProfile) ?? "project";
const factories = filterExtensionsByProfile(
  allExtensions.map((f) => ({ name: (f as { extensionName?: string }).extensionName ?? "", factory: f })),
  profile,
).map((x) => x.factory);
// 用 factories 替换传给 resourceLoaderOptions.extensionFactories 的 allExtensions
```

> 若扩展工厂无可读 name（见任务1注），改为在 `extensions/index.ts` 导出 `namedExtensions: {name, factory}[]`，main.ts 用它过滤。

- [ ] **步骤 2：typecheck + build**

运行：`cd cli && npm run typecheck && npm run build`
预期：通过。

- [ ] **步骤 3：Commit**

```bash
git add cli/src/main.ts
git commit -m "feat(sp3): sidecar loads extensions by EXTENSIONS_PROFILE"
```

## 任务 3：Tauri `__chat__` 常驻进程

**文件：**
- 修改：`tauri-agent/src-tauri/src/commands/agent.rs`

- [ ] **步骤 1：中性 cwd 解析 + spawn 时注入 chat profile**

加一个常量/解析：当 `workspace == "__chat__"` 时，实际 cwd = `<home>/.pi/chat-scratch`（不存在则创建），并在 spawn sidecar 时把 `EXTENSIONS_PROFILE=chat` 写入该进程的 runtime config / env。其余复用现有 `get_or_open` + spawn 工厂（`agent.rs` 现有 open/warm 逻辑），不另起一套。

- [ ] **步骤 2：编译**

运行：`cd tauri-agent/src-tauri && cargo build`
预期：通过。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/agent.rs
git commit -m "feat(sp3): __chat__ resident process with neutral cwd + chat profile"
```

## 任务 4：启动预热 + 前端对话入口

**文件：**
- 修改：`tauri-agent/src/lib/prewarm.ts`（或调用处 `App.tsx`）
- 修改/创建：前端对话入口组件

- [ ] **步骤 1：启动预热 __chat__**

在应用启动初始化处（`App.tsx` 或现有 prewarm 调用点）加 `prewarmWorkspace("__chat__")`（`prewarm.ts` 现有函数；Rust 侧据 workspace 解析中性 cwd）。

- [ ] **步骤 2：前端对话入口**

在侧栏/顶部加「对话」入口，点击进入复用现有聊天界面，`workspace` 固定传 `"__chat__"`；模型选择器用 `pi.listModelsGlobal()`（SP-1）。

- [ ] **步骤 3：前端类型检查 + 测试**

运行：`cd tauri-agent && npx tsc --noEmit && npm run test`
预期：通过。

- [ ] **步骤 4：手测延迟**

启动 app → 不开任何项目 → 进"对话" → 首条消息应秒回（已预热）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/lib/prewarm.ts tauri-agent/src/App.tsx tauri-agent/src/features/chat
git commit -m "feat(sp3): prewarm chat process + standalone chat entry"
```

---

## 自检

- 规格覆盖：精简扩展集（任务1-2）✓、__chat__ 常驻 + 中性 cwd（任务3）✓、启动预热（任务4步1）✓、前端入口 + 模型可选（任务4步2）✓、会话隔离（中性 cwd 的 sessions 分区，天然）✓、safety 不剔除（任务1 CHAT_EXCLUDED 不含 safety）✓。
- 占位符：无；扩展 name 可读性两处标注"以现有代码为准"并给补救（namedExtensions 映射）。
- 类型一致：`ExtensionProfile`（"project"|"chat"）在任务1定义、任务2 复用；`EXTENSIONS_PROFILE` config 键在 sidecar（任务2 读）与 Tauri（任务3 写）一致。
