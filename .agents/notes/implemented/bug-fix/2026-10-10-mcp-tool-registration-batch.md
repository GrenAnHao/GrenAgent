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

## 原始记录（合并自 docs/decisions）

以下为 `docs/decisions/extensions/2026-10-10-mcp-tool-registration-batch.md` 的原文（标题降一级），保留本笔记未写到的细节；与上文冲突时以上文为准。

### 背景

`project()` 每次快照推送（连接中、已连接、失败、登录地址、断开）都把所有已连接服务器的每个工具重新 `pi.registerTool` 一遍。pi 1.1.0 的 `registerTool` 每调一次都同步执行 `refreshTools()`，也就是 `AgentSession._refreshToolRegistry()`：重新包装全部工具、重算 loadout，codemode 的 `prepareLoadout` 再把所有可调用工具渲染成描述。一次投影的开销是「工具数 × 全量刷新」。冒烟里 300 个工具重连一次，agent-host 子进程约 0.8 秒不响应；在 Electron 主进程里时，这就是开关 MCP 卡住窗口的主因之一（`electron-agent/2026-10-09-agent-host-child-process.md`）。

### 决定

- `project()` 收一个按 pi 会话保存的 `ProjectionCache`（工具名 → 定义指纹：服务器、原名、描述、inputSchema、exposure、namespace）。指纹没变的工具不再登记。连接中、断开、同样的工具重连，都不触发登记。`bind()` 每个 pi 实例一份缓存。
- 本次投影的全部登记放在 `batchToolRefresh()` 里同步执行。会话创建后、绑定扩展前，`installToolRefreshBatching(session)` 把实例上的 `_refreshToolRegistry` 换成可合并的版本：批量期间无参数的调用只记下，批量结束时每个会话刷新一次；带参数的调用（建运行时、reload）照常立即执行。pi 的 `refreshTools` 动作每次现取 `this._refreshToolRegistry`，所以不用改 pi。三处创建会话的地方都装：`gren-runtime` 工厂、嵌入式子代理、冷恢复子代理。
- 活动工具清单在批量结束、工具表刷新之后才算（`setActiveTools` 只认已在工具表里的名字），清单和当前完全一样就不再 `setActiveTools`。

冒烟（`electron-agent/scripts/agent-host-smoke.mjs`）：300 个工具重连时子进程最长不响应从 733ms 降到 11ms，1000 个工具 28ms。首次打开工作区约 2 秒，不随工具数增长，耗在建会话运行时上。

### 放弃的方案

- 给 pi 打补丁，加 `registerTools` 批量接口或让 `registerTool` 延迟刷新：仓库里有过 pi 补丁脚本，可行；但延迟刷新会让紧跟其后的 `setActiveTools` 看不到新工具（它按工具表过滤名字），要连带改 `setActiveTools`，补丁面更大，每次升级 pi 都要重打。现在只依赖一个私有方法名，改名时 `tool-refresh-batch.test.ts` 的契约用例会失败。
- 只做指纹去重、不合并刷新：重连、断开已经不再登记，但第一次连上 N 个工具仍是 N 次全量刷新，平方级还在。
- 只合并刷新、不做指纹去重：一次投影只刷新一次，但每次推送仍把全部定义重新登记、重建一遍工具表，连接中 / 失败这类与工具无关的推送也要付一次全量刷新。
- 投影前先关掉 codemode、登记完再打开：省掉每次的描述渲染，但包装全部工具仍是平方级，且切换 codemode 会改动系统提示。

### 后果

- 依赖 pi 的私有方法 `_refreshToolRegistry` 及「refreshTools 动作每次现取它」这一实现。升级 pi 时契约用例会拦住改名；实现若改成闭包里直接引用原方法，合并会静默失效，只会变回原来的平方级，不会出错。
- 服务器断开或被关掉后，它的工具仍登记在会话里（pi 没有注销工具的接口），只是不在激活集里。这和改动前一样；指纹缓存让它重连时不必重新登记。
- 批量范围是同步代码块，进程里同一时刻只有一个批量在进行，不会合并到别的会话在别处触发的刷新。

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
