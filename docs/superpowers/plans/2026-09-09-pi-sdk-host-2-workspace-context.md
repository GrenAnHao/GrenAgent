# Pi SDK 宿主 · 第 2 份：workspace 上下文消费点 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在第 1 份已经建好的 ALS 存储与 `runInWorkspace` 包裹之上，把所有「今日靠进程边界隔离」的消费点接到 ALS，消除跨项目串数据与 Goal 提权。

**架构：** 不新建 ALS（第 1 份任务 3 已落地）。`getConfig` 改为 ALS config → 落盘缓存 → `process.env`；3 处直读 env（`goal/tools.ts` 两处 + `desktop-control.resolveToolOrigin`）改读 ALS，sidecar 双栈期间保留 env 回退；12 处 `process.cwd()` 按规格 B 三类改 `ctx.cwd` / `session_start` 闭包 / `currentCwd()`；`getApprovalPolicy` 与 `currentInput` 按 cwd/workspace 分键；`getMcpManager` 按 workspace 分键且 watch 回调闭包绑定 workspace（不靠 ALS）；IM 走进程级单份 `ImBinding`（不是 Map 分键）。`WorkspaceHandle.dispose` 接 `disposeMcpManager` / `releaseImBinding`。

**技术栈：** TypeScript、`node:async_hooks`（已有）、vitest（extensions / electron-agent）、`node --test` + tsx（cli，本份基本不改）

**规格来源：** `docs/superpowers/specs/2026-09-09-electron-pi-sdk-host-design.md` 的「workspace 上下文传播」A/B/C、「IM 绑定（Q3）」、「desktop-control 与身份」、「验证 · workspace 上下文」，以及 `2026-09-09-electron-pi-sdk-host-design-review.md` 第四节「第 2 份」全部修正项。

**依赖：** 必须在第 1 份之后。必须在第 3、4 份之前——Goal 身份与子代理身份都依赖本份消费点就位。

---

## 前置知识（工作者必读）

### 第 1 份已经做完、本份禁止重做的事

| 已落地 | 文件 | 本份动作 |
| --- | --- | --- |
| ALS 存储 + `runInWorkspace` / `currentCwd` / `resolveToolOrigin` | `extensions/_shared/workspace-context.ts` | **只消费，不重建** |
| 所有 handle 入口已包进 `runInWorkspace` | `electron/agent/workspaceHandle.ts` | 只补 `cwd` 字段与 `onDispose` |
| Q2-A：启动期设 `PI_RUNTIME_CONFIG` 并在任何 `run()` 前建 watcher | `electron/agent/runtimeConfigBootstrap.ts` | 不再处理 fs.watch 绑错 |
| `PI_ALLOWED_EXTENSIONS` 显式入参 | `cli/src/gren-runtime.ts` `allowedExtensionsJson` | 不走 ALS / 不改 `resolvePiCommand`（那是第 4 份的 `PI_WORKER_ENTRY`） |
| `onResourceReloadRequested` → 各 handle `reload()` | `electron/agent/agentHost.ts` | 模块单例保留广播语义，只加注释 |

止损点「ALS 穿透 `setTimeout`」与「ALS 穿透 SDK 构造链」已在第 1 份任务 3 / 任务 7。本份不再重复探针。

### 这是本次迁移唯一含安全回归的部分

1. **`AGENT_DATA_ENDPOINT` 塌缩 = 跨项目数据串写。** `agentData/runtime.ts:201-211` 每 workspace 独立 token。主进程 env 没有这个键；只改文件/env 读不到，必须走 ALS。
2. **`PI_HUMAN_ORIGIN_TOKEN` 塌缩 = Goal 提权。** 交互 `'1'`、Goal `'0'`。`goal/tools.ts:34,39` **直接读 `process.env`，不走 `getConfig`**——只改 `getConfig` 修不到。
3. **`goal/tools.ts:13 currentInput` 模块单例。** 今日注释写「一 sidecar 一 session」。进程内嵌后 A 的 `agent_end` 清空会让 B 跳过 `GOAL_CREATE_INTENT_REQUIRED`。

### 审查已推翻的旧计划写法（禁止再写）

- **「activate 开头 `const workspaceCwd = ctx.cwd`」不成立。** 扩展工厂签名是 `(pi: ExtensionAPI)`，**无 ctx**。`ctx.cwd` 首见于 `session_start`（`approval/index.ts:60`）。正确做法：`let workspaceCwd`，在 `session_start` 赋值，watch 回调用它。
- **IM 按 workspace 分 `Map` 方向错。** 微信长轮询 / 锁 / HTTP server 是账号级单实例。规格 Q3 决定：`ImBinding` 进程级一份 `{workspace, sessionId}`。
- **`PI_ALLOWED_EXTENSIONS` 不当 ALS 配置。** 本就全局，第 1 份已改显式入参。
- **Q2-A 不是本份任务。** 第 1 份任务 9 已做；本份 `getConfig` 只插 ALS 查询。

### `getConfig` 现状（第 1 份结束后）

```ts
export function getConfig(key: string): string | undefined {
  ensureStarted();
  if (/^TDAI_|^TENCENTDB_/i.test(key)) return undefined;
  return cache?.[key] ?? process.env[key];
}
```

签名必须不变（41 个扩展在调）。只在内部插入 ALS。`ensureStarted` 已由第 1 份 bootstrap 在 ALS 外触发过，本份调用不会再绑错 watcher。

`turnConfig`（第 1 份已加进 `PiRuntimeService`）进 ALS 的 per-(workspace, source) 键：`AGENT_DATA_ENDPOINT`、`PI_HUMAN_ORIGIN_TOKEN`、`PI_PERMISSION_PROFILE`、`PI_MCP_CONFIG`，以及 `resolveEnv` 带来的其它键。**不含** `PI_PACKAGE_DIR` / `PI_RUNTIME_CONFIG` / `PI_GOAL_WORKER` / `PI_ALLOWED_EXTENSIONS`。

### 12 处 `process.cwd()`（7 文件，规格 B）

| 类 | 位置 | 处理 |
| --- | --- | --- |
| 有 `ctx` | `approval/index.ts:53,71`；`mcp/index.ts:59`；`web-search/index.ts:527` | `ctx.cwd`（`mcp/index.ts:96` 已这么写） |
| watch / 无 `ctx` | `approval/index.ts:39`；`compaction-policy/index.ts:51`；`mcp/manager.ts:89,95,119` | `session_start` 赋 `let cwd` / `McpManager` 持有 `workspace` |
| 共享函数、无 `ctx` | `_shared/approval.ts:12`；`mcp/manager.ts:119`（上列）；`im-platforms/index.ts:114` | `getApprovalPolicy(cwd?)` 回退 `currentCwd()`；IM 的 `cwd` 改由 `ImBinding` / owner `session_start` 写入 |

### 测试命令

| 包 | 命令 |
| --- | --- |
| `extensions/` | `cd extensions && npx vitest run` |
| 单文件 | `cd extensions && npx vitest run _shared/runtime-config.test.ts` |
| `electron-agent/` | `cd electron-agent && npx vitest run --project main` |

本份类型检查门槛（第 1 份已把 `tsconfig.node.json` 修成真检查）：

```bash
cd electron-agent && npx tsc -p tsconfig.node.json --noEmit 2>&1 \
  | grep -E "electron/agent/(workspaceHandle|createWorkspaceHandle)\.ts|extensions/_shared/(runtime-config|approval|desktop-control|im-binding|resource-reload)\.ts|extensions/(goal/tools|approval/index|compaction-policy/index|mcp/manager|mcp/index|web-search/index|im-platforms/index|im-gateway/index)\.ts"
```

预期：空输出。

---

## 文件结构

**新建：**

| 文件 | 职责 |
| --- | --- |
| `extensions/_shared/im-binding.ts` | 进程级单份 IM 绑定 `{workspace, sessionId}`。 |
| `extensions/_shared/im-binding.test.ts` | 首个声明 / 同 workspace 跟随 / 他 workspace 拒绝 / owner 释放。 |

**修改：**

| 文件 | 改动 |
| --- | --- |
| `extensions/_shared/runtime-config.ts` | `getConfig` / `getAllConfig` 插入 ALS。 |
| `extensions/_shared/runtime-config.test.ts` | ALS 优先、并发隔离、敏感前缀。 |
| `extensions/_shared/approval.ts` | `getApprovalPolicy(cwd?)`；`Map<cwd, ApprovalPolicy>` 替模块级 `current`。 |
| `extensions/_shared/approval.test.ts` | 分键、ALS cwd、与 `writeApprovalPolicy` 键匹配。 |
| `extensions/_shared/desktop-control.ts` | `resolveToolOrigin` 改读 ALS，sidecar env 回退。 |
| `extensions/_shared/desktop-control.test.ts` | ALS / env 回退。 |
| `extensions/_shared/resource-reload.ts` | 注释：广播语义是规格决定，不是漏改。 |
| `extensions/goal/tools.ts` | 直读 env → ALS；`currentInput` 按 workspace 分键。 |
| `extensions/goal/tools.test.ts` | Goal 提权不吃全局 env；A/B `currentInput` 隔离。 |
| `extensions/approval/index.ts` | `session_start` 赋 `let workspaceCwd`；slash / watch / live 读都用它。 |
| `extensions/approval/index.test.ts` | 按 `ctx.cwd` 写键；无 `session_start` 时回退 `process.cwd()`（保持旧用例）。 |
| `extensions/compaction-policy/index.ts` | 同上，`consumeDesktopPulse` 用闭包 cwd。 |
| `extensions/mcp/manager.ts` | `Map<workspace, McpManager>`；`defaultReadServers(workspace)`；删 `process.on`。 |
| `extensions/mcp/manager.test.ts` | 分键、dispose 不影响另一把、watch 用闭包 workspace。 |
| `extensions/mcp/index.ts:59` | `process.cwd()` → `ctx.cwd`。 |
| `extensions/web-search/index.ts` | `requireNetwork` 接收 cwd；5 个 execute 传 `ctx.cwd`。 |
| `extensions/im-gateway/index.ts` | `session_start` 走 `claimImBinding`。 |
| `extensions/im-gateway/index.test.ts` | 第二 workspace 不覆盖路由；`beforeEach` 重置绑定。 |
| `extensions/im-platforms/index.ts` | 同上；初始 `cwd` 不再 `process.cwd()`。 |
| `electron-agent/electron/agent/workspaceHandle.ts` | options 补 `cwd` + `onDispose`。 |
| `electron-agent/electron/agent/workspaceHandle.test.ts` | dispose 调 `onDispose(workspace, cwd)`。 |
| `electron-agent/electron/agent/createWorkspaceHandle.ts` | 传入真实 `cwd`；`onDispose` 接 MCP / IM。 |

**本份不动：** `resolvePiCommand` / `PI_BIN` / `PI_WORKER_ENTRY`（第 4 份）；Goal 路由 / `GoalHost`（第 3 份）；sidecar 删除（第 5 份）；`workspace-context.ts` 的存储实现。

---

## 任务 1：`getConfig` / `getAllConfig` 接入 ALS

规格 A 节。第 1 份 bootstrap 已保证 `ensureStarted()` 在 ALS 外发生过，本份只改读取顺序。

**文件：**
- 修改：`extensions/_shared/runtime-config.ts`
- 测试：`extensions/_shared/runtime-config.test.ts`（已存在，追加）

- [ ] **步骤 1：编写失败的测试**

在 `extensions/_shared/runtime-config.test.ts` 顶部 import 补 `runInWorkspace`，文件末尾追加：

```ts
import { runInWorkspace } from "./workspace-context.js";

describe("getConfig 与 workspace 上下文", () => {
  it("ALS 内的值优先于 process.env 与落盘文件", async () => {
    process.env.PI_RUNTIME_CONFIG = fileWith({ AGENT_DATA_ENDPOINT: "from-file" });
    process.env.AGENT_DATA_ENDPOINT = "from-env";
    try {
      await runInWorkspace(
        { origin: "main", workspace: "D:/a", cwd: "D:/a", config: { AGENT_DATA_ENDPOINT: "from-als" } },
        async () => {
          expect(getConfig("AGENT_DATA_ENDPOINT")).toBe("from-als");
        },
      );
      expect(getConfig("AGENT_DATA_ENDPOINT")).toBe("from-file");
    } finally {
      delete process.env.AGENT_DATA_ENDPOINT;
    }
  });

  it("两个 workspace 并发读到各自的值", async () => {
    const read = (workspace: string, endpoint: string) =>
      runInWorkspace(
        { origin: "main", workspace, cwd: workspace, config: { AGENT_DATA_ENDPOINT: endpoint } },
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          return getConfig("AGENT_DATA_ENDPOINT");
        },
      );
    const [a, b] = await Promise.all([read("D:/a", "endpoint-a"), read("D:/b", "endpoint-b")]);
    expect(a).toBe("endpoint-a");
    expect(b).toBe("endpoint-b");
  });

  it("ALS 未定义的 key 仍回退文件再回退 env", async () => {
    process.env.PI_RUNTIME_CONFIG = fileWith({ FILE_ONLY: "file" });
    process.env.ENV_ONLY = "env";
    try {
      await runInWorkspace(
        { origin: "main", workspace: "D:/a", cwd: "D:/a", config: { AGENT_DATA_ENDPOINT: "x" } },
        async () => {
          expect(getConfig("FILE_ONLY")).toBe("file");
          expect(getConfig("ENV_ONLY")).toBe("env");
        },
      );
    } finally {
      delete process.env.ENV_ONLY;
    }
  });

  it("敏感前缀在 ALS 内同样被拦截", async () => {
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: { TDAI_SECRET: "leak" } },
      async () => {
        expect(getConfig("TDAI_SECRET")).toBeUndefined();
      },
    );
  });

  it("getAllConfig 让 ALS 覆盖 file/env", async () => {
    process.env.SOME_KEY = "env";
    process.env.PI_RUNTIME_CONFIG = fileWith({ SOME_KEY: "file" });
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: { SOME_KEY: "als" } },
      async () => {
        expect(getAllConfig().SOME_KEY).toBe("als");
      },
    );
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run _shared/runtime-config.test.ts`
预期：新增用例 FAIL，「ALS 内的值优先」拿到 `from-file` 而非 `from-als`。

- [ ] **步骤 3：改实现**

`extensions/_shared/runtime-config.ts` 顶部加：

```ts
import { currentWorkspaceContext } from "./workspace-context.js";
```

改 `getConfig` / `getAllConfig`：

```ts
export function getConfig(key: string): string | undefined {
  ensureStarted();
  if (/^TDAI_|^TENCENTDB_/i.test(key)) return undefined;
  return currentWorkspaceContext()?.config[key] ?? cache?.[key] ?? process.env[key];
}

export function getAllConfig(): Record<string, string> {
  ensureStarted();
  return withoutSensitiveProcessConfig({
    ...(process.env as Record<string, string>),
    ...(cache ?? {}),
    ...(currentWorkspaceContext()?.config ?? {}),
  });
}
```

不要引入不存在的 `contextConfig()`（旧计划的占位符）。键就在 `WorkspaceContext.config` 上。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run _shared/runtime-config.test.ts`
预期：PASS，原有用例全绿，新增 5 个全绿。

- [ ] **步骤 5：Commit**

```bash
git add extensions/_shared/runtime-config.ts extensions/_shared/runtime-config.test.ts
git commit -m "feat(extensions): getConfig prefers workspace ALS over file and env"
```

---

## 任务 2：Goal 提权 + `currentInput` 按 workspace 分键

规格 A 节直读 env 三点中的两处，加上 C 节 `goal/tools.ts:13`。`automaticTurn` / `trustedHumanOrigin` **不导出**——经已有 `create_goal` execute 路径测。

**文件：**
- 修改：`extensions/goal/tools.ts`
- 测试：`extensions/goal/tools.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `extensions/goal/tools.test.ts` 追加（保留现有 `afterEach` 的 env 清理；再加 `__resetGoalInputForTest`，实现步骤再导出）：

```ts
import { runInWorkspace } from "../_shared/workspace-context.js";
import { __resetGoalInputForTest } from "./tools.js";

// 把 afterEach 里的 clearGoalInputContext() 换成：
//   __resetGoalInputForTest();

describe("Goal 创建权限（ALS）", () => {
  it("goal 上下文 token=0 时即使全局 env=1 也禁止 create", async () => {
    process.env.PI_HUMAN_ORIGIN_TOKEN = "1";
    const request = vi.fn();
    const { defs, ctx } = setup(request);
    await runInWorkspace(
      { origin: "goal", workspace: "/repo", cwd: "/repo", config: { PI_HUMAN_ORIGIN_TOKEN: "0" } },
      async () => {
        await expect(
          defs[1].execute("id", { condition: "x", continuousIntentEvidence: "直到完成" }, undefined, undefined, ctx),
        ).rejects.toThrow("GOAL_CREATE_FORBIDDEN");
      },
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("main 上下文 token=1 时允许 create（不依赖 process.env）", async () => {
    delete process.env.PI_HUMAN_ORIGIN_TOKEN;
    delete process.env.PI_TURN_ORIGIN;
    const request = vi.fn().mockResolvedValue({ goalId: "g", sessionId: "session-a", workspace: "/repo", revision: 1 });
    const { defs, ctx } = setup(request);
    await runInWorkspace(
      { origin: "main", workspace: "/repo", cwd: "/repo", config: { PI_HUMAN_ORIGIN_TOKEN: "1" } },
      async () => {
        await defs[1].execute("id", { condition: "x", continuousIntentEvidence: "直到完成" }, undefined, undefined, ctx);
      },
    );
    expect(request).toHaveBeenCalledWith("goal.create", expect.objectContaining({ sessionId: "session-a" }));
  });

  it("ALS origin=goal 视为 automatic，禁止 create", async () => {
    const request = vi.fn();
    const { defs, ctx } = setup(request);
    await runInWorkspace(
      { origin: "goal", workspace: "/repo", cwd: "/repo", config: { PI_HUMAN_ORIGIN_TOKEN: "1" } },
      async () => {
        await expect(
          defs[1].execute("id", { condition: "x", continuousIntentEvidence: "直到完成" }, undefined, undefined, ctx),
        ).rejects.toThrow("GOAL_CREATE_FORBIDDEN");
      },
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("A 的 currentInput 不被 B 的 agent 回合看见", async () => {
    process.env.PI_HUMAN_ORIGIN_TOKEN = "1";
    const request = vi.fn().mockResolvedValue({ goalId: "g", sessionId: "session-a", workspace: "/repo", revision: 1 });
    const { defs, ctx } = setup(request);
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: { PI_HUMAN_ORIGIN_TOKEN: "1" } },
      async () => {
        setGoalInputContext("rpc", "please inspect this once");
      },
    );
    await runInWorkspace(
      { origin: "main", workspace: "D:/b", cwd: "D:/b", config: { PI_HUMAN_ORIGIN_TOKEN: "1" } },
      async () => {
        await defs[1].execute("id", { condition: "x", continuousIntentEvidence: "直到完成" }, undefined, undefined, ctx);
      },
    );
    expect(request).toHaveBeenCalled();
  });

  it("A 的 agent_end 不清空 B 的 currentInput", async () => {
    const request = vi.fn();
    const { defs, ctx } = setup(request);
    await runInWorkspace(
      { origin: "main", workspace: "D:/b", cwd: "D:/b", config: { PI_HUMAN_ORIGIN_TOKEN: "1" } },
      async () => {
        setGoalInputContext("rpc", "please inspect this once");
      },
    );
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: { PI_HUMAN_ORIGIN_TOKEN: "1" } },
      async () => {
        clearGoalInputContext();
      },
    );
    await runInWorkspace(
      { origin: "main", workspace: "D:/b", cwd: "D:/b", config: { PI_HUMAN_ORIGIN_TOKEN: "1" } },
      async () => {
        await expect(
          defs[1].execute("id", { condition: "x", continuousIntentEvidence: "直到完成" }, undefined, undefined, ctx),
        ).rejects.toThrow("GOAL_CREATE_INTENT_REQUIRED");
      },
    );
    expect(request).not.toHaveBeenCalled();
  });
});
```

把文件顶部的 `afterEach` 改成：

```ts
afterEach(() => {
  __resetGoalInputForTest();
  delete process.env.PI_IS_SUBAGENT;
  delete process.env.PI_SYSTEM_WORKER;
  delete process.env.PI_GOAL_WORKER;
  delete process.env.PI_TURN_ORIGIN;
  delete process.env.PI_INPUT_ORIGIN;
  delete process.env.PI_GOAL_ORIGIN;
  delete process.env.PI_HUMAN_ORIGIN_TOKEN;
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run goal/tools.test.ts`
预期：FAIL，无法解析 `__resetGoalInputForTest`；即便临时 stub，ALS 用例也会因仍读 `process.env` 而让「env=1 + ALS token=0」放行。

- [ ] **步骤 3：改实现**

`extensions/goal/tools.ts` 顶部加：

```ts
import { currentWorkspaceContext, resolveToolOrigin } from "../_shared/workspace-context.js";
import { getConfig } from "../_shared/runtime-config.js";
```

替换第 10-40 行：

```ts
const inputs = new Map<string, GoalInputContext>();

function inputKey(): string {
  return currentWorkspaceContext()?.workspace ?? process.cwd();
}

export function setGoalInputContext(source: GoalInputContext["source"], text: string): void {
  inputs.set(inputKey(), { source, text });
}

export function clearGoalInputContext(): void {
  inputs.delete(inputKey());
}

/** 仅测试：清空全部分键，避免 afterEach 依赖当前 ALS。 */
export function __resetGoalInputForTest(): void {
  inputs.clear();
}

function currentInput(): GoalInputContext | undefined {
  return inputs.get(inputKey());
}

function automaticTurn(): boolean {
  const origin = resolveToolOrigin();
  if (origin === "goal" || origin === "subagent") return true;
  // sidecar 双栈回退：第 3/5 份删 Goal sidecar 与 system worker 之前，worker 仍靠 env。
  return process.env.PI_GOAL_WORKER === "1" || process.env.PI_SYSTEM_WORKER === "1";
}

function trustedHumanOrigin(): boolean {
  const origin = process.env.PI_TURN_ORIGIN ?? process.env.PI_INPUT_ORIGIN ?? process.env.PI_GOAL_ORIGIN;
  // getConfig 已优先 ALS（任务 1）。Goal 回合 turnConfig 写 PI_HUMAN_ORIGIN_TOKEN='0'，
  // 即使主进程 env 残留 '1' 也不会提权。
  return origin === "human" || origin === "human-ui" || getConfig("PI_HUMAN_ORIGIN_TOKEN") === "1";
}
```

`userTurnRequired` 里所有 `currentInput` 改为 `currentInput()` 调用：

```ts
function userTurnRequired(): void {
  if (automaticTurn() || !trustedHumanOrigin()) throw new Error("GOAL_CREATE_FORBIDDEN");
  const input = currentInput();
  if (input) {
    if (input.source === "extension") throw new Error("GOAL_CREATE_FORBIDDEN");
    if (!hasContinuousIntent(input.text)) throw new Error("GOAL_CREATE_INTENT_REQUIRED");
  }
}
```

`PI_GOAL_WORKER` 废止后身份由 ALS `origin` 承担；env 回退只服务第 5 份删 sidecar 之前的 Goal worker。`goal/index.ts` 的 `new MemoryClient()` **保持不动**（规格接受：走 Agent Data TCP；ALS 提供正确 `AGENT_DATA_ENDPOINT` 即可）。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run goal/tools.test.ts`
预期：PASS。原有「`PI_GOAL_WORKER=1` 禁止 create」「`PI_TURN_ORIGIN=human` 放行」仍绿（env 回退 + `getConfig` 回退 env）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/goal/tools.ts extensions/goal/tools.test.ts
git commit -m "fix(goal): read origin from ALS and key currentInput by workspace"
```

---

## 任务 3：`desktop-control.resolveToolOrigin` 改读 ALS

规格「desktop-control 与身份」。`safety/index.ts:45` 从本文件 import `resolveToolOrigin`，**导出名字不变**。`workspace-context.resolveToolOrigin` 是另一份（无 sidecar env 回退，符合规格公式）；本函数在无 ALS 时多认 `PI_GOAL_WORKER` / `PI_SYSTEM_WORKER`，避免第 3/5 份完成前 Goal sidecar 被当成 `main`。

**文件：**
- 修改：`extensions/_shared/desktop-control.ts:73-78`
- 测试：`extensions/_shared/desktop-control.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

在 `desktop-control.test.ts` 追加：

```ts
import { resolveToolOrigin } from "./desktop-control.js";
import { runInWorkspace } from "./workspace-context.js";

describe("resolveToolOrigin", () => {
  const prevGoal = process.env.PI_GOAL_WORKER;
  const prevSub = process.env.PI_IS_SUBAGENT;
  const prevSys = process.env.PI_SYSTEM_WORKER;

  afterEach(() => {
    if (prevGoal === undefined) delete process.env.PI_GOAL_WORKER;
    else process.env.PI_GOAL_WORKER = prevGoal;
    if (prevSub === undefined) delete process.env.PI_IS_SUBAGENT;
    else process.env.PI_IS_SUBAGENT = prevSub;
    if (prevSys === undefined) delete process.env.PI_SYSTEM_WORKER;
    else process.env.PI_SYSTEM_WORKER = prevSys;
  });

  it("ALS origin 优先于 env", async () => {
    process.env.PI_GOAL_WORKER = "1";
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: {} },
      async () => {
        expect(resolveToolOrigin()).toBe("main");
      },
    );
    await runInWorkspace(
      { origin: "goal", workspace: "D:/a", cwd: "D:/a", config: {} },
      async () => {
        expect(resolveToolOrigin()).toBe("goal");
      },
    );
  });

  it("无 ALS 时 PI_IS_SUBAGENT=1 → subagent", () => {
    process.env.PI_IS_SUBAGENT = "1";
    delete process.env.PI_GOAL_WORKER;
    expect(resolveToolOrigin()).toBe("subagent");
  });

  it("无 ALS 时 PI_GOAL_WORKER=1 → goal（sidecar 回退）", () => {
    delete process.env.PI_IS_SUBAGENT;
    process.env.PI_GOAL_WORKER = "1";
    expect(resolveToolOrigin()).toBe("goal");
  });
});
```

`safety/toolAuthorization.test.ts` 注释写「靠设置 `PI_IS_SUBAGENT` 等环境变量驱动」——env 回退保留后那些用例不必改。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run _shared/desktop-control.test.ts`
预期：FAIL，「ALS origin 优先」在 `PI_GOAL_WORKER=1` 时仍返回 `goal`。

- [ ] **步骤 3：改实现**

替换 `desktop-control.ts:73-78`：

```ts
import { currentWorkspaceContext } from "./workspace-context.js";

/** 判定本进程 / 本回合身份。ALS 优先；无 ALS 时回退子进程 env（fork 与尚未删除的 sidecar）。 */
export function resolveToolOrigin(): ToolOrigin {
  const ctx = currentWorkspaceContext();
  if (ctx) return ctx.origin;
  if (process.env.PI_IS_SUBAGENT === "1") return "subagent";
  if (process.env.PI_GOAL_WORKER === "1" || process.env.PI_SYSTEM_WORKER === "1") return "goal";
  return "main";
}
```

不要把 `workspace-context.ts` 的 `resolveToolOrigin` 改成带 sidecar 回退——规格公式保持「ALS → `PI_IS_SUBAGENT` → main」，Goal 工具（任务 2）已经自己加了 sidecar 回退。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run _shared/desktop-control.test.ts safety/toolAuthorization.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/_shared/desktop-control.ts extensions/_shared/desktop-control.test.ts
git commit -m "fix(shared): resolveToolOrigin prefers ALS origin over worker env"
```

---

## 任务 4：`getApprovalPolicy(cwd?)` + 按 cwd 分键

规格 B 共享函数 + C 节 `_shared/approval.ts:7 current`。这是真实读取点：`safety:123,165`、`mcp-policy:86`、`multi-agent:311`、`im-platforms:280` 都调无参 `getApprovalPolicy()`——它们在工具 / 钩子链内，ALS 已在，回退 `currentCwd()` 即可。有 ctx 的调用方（下一任务）显式传 `ctx.cwd`。

**文件：**
- 修改：`extensions/_shared/approval.ts`
- 测试：`extensions/_shared/approval.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `approval.test.ts` 追加（`beforeEach` 改为 `__resetApprovalForTest()`）：

```ts
import { runInWorkspace } from "./workspace-context.js";
import { __resetApprovalForTest } from "./approval.js";

// beforeEach(() => { __resetApprovalForTest(); });

describe("getApprovalPolicy 分键", () => {
  it("set/get 按 cwd 隔离", () => {
    setApprovalPolicy("ask", "D:/a");
    setApprovalPolicy("full", "D:/b");
    expect(getApprovalPolicy("D:/a")).toBe("ask");
    expect(getApprovalPolicy("D:/b")).toBe("full");
  });

  it("无参时读 ALS cwd", async () => {
    setApprovalPolicy("ask", "D:/a");
    setApprovalPolicy("full", "D:/b");
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: {} },
      async () => {
        expect(getApprovalPolicy()).toBe("ask");
      },
    );
  });

  it("live 文件键按传入 cwd 匹配，不读 process.cwd()", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approval-cwd-"));
    directories.push(directory);
    const runtime = join(directory, "runtime-settings.json");
    const target = "D:/proj-a";
    process.env.PI_RUNTIME_CONFIG = runtime;
    await writeFile(runtime, JSON.stringify({ [approvalPolicyConfigKey(target)]: "full" }));
    __resetForTest();
    setApprovalPolicy("ask", target);
    expect(getApprovalPolicy(target)).toBe("full");
    expect(getApprovalPolicy("D:/other")).not.toBe("full");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run _shared/approval.test.ts`
预期：FAIL，`getApprovalPolicy` / `setApprovalPolicy` 仍是单值，A/B 互相覆盖。

- [ ] **步骤 3：改实现**

整文件替换为：

```ts
// 进程内共享的审批策略（多扩展读同一份）。live 源是 runtime 配置文件，
// 对话中切档立刻现读，不跟 session 开场绑定。默认 auto（替我审批）。
import { getConfig, refreshConfig } from "./runtime-config.js";
import { currentCwd } from "./workspace-context.js";

export type ApprovalPolicy = "ask" | "auto" | "full";

const byCwd = new Map<string, ApprovalPolicy>();

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function resolveCwd(cwd?: string): string {
  return normalizeCwd(cwd ?? currentCwd());
}

export function getApprovalPolicy(cwd?: string): ApprovalPolicy {
  refreshConfig();
  const key = resolveCwd(cwd);
  const live =
    parseApproval(getConfig(approvalPolicyConfigKey(key))) ??
    parseApproval(getConfig("APPROVAL_POLICY"));
  return live ?? byCwd.get(key) ?? "auto";
}

export function setApprovalPolicy(p: ApprovalPolicy, cwd?: string): void {
  byCwd.set(resolveCwd(cwd), p);
}

/** 与主进程 `approvalPolicyConfigKey` 保持一致：工作区路径规范化后作为热更新键。 */
export function approvalPolicyConfigKey(workspace: string): string {
  return `APPROVAL_POLICY:${normalizeCwd(workspace)}`;
}

export function parseApproval(s: string | undefined): ApprovalPolicy | undefined {
  const v = (s ?? "").trim().toLowerCase();
  return v === "ask" || v === "auto" || v === "full" ? v : undefined;
}

export const APPROVAL_LABELS: Record<ApprovalPolicy, string> = {
  ask: "请求批准",
  auto: "替我审批",
  full: "完全访问",
};

/** 仅测试。 */
export function __resetApprovalForTest(): void {
  byCwd.clear();
}
```

`approvalPolicyConfigKey` 的规范化抽成 `normalizeCwd`，与 Map 键、`getApprovalPolicy` 入参使用同一函数——否则 `D:/A` 与 `d:/a` 会打到不同槽，和主进程 `settingsService.ts:9` 的键对不上。

既有用例「`setApprovalPolicy("ask"); getApprovalPolicy()`」无参，走 `currentCwd()` = `process.cwd()`，行为与今日单值相同。`approval.test.ts` 的 `beforeEach` 从 `setApprovalPolicy("auto")` 改为 `__resetApprovalForTest()`。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run _shared/approval.test.ts approval/index.test.ts safety/index.test.ts mcp-policy/index.test.ts multi-agent/index.test.ts`
预期：PASS（这些调用方仍无参，工具链内 `currentCwd()` 等于今日 `process.cwd()`）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/_shared/approval.ts extensions/_shared/approval.test.ts
git commit -m "fix(shared): key approval policy by cwd instead of a process singleton"
```

---

## 任务 5：approval / compaction-policy 的 watch 回调闭包 cwd

规格 B「watch 回调、无 ctx」。工厂无 ctx，**禁止**写 `activate` 时捕获 `ctx.cwd`。

**文件：**
- 修改：`extensions/approval/index.ts`
- 修改：`extensions/compaction-policy/index.ts`
- 测试：`extensions/approval/index.test.ts`、`extensions/compaction-policy/index.test.ts`

- [ ] **步骤 1：编写失败的测试**

`approval/index.test.ts` 的 `ctx()` helper 补可选 `cwd`（缺省仍不设，旧用例走 `process.cwd()` 回退）：

```ts
const ctx = (entries: SessionEntry[] = [], cwd?: string) => ({
  sessionManager: { getEntries: () => entries },
  ui: { setStatus: vi.fn(), notify: vi.fn() },
  ...(cwd ? { cwd } : {}),
});
```

追加：

```ts
it("watchConfig 在 session_start 之后按 ctx.cwd 读键，不读 process.cwd()", async () => {
  const subscribers: Array<(next: Record<string, string>) => void> = [];
  vi.mocked(watchConfig).mockImplementation((cb) => {
    subscribers.push(cb);
    return () => {};
  });
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  approval({
    registerCommand: () => {},
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => {
      handlers[ev] = h;
    },
    appendEntry: () => {},
  } as never);
  await handlers.session_start?.({}, ctx([], "D:/proj-a"));
  const key = `APPROVAL_POLICY:${"D:/proj-a".replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}`;
  for (const cb of subscribers) cb({ [key]: "ask" });
  expect(getApprovalPolicy("D:/proj-a")).toBe("ask");
  expect(getApprovalPolicy("D:/other")).toBe("auto");
});

it("/approval 把档位写到 ctx.cwd 键", async () => {
  let handler: ((args: string, ctx: { cwd: string; ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
  approval({
    registerCommand: (_n: string, spec: { handler: typeof handler }) => {
      handler = spec.handler;
    },
    on: () => {},
    appendEntry: () => {},
  } as never);
  const ui = { notify: vi.fn(), setStatus: vi.fn() };
  await handler!("full", { cwd: "D:/proj-a", ui });
  expect(setRuntimeConfig).toHaveBeenCalledWith(
    `APPROVAL_POLICY:${"D:/proj-a".replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}`,
    "full",
  );
});
```

`compaction-policy/index.test.ts` 追加（同样先 `session_start` 再触发 watch）：

```ts
it("desktop pulse 按 session_start 的 ctx.cwd 读键", async () => {
  const subscribers: Array<(next: Record<string, string>) => void> = [];
  vi.mocked(watchConfig).mockImplementation((cb) => {
    subscribers.push(cb);
    return () => {};
  });
  const entries: unknown[] = [];
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  factory({
    registerCommand: () => {},
    on: (e: string, h: (event: unknown, ctx: unknown) => unknown) => {
      handlers[e] = h;
    },
    appendEntry: (_type: string, data: unknown) => {
      entries.push(data);
    },
  } as never);
  await handlers.session_start?.({}, { cwd: "D:/proj-a", sessionManager: { getEntries: () => [] } });
  const key = contextExclusionConfigKey("D:/proj-a");
  vi.mocked(getConfig).mockImplementation((name: string) =>
    name === key ? JSON.stringify({ op: "add", ts: 42, rev: 1 }) : undefined,
  );
  for (const cb of subscribers) cb({ [key]: JSON.stringify({ op: "add", ts: 42, rev: 1 }) });
  expect(entries).toEqual([{ op: "add", ts: 42 }]);
});
```

旧用例「工厂后立刻 watch、键为 `process.cwd()`」必须继续绿：`workspaceCwd` 未赋值时回退 `currentCwd()`。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run approval/index.test.ts compaction-policy/index.test.ts`
预期：FAIL，watch / slash 仍用 `process.cwd()` 拼键。

- [ ] **步骤 3：改 `approval/index.ts`**

工厂函数体内、所有 hook 之前加：

```ts
  let workspaceCwd: string | undefined;
  const cwd = (): string => workspaceCwd ?? currentCwd();
```

顶部加 `import { currentCwd } from "../_shared/workspace-context.js";`。

三处 `process.cwd()` 全部改为 `cwd()`：

```ts
  watchConfig((next) => {
    const nextPolicy = parseApproval(next[approvalPolicyConfigKey(cwd())]);
    if (!nextPolicy || nextPolicy === getApprovalPolicy(cwd())) return;
    setApprovalPolicy(nextPolicy, cwd());
  });

  pi.registerCommand("approval", {
    description: "切换审批策略：/approval ask|auto|full",
    handler: async (args, ctx) => {
      const next = parseApproval(args);
      if (!next) {
        ctx.ui.notify(`用法：/approval ask|auto|full（当前：${getApprovalPolicy(ctx.cwd)}）`, "warning");
        return;
      }
      setApprovalPolicy(next, ctx.cwd);
      setRuntimeConfig(approvalPolicyConfigKey(ctx.cwd), next);
      persist();
      push(ctx);
      ctx.ui.notify(`审批策略：${APPROVAL_LABELS[next]}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    workspaceCwd = ctx.cwd;
    const entries = ctx.sessionManager.getEntries() as Array<{
      type: string;
      customType?: string;
      data?: unknown;
    }>;
    const entry = entries.filter((e) => e.type === "custom" && e.customType === "approval").pop();
    const data = entry?.data as PersistedState | undefined;
    setApprovalPolicy(
      parseApproval(getConfig(approvalPolicyConfigKey(ctx.cwd))) ??
        parseApproval(getConfig("APPROVAL_POLICY")) ??
        parseApproval(data?.policy) ??
        "auto",
      ctx.cwd,
    );
    push(ctx);
  });
```

`persist` / `push` 里的 `getApprovalPolicy()` 改为 `getApprovalPolicy(workspaceCwd)`（`session_start` 之后 `workspaceCwd` 已有值）。

- [ ] **步骤 4：改 `compaction-policy/index.ts`**

同样加 `let workspaceCwd` + `import { currentCwd }`，`consumeDesktopPulse` 改为：

```ts
  let workspaceCwd: string | undefined;

  const consumeDesktopPulse = () => {
    refreshConfig();
    const pulse = parseContextExclusionPulse(getConfig(contextExclusionConfigKey(workspaceCwd ?? currentCwd())));
    if (!pulse) return;
    const decision = shouldApplyContextExclusionPulse(pulse, lastPulseRev, excluded);
    lastPulseRev = decision.nextRev;
    if (decision.apply) applyOp({ op: pulse.op, ts: pulse.ts });
  };
```

`session_start` 开头加 `workspaceCwd = ctx.cwd;`，其余逻辑不动。

- [ ] **步骤 5：运行测试验证通过**

运行：`cd extensions && npx vitest run approval/index.test.ts compaction-policy/index.test.ts _shared/approval.test.ts`
预期：PASS，新旧用例全绿。

- [ ] **步骤 6：Commit**

```bash
git add extensions/approval/index.ts extensions/approval/index.test.ts extensions/compaction-policy/index.ts extensions/compaction-policy/index.test.ts
git commit -m "fix(extensions): bind approval and compaction watch callbacks to session cwd"
```

---

## 任务 6：`mcp/index.ts` 与 `web-search` 上报 `ctx.cwd`

规格 B「有 ctx」两类。`mcp/index.ts:96` 已写 `typeof ctx.cwd === 'string' ? ctx.cwd : process.cwd()`，`:59` 的 execute 漏了。

**文件：**
- 修改：`extensions/mcp/index.ts:55-63`
- 修改：`extensions/web-search/index.ts`
- 测试：`extensions/mcp/index.test.ts`（追加）；web-search 若无现成 execute 单测，本任务用 mcp 用例锁形状，web-search 靠步骤 3 的机械替换 + 全量 vitest

- [ ] **步骤 1：编写失败的测试**

在 `mcp/index.test.ts` 的 `"authorizes MCP calls..."` 旁追加：

```ts
  it("authorize 上报 ctx.cwd 而不是 process.cwd()", async () => {
    const pi = fakeProjectPi();
    const manager = { callTool: vi.fn(async () => ({ text: "x" })) };
    const control = { request: vi.fn(async () => ({ status: "allowed" })) };
    const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    pi.registerTool = (tool: any) => definitions.push(tool);
    project(pi as never, snap({ a: { status: "connected", tools: ["x"] } }), manager as never, control as never);

    await definitions[0].execute("call", {}, undefined, undefined, { cwd: "D:/proj-a" });

    expect(control.request).toHaveBeenCalledWith(
      "permission.authorize",
      expect.objectContaining({ operation: expect.objectContaining({ workspace: "D:/proj-a" }) }),
    );
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/index.test.ts`
预期：FAIL，`workspace` 为 `process.cwd()`。

- [ ] **步骤 3：改实现**

`mcp/index.ts` 的 `execute` 补第 5 参并改 workspace：

```ts
        async execute(_toolCallId, params, _signal, _update, ctx): Promise<AgentToolResult<McpToolDetails>> {
          if (control) {
            const authorization = await authorizeDesktopOperation(control, {
              kind: "mcp.call",
              workspace: typeof ctx?.cwd === "string" ? ctx.cwd : currentCwd(),
              server,
              toolName: t.name,
              args: params ?? {},
            });
```

顶部加 `import { currentCwd } from "../_shared/workspace-context.js";`。`:96` 的 `process.cwd()` 回退也改 `currentCwd()`。

`web-search/index.ts`：

```ts
import { currentCwd } from "../_shared/workspace-context.js";

function toolCwd(ctx: { cwd?: unknown } | undefined): string {
  return typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : currentCwd();
}

async function requireNetwork(
  control: DesktopControlPort,
  toolName: string,
  cwd: string,
  url?: string,
): Promise<AgentToolResult<Record<string, unknown>> | undefined> {
  const authorization = await authorizeDesktopOperation(control, {
    kind: "network.request",
    workspace: cwd,
    toolName,
    ...(url ? { url } : {}),
  });
  // ...原拒绝分支不变
}
```

5 个 execute 都补 `ctx` 并改调用（逐处，不要漏 `articleTool` 内部那一处）：

```ts
    async execute(_toolCallId, params, signal, _update, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      const denied = await requireNetwork(control, "web_search", toolCwd(ctx));
```

```ts
    async execute(_toolCallId, params, signal, _update, ctx) {
      const denied = await requireNetwork(control, "web_search_multi", toolCwd(ctx));
```

```ts
      async execute(_toolCallId, params, signal, _update, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
        const denied = await requireNetwork(control, name, toolCwd(ctx), params.url);
```

```ts
    async execute(_toolCallId, params, signal, _update, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      const denied = await requireNetwork(control, "fetch_github_readme", toolCwd(ctx), params.url);
```

```ts
    async execute(_toolCallId, params, signal, _update, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      const denied = await requireNetwork(control, "fetch_web_content", toolCwd(ctx), params.url);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run mcp/index.test.ts web-search`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp/index.ts extensions/mcp/index.test.ts extensions/web-search/index.ts
git commit -m "fix(extensions): report ctx.cwd to desktop-control instead of process.cwd"
```

---

## 任务 7：`getMcpManager` 按 workspace 分键

规格 C 节 + review「`onConfigChange` 在 fs.watch 上下文，ALS 键会错，须闭包绑定 workspace」。工厂期 `getMcpManager()` 在第 1 份的 `runInWorkspace` 内调用，能读到 ALS workspace。watch 回调**不能**再读 ALS。

`PI_MCP_CONFIG` 只存在于 `turnConfig`（ALS），从不写入 `runtime-settings.json`。因此 watch 触发时 `getConfig('PI_MCP_CONFIG')` 会变成 `undefined`，必须在 ALS 内见过一次后按 workspace 缓存。

**文件：**
- 修改：`extensions/mcp/manager.ts`
- 测试：`extensions/mcp/manager.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `manager.test.ts` 追加：

```ts
import { getMcpManager, disposeMcpManager, __resetMcpManagersForTest, createManager } from "./manager";
import { runInWorkspace } from "../_shared/workspace-context.js";

afterEach(() => {
  __resetMcpManagersForTest();
});

describe("getMcpManager 分键", () => {
  it("两个 workspace 拿到两份互不共享的 manager", async () => {
    const a = await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: {} },
      async () => getMcpManager(),
    );
    const b = await runInWorkspace(
      { origin: "main", workspace: "D:/b", cwd: "D:/b", config: {} },
      async () => getMcpManager(),
    );
    expect(a).not.toBe(b);
    const a2 = await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: {} },
      async () => getMcpManager(),
    );
    expect(a2).toBe(a);
  });

  it("dispose A 不影响 B", async () => {
    const connect = vi.fn(async () => fakeClient([{ name: "t" }]));
    const a = createManager({ connect, readServers: () => [srv("a")], watch: () => () => {}, writeCache: () => {} });
    const b = createManager({ connect, readServers: () => [srv("b")], watch: () => () => {}, writeCache: () => {} });
    a.init();
    b.init();
    await waitFor(a.subscribe, a.snapshot, (s) => s.servers.get("a")?.status === "connected");
    await waitFor(b.subscribe, b.snapshot, (s) => s.servers.get("b")?.status === "connected");
    a.closeAll();
    expect(b.snapshot().servers.get("b")?.status).toBe("connected");
  });

  it("watch 回调用闭包 workspace 读服务器，不读 process.cwd()", async () => {
    const seen: string[] = [];
    let fire = () => {};
    const mgr = createManager({
      workspace: "D:/proj-a",
      connect: async () => fakeClient([]),
      readServers: () => {
        seen.push("read");
        return [srv("s")];
      },
      watch: (cb) => {
        fire = cb;
        return () => {};
      },
      writeCache: () => {},
    });
    mgr.init();
    fire();
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});
```

「无 `process.on`」用源码断言，放在步骤 4 的扫描里，不在单测里 mock `process.on`。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/manager.test.ts`
预期：FAIL，`getMcpManager` 仍是 `globalThis` 单例，两 workspace 身份相同。

- [ ] **步骤 3：改实现**

`manager.ts` 顶部加：

```ts
import { currentWorkspaceContext } from "../_shared/workspace-context.js";
```

`ManagerDeps` 加可选 `workspace?: string`。

替换 `defaultReadServers` 与默认 `watch`，并改 registry：

```ts
const managers = new Map<string, McpManager>();
const alsConfigByWorkspace = new Map<string, Readonly<Record<string, string>>>();

function rememberAlsConfig(workspace: string): void {
  const als = currentWorkspaceContext();
  if (als) alsConfigByWorkspace.set(workspace, als.config);
}

function defaultReadServers(workspace: string): McpServerConfig[] {
  rememberAlsConfig(workspace);
  const captured = alsConfigByWorkspace.get(workspace);
  const raw = currentWorkspaceContext()?.config.PI_MCP_CONFIG ?? captured?.PI_MCP_CONFIG ?? getConfig("PI_MCP_CONFIG");
  const all = { ...getAllConfig(), ...captured, ...currentWorkspaceContext()?.config };
  const managed = managedServers(raw);
  const servers = injectDefaultServers(
    managed ?? readLayeredMcpServersSync(workspace, getConfig("MCP_SERVERS") ?? ""),
    all,
    process.platform,
    readToolsCache(),
    process.arch,
  );
  return expandServerVars(servers, workspace);
}

export function createManager(deps: ManagerDeps = {}): McpManager {
  const workspace = deps.workspace ?? currentWorkspaceContext()?.workspace ?? process.cwd();
  const connect = deps.connect ?? realConnect;
  const readServers = deps.readServers ?? (() => defaultReadServers(workspace));
  const watch =
    deps.watch ??
    ((cb: () => void) => {
      const offConfig = watchConfig(() => cb());
      const offFiles = watchMcpConfigFiles(workspace, cb);
      return () => {
        offConfig();
        offFiles();
      };
    });
  const writeCache = deps.writeCache ?? writeToolsCacheEntry;
  // ...connectServer / onConfigChange / return 对象保持原样
}

export function getMcpManager(): McpManager {
  const workspace = currentWorkspaceContext()?.workspace ?? process.cwd();
  let mgr = managers.get(workspace);
  if (!mgr) {
    mgr = createManager({ workspace });
    managers.set(workspace, mgr);
  }
  return mgr;
}

export function disposeMcpManager(workspace: string): void {
  const mgr = managers.get(workspace);
  if (!mgr) return;
  mgr.closeAll();
  managers.delete(workspace);
  alsConfigByWorkspace.delete(workspace);
}

export function __resetMcpManagersForTest(): void {
  for (const mgr of managers.values()) mgr.closeAll();
  managers.clear();
  alsConfigByWorkspace.clear();
}
```

**删除** `getMcpManager` 里的 `process.on("exit"/"SIGTERM"/"SIGINT")` 与 `__grenMcpExitHooked`。关项目改由 `WorkspaceHandle.dispose` → `disposeMcpManager`（任务 9）；app quit 由第 1 份的 `agentHost.closeAll()` 间接触发。

`onConfigChange` 继续调闭包里的 `readServers`——它捕获的是构造时的 `workspace`，不读 ALS。这就是 review 要的「闭包绑定」。

- [ ] **步骤 4：运行测试 + 扫描 `process.on`**

运行：`cd extensions && npx vitest run mcp/manager.test.ts mcp/index.test.ts`
预期：PASS。

运行：`rg "process\\.on\\(" extensions/mcp/manager.ts`
预期：无匹配。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp/manager.ts extensions/mcp/manager.test.ts
git commit -m "fix(mcp): key McpManager by workspace and drop process signal hooks"
```

---

## 任务 8：`ImBinding`（账号级单实例）

规格「IM 绑定（Q3）」。**不要**把 `im-gateway` / `im-platforms` 改成 `Map<workspace, …>`。HTTP server / 微信长轮询 / 锁继续是进程级一份；变的是「谁有权改路由」。

**文件：**
- 创建：`extensions/_shared/im-binding.ts`、`extensions/_shared/im-binding.test.ts`
- 修改：`extensions/im-gateway/index.ts`、`extensions/im-gateway/index.test.ts`
- 修改：`extensions/im-platforms/index.ts`

- [ ] **步骤 1：编写 `im-binding` 失败测试**

创建 `extensions/_shared/im-binding.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  claimImBinding,
  currentImBinding,
  releaseImBinding,
  __resetImBindingForTest,
} from "./im-binding.js";

afterEach(() => {
  __resetImBindingForTest();
});

describe("ImBinding", () => {
  it("首个 session_start 声明成功", () => {
    expect(claimImBinding("D:/a", "s1")).toEqual({ claimed: true });
    expect(currentImBinding()).toEqual({ workspace: "D:/a", sessionId: "s1" });
  });

  it("同 workspace 切会话跟随更新 sessionId", () => {
    claimImBinding("D:/a", "s1");
    expect(claimImBinding("D:/a", "s2")).toEqual({ claimed: true });
    expect(currentImBinding()).toEqual({ workspace: "D:/a", sessionId: "s2" });
  });

  it("其他 workspace 不能覆盖路由", () => {
    claimImBinding("D:/a", "s1");
    expect(claimImBinding("D:/b", "s9")).toEqual({
      claimed: false,
      owner: { workspace: "D:/a", sessionId: "s1" },
    });
    expect(currentImBinding()).toEqual({ workspace: "D:/a", sessionId: "s1" });
  });

  it("owner 关闭后下一个可以声明", () => {
    claimImBinding("D:/a", "s1");
    releaseImBinding("D:/a");
    expect(currentImBinding()).toBeUndefined();
    expect(claimImBinding("D:/b", "s2")).toEqual({ claimed: true });
  });

  it("非 owner 调用 release 是空操作", () => {
    claimImBinding("D:/a", "s1");
    releaseImBinding("D:/b");
    expect(currentImBinding()).toEqual({ workspace: "D:/a", sessionId: "s1" });
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd extensions && npx vitest run _shared/im-binding.test.ts`
预期：FAIL，无法解析 `./im-binding.js`。

- [ ] **步骤 3：编写 `im-binding.ts`**

```ts
export interface ImBinding {
  workspace: string;
  sessionId: string;
}

let binding: ImBinding | undefined;

export function claimImBinding(
  workspace: string,
  sessionId: string,
): { claimed: true } | { claimed: false; owner: ImBinding } {
  if (!binding || binding.workspace === workspace) {
    binding = { workspace, sessionId };
    return { claimed: true };
  }
  return { claimed: false, owner: binding };
}

export function currentImBinding(): ImBinding | undefined {
  return binding;
}

export function releaseImBinding(workspace: string): void {
  if (binding?.workspace === workspace) binding = undefined;
}

export function __resetImBindingForTest(): void {
  binding = undefined;
}
```

- [ ] **步骤 4：改 `im-gateway/index.ts` 的 `session_start`**

顶部加 `import { claimImBinding } from "../_shared/im-binding.js";`。

替换 `session_start` 回调（`:118-135`）为：

```ts
  pi.on("session_start", (_event, ctx) => {
    const workspace = typeof ctx.cwd === "string" ? ctx.cwd : "";
    const sessionId = ctx.sessionManager.getSessionId?.() ?? "";
    const claim = claimImBinding(workspace, sessionId);
    if (!claim.claimed) {
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(`IM 已绑定到 ${claim.owner.workspace}`, "warning");
        } catch {
          /* best-effort */
        }
      }
      return;
    }
    const st = gwState();
    st.sendUserMessage = (text, opts) => pi.sendUserMessage(text, opts);
    st.notify = (msg, level) => {
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(msg, level);
        } catch {
          /* best-effort */
        }
      }
    };
    if (!st.watching) {
      st.watching = true;
      watchConfig(() => reconcile());
    }
    reconcile();
  });
```

gateway HTTP server 仍然只起一次（`gwState().watching` / `lastSig` 不变）。无 token 强制 `127.0.0.1`（`:50-59`）不动。

- [ ] **步骤 5：改 `im-platforms/index.ts` 的 `session_start`**

顶部加 `import { claimImBinding } from "../_shared/im-binding.js";`。

`imState()` 初始值把 `cwd: process.cwd()` 改为 `cwd: ""`（owner 声明前不应冒充某个项目；这是规格 B 表第 12 处）。

替换 `session_start` 回调（`:546-576`）为：

```ts
  pi.on("session_start", (_event, ctx) => {
    const workspace = typeof ctx.cwd === "string" ? ctx.cwd : "";
    const sessionId = ctx.sessionManager.getSessionId?.() ?? "";
    const claim = claimImBinding(workspace, sessionId);
    if (!claim.claimed) {
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(`IM 已绑定到 ${claim.owner.workspace}`, "warning");
        } catch {
          /* best-effort */
        }
      }
      return;
    }
    const st = imState();
    st.cwd = ctx.cwd || st.cwd;
    st.notify = (msg, level) => {
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(msg, level);
        } catch {
          /* best-effort */
        }
      }
    };
    st.pushStatus = (key, text) => {
      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus(key, text);
        } catch {
          /* best-effort */
        }
      }
    };
    ensureContext();
    if (!st.watching) {
      st.watching = true;
      watchConfig(() => reconcile());
    }
    reconcile();
    rebroadcastStatus();
  });
```

- [ ] **步骤 6：改 `im-gateway/index.test.ts`**

`beforeEach` 加 `__resetImBindingForTest()`。旧用例 `session_start?.({}, { hasUI: false })` 无 `cwd`：`claimImBinding("", "")` 第一次成功，gateway 仍启动。追加：

```ts
import { __resetImBindingForTest } from "../_shared/im-binding.js";

describe("ImBinding", () => {
  it("第二 workspace 不重绑网关且通知 owner", async () => {
    const handlers = load({ IM_GATEWAY: "1" });
    await handlers.session_start?.(
      {},
      { hasUI: true, cwd: "D:/a", sessionManager: { getSessionId: () => "s-a" }, ui: { notify: vi.fn() } },
    );
    await flush();
    expect(startGateway).toHaveBeenCalledTimes(1);
    const notify = vi.fn();
    await handlers.session_start?.(
      {},
      { hasUI: true, cwd: "D:/b", sessionManager: { getSessionId: () => "s-b" }, ui: { notify } },
    );
    expect(notify).toHaveBeenCalledWith("IM 已绑定到 D:/a", "warning");
    expect(startGateway).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **步骤 7：运行验证通过**

运行：`cd extensions && npx vitest run _shared/im-binding.test.ts im-gateway/index.test.ts im-platforms`
预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add extensions/_shared/im-binding.ts extensions/_shared/im-binding.test.ts extensions/im-gateway/index.ts extensions/im-gateway/index.test.ts extensions/im-platforms/index.ts
git commit -m "feat(im): bind WeChat and gateway routing to a single owner workspace"
```

---

## 任务 9：`WorkspaceHandle.dispose` 接 MCP / IM；补真实 `cwd`

规格「失败与生命周期」：`dispose` → `cancelAll` → `abort` → 停 subscribe → `disposeMcpManager(workspace)` → `releaseImBinding(workspace)` →（第 4 份再加 `killSubagentsFor(cwd)`）。

第 1 份的 handle 把 ALS `cwd` 写成 `this.options.workspace`。`writeApprovalPolicy` 同时写 workspace 键与 resolved 键；扩展侧读的是 cwd。本份把真实 `cwd` 存进 options，避免 workspace ≠ resolved 时审批键对不上。

**文件：**
- 修改：`electron-agent/electron/agent/workspaceHandle.ts`
- 修改：`electron-agent/electron/agent/workspaceHandle.test.ts`
- 修改：`electron-agent/electron/agent/createWorkspaceHandle.ts`
- 修改：`extensions/_shared/resource-reload.ts`（只加注释）

- [ ] **步骤 1：编写失败的测试**

在 `workspaceHandle.test.ts` 的 dispose 相关 describe 追加：

```ts
  it("dispose 调用 onDispose(workspace, cwd)", async () => {
    const onDispose = vi.fn();
    const { handle } = makeHandle(makeRuntime().runtime, { cwd: "D:/resolved", onDispose });
    await handle.dispose();
    expect(onDispose).toHaveBeenCalledWith("D:/proj", "D:/resolved");
  });
```

`makeHandle` 的 options 需能覆盖 `cwd` / `onDispose`。按第 1 份的 `makeHandle` 形参扩成：

```ts
function makeHandle(
  runtime: ReturnType<typeof makeRuntime>["runtime"],
  extra: Partial<WorkspaceHandleOptions> = {},
) {
  // ...原 onEvent / onFatal / resolveConfig
  return new WorkspaceHandle({
    workspace: "D:/proj",
    cwd: extra.cwd ?? "D:/proj",
    runtime,
    resolveConfig,
    emitUiRequest: vi.fn(),
    onEvent,
    onFatal,
    ...extra,
  });
}
```

并加一条 ALS cwd 断言（改现有「prompt 期间 origin」用例，或新增）：

```ts
  it("ALS cwd 使用 options.cwd 而不是把 workspace 当 cwd", async () => {
    const { handle } = makeHandle(makeRuntime().runtime, { cwd: "D:/resolved" });
    await handle.start();
    // 若第 1 份测试里有 spy resolveConfig + currentCwd，这里断言 prompt 包裹的 ctx.cwd。
    // 最小锁：handle 的私有 ctx 经 resolveConfig 调用可观察——改为在 resolveConfig mock 外
    // 用 run 后的 getConfig 不合适（handle 测试不加载 extensions）。
    // 用 onDispose 的 cwd 即可锁存储；再在 start 后读 (handle as any) 不写。
    expect((handle as unknown as { options: { cwd: string } }).options).toBeUndefined();
  });
```

不要用 `(handle as any).options`。改成：让 `resolveConfig` 被 `prompt` 调用后，测试只锁 `onDispose` 的第二参；ALS cwd 用下面这条（在 `makeRuntime` 的 `prompt` mock 里读 `currentCwd()`）：

```ts
  it("prompt 的 ALS cwd 是 options.cwd", async () => {
    const seen: string[] = [];
    const runtime = makeRuntime();
    runtime.session.prompt = vi.fn(async () => {
      const { currentCwd } = await import("../../../extensions/_shared/workspace-context.js");
      seen.push(currentCwd());
    });
    const { handle } = makeHandle(runtime.runtime, { cwd: "D:/resolved" });
    await handle.start();
    await handle.prompt("hi", {}, "main");
    expect(seen).toEqual(["D:/resolved"]);
  });
```

`resource-reload.ts` 无行为变更，不写失败测试。步骤 4 只加注释。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/agent/workspaceHandle.test.ts`
预期：FAIL，`onDispose` 不存在 / ALS cwd 仍等于 workspace。

- [ ] **步骤 3：改 `WorkspaceHandle`**

`WorkspaceHandleOptions` 增加：

```ts
  cwd: string;
  onDispose?: (workspace: string, cwd: string) => void | Promise<void>;
```

`ctx()` 改为 `cwd: this.options.cwd`（不再用 `this.options.workspace`）。

`dispose()`：

```ts
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.ui.cancelAll();
    try { await this.session.abort(); } catch { /* 清理阶段 abort 失败不阻断 */ }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try { await this.options.runtime.dispose(); } catch { /* 同上 */ }
    try { await this.options.onDispose?.(this.options.workspace, this.options.cwd); } catch { /* 同上 */ }
  }
```

`createWorkspaceHandle.ts`：

```ts
import { disposeMcpManager } from "../../../extensions/mcp/manager.js";
import { releaseImBinding } from "../../../extensions/_shared/im-binding.js";

  const handle = new WorkspaceHandle({
    workspace: input.workspace,
    cwd: input.cwd,
    runtime,
    resolveConfig: input.resolveConfig,
    emitUiRequest: input.emitUiRequest,
    onEvent: input.onEvent,
    onFatal: input.onFatal,
    onDispose: async (workspace, cwd) => {
      disposeMcpManager(workspace);
      releaseImBinding(workspace);
      void cwd; // 第 4 份在此接 killSubagentsFor(cwd)
    },
  });
```

若 `CreateWorkspaceHandleInput` 已有 `cwd`，只是没传进 handle——现在传进去。`makeHandle` / `agentHost` 测试里构造 `WorkspaceHandle` 的地方都补 `cwd`（与 `workspace` 相同即可，除非用例在测 resolved）。

- [ ] **步骤 4：`resource-reload.ts` 加注释**

文件头改成：

```ts
// 模块级 listeners 是有意的进程级广播：requestResourceReload() 触发所有 handle reload。
// 规格 C 节接受（reload 在 waitForIdle 后执行、幂等）。不要改成按 workspace 分键。
type Listener = () => void;
```

行为一行都不改。AgentHost 第 1 份已订阅。

- [ ] **步骤 5：运行验证通过 + 类型检查**

运行：`cd electron-agent && npx vitest run --project main electron/agent/workspaceHandle.test.ts electron/agent/agentHost.test.ts`
预期：PASS。门槛 grep 空输出。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agent/workspaceHandle.ts electron-agent/electron/agent/workspaceHandle.test.ts electron-agent/electron/agent/createWorkspaceHandle.ts extensions/_shared/resource-reload.ts
git commit -m "feat(electron): dispose MCP and IM bindings with the workspace handle"
```

---

## 任务 10：跨 workspace 隔离回归 + 残余扫描

规格「验证 · workspace 上下文」。不打真实 LLM。本任务把前面单点测收成一张清单，并 grep 确认 12 处 / 3 处直读已改完。

**文件：**
- 测试：`extensions/_shared/workspace-isolation.test.ts`（新建，只组合已有 API，不引 SDK）

- [ ] **步骤 1：编写隔离回归**

创建 `extensions/_shared/workspace-isolation.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { getConfig, __resetForTest } from "./runtime-config.js";
import { getApprovalPolicy, setApprovalPolicy, __resetApprovalForTest } from "./approval.js";
import { resolveToolOrigin } from "./desktop-control.js";
import { claimImBinding, currentImBinding, __resetImBindingForTest } from "./im-binding.js";
import { runInWorkspace } from "./workspace-context.js";

afterEach(() => {
  __resetForTest();
  __resetApprovalForTest();
  __resetImBindingForTest();
  delete process.env.AGENT_DATA_ENDPOINT;
  delete process.env.PI_HUMAN_ORIGIN_TOKEN;
  delete process.env.PI_GOAL_WORKER;
});

const ctx = (workspace: string, config: Record<string, string>, origin: "main" | "goal" = "main") =>
  ({ origin, workspace, cwd: workspace, config }) as const;

describe("跨 workspace 隔离回归", () => {
  it("A / B 的 AGENT_DATA_ENDPOINT 与 PI_MCP_CONFIG 互不可见", async () => {
    process.env.AGENT_DATA_ENDPOINT = "global-should-not-win";
    const [a, b] = await Promise.all([
      runInWorkspace(ctx("D:/a", { AGENT_DATA_ENDPOINT: "token-a", PI_MCP_CONFIG: "[a]" }), async () => ({
        endpoint: getConfig("AGENT_DATA_ENDPOINT"),
        mcp: getConfig("PI_MCP_CONFIG"),
      })),
      runInWorkspace(ctx("D:/b", { AGENT_DATA_ENDPOINT: "token-b", PI_MCP_CONFIG: "[b]" }), async () => ({
        endpoint: getConfig("AGENT_DATA_ENDPOINT"),
        mcp: getConfig("PI_MCP_CONFIG"),
      })),
    ]);
    expect(a).toEqual({ endpoint: "token-a", mcp: "[a]" });
    expect(b).toEqual({ endpoint: "token-b", mcp: "[b]" });
  });

  it("Goal 回合 origin=goal 且 token=0", async () => {
    process.env.PI_HUMAN_ORIGIN_TOKEN = "1";
    await runInWorkspace(ctx("D:/a", { PI_HUMAN_ORIGIN_TOKEN: "0" }, "goal"), async () => {
      expect(resolveToolOrigin()).toBe("goal");
      expect(getConfig("PI_HUMAN_ORIGIN_TOKEN")).toBe("0");
    });
  });

  it("getApprovalPolicy 按 cwd 匹配，不串到另一项目", () => {
    setApprovalPolicy("ask", "D:/a");
    setApprovalPolicy("full", "D:/b");
    expect(getApprovalPolicy("D:/a")).toBe("ask");
    expect(getApprovalPolicy("D:/b")).toBe("full");
  });

  it("ImBinding：第二 workspace 不覆盖；owner 关闭后可重新声明", () => {
    expect(claimImBinding("D:/a", "s1")).toEqual({ claimed: true });
    expect(claimImBinding("D:/b", "s2")).toMatchObject({ claimed: false });
    expect(currentImBinding()?.workspace).toBe("D:/a");
  });
});
```

- [ ] **步骤 2：运行验证失败或通过**

若任务 1-8 已落地，这一步应直接 PASS。FAIL 则停下来修回归，不要在本任务里加新功能。

运行：`cd extensions && npx vitest run _shared/workspace-isolation.test.ts`
预期：PASS。

- [ ] **步骤 3：残余扫描（硬性清单）**

在 `extensions/` 下跑（排除 `*.test.ts`、`node_modules`）：

```bash
rg -n "process\\.cwd\\(\\)" extensions --glob "!**/*.{test,spec}.ts" --glob "!node_modules/**"
```

预期**仅剩**这些（全局 / 子进程 / 测试夹具，不是塌缩点）：

| 文件 | 原因 |
| --- | --- |
| `extensions/dap/protocol.ts` 或测试夹具里的 `process.cwd()` | 若只出现在 `*.test.ts` 则本扫描不应看到 |
| `extensions/code-exec/**` 测试 | 已排除 |
| `extensions/mcp/manager.ts` 的 `getMcpManager` / `createManager` 回退 `process.cwd()` | 无 ALS 时（CLI / 单测）的显式回退，允许 |
| `extensions/goal/tools.ts` 的 `inputKey()` 回退 `process.cwd()` | 同上 |

**禁止再出现**于：`approval/index.ts`、`compaction-policy/index.ts`、`_shared/approval.ts`、`mcp/index.ts`、`web-search/index.ts`、`im-platforms/index.ts:114`。`mcp/manager.ts` 的 `defaultReadServers` / `watchMcpConfigFiles` **禁止**再写 `process.cwd()`。

```bash
rg -n "process\\.env\\.PI_GOAL_WORKER|process\\.env\\.PI_HUMAN_ORIGIN_TOKEN" extensions --glob "!**/*.{test,spec}.ts"
```

预期仅：

| 文件 | 原因 |
| --- | --- |
| `goal/tools.ts` `automaticTurn` 的 sidecar 回退 | 第 5 份删 sidecar 后可删 |
| `desktop-control.ts` `resolveToolOrigin` 的 sidecar 回退 | 同上 |

`goal/tools.ts` 的 `trustedHumanOrigin` **不得**再直读 `process.env.PI_HUMAN_ORIGIN_TOKEN`。

```bash
rg -n "process\\.on\\(" extensions/mcp/manager.ts extensions/im-gateway extensions/im-platforms
```

预期：`mcp/manager.ts` 无匹配。im-platforms 若仍有 `hookExitRelease` 释放微信锁，保留（账号级锁，不是 workspace 隔离）。

- [ ] **步骤 4：extensions + electron-agent 全量**

```bash
cd extensions && npx vitest run
cd electron-agent && npx vitest run --project main
```

预期：PASS。门槛 grep 空输出。

- [ ] **步骤 5：Commit**

```bash
git add extensions/_shared/workspace-isolation.test.ts
git commit -m "test(shared): add cross-workspace isolation regression for ALS consumers"
```

---

## 交付标准

- `getConfig` / `getAllConfig`：ALS → 文件 → env；敏感前缀在 ALS 内同样拦截。
- `goal/tools.ts`：Goal 回合 `origin:"goal"` + `PI_HUMAN_ORIGIN_TOKEN==="0"` 时 `GOAL_CREATE_FORBIDDEN`；全局 env `'1'` 不能提权；A 的 `currentInput` / `agent_end` 不影响 B。
- `desktop-control.resolveToolOrigin`：ALS 优先；无 ALS 时 sidecar env 回退仍在。
- 12 处 `process.cwd()` 按 B 节三类改完；`getApprovalPolicy(cwd)` 与主进程 `writeApprovalPolicy` 的规范化键匹配。
- `getMcpManager()` 按 workspace 分键；`onConfigChange` 用闭包 workspace + 缓存的 `PI_MCP_CONFIG`；无 `process.on`；关 A 不影响 B。
- `ImBinding`：第二 workspace 不覆盖路由；owner 关闭后可重新声明。gateway 无 token 仍强制 `127.0.0.1`。
- `WorkspaceHandle.dispose` 调 `onDispose(workspace, cwd)` → `disposeMcpManager` + `releaseImBinding`。ALS `cwd` 为 resolved cwd。
- `resource-reload` 保持进程级广播（有注释）。
- 残余扫描清单与任务 10 步骤 3 一致。三包相关测试全绿；本份触及文件类型检查零错误。

**本份不可发布**：Goal 仍走 sidecar，身份判定已按 ALS 修好，但主线仍是规格禁止的双栈中间态。

## 已知风险（交给后续计划）

1. **`PI_SYSTEM_WORKER` 仍出现在 sidecar 回退里（第 3/5 份删除）。** system worker 形态第 3 份改为 `completeSimple`，本份保留 env 回退以免双栈期间把 system worker 当成 `main`。
2. **`goal/index.ts` 仍 `new MemoryClient()`。** 规格接受；依赖本份 ALS 的 `AGENT_DATA_ENDPOINT`。不经 in-process port。
3. **MCP `init()` 幂等。** reload 不会重建已有 manager；活更新仍靠 `watchMcpConfigFiles` + `watchConfig` + 闭包 workspace。与今日 sidecar 单例行为一致。
4. **`resolvePiCommand` / `PI_WORKER_ENTRY` 是第 4 份。** 本份不改 runner。
5. **`reload()` 的 `resetApiProviders()` 跨 workspace 影响仍未核实（规格 E）。** 继续作为 e2e 观察项。
6. **IM「独一份会话」若产品本意是专属 IM handle。** 规格写明只需改 `ImBinding` 声明来源；本份按「首个开启 IM 的 workspace 为 owner」落地。