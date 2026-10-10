---
title: MCP 工具只登记有变化的定义，一次投影里的登记合并成一次工具表刷新
status: active
date: 2026-10-10
scope: extensions
files:
  - extensions/_shared/tool-refresh-batch.ts
  - extensions/mcp/index.ts
  - cli/src/gren-runtime.ts
  - extensions/multi-agent/embedded-runner.ts
  - extensions/multi-agent/activation.ts
supersedes:
superseded_by:
---

## 背景

`project()` 每次快照推送（连接中、已连接、失败、登录地址、断开）都把所有已连接服务器的每个工具重新 `pi.registerTool` 一遍。pi 1.1.0 的 `registerTool` 每调一次都同步执行 `refreshTools()`，也就是 `AgentSession._refreshToolRegistry()`：重新包装全部工具、重算 loadout，codemode 的 `prepareLoadout` 再把所有可调用工具渲染成描述。一次投影的开销是「工具数 × 全量刷新」。冒烟里 300 个工具重连一次，agent-host 子进程约 0.8 秒不响应；在 Electron 主进程里时，这就是开关 MCP 卡住窗口的主因之一（`electron-agent/2026-10-09-agent-host-child-process.md`）。

## 决定

- `project()` 收一个按 pi 会话保存的 `ProjectionCache`（工具名 → 定义指纹：服务器、原名、描述、inputSchema、exposure、namespace）。指纹没变的工具不再登记。连接中、断开、同样的工具重连，都不触发登记。`bind()` 每个 pi 实例一份缓存。
- 本次投影的全部登记放在 `batchToolRefresh()` 里同步执行。会话创建后、绑定扩展前，`installToolRefreshBatching(session)` 把实例上的 `_refreshToolRegistry` 换成可合并的版本：批量期间无参数的调用只记下，批量结束时每个会话刷新一次；带参数的调用（建运行时、reload）照常立即执行。pi 的 `refreshTools` 动作每次现取 `this._refreshToolRegistry`，所以不用改 pi。三处创建会话的地方都装：`gren-runtime` 工厂、嵌入式子代理、冷恢复子代理。
- 活动工具清单在批量结束、工具表刷新之后才算（`setActiveTools` 只认已在工具表里的名字），清单和当前完全一样就不再 `setActiveTools`。

冒烟（`electron-agent/scripts/agent-host-smoke.mjs`）：300 个工具重连时子进程最长不响应从 733ms 降到 11ms，1000 个工具 28ms。首次打开工作区约 2 秒，不随工具数增长，耗在建会话运行时上。

## 放弃的方案

- 给 pi 打补丁，加 `registerTools` 批量接口或让 `registerTool` 延迟刷新：仓库里有过 pi 补丁脚本，可行；但延迟刷新会让紧跟其后的 `setActiveTools` 看不到新工具（它按工具表过滤名字），要连带改 `setActiveTools`，补丁面更大，每次升级 pi 都要重打。现在只依赖一个私有方法名，改名时 `tool-refresh-batch.test.ts` 的契约用例会失败。
- 只做指纹去重、不合并刷新：重连、断开已经不再登记，但第一次连上 N 个工具仍是 N 次全量刷新，平方级还在。
- 只合并刷新、不做指纹去重：一次投影只刷新一次，但每次推送仍把全部定义重新登记、重建一遍工具表，连接中 / 失败这类与工具无关的推送也要付一次全量刷新。
- 投影前先关掉 codemode、登记完再打开：省掉每次的描述渲染，但包装全部工具仍是平方级，且切换 codemode 会改动系统提示。

## 后果

- 依赖 pi 的私有方法 `_refreshToolRegistry` 及「refreshTools 动作每次现取它」这一实现。升级 pi 时契约用例会拦住改名；实现若改成闭包里直接引用原方法，合并会静默失效，只会变回原来的平方级，不会出错。
- 服务器断开或被关掉后，它的工具仍登记在会话里（pi 没有注销工具的接口），只是不在激活集里。这和改动前一样；指纹缓存让它重连时不必重新登记。
- 批量范围是同步代码块，进程里同一时刻只有一个批量在进行，不会合并到别的会话在别处触发的刷新。
