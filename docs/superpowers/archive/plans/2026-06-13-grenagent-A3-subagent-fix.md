# A3 Sub-agent 修复 + UI 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 修复桌面环境下 `spawn_agent`（子代理）与 `MEMORY_EXTRACT` 记忆提取无法工作的问题，使其复用 GrenAgent sidecar 二进制本体（而非依赖系统全局 `pi`），并补齐设置项与 UI 呈现。**核心策略：跟官方 pi CLI 对齐（方案 A1）。**

**父 spec：** `docs/superpowers/specs/2026-06-13-grenagent-subproject-a-extensions-safety-design.md`（§4.6 模块 3：sub-agent 修复 + UI）

---

## 实施状态（2026-06-13）

- ✅ **任务 1**（runner/extractor fallback → `process.execPath` + 单测）：提交 `73ba30e`，7/7 测试通过。
- ✅ **任务 2**（cli/main.ts 复用官方 `main`）：提交 `8a63707`。验证：`bun build` 重建成功；`<sidecar> --help` 证明官方 main 接管 argv（含 `--mode text|json|rpc`、`-p`、`--no-session`、`--model`）；`<sidecar> --mode json -p --no-session "..."` **实跑成功**（完整 JSONL：含 long-term-memory extension auto-recall + LLM 响应 + 进程 ~4s 退出）。注：`tsc` 因 cli **pre-existing 缺 `@types/node`** 无法跑，改用 bun build 产物 + 实跑验证。
- ✅ **任务 3**（settingsSchema 加 `PI_BIN`）：提交 `56bd3b7`，前端 `tsc --noEmit` 退出 0。
- ◐ **任务 5**（端到端冒烟）：重建 ✓、print 模式实跑 ✓（等价验证子代理链路）。**待用户在 GrenAgent app 内确认**：① `--mode rpc` 连接未回归（代码层已验证：官方 `main.js` 路由 `appMode==="rpc" → runRpcMode`）；② app 内触发 `spawn_agent` 工具实跑。
- ⊘ **任务 4**（Rust 注入 PI_BIN）：**跳过（YAGNI）**。`process.execPath` 兜底 + print 实跑已证明二进制可被子代理调用；如后续 app 冒烟发现需显式控制再补。
- 🔧 **后续修复（用户 GUI 反馈：子代理一直加载/超时）**：根因是 **print 模式会读 piped stdin，而 runner spawn 子进程未关闭 stdin → 子进程阻塞等 EOF、永不执行任务**（A3 验证时用 `$null |` 关 stdin 掩盖了它）。修 `stdio:["ignore","pipe","pipe"]` + 子代理轻量化（spawn 时禁 `KB_AUTO_INJECT`/`MEMORY_AUTO_INJECT`/`MEMORY_AUTO_CAPTURE`/`MEMORY_EXTRACT`/`MCP_SERVERS`，避免每个子代理重跑 embedding/重连 MCP/递归）。命令行实测：超时 → **6.6s 返回**。提交 `fa39740`。

> 下方为原始计划步骤（复选框保留为原始拆解；实际完成情况以本节为准）。

---

## 关键发现（实现前排查，修正 spec §4.6）

spec §4.6 假设「runner 默认 spawn 系统 `pi`、`PI_BIN` 未注入」是唯一问题，注入 `PI_BIN` 即可。实际排查代码后发现 **spec 不完整**，真正的阻塞链是：

1. **`extensions/multi-agent/runner.ts` 已经支持 `PI_BIN`** —— `resolvePiCommand()` 已是 `process.env.PI_BIN ?? "pi"`（先前提交已改）。`extensions/long-term-memory/extractor.ts` 同样已支持。**spec 描述的这两处 TS 修改其实已完成。**

2. **`tauri-agent/src-tauri/src/pi/sidecar.rs` 未注入 `PI_BIN`** —— `spawn_pi_client` 注入了 `PI_PACKAGE_DIR` 与调用方 `env`，但没有 `PI_BIN`，所以 sidecar 进程内 `process.env.PI_BIN` 为 undefined → fallback 到系统 `pi` → 桌面无全局 `pi` 时失败。

3. **【核心阻塞】`cli/src/main.ts` 只支持 `--mode rpc`，不解析 argv** —— 它直接 `await runRpcMode(runtime)`，忽略所有命令行参数。所以即便把 `PI_BIN` 指向 sidecar 二进制，子代理执行 `<sidecar> --mode json -p --no-session <task>` 也**不会**跑一次性任务，而是进入 RPC 模式干等 stdin。**这是 spec 完全没覆盖的点，也是 A3 的真正核心。**

4. **pi 0.78.1 包能力**（已核对 `@earendil-works/pi-coding-agent` 的 `dist/*.d.ts` 与 `dist/main.js`）：
   - `main(args: string[], options?: { extensionFactories?: ExtensionFactory[] }): Promise<void>` —— 官方完整 CLI 入口，自己解析 argv 并分发到各模式，且接受我们的 `extensionFactories`。
   - `runPrintMode(runtime, { mode: "text"|"json"; initialMessage?; messages?; initialImages? }): Promise<number>` —— `pi -p` / `pi --mode json` 的单次执行入口。
   - `runRpcMode(runtime): Promise<never>`（现状已用）。

5. **`settingsSchema.ts` 无 `PI_BIN` 字段**，但「网页抓取 / 子代理」分类已有 `SUBAGENT_TIMEOUT_MS`。

6. **前端 `SpawnAgentCard` 已存在**（`extensionCards.tsx`，注册在 `EXTENSION_CARDS.spawn_agent`），展示子代理数量/失败数 + Markdown 输出。`multi-agent` / `long-term-memory` **均无测试文件**。

---

## 方案与权衡

### 决策 1：sidecar 如何支持子代理的一次性 print 模式（核心）—— 采用 A1「跟官方对齐」

**已验证（读 `@earendil-works/pi-coding-agent/dist/main.js`）**：官方 `main` 完整支持 RPC 模式 —— argv 解析含 `if (parsed.mode === "rpc") return "rpc"`，路由含 `if (appMode === "rpc") await runRpcMode(runtime)`，且对 RPC 模式正确特化（`@file` 在 rpc 下报错拒绝、仅 `appMode !== "rpc"` 才读 piped stdin、rpc 不 `initTheme`）。→ **A1 前提成立，Tauri 的 `--mode rpc` 不会被破坏。**

**方案：`cli/src/main.ts` 改为复用官方 CLI 入口**

```ts
import { main } from "@earendil-works/pi-coding-agent";
import { allExtensions } from "../../extensions/index.js";

main(process.argv.slice(2), { extensionFactories: allExtensions }).catch((error) => {
  console.error(error);
  process.exit(1);
});
```

sidecar 二进制 = 官方 pi CLI + 我们的 extensions，一举支持全部模式与参数：
- Tauri `--mode rpc` → `runRpcMode` ✓（已验证）
- 子代理 `--mode json -p --no-session <task>` → `runPrintMode` ✓
- `--model` / `--provider` / `--no-session` 由官方 main 解析 ✓（决策 4、6 自动解决）

**收益**：删掉自定义 `createRuntime` 与手写 argv 解析，与官方升级路径对齐，维护成本最低。

> 备选 A2（保留 `runRpcMode` 入口 + 手写 print 分支）已不采纳：A1 验证通过后，A2 的「隔离」优势不再值得其手写 argv 解析的重复成本。

### 决策 2：`PI_BIN` 如何解析到 sidecar 自身

- sidecar 是 `bun build --compile` 的单文件 exe；**在该 exe 内 `process.execPath` 指向 exe 自身**。Tauri（生产与 dev）都经 `app.shell().sidecar("pi")` spawn 这个编译产物 → runner 运行其中时 `process.execPath` 即正确的 sidecar 路径。
- **方案**：`runner.ts` / `extractor.ts` 的 fallback 从 `?? "pi"` 改为 `?? process.execPath`（生产/Tauri dev 自包含）；`PI_BIN` env 仍可显式覆盖（纯 node+tsx 调试 sidecar 时用）。
- **Rust 注入 `PI_BIN`（任务 4）降级为可选**：有了 `process.execPath` 兜底后非必需；仅当需要显式可控时实现（实测 `process.execPath` 生效即可跳过）。

### 决策 3：UI

- `SpawnAgentCard` 已满足基本展示（数量/失败/输出），与官方做法一致。
- spec 提的「右面板子代理列表/进度」：子代理是 `await spawnPiAgent` **同步执行**、无中间进度流，做实时进度列表收益低 → **MVP 不做，留作增强**（与 A2 plan-mode 的「步骤卡片」处理一致）。

---

## 文件结构

- 修改 `extensions/multi-agent/runner.ts` — `resolvePiCommand` fallback → `process.execPath`
- 创建 `extensions/multi-agent/runner.test.ts` — 单测 `resolvePiCommand` / `extractFinalText`
- 创建 `extensions/multi-agent/package.json` — `pi-multi-agent`（若不存在；供独立 vitest）
- 修改 `extensions/long-term-memory/extractor.ts` — `resolvePiCommand` fallback → `process.execPath`
- 创建 `extensions/long-term-memory/extractor.test.ts` — 单测 `resolvePiCommand` / `parseExtracted`
- 修改 `cli/src/main.ts` — 复用官方 `main(argv, { extensionFactories })`（A1，删自定义 createRuntime）
- 修改 `tauri-agent/src/features/settings/settingsSchema.ts` — 「子代理」分类加 `PI_BIN`
- （可选）修改 `tauri-agent/src-tauri/src/pi/sidecar.rs` — 注入 `PI_BIN`
- 重建 sidecar + 端到端冒烟验证

---

## 任务 1：runner / extractor 的 PI_BIN fallback → process.execPath（+ 单测）

**文件：** `extensions/multi-agent/runner.ts`、`extensions/multi-agent/runner.test.ts`、`extensions/multi-agent/package.json`、`extensions/long-term-memory/extractor.ts`、`extensions/long-term-memory/extractor.test.ts`

- [ ] **步骤 1：先读现状** — 确认 `multi-agent` / `long-term-memory` 是否已有 `package.json`（缺则按 `plan-mode/package.json` 同构创建，name 分别 `pi-multi-agent` / 现有 LTM 名）。
- [ ] **步骤 2：写失败测试** `runner.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { extractFinalText, resolvePiCommand } from "./runner.js";

const orig = process.env.PI_BIN;
afterEach(() => { if (orig === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = orig; });

describe("resolvePiCommand", () => {
  it("prefers PI_BIN when set", () => {
    process.env.PI_BIN = "/custom/pi";
    expect(resolvePiCommand().cmd).toBe("/custom/pi");
  });
  it("falls back to the current executable (sidecar self), not bare 'pi'", () => {
    delete process.env.PI_BIN;
    expect(resolvePiCommand().cmd).toBe(process.execPath);
  });
});

describe("extractFinalText", () => {
  it("returns the last assistant text from JSONL", () => {
    const jsonl = [
      JSON.stringify({ role: "assistant", content: "first" }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } }),
    ].join("\n");
    expect(extractFinalText(jsonl)).toBe("final answer");
  });
});
```

- [ ] **步骤 3：运行确认失败** — `cd extensions/multi-agent && & "../../tauri-agent/node_modules/.bin/vitest.CMD" run` → FAIL（fallback 仍是 `"pi"`）
- [ ] **步骤 4：实现** — `runner.ts` 改：

```ts
export function resolvePiCommand(): { cmd: string; baseArgs: string[] } {
  // PI_BIN 显式覆盖；否则复用当前 sidecar 可执行文件本体（bun --compile 下即自身）。
  const piBin = process.env.PI_BIN;
  if (piBin) return { cmd: piBin, baseArgs: [] };
  return { cmd: process.execPath, baseArgs: [] };
}
```

- [ ] **步骤 5：extractor.ts 同改 + 测试** `extractor.test.ts`（`resolvePiCommand()` → `process.env.PI_BIN ?? process.execPath`；测 `parseExtracted` 去编号/裁剪逻辑）
- [ ] **步骤 6：运行确认通过**
- [ ] **步骤 7：Commit** — `feat(multi-agent): resolve sub-agent binary to sidecar self via process.execPath (A3)`

---

## 任务 2：cli/main.ts 复用官方 CLI 入口（核心，方案 A1「跟官方对齐」）

**文件：** `cli/src/main.ts`

- [ ] **步骤 1：读现状并改写** — 将 `cli/src/main.ts` 从「自建 runtime + 仅 runRpcMode」改为复用官方 `main`：

```ts
import { main } from "@earendil-works/pi-coding-agent";
import { allExtensions } from "../../extensions/index.js";

main(process.argv.slice(2), { extensionFactories: allExtensions }).catch((error) => {
  console.error(error);
  process.exit(1);
});
```

> 删除原 `createRuntime` / `createAgentSessionServices` 等样板（官方 main 内部完成，并通过 `MainOptions.extensionFactories` 编入我们的 extension）。Tauri 仍传 `--mode rpc`，由官方 main 路由到 `runRpcMode`（已读 `dist/main.js` 验证）。

- [ ] **步骤 2：typecheck** — `cd cli && npm run typecheck`（tsc --noEmit）→ 0
- [ ] **步骤 3：重建并验证 RPC 未回归 + print 可用**（关键）—— 见任务 5 步骤 2/3。
- [ ] **步骤 4：Commit** — `feat(sidecar): reuse official pi CLI entry (all modes) for sub-agents (A3)`

---

## 任务 3：settingsSchema 加 PI_BIN 字段

**文件：** `tauri-agent/src/features/settings/settingsSchema.ts`（如有 `settingsSchema.test.ts` 一并更新）

- [ ] **步骤 1**：在 `id: 'web'`（「网页抓取 / 子代理」）分类的 `fields` 增加：

```ts
{ key: 'PI_BIN', label: '子代理可执行文件（留空＝复用本体）', type: 'text', placeholder: '默认：sidecar 自身' },
```

- [ ] **步骤 2**：若存在 settings 相关测试/快照，跑一次确保通过；否则跳过。
- [ ] **步骤 3：Commit** — `feat(settings): expose PI_BIN override for sub-agent binary (A3)`

---

## 任务 4（可选）：sidecar.rs 注入 PI_BIN（显式保险）

**文件：** `tauri-agent/src-tauri/src/pi/sidecar.rs`

> 前置判断：先做完任务 5 的端到端冒烟。若 `process.execPath` 兜底已让子代理跑通，本任务可**跳过**（YAGNI）。仅当需要显式可控 / dev 调试一致性时实现。

- [ ] **步骤 1**：在 `spawn_pi_client` 解析 sidecar 自身路径，spawn 前 `.env("PI_BIN", <path>)`（仅当调用方未在 `env` 里提供 `PI_BIN` 时）。开发期路径＝`pi_package_dir()` 旁的 `pi-<triple>.exe`；生产期＝主 exe 同目录。
- [ ] **步骤 2**：`cargo test` / `cargo check` 通过。
- [ ] **步骤 3：Commit** — `feat(sidecar): inject PI_BIN pointing at sidecar binary (A3)`

---

## 任务 5：重建 sidecar + 端到端冒烟验证

- [ ] **步骤 1：重建** — 先确认无 GrenAgent 进程占用 exe，`cd tauri-agent && node scripts/build-sidecar.mjs` → `GrenAgent sidecar ready`，无 `Could not resolve`。
- [ ] **步骤 2：验证 RPC 未回归** — 确认 sidecar 默认（`--mode rpc`）仍进 RPC 模式（启动 GrenAgent 冒烟，或对二进制发一条 RPC JSONL 看响应）。
- [ ] **步骤 3：验证 print 模式** — 直接运行编译产物：
  `& "src-tauri/binaries/pi-x86_64-pc-windows-msvc.exe" --mode json -p --no-session "say hi in one word"`
  预期：输出 JSONL 事件流并退出（exit 0），而非挂起等待 stdin。
- [ ] **步骤 4：验证子代理链路** — 在 GrenAgent 内触发 `spawn_agent`（或设 `MEMORY_EXTRACT=1`），确认子进程用 sidecar 自身、返回结果，`SpawnAgentCard` 正常渲染。
- [ ] **步骤 5：Commit（如有构建产物外的改动）** + 勾选本计划复选框。

---

## 自检

**规格覆盖度（对照 spec §4.6）：**
- 修 runner spawn 用 `PI_BIN` → 任务 1（已有 PI_BIN，补 `process.execPath` 兜底）✅
- sidecar.rs 注入 `PI_BIN` → 任务 4（降级为可选；`process.execPath` 兜底）✅/⚠️
- `settingsSchema` 加 `PI_BIN` → 任务 3 ✅
- 修 `long-term-memory/extractor.ts` spawn 路径 → 任务 1 ✅
- `SpawnAgentCard` + 右面板子代理列表 → SpawnAgentCard 已有 ✅；右面板进度 = ⚠️ MVP 未含（同步执行无中间进度，留作增强）
- **【spec 未覆盖但必须做】sidecar 支持 print 模式** → 任务 2（A1 复用官方 main）✅

**风险：**
- 任务 2 改 `cli/main.ts` 入口为官方 `main`：已读 `dist/main.js` 验证 `--mode rpc` 被支持，但仍须冒烟确认 Tauri 实际连接未回归（任务 5 步骤 2）。
- `--model` / `--no-session` 由官方 main 处理（A1 自动覆盖决策 4、6）。
- `process.execPath`：仅在 compiled sidecar 下＝自身；纯 node+tsx dev 调试需手设 `PI_BIN`（任务 1 注释说明）。
- OneDrive 路径含空格：spawn 时 `cmd` 作为单一 argv（非 shell 拼接），`node:child_process` 不经 shell，安全。
