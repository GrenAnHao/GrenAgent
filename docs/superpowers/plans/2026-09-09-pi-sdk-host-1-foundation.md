# Pi SDK 宿主 · 第 1 份：宿主骨架与事件降级层 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Electron 主进程内建立进程内嵌 Pi SDK 的交互宿主骨架，让交互主 Agent 不再依赖 sidecar 子进程，同时保证渲染层收到的事件形状、UI 请求线协议、`get_state` / `get_commands` 返回形状与今日 JSONL 逐字节一致。

**架构：** `extensions/_shared/workspace-context.ts` 建 `AsyncLocalStorage`（本份只建存储与 helper，消费点第 2 份接）；`cli/src/pi-sdk.ts` 作为 Electron 侧访问 SDK 的唯一桶文件（避免两套 SDK 声明副本的名义类型冲突）；`cli/src/json-event.ts` 自持 `toJsonEvent` 抄本；`cli/src/gren-runtime.ts` 抽出 `createGrenRuntime` 工厂并转发 `modelRuntime`；`electron/agent/` 下新建 `ModelRuntimeHost`（进程内一份）、`SessionUiAdapter`（28 项 `ExtensionUIContext`）、`WorkspaceHandle`（持一个 `AgentSessionRuntime`，所有构造/切换入口包进 `runInWorkspace`）、`AgentHost`（按 workspace 管理 handle + watch reload）。主进程启动期先设 `PI_RUNTIME_CONFIG` 再 `refreshConfig`（Q2-A）。最后把 `PiRuntimeService` 交互路径从 `PiClient.send(JSONL)` 切到 handle 具名方法，Goal 路径本份保持走 sidecar（第 3 份再切）。

**技术栈：** TypeScript、`@earendil-works/pi-coding-agent@0.85.1`、Electron 38.8.6、vitest（electron-agent projects: main/renderer；extensions）、`node --test` + tsx（cli）

**规格来源：** `docs/superpowers/specs/2026-09-09-electron-pi-sdk-host-design.md` 的「模块与文件」「IPC 与会话操作映射」「事件降级层」「广播接线」「SessionUiAdapter」「workspace 上下文传播 · ALS 存储与可行性」「验证 · 宿主骨架 / SessionUiAdapter」各节，以及 `2026-09-09-electron-pi-sdk-host-design-review.md` 第四节「第 1 份」全部修正项。

---

## 前置知识（工作者必读）

### 三个包，三套测试运行器

| 包 | 运行器 | 命令 |
| --- | --- | --- |
| `cli/` | `node --test` + tsx | `cd cli && node --import tsx --test "src/**/*.test.ts"` |
| `electron-agent/` | vitest（projects: main / renderer） | `cd electron-agent && npx vitest run --project main` |
| `extensions/` | vitest（package.json 无 scripts） | `cd extensions && npx vitest run` |

单文件跑法：
- cli：`cd cli && node --import tsx --test src/json-event.test.ts`
- electron-agent：`cd electron-agent && npx vitest run --project main electron/agent/xxx.test.ts`
- extensions：`cd extensions && npx vitest run _shared/workspace-context.test.ts`

### 今日事件链路（迁移后必须等价）

```
sidecar: session.subscribe(event) → toJsonEvent(event) → stdout JSONL
  → PiClient 解析 → PiRuntimeService：先 eventEnvelope → broadcastPiEvent('pi://event')，后 handlePiEvent 落盘
```

迁移后 sidecar 与 stdout 消失，`toJsonEvent` 降级层与「先广播后落盘」的顺序**都必须保留**。广播接线以 `electron/main.ts:167-208`（`PiManager.onEvent/onUiRequest/onExit`）为准：`eventEnvelope` 先算信封 → `broadcastPiEvent` → `void handlePiEvent(...)`（sqlite 同步写不得阻塞本帧 `webContents.send`）。**不要**把 subscribe 只接进 `handlePiEvent`——回合外事件（`session_info_changed` / `queue_update`）会到不了渲染层（review 六.4）。

### `AgentSessionRuntime` 的 rebind 不变量（易错点，已核实）

`runtime.session` 可替换。`switchSession` / `newSession` / `fork` / `importFromJsonl` 内部都会调 `finishSessionReplacement`，**它会自动调 `this.rebindSession(this.session)`**（`agent-session-runtime.js:120-127`）。因此宿主的正确做法是：**只用 `runtime.setRebindSession(async () => { await this.bindAndSubscribe(); })` 注册一次**，`switchSession` 等方法之后**绝不自行再 rebind**——否则同一 session 会被 `bindExtensions` 两次，而 `bindExtensions` 无幂等保护，每次都 `emit(session_start)` 并重跑 `resources_discover`（`agent-session.js:1906-1928`）。`bindExtensions` 是 **async**，回调必须 await 它。`subscribe` 是幂等的（先退旧订阅再订新）。

### 两套 SDK 声明副本 → Electron 侧只经 `cli/src/pi-sdk.ts`

`cli/node_modules/@earendil-works` 与 `extensions/node_modules/@earendil-works` 是两份 0.85.1 副本；`cli/tsconfig.json` 已 `include: ["src","../extensions"]`，两份声明今日就同处一个 program。`ModelRuntime` / `AgentSession` 是带 `private` 成员的类，跨副本传递会触发 TS「Types have separate declarations of a private property」名义不兼容。

**规则：`electron-agent/electron/**` 一律不 import `@earendil-works/*` 裸标识符，只从 `../../../cli/src/pi-sdk.js` 取 SDK 的值与类型。** `pi-sdk.ts` 在 cli/src 下，其 import 解析到 cli 副本；electron 与 cli 因此共用同一份声明。extensions 仍用自己的副本（今日即如此，边界处都是结构化的函数类型，不受影响）。cli 自身文件（`json-event.ts` / `gren-runtime.ts`）直接 import `@earendil-works/*` 即可（本就是 cli 副本）。

**本份不把 SDK 加入 `electron-agent/package.json`。** 运行期 vitest / electron-vite 从 `cli/src/pi-sdk.ts` 出发解析到 cli 副本；把三包加为 electron-agent 依赖 + vite `resolve.dedupe` 是**第 5 份打包**的工作，本份提前加会引入第三份副本、反而制造名义冲突。

### ALS 入口包裹要求（本份只建存储，消费点第 2 份）

审查已验证（SDK 源码 + node 探针，高置信）：工具执行、`pi.on` 钩子、`steer/followUp` 排队、自动压缩、重试都在 `prompt()` 的 promise 链内；**构造期读取**（`createRuntime` 内同步 await）同样可行——**只要 `createGrenRuntime` 与 `AgentSessionRuntime` 的 new/switch/fork/reload/prompt 全部在 `runInWorkspace()` 内调用**。`WorkspaceHandle` 必须把这些入口全部包进去。本份把 ALS store 建好并让 handle 正确包裹；`getConfig` / `currentCwd` / `resolveToolOrigin` 的**消费**是第 2 份。

### Q2-A：fs.watch 绑错陷阱

`runtime-config.ts` 的 `ensureStarted()` 在首次 `getConfig` 惰性建 `fs.watch`。若首次调用落在某 workspace 的 `run()` 内，此后所有 watch 回调**永久继承该 store**（探针实测）。因此主进程启动期必须在**任何 `run()` 之前**设好 `process.env.PI_RUNTIME_CONFIG` 并触发一次 watcher 创建。见任务 9。

---

## 文件结构

**新建：**

| 文件 | 职责 |
| --- | --- |
| `cli/src/pi-sdk.ts` | Electron 侧访问 SDK 的唯一入口（re-export 值与类型）。 |
| `cli/src/json-event.ts` | 自持 `toJsonEvent` 抄本，返回 `JsonAgentSessionEvent`。纯函数。 |
| `cli/src/json-event.test.ts` | 降级形状断言。 |
| `cli/src/gren-runtime.ts` | 抽出的 `createGrenRuntime` 工厂，转发 `modelRuntime`、接受 `allowedExtensionsJson`。 |
| `cli/src/gren-runtime.test.ts` | 转发与过滤入参断言（DI SDK）。 |
| `extensions/_shared/workspace-context.ts` | `AsyncLocalStorage` 存储 + `runInWorkspace`/`currentWorkspaceContext`/`currentCwd`/`resolveToolOrigin`。 |
| `extensions/_shared/workspace-context.test.ts` | run/nested/outside/`setTimeout` 穿透/origin/cwd 回退。 |
| `electron-agent/electron/agent/modelRuntimeHost.ts` | 进程内单份 `ModelRuntime`。 |
| `electron-agent/electron/agent/modelRuntimeHost.test.ts` | 单例、并发、失败重试、refresh 原地刷新。 |
| `electron-agent/electron/agent/sessionUiAdapter.ts` | 28 项 `ExtensionUIContext` → `pi://ui-request` 信封。 |
| `electron-agent/electron/agent/sessionUiAdapter.test.ts` | 28 项存在且自有可枚举；线协议字段；signal/timeout；goal 立即默认值。 |
| `electron-agent/electron/agent/workspaceHandle.ts` | 持 `AgentSessionRuntime`；`runInWorkspace` 包裹；subscribe→降级→onEvent；rebind；prompt/getState/getCommands/dispose。 |
| `electron-agent/electron/agent/workspaceHandle.test.ts` | rebind 语义、降级接入、origin、致命路径、O(n) 回放。 |
| `electron-agent/electron/agent/createWorkspaceHandle.ts` | 组装真 SDK 的工厂（仅 main.ts 用，类型检查覆盖，不单测）。 |
| `electron-agent/electron/agent/agentHost.ts` | `Map<workspace, WorkspaceHandle>` + watch `PI_RELOAD_REV` / `onResourceReloadRequested`。 |
| `electron-agent/electron/agent/agentHost.test.ts` | 每 workspace 一个、并发、关项目清理、reload 广播。 |
| `electron-agent/electron/agent/runtimeConfigBootstrap.ts` | Q2-A：设 env + 建文件 + `restartRuntimeConfig`。 |
| `electron-agent/electron/agent/runtimeConfigBootstrap.test.ts` | watcher 在 ALS 外创建；bootstrap 前调过 getConfig 也能重建 watcher。 |

**修改：**

| 文件 | 改动 |
| --- | --- |
| `electron-agent/tsconfig.node.json` | 修成真类型检查：`rootDir: ".."`、include `../extensions`/`../cli/src`/`src/lib/usageReport.ts`。 |
| `cli/src/runtime.ts` | 删本地 `createRuntime`，改 import `createGrenRuntime`，rpc 路径显式传 `allowedExtensionsJson`。 |
| `extensions/_shared/runtime-config.ts` | 新增 `restartRuntimeConfig()`（保留 subscribers 重建 watcher）。 |
| `electron-agent/electron/app/piRuntimeService.ts` | 交互路径改走 handle 具名方法（`SessionOps` 过渡接缝）；Goal 保持 client；新增 `turnConfig`。 |
| `electron-agent/electron/app/piRuntimeService.test.ts` | 交互断言迁移到 handle stub；新增 preflight/SESSION_BUSY/set_mode/rewind 用例。 |
| `electron-agent/electron/main.ts` | 启动期 Q2-A；建 `ModelRuntimeHost`/`AgentHost`/`createHandle`；PRS 注入 host；`activeModel`/`refresh` 改走 handle/host；`before-quit` 加 `agentHost.closeAll()`。 |

**本份不动：** `electron/pi/eventAdapter.ts`（保留）、`electron/pi/{client,jsonl,manager,systemWorkerManager}.ts`（第 5 份删，本份 Goal 仍用 `manager`）、渲染层任何文件、`extensions/` 除 workspace-context/runtime-config 外任何文件。

---

## 任务 1：修复类型检查门槛 + `pi-sdk.ts` 桶文件

今日 electron-agent 从未有过有效类型检查：`build` 脚本里的 `tsc -p tsconfig.json` 是 solution-style 空转（`files:[]`+references，`-p` 不构建引用，4.7s 退出 0，**零检查**）；直接 `tsc -p tsconfig.node.json` 因 `composite:true` 下跨包 import 报 TS6307（`agentData/extensionIntegration.test.ts → extensions/memory/client` 今日就报）。先把它修成真门槛，后续任务才有验收依据。

**文件：**
- 修改：`electron-agent/tsconfig.node.json`
- 创建：`cli/src/pi-sdk.ts`

- [ ] **步骤 1：修 `tsconfig.node.json`**

改为（`rootDir` 上提到仓库根以容纳跨包源码；include 补 `../extensions`、`../cli/src` 与被 `electron/app/usageService.ts` import 的 `src/lib/usageReport.ts`）：

```json
{
  "compilerOptions": {
    "composite": true,
    "rootDir": "..",
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "types": ["node", "vitest/globals"]
  },
  "include": [
    "electron.vite.config.ts",
    "vite.config.ts",
    "electron/**/*.ts",
    "src/lib/usageReport.ts",
    "../extensions/**/*.ts",
    "../cli/src/**/*.ts"
  ],
  "exclude": ["node_modules", "../extensions/node_modules", "../cli/node_modules"]
}
```

- [ ] **步骤 2：记录基线错误数**

运行：`cd electron-agent && npx tsc -p tsconfig.node.json --noEmit 2>&1 | grep -c "error TS"`
预期：约 40 条既有错误（全部在 `electron/` 与 `../cli/src/*.test.ts`；`../extensions/**` 为 0；`electron/agent/**` 尚不存在）。把这个数记为 **BASELINE**，写进本份 PR 描述。修既有 40 条错误**不在本份范围**（记入第 5 份收尾清单）。

本份此后每个任务的类型检查门槛统一为：

```bash
cd electron-agent && npx tsc -p tsconfig.node.json --noEmit 2>&1 \
  | grep -E "electron/agent/|cli/src/(json-event|gren-runtime|pi-sdk)\.ts|extensions/_shared/workspace-context\.ts|electron/app/piRuntimeService\.ts|electron/main\.ts"
```

预期：**空输出**（本份触及的文件零错误）。总数不得超过 BASELINE。

- [ ] **步骤 3：创建 `cli/src/pi-sdk.ts`**

```ts
/**
 * Electron 主进程访问 Pi SDK 的唯一入口。
 *
 * cli/ 与 extensions/ 各带一份 @earendil-works 声明副本；ModelRuntime / AgentSession
 * 是带 private 成员的类，跨副本传递会触发 TS 名义类型不兼容。electron/ 一律从本文件
 * 取值与类型，使其解析到 cli 副本，与 cli 代码共用同一份声明。
 *
 * ⚠️ 对应上游版本：pi-coding-agent@0.85.1
 */
export {
  ModelRuntime,
  SessionManager,
  createAgentSessionRuntime,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

export type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  ExtensionUIContext,
  JsonAgentSessionEvent,
  PromptOptions,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
```

- [ ] **步骤 4：类型检查**

运行步骤 2 的门槛命令，预期空输出（`pi-sdk.ts` 无错误行）。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/tsconfig.node.json cli/src/pi-sdk.ts
git commit -m "build(electron): enable real typecheck; add pi-sdk barrel for single SDK copy"
```

---

## 任务 2：事件降级层 `json-event.ts`

规格《事件降级层》。渲染层「零改动」的前提。抄写而非 import：`toJsonEvent` 未从包根导出（`exports` 只暴露 `.` / `./rpc-entry` / `./client` / `./experimental/plugin`，深路径 import 得 `ERR_PACKAGE_PATH_NOT_EXPORTED`，node 探针实测）；但类型 `JsonAgentSessionEvent` **已**从包根导出（`index.d.ts:27`），用它约束返回类型。抄本须与 `dist/modes/json-event.js`（已核对）逐行等价：`message_update` 删 `message` 留 `usage`、`message.role !== "assistant"` 抛错；**所有**带 `partial` 的 `assistantMessageEvent` 都删 `partial`（不止 `toolcall_start`）；`toolcall_start` 另补 `id`/`toolName` 且内容非 toolCall 时抛错。

**文件：**
- 创建：`cli/src/json-event.ts`、`cli/src/json-event.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `cli/src/json-event.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { toJsonEvent } from "./json-event.js";

test("message_update 剥掉 message 快照，保留 usage", () => {
  const usage = { input: 10, output: 20 };
  const event = {
    type: "message_update",
    message: { role: "assistant", id: "m1", content: [{ type: "text", text: "累积全文" }], usage },
    assistantMessageEvent: { type: "text_delta", delta: "文" },
  };
  const result = toJsonEvent(event as never) as Record<string, unknown>;
  assert.equal(result.type, "message_update");
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(result.assistantMessageEvent, { type: "text_delta", delta: "文" });
  assert.ok(!("message" in result), "message 字段必须被剥掉");
});

test("toolcall_start 剥掉 partial，补 id 与 toolName", () => {
  const event = {
    type: "message_update",
    message: { role: "assistant", usage: { input: 1, output: 2 } },
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 0,
      partial: { content: [{ type: "toolCall", id: "call_1", name: "read_file" }] },
    },
  };
  const inner = (toJsonEvent(event as never) as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>;
  assert.equal(inner.id, "call_1");
  assert.equal(inner.toolName, "read_file");
  assert.equal(inner.contentIndex, 0);
  assert.ok(!("partial" in inner), "partial 必须被剥掉");
});

test("非 toolcall_start 的带 partial 事件也剥掉 partial", () => {
  const event = {
    type: "message_update",
    message: { role: "assistant", usage: {} },
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: { content: [] } },
  };
  const inner = (toJsonEvent(event as never) as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>;
  assert.equal(inner.type, "text_start");
  assert.ok(!("partial" in inner), "任何带 partial 的事件都要剥掉");
});

test("非 message_update 事件原样返回", () => {
  const event = { type: "agent_end", messages: [], willRetry: false };
  assert.equal(toJsonEvent(event as never), event);
});

test("toolcall_start 指向非 toolCall 内容时抛错", () => {
  const event = {
    type: "message_update",
    message: { role: "assistant", usage: {} },
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "text", text: "x" }] } },
  };
  assert.throws(() => toJsonEvent(event as never), /is not a tool call/);
});

test("message_update 的 message 非 assistant 时抛错", () => {
  const event = { type: "message_update", message: { role: "user" }, assistantMessageEvent: { type: "text_delta", delta: "x" } };
  assert.throws(() => toJsonEvent(event as never), /not an assistant message/);
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd cli && node --import tsx --test src/json-event.test.ts`
预期：FAIL，`Cannot find module './json-event.js'`

- [ ] **步骤 3：编写实现**

创建 `cli/src/json-event.ts`：

```ts
import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * 与 @earendil-works/pi-coding-agent 的 dist/modes/json-event.js 等价的降级实现。
 *
 * 上游未从包根导出 toJsonEvent（深路径 import 触发 ERR_PACKAGE_PATH_NOT_EXPORTED），
 * 故自持一份。作用：剥掉流式事件里的累积快照——否则 message_update 每 token 带一份完整
 * AgentMessage，单条消息 O(n²) IPC 克隆；且渲染层 agentReducer 的「快照优先、delta 兜底」
 * 分支会翻到从未被真实数据验证过的那条路。
 *
 * ⚠️ 对应上游版本：pi-coding-agent@0.85.1。升级 pi-coding-agent 必查 dist/modes/json-event.js。
 */
type UnknownRecord = Record<string, unknown>;

function toJsonAssistantMessageEvent(event: UnknownRecord): UnknownRecord {
  if (event.type === "toolcall_start") {
    const partial = event.partial as UnknownRecord | undefined;
    const content = partial?.content as UnknownRecord[] | undefined;
    const toolCall = content?.[event.contentIndex as number];
    if (toolCall?.type !== "toolCall") {
      throw new Error(`toolcall_start content at index ${String(event.contentIndex)} is not a tool call`);
    }
    const { partial: _partial, ...deltaEvent } = event;
    return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
  }
  if (!("partial" in event)) return event;
  const { partial: _partial, ...deltaEvent } = event;
  return deltaEvent;
}

export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
  const raw = event as unknown as UnknownRecord;
  if (raw.type !== "message_update") return event as unknown as JsonAgentSessionEvent;
  const message = raw.message as UnknownRecord | undefined;
  if (message?.role !== "assistant") {
    throw new Error("message_update message is not an assistant message");
  }
  return {
    type: "message_update",
    usage: message.usage,
    assistantMessageEvent: toJsonAssistantMessageEvent(raw.assistantMessageEvent as UnknownRecord),
  } as unknown as JsonAgentSessionEvent;
}
```

- [ ] **步骤 4：运行验证通过**

运行：`cd cli && node --import tsx --test src/json-event.test.ts`
预期：PASS，6 个测试全绿

- [ ] **步骤 5：Commit**

```bash
git add cli/src/json-event.ts cli/src/json-event.test.ts
git commit -m "feat(cli): add self-hosted toJsonEvent equivalent for in-process host"
```

---

## 任务 3：`workspace-context.ts`（ALS 存储）

规格《workspace 上下文传播 · ALS 存储与可行性》。本份只建存储与 helper，**不接任何消费点**（`getConfig` / `process.cwd()` 改造是第 2 份）。放 `extensions/_shared/` 因为 worker 与主进程都要 import。

**文件：**
- 创建：`extensions/_shared/workspace-context.ts`、`extensions/_shared/workspace-context.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/_shared/workspace-context.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { currentCwd, currentWorkspaceContext, resolveToolOrigin, runInWorkspace, type WorkspaceContext } from './workspace-context.js';

const ctx = (over: Partial<WorkspaceContext> = {}): WorkspaceContext => ({
  origin: 'main', workspace: 'D:/proj', cwd: 'D:/proj', config: {}, ...over,
});

describe('workspace-context', () => {
  it('run 内可读到 store，run 外为 undefined', () => {
    expect(currentWorkspaceContext()).toBeUndefined();
    runInWorkspace(ctx(), () => {
      expect(currentWorkspaceContext()?.workspace).toBe('D:/proj');
    });
    expect(currentWorkspaceContext()).toBeUndefined();
  });

  it('嵌套 run 内层覆盖外层', () => {
    runInWorkspace(ctx({ workspace: 'A', cwd: 'A' }), () => {
      runInWorkspace(ctx({ workspace: 'B', cwd: 'B' }), () => {
        expect(currentWorkspaceContext()?.workspace).toBe('B');
      });
      expect(currentWorkspaceContext()?.workspace).toBe('A');
    });
  });

  it('store 穿透 await 链与 setTimeout（方案前提）', async () => {
    await runInWorkspace(ctx({ workspace: 'X' }), async () => {
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 1));
      expect(currentWorkspaceContext()?.workspace).toBe('X');
    });
  });

  it('currentCwd 在 run 外回退 process.cwd()', () => {
    expect(currentCwd()).toBe(process.cwd());
    runInWorkspace(ctx({ cwd: 'D:/other' }), () => {
      expect(currentCwd()).toBe('D:/other');
    });
  });

  it('resolveToolOrigin：ALS origin 优先', () => {
    runInWorkspace(ctx({ origin: 'goal' }), () => {
      expect(resolveToolOrigin()).toBe('goal');
    });
  });

  it('resolveToolOrigin：无 ALS 且 PI_IS_SUBAGENT=1 → subagent，否则 main', () => {
    const prev = process.env.PI_IS_SUBAGENT;
    delete process.env.PI_IS_SUBAGENT;
    expect(resolveToolOrigin()).toBe('main');
    process.env.PI_IS_SUBAGENT = '1';
    expect(resolveToolOrigin()).toBe('subagent');
    if (prev === undefined) delete process.env.PI_IS_SUBAGENT; else process.env.PI_IS_SUBAGENT = prev;
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd extensions && npx vitest run _shared/workspace-context.test.ts`
预期：FAIL，无法解析 `./workspace-context.js`

- [ ] **步骤 3：编写实现**

创建 `extensions/_shared/workspace-context.ts`：

```ts
import { AsyncLocalStorage } from "node:async_hooks";

export type ToolOrigin = "main" | "goal" | "subagent";

/** 进程内嵌宿主的每回合上下文。origin 只有 main / goal；subagent 只出现在 fork 子进程（无 ALS，由 env 判定）。 */
export interface WorkspaceContext {
  origin: "main" | "goal";
  workspace: string;
  cwd: string;
  config: Readonly<Record<string, string>>;
}

const storage = new AsyncLocalStorage<WorkspaceContext>();

export function runInWorkspace<T>(ctx: WorkspaceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentWorkspaceContext(): WorkspaceContext | undefined {
  return storage.getStore();
}

/** 无 ALS 时回退 process.cwd()：fork 子进程与未包裹的 CLI 路径按进程 cwd 即正确。 */
export function currentCwd(): string {
  return storage.getStore()?.cwd ?? process.cwd();
}

export function resolveToolOrigin(): ToolOrigin {
  const ctx = storage.getStore();
  if (ctx) return ctx.origin;
  return process.env.PI_IS_SUBAGENT === "1" ? "subagent" : "main";
}
```

- [ ] **步骤 4：运行验证通过**

运行：`cd extensions && npx vitest run _shared/workspace-context.test.ts`
预期：PASS，6 个测试全绿。**步骤 3 的 `setTimeout` 穿透测试是整个方案的止损点**——若它失败（AsyncLocalStorage 不穿透定时器），停下，方案前提不成立，回到规格重新评估。

- [ ] **步骤 5：Commit**

```bash
git add extensions/_shared/workspace-context.ts extensions/_shared/workspace-context.test.ts
git commit -m "feat(shared): add AsyncLocalStorage workspace context store"
```

---

## 任务 4：抽出 `createGrenRuntime`

从 `cli/src/runtime.ts` 抽出 `createRuntime`，让主进程宿主与 worker 共用同一份扩展过滤逻辑。**两处修正（review 四.第1份 任务3）**：(a) 不带入 `runtime.ts:22-28` 的 `process.on('uncaughtException'/'unhandledRejection')`（EPIPE 静默吞错，主进程不能有）——它们留在 `runtime.ts`，不进 `gren-runtime.ts`；(b) 工厂接受并**转发 `modelRuntime`**（否则 `createAgentSessionServices` 每次 `ModelRuntime.create`，每次 new/switch/fork 重建，`agent-session-services.js:56-61`）；(c) `PI_ALLOWED_EXTENSIONS` 本就全局（`allowedPluginIds()` 无 workspace 参），改为显式入参 `allowedExtensionsJson`。

**文件：**
- 创建：`cli/src/gren-runtime.ts`、`cli/src/gren-runtime.test.ts`
- 修改：`cli/src/runtime.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `cli/src/gren-runtime.test.ts`（DI 掉真 SDK，只验转发与过滤入参）：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGrenRuntimeFactory } from "./gren-runtime.js";

function fakeDeps(captured: Record<string, unknown>) {
  return {
    createAgentSessionServices: async (opts: Record<string, unknown>) => {
      captured.servicesOptions = opts;
      return { diagnostics: [], modelRuntime: opts.modelRuntime };
    },
    createAgentSessionFromServices: async () => ({ session: {} }),
    manifestExtensions: [
      { name: "safety", factory: () => ({}) },
      { name: "code-exec", manifest: { id: "code-exec" }, factory: () => ({}) },
    ] as never[],
    getConfig: (key: string) => (key === "EXTENSIONS_PROFILE" ? "project" : undefined),
  };
}

test("转发注入的 modelRuntime 到 services", async () => {
  const captured: Record<string, unknown> = {};
  const modelRuntime = { marker: "shared" };
  const factory = makeGrenRuntimeFactory({ modelRuntime: modelRuntime as never, deps: fakeDeps(captured) as never });
  await factory({ cwd: "D:/p", agentDir: "D:/a", sessionManager: {} as never });
  assert.equal((captured.servicesOptions as Record<string, unknown>).modelRuntime, modelRuntime);
});

test("allowedExtensionsJson 参与 filterManagedExtensions（只留 core + 白名单 id）", async () => {
  const captured: Record<string, unknown> = {};
  const factory = makeGrenRuntimeFactory({
    allowedExtensionsJson: JSON.stringify(["code-exec"]),
    deps: fakeDeps(captured) as never,
  });
  await factory({ cwd: "D:/p", agentDir: "D:/a", sessionManager: {} as never });
  const opts = captured.servicesOptions as { resourceLoaderOptions: { extensionFactories: unknown[] } };
  // safety 恒在（CORE_ALWAYS_ON），code-exec 因白名单命中，共 2 个 factory
  assert.equal(opts.resourceLoaderOptions.extensionFactories.length, 2);
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd cli && node --import tsx --test src/gren-runtime.test.ts`
预期：FAIL，`Cannot find module './gren-runtime.js'`

- [ ] **步骤 3：编写实现**

创建 `cli/src/gren-runtime.ts`（可注入 deps 供测试；生产走真 SDK）：

```ts
import {
  type CreateAgentSessionRuntimeFactory,
  type ModelRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { manifestExtensions } from "../../extensions/index.js";
import { getConfig } from "../../extensions/_shared/runtime-config.js";
import { filterExtensionsByProfile, filterManagedExtensions, type ExtensionProfile } from "./extension-profile.js";

function bareSkillName(name: string): string {
  return name.startsWith("skill:") ? name.slice(6) : name;
}

/** Native Skill toggle. Read on every reload so the UI does not need a restart. */
function disabledSkills(getConfigFn: (key: string) => string | undefined): Set<string> {
  return new Set(
    (getConfigFn("SKILLS_DISABLED") ?? "")
      .split(",")
      .map((name) => bareSkillName(name.trim()))
      .filter(Boolean),
  );
}

export interface GrenRuntimeDeps {
  createAgentSessionServices: typeof createAgentSessionServices;
  createAgentSessionFromServices: typeof createAgentSessionFromServices;
  manifestExtensions: typeof manifestExtensions;
  getConfig: (key: string) => string | undefined;
}

const realDeps: GrenRuntimeDeps = {
  createAgentSessionServices,
  createAgentSessionFromServices,
  manifestExtensions,
  getConfig,
};

export interface GrenRuntimeOptions {
  /** 进程内共享的 ModelRuntime。省略则由 createAgentSessionServices 自建（worker 场景）。 */
  modelRuntime?: ModelRuntime;
  /** PI_ALLOWED_EXTENSIONS 的 JSON 字符串（全局白名单）。省略走 getConfig 回退。 */
  allowedExtensionsJson?: string;
  /** 仅测试注入。 */
  deps?: GrenRuntimeDeps;
}

/**
 * Electron 主进程宿主与 pi-worker 子进程共用的 runtime 工厂。
 * 从 cli/src/runtime.ts 抽出；不带入 runtime.ts 的 process.on 静默吞错钩子。
 */
export function makeGrenRuntimeFactory(options: GrenRuntimeOptions = {}): CreateAgentSessionRuntimeFactory {
  const deps = options.deps ?? realDeps;
  const getConfigFn = deps.getConfig;
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const allowedJson = options.allowedExtensionsJson ?? getConfigFn("PI_ALLOWED_EXTENSIONS");
    const services = await deps.createAgentSessionServices({
      cwd,
      agentDir,
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      resourceLoaderOptions: {
        extensionFactories: getConfigFn("PI_SYSTEM_WORKER") === "1"
          ? []
          : filterManagedExtensions(
              filterExtensionsByProfile(
                deps.manifestExtensions,
                (getConfigFn("EXTENSIONS_PROFILE") as ExtensionProfile) ?? "project",
              ),
              allowedJson,
            ).map((x) => x.factory),
        noContextFiles: getConfigFn("PI_DISABLE_PROJECT_CONTEXT") === "1",
        skillsOverride: (base) => {
          const disabled = disabledSkills(getConfigFn);
          if (disabled.size === 0) return base;
          return {
            skills: base.skills.filter((skill) => !disabled.has(bareSkillName(skill.name))),
            diagnostics: base.diagnostics,
          };
        },
      },
    });
    return {
      ...(await deps.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };
}
```

> `PI_SYSTEM_WORKER === '1'` 分支本份保留：system worker sidecar 第 3 份才删。第 3 份改造后此分支移除。

- [ ] **步骤 4：改 `runtime.ts` 复用**

在 `cli/src/runtime.ts`：删除本地 `bareSkillName`、`disabledSkills`、`createRuntime`（第 35-77 行）。**保留** `process.stdout/stderr.on("error")` 与两个 `process.on`（第 22-28 行，sidecar 专用）。import 区去掉只被抽走代码用的符号（`createAgentSessionFromServices`、`createAgentSessionServices`、`CreateAgentSessionRuntimeFactory`、`manifestExtensions`、`filterExtensionsByProfile`、`filterManagedExtensions`、`ExtensionProfile`），新增：

```ts
import { makeGrenRuntimeFactory } from "./gren-runtime.js";
```

rpc 路径把 `createAgentSessionRuntime(createRuntime, {` 改为显式传全局白名单：

```ts
const runtime = await createAgentSessionRuntime(
  makeGrenRuntimeFactory({ allowedExtensionsJson: getConfig("PI_ALLOWED_EXTENSIONS") }),
  { cwd, agentDir: getAgentDir(), sessionManager: SessionManager.create(cwd) },
);
```

`allExtensions` / `safety` 仍被 `emitReadyBanner()` 与 `main()`（第 153 行）使用，**不要删**。

- [ ] **步骤 5：类型检查 + cli 全量测试**

```bash
cd cli && npx tsc --noEmit && node --import tsx --test "src/**/*.test.ts"
```
预期：无类型错误；测试与改动前一致（`runtime.test.ts` 若断言旧 `createRuntime` 名，按新 `makeGrenRuntimeFactory` 调整——只改因抽取而失效的断言，不改行为断言）。

- [ ] **步骤 6：Commit**

```bash
git add cli/src/gren-runtime.ts cli/src/gren-runtime.test.ts cli/src/runtime.ts
git commit -m "refactor(cli): extract makeGrenRuntimeFactory forwarding modelRuntime"
```

---

## 任务 5：`ModelRuntimeHost`

进程内单份 `ModelRuntime`。本份只做单例与 `refresh`（`completeSimple` / `resolveDefaultModel` 是第 3 份）。**修正（review 四.第3份）**：`refresh()` 必须**原地** `runtime.refresh()`（`model-runtime.d.ts:96` 存在），不能丢弃实例——各 workspace 的 `AgentSession` 持有的是同一个 `services.modelRuntime` 引用，丢弃会让在飞 session 指向孤儿实例。

**文件：**
- 创建：`electron-agent/electron/agent/modelRuntimeHost.ts`、`electron-agent/electron/agent/modelRuntimeHost.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/agent/modelRuntimeHost.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { ModelRuntimeHost } from './modelRuntimeHost.js';

const stubRuntime = () => ({ getAvailableSnapshot: () => [], refresh: vi.fn(async () => ({})) });

describe('ModelRuntimeHost', () => {
  it('ensure() 只创建一次', async () => {
    const create = vi.fn().mockResolvedValue(stubRuntime());
    const host = new ModelRuntimeHost({ create });
    const a = await host.ensure();
    const b = await host.ensure();
    expect(create).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('并发 ensure() 不重复创建', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    const create = vi.fn().mockReturnValue(new Promise((r) => { resolveCreate = r; }));
    const host = new ModelRuntimeHost({ create });
    const pending = Promise.all([host.ensure(), host.ensure(), host.ensure()]);
    resolveCreate(stubRuntime());
    const [a, b, c] = await pending;
    expect(create).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('创建失败后下次 ensure() 重试', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('auth failed')).mockResolvedValue(stubRuntime());
    const host = new ModelRuntimeHost({ create });
    await expect(host.ensure()).rejects.toThrow('auth failed');
    await expect(host.ensure()).resolves.toBeDefined();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('refresh() 原地刷新，不丢弃实例', async () => {
    const runtime = stubRuntime();
    const create = vi.fn().mockResolvedValue(runtime);
    const host = new ModelRuntimeHost({ create });
    const a = await host.ensure();
    await host.refresh();
    const b = await host.ensure();
    expect(create).toHaveBeenCalledTimes(1);       // 未重建
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('refresh() 未 ensure 时先 ensure 再刷新', async () => {
    const runtime = stubRuntime();
    const create = vi.fn().mockResolvedValue(runtime);
    const host = new ModelRuntimeHost({ create });
    await host.refresh();
    expect(create).toHaveBeenCalledTimes(1);
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/agent/modelRuntimeHost.test.ts`
预期：FAIL，无法解析 `./modelRuntimeHost.js`

- [ ] **步骤 3：编写实现**

创建 `electron-agent/electron/agent/modelRuntimeHost.ts`：

```ts
import type { ModelRuntime } from '../../../cli/src/pi-sdk.js';

export interface ModelRuntimeHostOptions {
  /** 注入点仅为可测性；生产传 () => ModelRuntime.create({ authPath, modelsPath })。 */
  create: () => Promise<ModelRuntime>;
}

/**
 * 进程内唯一的 ModelRuntime。今日每个 sidecar 各持一份；进程内嵌后鉴权与模型表只需一份，
 * 由各 WorkspaceHandle 共用（第 3 份再加 completeSimple / resolveDefaultModel）。
 */
export class ModelRuntimeHost {
  private runtime: ModelRuntime | undefined;
  private pending: Promise<ModelRuntime> | undefined;

  constructor(private readonly options: ModelRuntimeHostOptions) {}

  async ensure(): Promise<ModelRuntime> {
    if (this.runtime) return this.runtime;
    if (!this.pending) {
      this.pending = this.options.create()
        .then((runtime) => { this.runtime = runtime; return runtime; })
        .finally(() => { this.pending = undefined; }); // 失败清空以便重试
    }
    return this.pending;
  }

  /** provider 配置 / models.json 变更后调用：原地重读，不丢弃实例（在飞 session 持有同一引用）。 */
  async refresh(): Promise<void> {
    const runtime = await this.ensure();
    await runtime.refresh();
  }

  peek(): ModelRuntime | undefined {
    return this.runtime;
  }
}
```

- [ ] **步骤 4：运行验证通过 + 类型检查**

```bash
cd electron-agent && npx vitest run --project main electron/agent/modelRuntimeHost.test.ts
```
预期：PASS，5 个测试全绿。再跑任务 1 步骤 2 的门槛命令，空输出。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agent/modelRuntimeHost.ts electron-agent/electron/agent/modelRuntimeHost.test.ts
git commit -m "feat(electron): add ModelRuntimeHost single-instance model runtime"
```

---

## 任务 6：`SessionUiAdapter`

实现 `ExtensionUIContext` **28 项全部**（review 四.第1份 任务4 + 附录 B），转成现有 `pi://ui-request` 信封。**硬约束（全部已核实）**：

- `hasUI` / `mode` **不在** `ExtensionUIContext`（在 `ExtensionContext`），本适配器不含它们。
- 成员必须是**自有可枚举属性**（runner 以 `{...ui}` 展开，`runner.js:273-282`）——用对象字面量 + 箭头函数，不用类原型方法。
- 签名以 `types.d.ts:68-192` 为准：`select(title, options, opts?)`、`confirm(title, message, opts?)`、`input(title, placeholder?, opts?)` 收第三参 `{signal?, timeout?}`；`editor(title, prefill?)` **无 opts**；`notify(message, type?)` 的 type 是 `"info"|"warning"|"error"`。
- 线协议字段名冻结（`rpc-mode.js:84-193`，消费点 `lib/pi.ts:62-72`、`ExtensionUiHost.tsx`、`PromptRequestCard.tsx`）：`{type:"extension_ui_request", id, method, ...}`——`select: title/options/timeout`、`confirm: title/message/timeout`、`input: title/placeholder/timeout`、`editor: title/prefill`、`notify: message/notifyType`、`setStatus: statusKey/statusText`、`setWidget: widgetKey/widgetLines/widgetPlacement`、`setTitle: title`、`set_editor_text: text`。
- 回包解析同 rpc：`cancelled` → 默认值（confirm=false，其余 undefined）；`select/input/editor` 取 `value`，`confirm` 取 `confirmed`。
- `signal` 语义同 `createDialogPromise`（`rpc-mode.js:47-79`）：已 aborted 立即默认值、不广播；abort 事件 → 默认值；`timeout` → 默认值。
- `custom()` **必须 async 返回 undefined**（runner 对返回值 `.finally`，同步返回会 TypeError）。
- **Goal 回合**：`isGoalTurn()` 为真时对话请求**不广播**，直接 resolve 默认值；通知类（notify/setStatus/…）直接丢弃——对齐今日 `main.ts:184-188` 对 goal 源一律 `rejectUiRequest`。
- `theme` 给 stub（本仓库扩展未读 `ui.theme`，grep 空）；13 项 no-op（`setWorking*`×3、`setHiddenThinkingLabel`、`setFooter`、`setHeader`、`onTerminalInput`、`addAutocompleteProvider`、`setEditorComponent`、`getEditorComponent`、`getAllThemes`/`getTheme`/`setTheme`、`getToolsExpanded`/`setToolsExpanded`）。

**文件：**
- 创建：`electron-agent/electron/agent/sessionUiAdapter.ts`、`electron-agent/electron/agent/sessionUiAdapter.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/agent/sessionUiAdapter.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { SessionUiAdapter } from './sessionUiAdapter.js';

function makeAdapter(over: { isGoalTurn?: () => boolean } = {}) {
  const emit = vi.fn();
  const adapter = new SessionUiAdapter({
    workspace: 'D:/proj',
    sessionId: () => 's1',
    isGoalTurn: over.isGoalTurn ?? (() => false),
    emit,
  });
  return { adapter, emit };
}

const EXPECTED_KEYS = [
  'select','confirm','input','notify','onTerminalInput','setStatus','setWorkingMessage','setWorkingVisible',
  'setWorkingIndicator','setHiddenThinkingLabel','setWidget','setFooter','setHeader','setTitle','custom',
  'pasteToEditor','setEditorText','getEditorText','editor','addAutocompleteProvider','setEditorComponent',
  'getEditorComponent','theme','getAllThemes','getTheme','setTheme','getToolsExpanded','setToolsExpanded',
];

describe('SessionUiAdapter', () => {
  it('28 项全部为自有可枚举属性，无 hasUI/mode', () => {
    const { adapter } = makeAdapter();
    const own = Object.keys(adapter.context);
    for (const key of EXPECTED_KEYS) expect(own, key).toContain(key);
    expect(own).toHaveLength(28);
    expect(own).not.toContain('hasUI');
    expect(own).not.toContain('mode');
  });

  it('select 广播线协议字段并在 respond value 后 resolve', async () => {
    const { adapter, emit } = makeAdapter();
    const pending = adapter.context.select('选一个', ['a', 'b']);
    const env = emit.mock.calls[0][0];
    expect(env.workspace).toBe('D:/proj');
    expect(env.sessionId).toBe('s1');
    expect(env.source).toBe('interactive');
    expect(env.request).toMatchObject({ type: 'extension_ui_request', method: 'select', title: '选一个', options: ['a', 'b'] });
    expect(typeof env.request.id).toBe('string');
    adapter.respond(env.request.id, { value: 'b' });
    await expect(pending).resolves.toBe('b');
  });

  it('confirm 用 confirmed；input 带 placeholder；editor 带 prefill 无 timeout', async () => {
    const { adapter, emit } = makeAdapter();
    const c = adapter.context.confirm('标题', '消息', { timeout: 5000 });
    expect(emit.mock.calls[0][0].request).toMatchObject({ method: 'confirm', title: '标题', message: '消息', timeout: 5000 });
    adapter.respond(emit.mock.calls[0][0].request.id, { confirmed: true });
    await expect(c).resolves.toBe(true);

    emit.mockClear();
    void adapter.context.input('标题', '占位');
    expect(emit.mock.calls[0][0].request).toMatchObject({ method: 'input', title: '标题', placeholder: '占位' });

    emit.mockClear();
    void adapter.context.editor('标题', '预填');
    expect(emit.mock.calls[0][0].request).toMatchObject({ method: 'editor', title: '标题', prefill: '预填' });
    expect(emit.mock.calls[0][0].request).not.toHaveProperty('timeout');
  });

  it('cancelled 回默认值：select→undefined，confirm→false', async () => {
    const { adapter, emit } = makeAdapter();
    const s = adapter.context.select('一', ['x']);
    adapter.respond(emit.mock.calls[0][0].request.id, { cancelled: true });
    await expect(s).resolves.toBeUndefined();
    emit.mockClear();
    const c = adapter.context.confirm('二', '');
    adapter.respond(emit.mock.calls[0][0].request.id, { cancelled: true });
    await expect(c).resolves.toBe(false);
  });

  it('已 aborted 的 signal 立即默认值且不广播', async () => {
    const { adapter, emit } = makeAdapter();
    await expect(adapter.context.select('一', ['x'], { signal: AbortSignal.abort() })).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it('signal abort 事件 → 默认值', async () => {
    const { adapter } = makeAdapter();
    const ctrl = new AbortController();
    const p = adapter.context.input('一', undefined, { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).resolves.toBeUndefined();
  });

  it('timeout → 默认值', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter();
    const p = adapter.context.select('一', ['a'], { timeout: 1000 });
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('cancelAll 把挂起请求标为默认值', async () => {
    const { adapter } = makeAdapter();
    const a = adapter.context.select('一', ['x']);
    const b = adapter.context.confirm('二', '');
    adapter.cancelAll();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBe(false);
  });

  it('重复 respond 同一 id 不抛错', () => {
    const { adapter, emit } = makeAdapter();
    void adapter.context.confirm('一', '');
    const id = emit.mock.calls[0][0].request.id;
    adapter.respond(id, { confirmed: true });
    expect(() => adapter.respond(id, { confirmed: false })).not.toThrow();
  });

  it('custom() 返回 Promise<undefined>', async () => {
    const { adapter } = makeAdapter();
    const r = adapter.context.custom(() => ({}) as never);
    expect(r).toBeInstanceOf(Promise);
    await expect(r).resolves.toBeUndefined();
  });

  it('notify/setStatus/setTitle/setEditorText 走通知信封（无挂起请求）', () => {
    const { adapter, emit } = makeAdapter();
    adapter.context.notify('提示', 'warning');
    expect(emit.mock.calls[0][0].request).toMatchObject({ method: 'notify', message: '提示', notifyType: 'warning' });
    adapter.context.setStatus('k', 't');
    expect(emit.mock.calls[1][0].request).toMatchObject({ method: 'setStatus', statusKey: 'k', statusText: 't' });
    adapter.context.setTitle('标题');
    expect(emit.mock.calls[2][0].request).toMatchObject({ method: 'setTitle', title: '标题' });
    adapter.context.setEditorText('文本');
    expect(emit.mock.calls[3][0].request).toMatchObject({ method: 'set_editor_text', text: '文本' });
  });

  it('setWidget 数组走线协议，factory 被忽略', () => {
    const { adapter, emit } = makeAdapter();
    adapter.context.setWidget('k', ['l1', 'l2'], { placement: 'belowEditor' });
    expect(emit.mock.calls[0][0].request).toMatchObject({ method: 'setWidget', widgetKey: 'k', widgetLines: ['l1', 'l2'], widgetPlacement: 'belowEditor' });
    emit.mockClear();
    adapter.context.setWidget('k', (() => ({})) as never);
    expect(emit).not.toHaveBeenCalled();
  });

  it('getEditorText 返回空串；no-op 方法不抛', () => {
    const { adapter } = makeAdapter();
    expect(adapter.context.getEditorText()).toBe('');
    expect(adapter.context.getToolsExpanded()).toBe(false);
    expect(adapter.context.getEditorComponent()).toBeUndefined();
    expect(adapter.context.getAllThemes()).toEqual([]);
    expect(() => adapter.context.setWorkingMessage('x')).not.toThrow();
    expect(adapter.context.onTerminalInput(() => undefined)()).toBeUndefined();
  });

  it('Goal 回合：对话不广播、立即默认值；通知丢弃', async () => {
    const { adapter, emit } = makeAdapter({ isGoalTurn: () => true });
    await expect(adapter.context.confirm('一', '')).resolves.toBe(false);
    adapter.context.notify('x');
    expect(emit).not.toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/agent/sessionUiAdapter.test.ts`
预期：FAIL，无法解析 `./sessionUiAdapter.js`

- [ ] **步骤 3：编写实现**

创建 `electron-agent/electron/agent/sessionUiAdapter.ts`：

```ts
import { randomUUID } from 'node:crypto';
import type { ExtensionUIContext } from '../../../cli/src/pi-sdk.js';

export type UiSource = 'interactive' | 'goal';

export interface UiEnvelope {
  workspace: string;
  source: UiSource;
  sessionId?: string;
  request: Record<string, unknown>;
}

export interface UiResponse {
  value?: unknown;
  confirmed?: boolean;
  cancelled?: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  cancelValue: unknown;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface DialogOpts { signal?: AbortSignal; timeout?: number }

export interface SessionUiAdapterOptions {
  workspace: string;
  sessionId: () => string | undefined;
  /** 当前回合是否为 Goal：为真则对话立即默认值、通知丢弃，都不广播（对齐今日 rejectUiRequest）。 */
  isGoalTurn: () => boolean;
  emit: (envelope: UiEnvelope) => void;
}

/**
 * 把 pi 扩展的 UI 调用转成 pi://ui-request 信封。回包字段（value/confirmed/cancelled）
 * 与线协议 method 字段名对渲染层冻结，不得更改。成员均为自有可枚举属性（runner {...ui} 展开）。
 */
export class SessionUiAdapter {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: SessionUiAdapterOptions) {}

  readonly context: ExtensionUIContext = {
    select: (title: string, options: string[], opts?: DialogOpts) =>
      this.dialog('select', { title, options, timeout: opts?.timeout }, undefined, opts) as Promise<string | undefined>,
    confirm: (title: string, message: string, opts?: DialogOpts) =>
      this.dialog('confirm', { title, message, timeout: opts?.timeout }, false, opts) as Promise<boolean>,
    input: (title: string, placeholder?: string, opts?: DialogOpts) =>
      this.dialog('input', { title, placeholder, timeout: opts?.timeout }, undefined, opts) as Promise<string | undefined>,
    editor: (title: string, prefill?: string) =>
      this.dialog('editor', { title, prefill }, undefined, undefined) as Promise<string | undefined>,

    notify: (message: string, type?: 'info' | 'warning' | 'error') =>
      this.fireAndForget({ method: 'notify', message, notifyType: type }),
    setStatus: (key: string, text: string | undefined) =>
      this.fireAndForget({ method: 'setStatus', statusKey: key, statusText: text }),
    setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
      if (content === undefined || Array.isArray(content)) {
        this.fireAndForget({ method: 'setWidget', widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
      }
    },
    setTitle: (title: string) => this.fireAndForget({ method: 'setTitle', title }),
    setEditorText: (text: string) => this.fireAndForget({ method: 'set_editor_text', text }),
    pasteToEditor: (text: string) => this.fireAndForget({ method: 'set_editor_text', text }),

    // TUI 专用，rpc 模式空实现。必须存在且不抛，否则加载 TUI 分支的扩展会崩主进程。
    custom: async () => undefined,
    onTerminalInput: () => () => {},
    getEditorText: () => '',
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: new Proxy({}, { get() { throw new Error('theme is unavailable in the Electron host'); } }) as ExtensionUIContext['theme'],
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Theme switching not supported in the Electron host' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  } as ExtensionUIContext;

  respond(id: string, response: UiResponse): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.settle(id, entry, response.cancelled ? entry.cancelValue : (response.confirmed ?? response.value));
  }

  cancelAll(): void {
    for (const [id, entry] of [...this.pending]) this.settle(id, entry, entry.cancelValue);
  }

  private dialog(method: string, fields: Record<string, unknown>, cancelValue: unknown, opts?: DialogOpts): Promise<unknown> {
    // Goal 回合：不广播，立即默认值（对齐 main.ts:184-188 对 goal 源一律 rejectUiRequest）。
    if (this.options.isGoalTurn()) return Promise.resolve(cancelValue);
    if (opts?.signal?.aborted) return Promise.resolve(cancelValue);
    const id = randomUUID();
    return new Promise((resolve) => {
      const entry: Pending = { resolve, cancelValue };
      if (opts?.signal) {
        entry.signal = opts.signal;
        entry.onAbort = () => this.settle(id, entry, cancelValue);
        opts.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      if (typeof opts?.timeout === 'number' && opts.timeout > 0) {
        entry.timer = setTimeout(() => this.settle(id, entry, cancelValue), opts.timeout);
      }
      this.pending.set(id, entry);
      this.options.emit({
        workspace: this.options.workspace,
        source: 'interactive',
        ...(this.options.sessionId() ? { sessionId: this.options.sessionId()! } : {}),
        request: { type: 'extension_ui_request', id, method, ...fields },
      });
    });
  }

  private fireAndForget(fields: Record<string, unknown>): void {
    if (this.options.isGoalTurn()) return;
    this.options.emit({
      workspace: this.options.workspace,
      source: 'interactive',
      ...(this.options.sessionId() ? { sessionId: this.options.sessionId()! } : {}),
      request: { type: 'extension_ui_request', id: randomUUID(), ...fields },
    });
  }

  private settle(id: string, entry: Pending, value: unknown): void {
    if (!this.pending.delete(id)) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.resolve(value);
  }
}
```

> `theme` 用抛错 Proxy 而非空对象：本仓库扩展不读它（grep 空），若未来有扩展误读，抛错比静默返回 `undefined` 易定位。`{...ui}` 展开只复制 Proxy 引用、不触发 `get`，不会误抛。

- [ ] **步骤 4：运行验证通过 + 类型检查**

运行测试（预期 14 个全绿）与门槛命令（空输出）。若 `ExtensionUIContext` 签名导致类型错，以 `types.d.ts:68-192` 为准调方法签名，断言不变。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agent/sessionUiAdapter.ts electron-agent/electron/agent/sessionUiAdapter.test.ts
git commit -m "feat(electron): add SessionUiAdapter with all 28 ExtensionUIContext members"
```

---

## 任务 7：`WorkspaceHandle`

持一个 `AgentSessionRuntime`，负责 `runInWorkspace` 包裹、subscribe→降级→onEvent、rebind、prompt。本份最易错。

**关键设计（全部已核实）：**
- 只 `runtime.setRebindSession(async () => { await this.bindAndSubscribe(); })` 注册一次；`switchSession/newSession/fork/reload` **不自行 rebind**（`finishSessionReplacement` 会自动调）。`bindAndSubscribe()` 内 `await bindExtensions(全量 bindings)` + 重 subscribe。
- 所有会切换 session 的入口（new/switch/fork/reload）用 `runInWorkspace({origin:'main', ...})` 包裹——即使触发方来自其他 origin 的回调，构造期也必须落在 main store（扩展工厂在构造期读 config）。
- `bindExtensions` 全量：`{ uiContext, mode:"rpc", commandContextActions:{waitForIdle,newSession,fork,navigateTree,switchSession,reload}, shutdownHandler, onError }`——缺 `commandContextActions` 则扩展的 `ctx.newSession/fork/...` 变空操作；缺 `onError` 则 `extension_error` 消失。
- subscribe 回调经 `toJsonEvent` 降级；畸形事件（抛错）丢单条不断流；`onEvent(event, {sessionId, source})`，source 由 `currentTurnOrigin` 决定。
- `onError` 回调把 `{type:"extension_error", extensionPath, event, error}` 送进同一条 `onEvent`（`agentReducer.ts:465` 依赖）。
- `prompt`：preflight 成功即 resolve；`preflightResult(false)` 后 SDK throw → `.catch` reject；**preflight 成功后的回合内错误由 `.catch` 静默吞掉**（`agent-session.js:948-949` 确认 preflight(true) 后才 await `_runAgentPrompt`；rpc-mode 同样吞），走事件流。
- **致命路径**：`new/switch/fork/reload` 的 runtime 构造失败使 handle 损坏（旧 session 已 dispose）→ `onFatal(error)` 后 rethrow；`onFatal` 由 `AgentHost` 接（evict + 广播 `pi://exit`）。prompt 的 preflight 后 reject **不是**致命（照常吞）。

**文件：**
- 创建：`electron-agent/electron/agent/workspaceHandle.ts`、`electron-agent/electron/agent/workspaceHandle.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/agent/workspaceHandle.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { currentWorkspaceContext } from '../../../extensions/_shared/workspace-context.js';
import { WorkspaceHandle } from './workspaceHandle.js';

function makeSession(id: string) {
  const subs: Array<(e: unknown) => void> = [];
  return {
    id,
    sessionId: id,
    subscribe: vi.fn((cb: (e: unknown) => void) => { subs.push(cb); return () => { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); }; }),
    bindExtensions: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emit: (e: unknown) => subs.forEach((cb) => cb(e)),
    subCount: () => subs.length,
  };
}

function makeRuntime() {
  const first = makeSession('s1');
  const second = makeSession('s2');
  let rebindCb: ((s: unknown) => Promise<void>) | undefined;
  const runtime = {
    session: first as unknown,
    setRebindSession: vi.fn((cb: (s: unknown) => Promise<void>) => { rebindCb = cb; }),
    // 真 finishSessionReplacement 在 apply 新 session 后调 rebindSession——mock 如实模拟
    switchSession: vi.fn(async () => { runtime.session = second; await rebindCb?.(second); return { cancelled: false }; }),
    newSession: vi.fn(async () => { runtime.session = second; await rebindCb?.(second); return { cancelled: false }; }),
    fork: vi.fn(async () => { runtime.session = second; await rebindCb?.(second); return { cancelled: false, selectedText: 'x' }; }),
    dispose: vi.fn(async () => {}),
  };
  return { runtime, first, second };
}

function makeHandle(runtime: unknown, over: Record<string, unknown> = {}) {
  const onEvent = vi.fn();
  const onFatal = vi.fn();
  const emit = vi.fn();
  const handle = new WorkspaceHandle({
    workspace: 'D:/proj',
    runtime: runtime as never,
    resolveConfig: async () => ({}),
    emitUiRequest: emit,
    onEvent,
    onFatal,
    ...over,
  });
  return { handle, onEvent, onFatal, emit };
}

describe('WorkspaceHandle', () => {
  it('start：注册 setRebindSession，bindExtensions 全量 + subscribe', async () => {
    const { runtime, first } = makeRuntime();
    const { handle } = makeHandle(runtime);
    await handle.start();
    expect(runtime.setRebindSession).toHaveBeenCalledTimes(1);
    expect(first.bindExtensions).toHaveBeenCalledTimes(1);
    const bindings = first.bindExtensions.mock.calls[0][0];
    expect(bindings.mode).toBe('rpc');
    expect(bindings.uiContext).toBeDefined();
    expect(typeof bindings.onError).toBe('function');
    expect(typeof bindings.commandContextActions.newSession).toBe('function');
    expect(first.subCount()).toBe(1);
  });

  it('构造/切换在 runInWorkspace(main) 内', async () => {
    const { runtime } = makeRuntime();
    const seen: Array<string | undefined> = [];
    const { handle } = makeHandle(runtime, {
      resolveConfig: async () => ({}),
    });
    (runtime as { switchSession: ReturnType<typeof vi.fn> }).switchSession = vi.fn(async () => {
      seen.push(currentWorkspaceContext()?.origin);
      return { cancelled: false };
    });
    await handle.start();
    await handle.switchSession('/x/other.jsonl');
    expect(seen).toEqual(['main']);
  });

  it('message_update 经降级层剥掉 message', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    first.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '全文' }], usage: { input: 1 } }, assistantMessageEvent: { type: 'text_delta', delta: '文' } });
    const [event, meta] = onEvent.mock.calls[0];
    expect(event).not.toHaveProperty('message');
    expect(event.usage).toEqual({ input: 1 });
    expect(meta).toMatchObject({ sessionId: 's1', source: 'interactive' });
  });

  it('非 message_update 原样转发', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    const e = { type: 'queue_update', steering: [], followUp: [] };
    first.emit(e);
    expect(onEvent.mock.calls[0][0]).toEqual(e);
  });

  it('switchSession 后重绑一次（不双 bind）、旧 session 事件不再转发', async () => {
    const { runtime, first, second } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    await handle.switchSession('/x/other.jsonl');
    expect(second.bindExtensions).toHaveBeenCalledTimes(1); // rebind 只经 setRebindSession 触发
    expect(first.subCount()).toBe(0);
    expect(second.subCount()).toBe(1);
    onEvent.mockClear();
    first.emit({ type: 'agent_end', willRetry: false });
    expect(onEvent).not.toHaveBeenCalled();
    second.emit({ type: 'agent_end', willRetry: false });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('prompt：preflight(true) 即 resolve，设 origin=main', async () => {
    const { runtime, first } = makeRuntime();
    first.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (b: boolean) => void }) => { opts.preflightResult?.(true); return new Promise<void>(() => {}); });
    const { handle } = makeHandle(runtime);
    await handle.start();
    await handle.prompt('你好', {}, 'main');
    expect(first.prompt).toHaveBeenCalledTimes(1);
    expect(first.prompt.mock.calls[0][1]).toMatchObject({ source: 'rpc' });
    expect(handle.currentTurnOrigin).toBe('main');
  });

  it('prompt：preflight(false)+throw → reject', async () => {
    const { runtime, first } = makeRuntime();
    first.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (b: boolean) => void }) => { opts.preflightResult?.(false); throw new Error('preflight denied'); });
    const { handle } = makeHandle(runtime);
    await handle.start();
    await expect(handle.prompt('x', {}, 'main')).rejects.toThrow('preflight denied');
  });

  it('prompt：preflight 成功后回合内错误被吞（不 reject 不致命）', async () => {
    const { runtime, first, onFatal } = { ...makeRuntime(), onFatal: undefined } as never;
    const rt = makeRuntime();
    const first2 = rt.first;
    first2.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (b: boolean) => void }) => { opts.preflightResult?.(true); throw new Error('turn crashed'); });
    const h = makeHandle(rt.runtime);
    await h.handle.start();
    await expect(h.handle.prompt('x', {}, 'main')).resolves.toBeUndefined();
    expect(h.onFatal).not.toHaveBeenCalled();
  });

  it('agent_end(!willRetry) 后 origin 归位到 main', async () => {
    const { runtime, first } = makeRuntime();
    first.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (b: boolean) => void }) => { opts.preflightResult?.(true); return new Promise<void>(() => {}); });
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    await handle.prompt('x', {}, 'goal');
    expect(handle.currentTurnOrigin).toBe('goal');
    first.emit({ type: 'agent_end', willRetry: false });
    expect(handle.currentTurnOrigin).toBe('main');
    expect(onEvent.mock.calls.at(-1)?.[1].source).toBe('goal'); // 该 agent_end 仍标 goal
  });

  it('onError 产出 extension_error 事件', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    const bindings = first.bindExtensions.mock.calls[0][0];
    bindings.onError({ extensionPath: '/ext', event: 'tool', error: 'boom' });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension_error', extensionPath: '/ext', error: 'boom' }), expect.anything());
  });

  it('switchSession 构造失败 → onFatal 并 rethrow', async () => {
    const { runtime } = makeRuntime();
    (runtime as { switchSession: ReturnType<typeof vi.fn> }).switchSession = vi.fn(async () => { throw new Error('create failed'); });
    const { handle, onFatal } = makeHandle(runtime);
    await handle.start();
    await expect(handle.switchSession('/x/o.jsonl')).rejects.toThrow('create failed');
    expect(onFatal).toHaveBeenCalledWith(expect.any(Error));
  });

  it('session 替换前取消挂起 UI', async () => {
    const { runtime } = makeRuntime();
    const emit = vi.fn();
    const { handle } = makeHandle(runtime, { emitUiRequest: emit });
    await handle.start();
    const pending = handle.ui.context.confirm('一', '');
    await handle.newSession();
    await expect(pending).resolves.toBe(false);
  });

  it('dispose：abort、取消 UI、停止转发', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    await handle.dispose();
    expect(first.abort).toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalled();
    expect(first.subCount()).toBe(0);
    onEvent.mockClear();
    first.emit({ type: 'agent_end', willRetry: false });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('reload：先 waitForIdle 再 reload，在 runInWorkspace 内', async () => {
    const { runtime, first } = makeRuntime();
    const { handle } = makeHandle(runtime);
    await handle.start();
    await handle.reload();
    expect(first.waitForIdle).toHaveBeenCalled();
    expect(first.reload).toHaveBeenCalled();
    expect(first.waitForIdle.mock.invocationCallOrder[0]).toBeLessThan(first.reload.mock.invocationCallOrder[0]);
  });

  it('降级层抛错不断流', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    first.emit({ type: 'message_update', message: { role: 'user' }, assistantMessageEvent: {} });
    first.emit({ type: 'agent_end', willRetry: false });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].type).toBe('agent_end');
  });

  it('长消息流式回放总字节 O(n)', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    const n = 500;
    let acc = '';
    for (let i = 0; i < n; i++) {
      acc += '词';
      first.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: acc }], usage: { output: i } }, assistantMessageEvent: { type: 'text_delta', delta: '词' } });
    }
    const total = onEvent.mock.calls.reduce((s, [e]) => s + JSON.stringify(e).length, 0);
    expect(onEvent).toHaveBeenCalledTimes(n);
    expect(total).toBeLessThan(n * 200);
    expect(total).toBeLessThan((n * (n + 1)) / 2);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/agent/workspaceHandle.test.ts`
预期：FAIL，无法解析 `./workspaceHandle.js`

- [ ] **步骤 3：编写实现**

创建 `electron-agent/electron/agent/workspaceHandle.ts`：

```ts
import { runInWorkspace, type WorkspaceContext } from '../../../extensions/_shared/workspace-context.js';
import { toJsonEvent } from '../../../cli/src/json-event.js';
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime, PromptOptions } from '../../../cli/src/pi-sdk.js';
import { SessionUiAdapter } from './sessionUiAdapter.js';

type TurnOrigin = 'main' | 'goal';
export type ImageContent = NonNullable<PromptOptions['images']>[number];

export interface HandleEventMeta { sessionId?: string; source: 'interactive' | 'goal' }

export interface WorkspaceHandleOptions {
  workspace: string;
  runtime: AgentSessionRuntime;
  /** 解析该 origin 的 per-(workspace, source) 配置进 ALS（第 2 份消费）。 */
  resolveConfig: (origin: TurnOrigin) => Promise<Readonly<Record<string, string>>>;
  emitUiRequest: (envelope: { workspace: string; source: 'interactive' | 'goal'; sessionId?: string; request: Record<string, unknown> }) => void;
  onEvent: (event: Record<string, unknown>, meta: HandleEventMeta) => void;
  /** 构造失败使 handle 损坏时调用（AgentHost 负责 evict + 广播 pi://exit）。 */
  onFatal: (error: unknown) => void;
}

/**
 * 一个项目的交互 runtime。
 * runtime.session 可替换：new/switch/fork/reload 内部经 finishSessionReplacement 自动调
 * setRebindSession 注册的回调，宿主绝不自行二次 rebind（bindExtensions 无幂等保护）。
 * new/switch/fork/reload/prompt 全部包进 runInWorkspace，ALS 才能穿透构造期与回合。
 */
export class WorkspaceHandle {
  readonly ui: SessionUiAdapter;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  private turnOrigin: TurnOrigin = 'main';

  constructor(private readonly options: WorkspaceHandleOptions) {
    this.ui = new SessionUiAdapter({
      workspace: options.workspace,
      sessionId: () => this.session.sessionId,
      isGoalTurn: () => this.turnOrigin === 'goal',
      emit: options.emitUiRequest,
    });
  }

  get session(): AgentSession {
    return this.options.runtime.session;
  }

  get currentTurnOrigin(): TurnOrigin {
    return this.turnOrigin;
  }

  async start(): Promise<void> {
    // finishSessionReplacement 会 await 这个回调；直接 bindAndSubscribe，不要再包一层同步 rebind。
    this.options.runtime.setRebindSession(async () => { await this.bindAndSubscribe(); });
    await this.runMain(async () => { await this.bindAndSubscribe(); });
  }

  async prompt(text: string, options: { images?: ImageContent[]; streamingBehavior?: 'steer' | 'followUp' }, origin: TurnOrigin): Promise<void> {
    const config = await this.options.resolveConfig(origin);
    this.turnOrigin = origin;
    return runInWorkspace(this.ctx(origin, config), () => new Promise<void>((resolve, reject) => {
      let settled = false;
      void this.session.prompt(text, {
        images: options.images,
        streamingBehavior: options.streamingBehavior,
        source: 'rpc',
        preflightResult: (ok: boolean) => { if (ok) { settled = true; resolve(); } },
      } as PromptOptions).catch((error: unknown) => {
        // preflight 前失败 → reject；preflight 成功后的回合内错误由事件流上报，吞掉。
        if (!settled) reject(error);
      });
    }));
  }

  async newSession(): Promise<{ cancelled: boolean }> {
    return this.replace(() => this.options.runtime.newSession());
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return this.replace(() => this.options.runtime.switchSession(sessionPath));
  }

  async fork(entryId: string, options?: { position?: 'before' | 'at' }): Promise<{ cancelled: boolean; selectedText?: string }> {
    return this.replace(() => this.options.runtime.fork(entryId, options));
  }

  async reload(): Promise<void> {
    await this.runMain(async () => {
      await this.session.waitForIdle();
      await this.session.reload();
    });
  }

  getState(): Record<string, unknown> {
    const s = this.session;
    return {
      model: s.model,
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
      isCompacting: s.isCompacting,
      steeringMode: s.steeringMode,
      followUpMode: s.followUpMode,
      sessionFile: s.sessionFile,
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      autoCompactionEnabled: s.autoCompactionEnabled,
      messageCount: s.messages.length,
      pendingMessageCount: s.pendingMessageCount,
    };
  }

  getCommands(): { commands: Array<Record<string, unknown>> } {
    const commands: Array<Record<string, unknown>> = [];
    for (const c of this.session.extensionRunner.getRegisteredCommands()) {
      commands.push({ name: c.invocationName, description: c.description, source: 'extension', sourceInfo: c.sourceInfo });
    }
    for (const t of this.session.promptTemplates) {
      commands.push({ name: t.name, description: t.description, source: 'prompt', sourceInfo: t.sourceInfo });
    }
    for (const skill of this.session.resourceLoader.getSkills().skills) {
      commands.push({ name: `skill:${skill.name}`, description: skill.description, source: 'skill', sourceInfo: skill.sourceInfo });
    }
    return { commands };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.ui.cancelAll();
    try { await this.session.abort(); } catch { /* 清理阶段 abort 失败不阻断 */ }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try { await this.options.runtime.dispose(); } catch { /* 同上 */ }
  }

  private async replace<T>(action: () => Promise<T>): Promise<T> {
    this.ui.cancelAll();
    try {
      return await this.runMain(action);
    } catch (error) {
      // 构造失败：旧 session 已 teardown，runtime 处于损坏态。上报致命，交 AgentHost evict。
      this.options.onFatal(error);
      throw error;
    }
  }

  private runMain<T>(fn: () => Promise<T>): Promise<T> {
    return this.resolveMainCtx().then((ctx) => runInWorkspace(ctx, fn));
  }

  private async resolveMainCtx(): Promise<WorkspaceContext> {
    return this.ctx('main', await this.options.resolveConfig('main'));
  }

  private ctx(origin: TurnOrigin, config: Readonly<Record<string, string>>): WorkspaceContext {
    return { origin, workspace: this.options.workspace, cwd: this.options.workspace, config };
  }

  private async bindAndSubscribe(): Promise<void> {
    const runtime = this.options.runtime;
    await this.session.bindExtensions({
      uiContext: this.ui.context,
      mode: 'rpc',
      commandContextActions: {
        waitForIdle: () => this.session.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        fork: async (entryId, forkOptions) => ({ cancelled: (await runtime.fork(entryId, forkOptions)).cancelled }),
        navigateTree: (targetId, options) => this.session.navigateTree(targetId, options),
        switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
        reload: async () => { await this.session.reload(); },
      },
      shutdownHandler: () => {},
      onError: (err) => {
        this.forward({ type: 'extension_error', extensionPath: err.extensionPath, event: err.event, error: err.error });
      },
    });
    this.unsubscribe?.();
    this.unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
      if (this.disposed) return;
      let downgraded: Record<string, unknown>;
      try {
        downgraded = toJsonEvent(event) as unknown as Record<string, unknown>;
      } catch {
        return; // 畸形事件丢单条，不断流
      }
      this.forward(downgraded);
      if (downgraded.type === 'agent_end' && downgraded.willRetry !== true) this.turnOrigin = 'main';
    });
  }

  private forward(event: Record<string, unknown>): void {
    this.options.onEvent(event, {
      ...(this.session.sessionId ? { sessionId: this.session.sessionId } : {}),
      source: this.turnOrigin === 'goal' ? 'goal' : 'interactive',
    });
  }
}
```

> `setRebindSession` 注册的回调会被 `finishSessionReplacement` 在 `runMain` 的 ALS 内 `await`（`runtime.switchSession()` 本身在 `runInWorkspace` 内调用），故 `bindAndSubscribe` 的构造期读取落在 main store，且 bind 完成后才继续。测试里 mock 的 `rebindCb` 同样被 await，语义一致。

- [ ] **步骤 4：运行验证通过**

运行：`cd electron-agent && npx vitest run --project main electron/agent/workspaceHandle.test.ts`
预期：PASS。**这是本份第二个止损点**：若 `runInWorkspace` 包裹后 `switchSession` 内读不到 `origin:'main'`（第 2 个测试失败），说明 ALS 不穿透 SDK 构造链，停下，退化为「handle 入参显式透传 config」需重评估。

- [ ] **步骤 5：跨包 import 可解析 + 类型检查**

运行门槛命令，预期空输出（`workspaceHandle.ts` import 的 `../../../cli/src/*.js`、`../../../extensions/_shared/*.js` 均在任务 1 的 include 内）。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agent/workspaceHandle.ts electron-agent/electron/agent/workspaceHandle.test.ts
git commit -m "feat(electron): add WorkspaceHandle with ALS wrapping, rebind and downgrade"
```

---

## 任务 8：`AgentHost` + `createWorkspaceHandle`

`AgentHost` 按 workspace 管理 handle，并 watch `PI_RELOAD_REV` / `onResourceReloadRequested` → 各 handle `reload()`（规格《模块与文件》《广播接线》）。`createWorkspaceHandle` 是组装真 SDK 的工厂（仅 main.ts 用，类型检查覆盖，不单测——纯 glue）。

**文件：**
- 创建：`electron-agent/electron/agent/agentHost.ts`、`electron-agent/electron/agent/agentHost.test.ts`、`electron-agent/electron/agent/createWorkspaceHandle.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/agent/agentHost.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { AgentHost } from './agentHost.js';

const stub = () => ({ dispose: vi.fn(async () => {}), reload: vi.fn(async () => {}) });

function makeHost(createHandle = vi.fn(async () => stub()), over: Record<string, unknown> = {}) {
  const host = new AgentHost({
    createHandle: createHandle as never,
    watchConfig: (() => () => {}) as never,
    onResourceReloadRequested: (() => () => {}) as never,
    ...over,
  });
  return { host, createHandle };
}

describe('AgentHost', () => {
  it('同一 workspace 复用 handle', async () => {
    const { host, createHandle } = makeHost();
    const a = await host.open('D:/p', 'D:/p');
    const b = await host.open('D:/p', 'D:/p');
    expect(createHandle).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('不同 workspace 各一个', async () => {
    const { host, createHandle } = makeHost();
    await host.open('D:/a', 'D:/a');
    await host.open('D:/b', 'D:/b');
    expect(createHandle).toHaveBeenCalledTimes(2);
  });

  it('并发 open 同一 workspace 只创建一次', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    const createHandle = vi.fn(() => new Promise((r) => { resolveCreate = r; }));
    const { host } = makeHost(createHandle as never);
    const pending = Promise.all([host.open('D:/p', 'D:/p'), host.open('D:/p', 'D:/p')]);
    resolveCreate(stub());
    await pending;
    expect(createHandle).toHaveBeenCalledTimes(1);
  });

  it('createHandle 失败不缓存半成品', async () => {
    const createHandle = vi.fn().mockRejectedValue(new Error('boom'));
    const { host } = makeHost(createHandle as never);
    await expect(host.open('D:/p', 'D:/p')).rejects.toThrow('boom');
    expect(host.get('D:/p')).toBeUndefined();
    await expect(host.open('D:/p', 'D:/p')).rejects.toThrow('boom');
    expect(createHandle).toHaveBeenCalledTimes(2);
  });

  it('close dispose 并移除；close 未开的 workspace 不抛', async () => {
    const handle = stub();
    const { host } = makeHost(vi.fn(async () => handle) as never);
    await host.open('D:/p', 'D:/p');
    await host.close('D:/p');
    expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(host.get('D:/p')).toBeUndefined();
    await expect(host.close('D:/never')).resolves.toBeUndefined();
  });

  it('closeAll 释放全部', async () => {
    const handles = [stub(), stub()];
    let i = 0;
    const { host } = makeHost(vi.fn(async () => handles[i++]) as never);
    await host.open('D:/a', 'D:/a');
    await host.open('D:/b', 'D:/b');
    await host.closeAll();
    expect(handles[0].dispose).toHaveBeenCalled();
    expect(handles[1].dispose).toHaveBeenCalled();
  });

  it('PI_RELOAD_REV 变化 → 各 handle reload（去重 rev）', async () => {
    let watchCb: ((next: Record<string, string>) => void) | undefined;
    const handle = stub();
    const { host } = makeHost(vi.fn(async () => handle) as never, {
      watchConfig: ((cb: (n: Record<string, string>) => void) => { watchCb = cb; return () => {}; }) as never,
    });
    await host.open('D:/p', 'D:/p');
    watchCb?.({ PI_RELOAD_REV: '1' });
    watchCb?.({ PI_RELOAD_REV: '1' }); // 同 rev 不重复
    await vi.waitFor(() => expect(handle.reload).toHaveBeenCalledTimes(1));
    watchCb?.({ PI_RELOAD_REV: '2' });
    await vi.waitFor(() => expect(handle.reload).toHaveBeenCalledTimes(2));
  });

  it('onResourceReloadRequested → 全部 handle reload', async () => {
    let reloadCb: (() => void) | undefined;
    const handle = stub();
    const { host } = makeHost(vi.fn(async () => handle) as never, {
      onResourceReloadRequested: ((cb: () => void) => { reloadCb = cb; return () => {}; }) as never,
    });
    await host.open('D:/p', 'D:/p');
    reloadCb?.();
    await vi.waitFor(() => expect(handle.reload).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/agent/agentHost.test.ts`
预期：FAIL，无法解析 `./agentHost.js`

- [ ] **步骤 3：编写实现**

创建 `electron-agent/electron/agent/agentHost.ts`：

```ts
import { watchConfig as realWatchConfig } from '../../../extensions/_shared/runtime-config.js';
import { onResourceReloadRequested as realOnResourceReload } from '../../../extensions/_shared/resource-reload.js';
import type { WorkspaceHandle } from './workspaceHandle.js';

interface Reloadable { dispose(): Promise<void>; reload(): Promise<void> }

export interface AgentHostOptions {
  createHandle: (workspace: string, cwd: string) => Promise<WorkspaceHandle>;
  watchConfig?: typeof realWatchConfig;
  onResourceReloadRequested?: typeof realOnResourceReload;
}

/**
 * 交互主 Agent 的 workspace 注册表。没有全局单例主 Agent；cwd/.pi/权限/session 目录按 workspace 隔离。
 * 同项目多份 jsonl 共用一个 handle，切换走 handle.switchSession。
 */
export class AgentHost {
  private readonly handles = new Map<string, WorkspaceHandle>();
  private readonly opening = new Map<string, Promise<WorkspaceHandle>>();
  private lastReloadRev = '';
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unwatch: Array<() => void> = [];

  constructor(private readonly options: AgentHostOptions) {
    const watch = options.watchConfig ?? realWatchConfig;
    const onReload = options.onResourceReloadRequested ?? realOnResourceReload;
    this.unwatch.push(watch((next) => {
      const rev = next.PI_RELOAD_REV ?? '';
      if (rev === this.lastReloadRev) return;
      this.lastReloadRev = rev;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => void this.reloadAll(), 150);
    }));
    this.unwatch.push(onReload(() => void this.reloadAll()));
  }

  get(workspace: string): WorkspaceHandle | undefined {
    return this.handles.get(workspace);
  }

  async open(workspace: string, cwd: string): Promise<WorkspaceHandle> {
    const existing = this.handles.get(workspace);
    if (existing) return existing;
    const inFlight = this.opening.get(workspace);
    if (inFlight) return inFlight;
    const pending = (async () => {
      const handle = await this.options.createHandle(workspace, cwd);
      this.handles.set(workspace, handle);
      return handle;
    })().finally(() => { this.opening.delete(workspace); });
    this.opening.set(workspace, pending);
    return pending;
  }

  async close(workspace: string): Promise<void> {
    const handle = this.handles.get(workspace);
    if (!handle) return;
    this.handles.delete(workspace);
    await handle.dispose();
  }

  async closeAll(): Promise<void> {
    for (const off of this.unwatch) off();
    this.unwatch.length = 0;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    const all = [...this.handles.keys()];
    await Promise.allSettled(all.map((w) => this.close(w)));
  }

  private async reloadAll(): Promise<void> {
    await Promise.allSettled([...this.handles.values()].map((h: Reloadable) => h.reload()));
  }
}
```

- [ ] **步骤 4：编写 `createWorkspaceHandle`（组装工厂，glue）**

创建 `electron-agent/electron/agent/createWorkspaceHandle.ts`：

```ts
import { createAgentSessionRuntime, getAgentDir, SessionManager, type ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { makeGrenRuntimeFactory } from '../../../cli/src/gren-runtime.js';
import { runInWorkspace } from '../../../extensions/_shared/workspace-context.js';
import { WorkspaceHandle, type WorkspaceHandleOptions } from './workspaceHandle.js';

export interface CreateWorkspaceHandleInput {
  workspace: string;
  cwd: string;
  modelRuntime: ModelRuntime;
  allowedExtensionsJson: string;
  resolveConfig: WorkspaceHandleOptions['resolveConfig'];
  emitUiRequest: WorkspaceHandleOptions['emitUiRequest'];
  onEvent: WorkspaceHandleOptions['onEvent'];
  onFatal: WorkspaceHandleOptions['onFatal'];
}

/** 在 main store 内构造 runtime（构造期扩展工厂读 ALS config），返回已 start 的 handle。 */
export async function createWorkspaceHandle(input: CreateWorkspaceHandleInput): Promise<WorkspaceHandle> {
  const config = await input.resolveConfig('main');
  const runtime = await runInWorkspace(
    { origin: 'main', workspace: input.workspace, cwd: input.cwd, config },
    () => createAgentSessionRuntime(
      makeGrenRuntimeFactory({ modelRuntime: input.modelRuntime, allowedExtensionsJson: input.allowedExtensionsJson }),
      { cwd: input.cwd, agentDir: getAgentDir(), sessionManager: SessionManager.create(input.cwd) },
    ),
  );
  const handle = new WorkspaceHandle({
    workspace: input.workspace,
    runtime,
    resolveConfig: input.resolveConfig,
    emitUiRequest: input.emitUiRequest,
    onEvent: input.onEvent,
    onFatal: input.onFatal,
  });
  await handle.start();
  return handle;
}
```

- [ ] **步骤 5：运行验证通过 + 类型检查**

```bash
cd electron-agent && npx vitest run --project main electron/agent/agentHost.test.ts
```
预期：PASS，8 个全绿。门槛命令空输出（含 `createWorkspaceHandle.ts` / `agentHost.ts`）。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agent/agentHost.ts electron-agent/electron/agent/agentHost.test.ts electron-agent/electron/agent/createWorkspaceHandle.ts
git commit -m "feat(electron): add AgentHost registry with reload watch and handle factory"
```

---

## 任务 9：主进程启动期 Q2-A（`PI_RUNTIME_CONFIG` + watcher 时序）

规格《workspace 上下文传播 · fs.watch 绑错陷阱》、Q2-A。主进程必须在**任何 `runInWorkspace()` 之前**设 `process.env.PI_RUNTIME_CONFIG` 并触发一次 watcher 创建，否则 watch 回调永久绑到「第一个进 ALS 的 workspace」。

**现状风险（本份新增修复）：** ESM import 会 hoist——若某扩展模块在 import 期就调 `getConfig`（`ensureStarted` 惰性建 watcher 于此刻），此后 `started=true` 永不重建。因此需要一个 `restartRuntimeConfig()`：在 env 设好后关掉可能已建的旧 watcher、保留 subscribers、重新 `ensureStarted`。且 `fs.watch` 对不存在的文件抛错并被 `ensureStarted` 吞掉 → watcher 永远建不起来，故 bootstrap 要先确保文件存在。

**文件：**
- 修改：`extensions/_shared/runtime-config.ts`
- 创建：`electron-agent/electron/agent/runtimeConfigBootstrap.ts`、`electron-agent/electron/agent/runtimeConfigBootstrap.test.ts`

- [ ] **步骤 1：给 `runtime-config.ts` 加 `restartRuntimeConfig`**

在 `__resetForTest` 前加入（保留 `subscribers`，只重建 watcher 与 cache）：

```ts
/**
 * 宿主启动期在设好 process.env.PI_RUNTIME_CONFIG 之后调用：丢弃可能在 env 设置前建立的
 * watcher（否则 started=true 使其永不重建），保留已注册 subscribers，按新路径重新 ensureStarted。
 */
export function restartRuntimeConfig(): void {
  watcher?.close();
  watcher = undefined;
  cache = null;
  started = false;
  ensureStarted();
}
```

- [ ] **步骤 2：编写失败的测试**

创建 `electron-agent/electron/agent/runtimeConfigBootstrap.test.ts`：

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { getConfig, watchConfig, __resetForTest } from '../../../extensions/_shared/runtime-config.js';
import { runInWorkspace } from '../../../extensions/_shared/workspace-context.js';
import { bootstrapRuntimeConfig } from './runtimeConfigBootstrap.js';

afterEach(() => { __resetForTest(); delete process.env.PI_RUNTIME_CONFIG; });

describe('bootstrapRuntimeConfig', () => {
  it('设置 env 且文件不存在时创建 {}', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-boot-'));
    const path = join(dir, 'sub', 'runtime-settings.json');
    try {
      bootstrapRuntimeConfig(path);
      expect(process.env.PI_RUNTIME_CONFIG).toBe(path);
      expect(getConfig('__any__')).toBeUndefined(); // 文件为 {}，读得到不报错
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('watcher 在 ALS 之外创建：watch 回调内 currentWorkspaceContext 为 undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-boot-'));
    const path = join(dir, 'runtime-settings.json');
    await writeFile(path, '{}');
    try {
      bootstrapRuntimeConfig(path);
      let seenOrigin: string | undefined = 'SENTINEL';
      // 在某 workspace 的 ALS 内注册 subscriber——但 watcher 已在 bootstrap（ALS 外）建立，
      // 回调应看不到 store。
      runInWorkspace({ origin: 'main', workspace: 'A', cwd: 'A', config: {} }, () => {
        watchConfig(() => { seenOrigin = (globalThis as never)['__wc__']?.() ?? undefined; });
      });
      const { currentWorkspaceContext } = await import('../../../extensions/_shared/workspace-context.js');
      (globalThis as never)['__wc__'] = () => currentWorkspaceContext()?.origin;
      await writeFile(path, JSON.stringify({ PI_RELOAD_REV: '1' }));
      await vi.waitFor(() => expect(seenOrigin).not.toBe('SENTINEL'), { timeout: 2000 });
      expect(seenOrigin).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('bootstrap 前调过 getConfig（模拟 import 期）仍能重建 watcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-boot-'));
    const path = join(dir, 'runtime-settings.json');
    await writeFile(path, '{}');
    try {
      getConfig('X'); // env 未设 → ensureStarted 建了个空 watcher，started=true
      bootstrapRuntimeConfig(path);
      let fired = false;
      watchConfig(() => { fired = true; });
      await writeFile(path, JSON.stringify({ PI_RELOAD_REV: '2' }));
      await vi.waitFor(() => expect(fired).toBe(true), { timeout: 2000 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
```

> 上面第 2 个测试用 globalThis 桥接是为了在 subscriber 里取到 `currentWorkspaceContext`——若嫌绕，可改为在 subscriber 内直接 import 并调用；保持断言 `seenOrigin === undefined` 即可。实现时以「watch 回调内读不到 ALS」为唯一验收。测试顶部需 `import { vi } from 'vitest'`。

- [ ] **步骤 3：运行验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/agent/runtimeConfigBootstrap.test.ts`
预期：FAIL，无法解析 `./runtimeConfigBootstrap.js`

- [ ] **步骤 4：编写实现**

创建 `electron-agent/electron/agent/runtimeConfigBootstrap.ts`：

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { restartRuntimeConfig } from '../../../extensions/_shared/runtime-config.js';

/**
 * Q2-A：在任何 runInWorkspace() 之前调用一次。
 * 设 process.env.PI_RUNTIME_CONFIG，确保文件存在（fs.watch 对不存在路径抛错并被吞，
 * watcher 就再也建不起来），再 restartRuntimeConfig 让 watcher 在 ALS 之外创建。
 */
export function bootstrapRuntimeConfig(runtimeConfigPath: string): void {
  const dir = dirname(runtimeConfigPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(runtimeConfigPath)) writeFileSync(runtimeConfigPath, '{}');
  process.env.PI_RUNTIME_CONFIG = runtimeConfigPath;
  restartRuntimeConfig();
}
```

- [ ] **步骤 5：运行验证通过**

运行：`cd electron-agent && npx vitest run --project main electron/agent/runtimeConfigBootstrap.test.ts`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add extensions/_shared/runtime-config.ts electron-agent/electron/agent/runtimeConfigBootstrap.ts electron-agent/electron/agent/runtimeConfigBootstrap.test.ts
git commit -m "feat(electron): bootstrap PI_RUNTIME_CONFIG before any ALS run (Q2-A)"
```

---

## 任务 10：`PiRuntimeService` 交互路径 + main.ts 接线

把 `send()` 交互分支从 `client.send(JSONL)` 切到 handle 具名方法；Goal 分支**保持** `client`（第 3 份再切）。用过渡接缝 `SessionOps` 收敛两条路径的调用点——它是让 sidecar Goal 路径在第 1-3 份存活的临时物，第 3 份 Goal 接 handle 后 `clientOps` 删除，`SessionOps.run` 收敛成 `runOnHandle`（这不是规格禁止的 JSONL AgentPort：键是 IPC 命令名即命令表，不是 `{type}` 线协议）。

**必须保留的语义：** `agent_prompt` 不 await 整回合（preflight 即返回，`SESSION_BUSY` 依赖 `prepareTurn` 在发送前登记 `activeTurns`）；`agent_rewind_to` 的 `get_state → findEntryIdByTimestamp → fork → refreshCurrentSession → syncSessionFork → migrateLegacyGoal` 副作用一个不少；`agent_set_mode` 走 `prompt("/mode …")`；`agent_set_approval`/`exclude_entry`/`restore_entry` 继续写 settings 不进 session。

**文件：**
- 修改：`electron-agent/electron/app/piRuntimeService.ts`、`electron-agent/electron/app/piRuntimeService.test.ts`、`electron-agent/electron/main.ts`

- [ ] **步骤 1：读现状定边界**

```bash
cd electron-agent && npx vitest run --project main electron/app/piRuntimeService.test.ts
```
先确认既有 33 个用例全绿（改造基线）。再通读 `send()`（264-369）、`openWorkspace`（161-185）、`refreshCurrentSession`（933-941）、`respondUi`/`rejectUiRequest`（511-524）、`refreshModelRegistry`（530-542）。

- [ ] **步骤 2：加 `SessionOps` 与端口类型、`runOnHandle`、`turnConfig`**

在 `piRuntimeService.ts` 顶部类型区加入（`ImageContent` / `ThinkingLevel` 经索引类型派生，避免裸 import SDK）：

```ts
import type { AgentSession, PromptOptions } from '../../../cli/src/pi-sdk.js';
import type { WorkspaceHandle } from '../agent/workspaceHandle.js';

type ImageContent = NonNullable<PromptOptions['images']>[number];

export interface AgentHostPort {
  open(workspace: string, cwd: string): Promise<WorkspaceHandlePort>;
  get(workspace: string): WorkspaceHandlePort | undefined;
  close(workspace: string): Promise<void>;
}
export type WorkspaceHandlePort = Pick<WorkspaceHandle,
  'session' | 'prompt' | 'getState' | 'getCommands' | 'newSession' | 'switchSession' | 'fork' | 'ui'>;

/** 交互路径会话操作的过渡接缝。第 3 份 Goal 接 handle 后 clientOps 删除，run 收敛为 runOnHandle。 */
interface SessionOps {
  getState(): Promise<Record<string, unknown>>;
  run(command: PiCommand, args: Record<string, unknown>): Promise<unknown>;
  setSessionIdentity?(sessionId: string, sessionPath?: string): void;
}

interface PiEventMeta { sessionId?: string; sessionPath?: string; source?: 'interactive' | 'goal' }
```

`PiRuntimeOptions` 增补：

```ts
  agentHost: AgentHostPort;
  modelRuntimeHost: { refresh(): Promise<void>; workspaces?(): string[] };
```

新增 `runOnHandle`（命令表 → 具名方法，形状逐字对齐 `rpc-mode.js`）：

```ts
  private async runOnHandle(handle: WorkspaceHandlePort, command: PiCommand, args: Record<string, unknown>): Promise<unknown> {
    const s = handle.session;
    const images = Array.isArray(args.images) ? (args.images as ImageContent[]) : undefined;
    switch (command) {
      case 'agent_prompt':
        return handle.prompt(readInput(args), { images, ...(args.streamingBehavior ? { streamingBehavior: args.streamingBehavior as 'steer' | 'followUp' } : {}) }, 'main');
      case 'agent_set_mode':
        return handle.prompt(`/mode ${String(args.mode ?? '')}`, {}, 'main');
      case 'agent_steer': await s.steer(readInput(args), images); return undefined;
      case 'agent_follow_up': await s.followUp(readInput(args), images); return undefined;
      case 'agent_abort': await s.abort(); return undefined;
      case 'agent_set_model': {
        const model = s.modelRuntime.getAvailableSnapshot().find((m) => m.provider === args.provider && m.id === args.modelId);
        if (!model) throw new Error(`Model not found: ${String(args.provider)}/${String(args.modelId)}`);
        await s.setModel(model);
        return model;
      }
      case 'agent_cycle_model': return (await s.cycleModel()) ?? null;
      case 'agent_get_available_models': return { models: s.modelRuntime.getAvailableSnapshot() };
      case 'agent_set_thinking_level': s.setThinkingLevel(args.level as Parameters<AgentSession['setThinkingLevel']>[0]); return undefined;
      case 'agent_cycle_thinking_level': { const level = s.cycleThinkingLevel(); return level ? { level } : null; }
      case 'agent_compact': return s.compact(typeof args.customInstructions === 'string' ? args.customInstructions : undefined);
      case 'agent_set_auto_compaction': s.setAutoCompactionEnabled(args.enabled === true); return undefined;
      case 'agent_abort_retry': s.abortRetry(); return undefined;
      case 'agent_get_session_stats': return s.getSessionStats();
      case 'agent_get_state': return handle.getState();
      case 'agent_get_messages': return { messages: s.messages };
      case 'agent_get_commands': return handle.getCommands();
      case 'agent_get_fork_messages': return { messages: s.getUserMessagesForForking() };
      case 'agent_set_session_name': {
        const name = String(args.name ?? '').trim();
        if (!name) throw new Error('Session name cannot be empty');
        s.setSessionName(name);
        return undefined;
      }
      case 'agent_new_session': return handle.newSession();
      case 'agent_switch_session': return handle.switchSession(String(args.sessionPath ?? ''));
      case 'agent_fork': return { ...(await handle.fork(String(args.entryId ?? ''))), };
      case 'agent_clone': {
        const leafId = s.sessionManager.getLeafId();
        if (!leafId) throw new Error('Cannot clone session: no current entry selected');
        return { cancelled: (await handle.fork(leafId, { position: 'at' })).cancelled };
      }
      case 'agent_rewind_to': return handle.fork(String(args.entryId ?? ''));
      default: throw new Error(`Unsupported handle command: ${command}`);
    }
  }
```

新增 helper 与 `turnConfig`（`workerEnv` 去进程级键）：

```ts
  /** per-(workspace, source) 配置进 ALS（去掉 PI_PACKAGE_DIR/PI_RUNTIME_CONFIG/PI_GOAL_WORKER/PI_ALLOWED_EXTENSIONS 进程级键）。 */
  async turnConfig(workspace: string, cwd: string, origin: 'main' | 'goal'): Promise<Record<string, string>> {
    const env = await this.workerEnv(workspace, cwd, origin === 'goal' ? 'goal' : 'interactive');
    delete env.PI_PACKAGE_DIR;
    delete env.PI_RUNTIME_CONFIG;
    delete env.PI_GOAL_WORKER;
    delete env.PI_ALLOWED_EXTENSIONS;
    return env;
  }
```

文件底部工具函数区加：

```ts
function readInput(args: Record<string, unknown>): string {
  return typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
}
```

- [ ] **步骤 3：改 `send()` 用 `SessionOps`**

在 `send()` 里，把 `const client = ...; if (...) client.setSessionIdentity...` 起的交互分支替换为：

```ts
    const ops: SessionOps = session.source === 'goal' && session.sessionId && session.sessionPath
      ? clientOps(await this.openGoalClient(session.sessionId, workspace, session.sessionPath))
      : this.handleOps(await this.openInteractive(workspace));
    if (session.source !== 'goal' && session.sessionId && command !== 'agent_switch_session') ops.setSessionIdentity?.(session.sessionId, session.sessionPath);
```

把后续所有 `client.send({ type, ...rpcArgs })` / `client.send({ type: 'get_state' })` / `client.send({ type: 'fork', entryId })` 改为 `ops.run(command, rpcArgs)` / `ops.getState()`（rewind 分支的 fork 走 `ops.run('agent_rewind_to', { entryId })`——但 rewind 已单独处理 entryId，见下）。`agent_set_mode` 分支删除（`runOnHandle`/`clientOps` 内已处理）。`agent_rewind_to` 分支改为：

```ts
    if (command === 'agent_rewind_to') {
      const state = await ops.getState();
      const sessionFile = state.sessionFile;
      if (typeof sessionFile !== 'string' || !sessionFile) throw new Error('no active session file');
      const entryId = await findEntryIdByTimestamp(sessionFile, args.timestamp);
      if (!entryId) throw new Error(`no message with timestamp ${String(args.timestamp)} in session`);
      const result = await ops.run('agent_rewind_to', { entryId });
      if (isCancelledResult(result)) return result;
      const targetIdentity = await this.refreshCurrentSession(workspace, ops, false);
      // …（syncSessionFork / migrateLegacyGoal 原样保留，仅 client→ops）
      return result;
    }
```

`refreshCurrentSession(workspace, client, migrateLegacy)` 签名改为收 `SessionOps`：`const state = await ops.getState();` 其余不变。主 try 里 `const result = await ops.run(command, rpcArgs);`；`get_state` 刷新分支、fork/new/switch 后处理不变（`client.setSessionIdentity` → `ops.setSessionIdentity?.`）。

加两个 ops 工厂：

```ts
  private handleOps(handle: WorkspaceHandlePort): SessionOps {
    return {
      getState: async () => handle.getState(),
      run: (command, args) => this.runOnHandle(handle, command, args),
      // 进程内 session 自知身份，无需回写。
    };
  }

  private async openInteractive(workspace: string): Promise<WorkspaceHandlePort> {
    const cwd = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    return this.options.agentHost.open(workspace, cwd);
  }
```

在文件底部加 `clientOps`（包旧 `PiClientPort`）：

```ts
function clientOps(client: PiClientPort): SessionOps {
  return {
    getState: () => client.send<Record<string, unknown>>({ type: 'get_state' }),
    run: (command, args) => client.send({ type: commandTypes[command], ...args }),
    setSessionIdentity: (id, path) => client.setSessionIdentity?.(id, path),
  };
}
```

- [ ] **步骤 4：改 `openWorkspace` / `warmWorkspace` / `closeWorkspace` / `respondUi` / `rejectUiRequest` / `refreshModelRegistry`**

- `openWorkspace`：`const ops = this.handleOps(await this.openInteractive(workspace)); const state = await ops.getState();` 其余（identity 校验、`SESSION_WORKSPACE_MISMATCH` 兜底）不变。
- `warmWorkspace`：`await this.openInteractive(workspace);`（open 即就绪，无需 get_state）。
- `closeWorkspace`：`await this.options.manager.close(workspace)` 改为 `await this.options.agentHost.close(workspace)`（交互不再用 manager）。Goal worker 关闭（`closeGoalWorker` 循环）不变。
- `respondUi`：`const handle = this.options.agentHost.get(workspace); if (!handle) return; handle.ui.respond(readOptionalString(response.id) ?? '', response);`（不再为回 UI 而 open sidecar）。
- `rejectUiRequest`：goal 分支不变；交互分支 `const handle = this.options.agentHost.get(workspace); handle?.ui.respond(requestId, { cancelled: true });`。
- `refreshModelRegistry`：开头 `await this.options.modelRuntimeHost.refresh();`，把交互 workspace 记入 `refreshed`（`this.options.modelRuntimeHost.workspaces?.() ?? []`）；保留对 `manager.all()`（goal sidecar）的循环。

- [ ] **步骤 5：迁移测试**

`piRuntimeService.test.ts` 顶部加 harness：

```ts
function fakeHandle(session: Record<string, unknown> = {}) {
  return {
    session: { steer: vi.fn(), followUp: vi.fn(), abort: vi.fn(), setModel: vi.fn(), cycleModel: vi.fn(), setThinkingLevel: vi.fn(), cycleThinkingLevel: vi.fn(), compact: vi.fn(), setAutoCompactionEnabled: vi.fn(), abortRetry: vi.fn(), getSessionStats: vi.fn(() => ({})), getUserMessagesForForking: vi.fn(() => []), setSessionName: vi.fn(), messages: [], modelRuntime: { getAvailableSnapshot: () => [] }, sessionManager: { getLeafId: () => 'leaf' }, ...session },
    prompt: vi.fn(async () => {}),
    getState: vi.fn(() => ({ sessionFile: 'C:/sessions/a.jsonl', sessionId: 'session-a' })),
    getCommands: vi.fn(() => ({ commands: [] })),
    newSession: vi.fn(async () => ({ cancelled: false })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    fork: vi.fn(async () => ({ cancelled: false })),
    ui: { respond: vi.fn() },
  };
}
function fakeAgentHost(handle = fakeHandle()) {
  return { host: { open: vi.fn(async () => handle), get: vi.fn(() => handle), close: vi.fn(async () => {}) }, handle };
}
const noopModelHost = { refresh: vi.fn(async () => {}), workspaces: () => [] };
```

给**所有** `new PiRuntimeService({...})` 调用补 `agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost`。既有交互断言按此表迁移（Goal 用例保持 client 断言不动）：

| 旧断言 | 新断言 |
| --- | --- |
| `expect(manager.open).toHaveBeenCalledWith('C:/work', 'C:/work', {...env})` | `expect(host.open).toHaveBeenCalledWith('C:/work', 'C:/work')`（env 校验移到 `turnConfig` 单测） |
| `expect(client.send).toHaveBeenLastCalledWith({ type: 'get_state' })` | `expect(handle.getState).toHaveBeenCalled()` |
| `resolves.toEqual({ ...command: {type:'get_state'} })` | `resolves.toMatchObject({ sessionFile: 'C:/sessions/a.jsonl' })` |

若某失败无法套用上表，停下查明，不改断言迁就实现。新增交互用例：

```ts
describe('进程内宿主交互路径', () => {
  it('agent_prompt 在 preflight 后立即返回', async () => {
    const { host, handle } = fakeAgentHost();
    handle.prompt = vi.fn(async () => {});
    const service = new PiRuntimeService({ manager: {} as never, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await expect(service.send('C:/work', 'agent_prompt', { message: '你好' })).resolves.toBeDefined();
    expect(handle.prompt).toHaveBeenCalledTimes(1);
  });

  it('agent_prompt 活跃时 session 替换命令抛 SESSION_BUSY', async () => {
    const { host, handle } = fakeAgentHost();
    handle.prompt = vi.fn(() => new Promise<void>(() => {}));
    const service = new PiRuntimeService({ manager: {} as never, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: { createThread: async (i: never) => i, createTurn: async (i: never) => i, updateTurn: async (i: never) => i } as never });
    await service.send('C:/work', 'agent_prompt', { message: 'x' });
    await expect(service.send('C:/work', 'agent_new_session', {})).rejects.toThrow('SESSION_BUSY');
  });

  it('agent_set_mode 走 handle.prompt 的斜杠命令', async () => {
    const { host, handle } = fakeAgentHost();
    const service = new PiRuntimeService({ manager: {} as never, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await service.send('C:/work', 'agent_set_mode', { mode: 'plan' });
    expect(handle.prompt).toHaveBeenCalledWith('/mode plan', {}, 'main');
  });

  it('agent_abort 调 session.abort', async () => {
    const { host, handle } = fakeAgentHost();
    const service = new PiRuntimeService({ manager: {} as never, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await service.send('C:/work', 'agent_abort', {});
    expect(handle.session.abort).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **步骤 6：接 main.ts**

在 `startup` 函数计算 `runtimeConfigPath` 处，先 bootstrap（Q2-A），并建 host：

```ts
const runtimeConfigPath = join(app.getPath('userData'), 'runtime-settings.json');
bootstrapRuntimeConfig(runtimeConfigPath); // 任何 runInWorkspace 之前

const modelRuntimeHost = new ModelRuntimeHost({
  create: () => ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') }),
});
const agentHost = new AgentHost({
  createHandle: async (workspace, cwd) => createWorkspaceHandle({
    workspace, cwd,
    modelRuntime: await modelRuntimeHost.ensure(),
    allowedExtensionsJson: JSON.stringify(plugins.allowedPluginIds()),
    resolveConfig: (origin) => piRuntime!.turnConfig(workspace, cwd, origin),
    emitUiRequest: (envelope) => {
      broadcastPiEvent('pi://ui-request', {
        workspace: envelope.workspace,
        request: envelope.request,
        ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
        source: envelope.source,
      });
    },
    onEvent: (event, meta) => {
      const envelope = piRuntime?.eventEnvelope(workspace, event, meta) ?? { workspace, event, source: meta.source, ...(meta.sessionId ? { sessionId: meta.sessionId } : {}) };
      broadcastPiEvent('pi://event', envelope);
      void piRuntime?.handlePiEvent(workspace, event, meta).catch((e) => console.error('Pi event handling failed', e));
    },
    onFatal: (error) => {
      console.error('WorkspaceHandle fatal', error);
      void agentHost.close(workspace).catch(() => {});
      broadcastPiEvent('pi://exit', { workspace, code: 1 });
      void piRuntime?.handlePiExit(workspace, 1).catch(() => {});
    },
  }),
});
```

`agentDir` 取 `getAgentDir()` 或既有 `process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent')`（与 `SettingsService` 一致）。`plugins` 需在 host 创建前就绪（今日 `plugins` 在 `PiManager` 之前建，`allowedPluginIds` 可用）。`PiRuntimeService` 构造补 `agentHost`、`modelRuntimeHost`。`ProviderService.refresh` 改 `() => piRuntime!.refreshModelRegistry()`（删除临时实例）；`activeModel` 改：

```ts
activeModel: async (workspace) => {
  const handle = agentHost.get(workspace);
  const model = handle?.session.model;
  if (!model) throw new Error(`workspace has no active model: ${workspace}`);
  return { provider: model.provider, modelId: model.id };
},
```

`before-quit` 分支加 `await agentHost.closeAll();`（在 `agentData.stop()` 之前）。`handlePiEvent`/`eventEnvelope`/`handlePiExit`/`rejectUiRequest` 的 metadata 形参类型由 `PiClientMetadata` 放宽为 `string | PiEventMeta`（`PiClientMetadata` 结构上满足 `PiEventMeta`，PiManager 的 goal 路径仍编译）。

- [ ] **步骤 7：三包测试 + 类型检查**

```bash
cd cli && node --import tsx --test "src/**/*.test.ts"
cd ../electron-agent && npx vitest run --project main
cd ../extensions && npx vitest run
```
预期：全 PASS（`electron/pi/client.test.ts` 等仍在，本份不删）。门槛命令空输出。

- [ ] **步骤 8：Commit**

```bash
git add electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/app/piRuntimeService.test.ts electron-agent/electron/main.ts
git commit -m "feat(electron): route interactive commands through AgentHost handles"
```

---

## 任务 11：本份收尾验证

- [ ] **步骤 1：三包测试全绿**

```bash
cd cli && node --import tsx --test "src/**/*.test.ts"
cd ../electron-agent && npx vitest run
cd ../extensions && npx vitest run
```

- [ ] **步骤 2：类型检查不超基线，触及文件零错误**

```bash
cd electron-agent && npx tsc -p tsconfig.node.json --noEmit 2>&1 | grep -c "error TS"   # ≤ BASELINE
cd cli && npx tsc --noEmit
```

- [ ] **步骤 3：确认降级层与「先广播后落盘」接上**

```bash
cd electron-agent && grep -n "toJsonEvent" electron/agent/workspaceHandle.ts   # 仅 subscribe 回调内一处
grep -n "broadcastPiEvent('pi://event'" electron/main.ts                        # 在 handlePiEvent 之前
```

- [ ] **步骤 4：确认 Electron 侧无裸 SDK import（单副本规则）**

```bash
cd electron-agent && grep -rn "@earendil-works/" electron --include=*.ts | grep -v "cli/src/pi-sdk"
```
预期：**空**。任何命中都要改成从 `../../../cli/src/pi-sdk.js` import。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "chore: verify plan 1 foundation green across cli/electron/extensions"
```

---

## 交付标准

- `cli/src/{pi-sdk,json-event,gren-runtime}.ts`、`extensions/_shared/workspace-context.ts` 存在，各自测试通过；`json-event.ts` 头标注 `pi-coding-agent@0.85.1`。
- `electron/agent/` 下 `ModelRuntimeHost`/`SessionUiAdapter`/`WorkspaceHandle`/`AgentHost`/`createWorkspaceHandle`/`runtimeConfigBootstrap` 存在且测试通过。
- `PiRuntimeService` 交互命令走 handle 具名方法，`agent_prompt` preflight 时序与 `SESSION_BUSY` 排队保持原语义；Goal 仍走 sidecar `client`。
- 主进程启动期 `PI_RUNTIME_CONFIG` 已设、watcher 在任何 `runInWorkspace` 之前创建。
- 类型检查修成真门槛；本份触及文件零错误。
- 三包测试与类型检查全绿。

**本份不可发布**：sidecar 与进程内宿主并存，属规格明确禁止的双栈中间态，仅作审查单元。

## 已知风险（交给后续计划）

1. **`getConfig` 尚未消费 ALS config（第 2 份）。** 本份 handle 的 ALS 已携带 `config`，但 `getConfig` 仍读文件/env——主进程 env 无 `AGENT_DATA_ENDPOINT`/`PI_MCP_CONFIG`/`PI_HUMAN_ORIGIN_TOKEN`/`PI_PERMISSION_PROFILE`，进程内 handle 的扩展读不到 per-workspace 配置。这是本份不可发布的另一原因；单元测试不受影响，开发期只开单项目验证。
2. **`process.cwd()` 未改（第 2 份）。** 多开项目会串 cwd 相关判定。
3. **`reload()` 的 `resetApiProviders()` 跨 workspace 影响未核实（规格 E）。** 本份 `reload` 只在本 handle `waitForIdle()` 后执行；e2e 观察项「A reload 期间 B 流式回合不中断」留待验证。
4. **`createWorkspaceHandle` 未单测。** 纯 glue，靠类型检查 + 第 5 份打包冒烟覆盖。
5. **`SettingsService` 与 bootstrap 的 `runtime-settings.json` 空文件初始化交互未核实。** `mergeRuntimeSettingsFile` 是 `{...legacy, ...appState, ...local}` 合并，空 `{}` 不遮蔽 legacy；但 `SettingsService` 首次读时机若早于 bootstrap 需复核（第 2 份接 `getConfig` 时一并验证）。