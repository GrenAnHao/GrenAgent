# Agent Note: MCP 工具增量注册、批量刷新

Status: implemented

## Problem

每次 MCP 快照推送，`project()`（`extensions/mcp/index.ts`）都把全部已连接工具重新 `pi.registerTool`。pi 的每次 `registerTool` 都同步全量刷新工具表（包装全部工具、codemode 重渲染全部描述），一次投影是工具数的平方级。开关 MCP、服务器重连时，运行时所在进程会停顿几百毫秒到数秒。这个进程原来是 Electron 主进程，现在是 agent-host 子进程。

## Decision

- 增量：`project()` 按 pi 会话维护 `ProjectionCache`（工具名 → 定义指纹），指纹没变 **never** 再 `registerTool`。`bind()` 每个 pi 实例一份。
- 合并：`extensions/_shared/tool-refresh-batch.ts`。
  - `installToolRefreshBatching(session)` **must** 在会话创建后、`bindExtensions` 前调用，否则 `session_start` 里那次最大的首次投影合并不到。现有调用点：`cli/src/gren-runtime.ts`、`extensions/multi-agent/embedded-runner.ts`、`extensions/multi-agent/activation.ts`。新增创建 `AgentSession` 的地方也要装。
  - `batchToolRefresh(fn)`：fn 同步执行期间，已安装会话无参数的 `_refreshToolRegistry()` 只记下，结束时每会话刷新一次。带参数的调用不合并。
- 顺序：`project()` 先在批量里登记，批量结束（工具表已刷新）后才算并设置活动工具。`setActiveTools` 只认工具表里已有的名字，**never** 把它放进批量里。清单没变就不调用。

## Alternatives considered

- **给 pi 打补丁，加批量注册接口**——最干净的语义，也有过 pi 补丁的先例。但延迟刷新要连带改 `setActiveTools` 的过滤，补丁面大，每次升级都要重打；换掉一个实例方法只依赖一个私有名字，契约用例兜底。
- **只做指纹去重**——重连、断开不再登记。首次连上 N 个工具仍是 N 次全量刷新。
- **只合并刷新**——每次投影刷新一次。但与工具无关的推送（连接中、失败）也要付一次全量刷新和全部定义的重新登记。

## Consequences

- **收益**：冒烟（`electron-agent/scripts/agent-host-smoke.mjs`）里，300 个工具重连时子进程最长不响应 733ms → 11ms，1000 个工具 28ms。首次投影从 N 次全量刷新变成 1 次。
- **代价**：
  - 依赖 pi 私有方法 `_refreshToolRegistry`，以及 `refreshTools` 动作每次现取它这一实现。
  - 断开的服务器的工具仍登记在会话里（pi 无注销接口，改动前即如此）。
- **重访信号**：升级 pi 后 `tool-refresh-batch.test.ts` 的契约用例失败，或冒烟里重连停顿重新随工具数增长，说明 pi 改了实现，合并已失效。pi 若提供批量注册接口，就换过去并删掉 `tool-refresh-batch.ts`。

## Verification

- `cd extensions && npx vitest run _shared/tool-refresh-batch.test.ts mcp/index.test.ts`：合并、嵌套、抛错仍刷新、契约；同快照不重登、只重登变化的工具、一次投影只刷新一次、清单不变不 `setActiveTools`。
- 冒烟：`node scripts/agent-host-smoke.mjs --entry <localrun 构建>/main/agent-host.js --tools 1000`，看「重新打开 MCP」一行的子进程停顿。
- 决策记录：[docs/decisions/extensions/2026-10-10-mcp-tool-registration-batch.md](../../../../docs/decisions/extensions/2026-10-10-mcp-tool-registration-batch.md)。
