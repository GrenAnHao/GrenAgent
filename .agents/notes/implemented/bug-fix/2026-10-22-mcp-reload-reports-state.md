# Agent Note: 设置页「重载」MCP 后用 manager 的回报更新状态

Status: implemented

## Problem

js-reverse-mcp 在 16:14–16:17 连了几次都失败（`pnpm start` 先跑 `tsc`，当时另一个会话正在改这个项目的源码，编译不过，进程一退出客户端就报 `Connection closed`）。源码修好以后，设置页的卡片一直显示「连接失败」，点「重载」也不变。

当时的实况：

- `~/.pi/agent/mcp.log` 里 16:47:41 那次重载发起了 connect，16:47:45 `mcp.json` 被改写，7 个工作区的 manager 同时重连，最后 7 条 `connected`。
- agent-host 底下有 7 个 js-reverse-mcp 进程，都是 16:47:53 起的。
- 在这个 agent-host 里的会话中直接调 `mcp__js_reverse_mcp__list_pages`，请求到了服务器，服务器回的是「还没连浏览器」，不是连接错误。

manager 是好的，面板却一直显示失败。原因在状态怎么到界面：面板的状态只来自会话里 MCP 扩展的推送（`extensions/mcp/index.ts` 的 `render` → `mcp.state.publish` → 主进程按会话 cwd 映射成 handle 的 workspace → `setStatus('mcp')`）。这要求那个工作区里有活会话订阅着这个 manager，而且会话 cwd 能映射回面板用的 key。重载（`mcp.reload` → `reloadMcpServer`）直接作用在工作区的 manager 上，自己什么都不回报。链上哪一环对不上，重连成功了界面也收不到，面板就一直停在上一次推上来的 `failed`。

到底是哪一环断的没有查实：开发版没开调试端口，读不到渲染层的 store；重启应用又会把现场一起清掉（本会话也跑在这个 agent-host 里）。旁证是 agent-host 里有 7 个工作区 manager，从早上起一个都没释放过，而 handle 和会话会关、会换，manager 的寿命按工作区 lease 算，和订阅它的会话不同步。

## Decision

重载把这个工作区 manager 的权威状态带回来，由主进程按面板传来的 workspace 直接推给界面：

- `reloadMcpServer(workspace, name)` 重连完返回 `summary(mgr.snapshot())`。`summary` / `ServerSummary` 从 `extensions/mcp/index.ts` 挪到 `extensions/mcp/summary.ts`（index 原样再导出），manager 用它不会形成循环引用。查找 manager 的函数可以注入，测试用。
- agent-host 的 `mcp.reload` 把这个返回值原样回给主进程，`mainBindings` 的 `agent.mcp.reload` 透传出来（类型 `unknown[] | null`）。
- `McpRuntimeHooks` 多一个 `publish(workspace, servers)`。`McpConfigService.reload` 拿到数组就发布；拿到 null（旧子进程）就不发布，免得用空列表把界面清掉。
- `main.ts` 把 `setStatus('mcp')` 的广播抽成 `publishMcpState`，会话推送和重载回报共用。

会话扩展的订阅推送不变，仍然负责开机、配置变化这些不是用户点出来的状态变化。

## Alternatives considered

- **让 manager 自己推状态，不经过会话** — 最强理由：从根上去掉对会话订阅的依赖，开机、配置热重载、断线也都准。没做是因为 manager 在扩展层，不认识主进程的通道，要么让 manager 拿到 control 端口，要么在 agent-host 里给每个 manager 挂监听，还要处理 manager 的 key（handle workspace）和会话 cwd 两套 key 的对应关系，改动面比这次的症状大得多。这次只修用户能操作的那条路：点了重载就一定看到真实结果。
- **先查清是哪条订阅断了再修那一环** — 最强理由：修在根上。没做是因为现场查不到（见上），而且就算修好那一环，「重载不回报结果」这个设计缺口还在，下次换一种断法照样卡住。
- **面板直接读工具缓存 `mcp-tools-cache.json`** — 最强理由：不用改进程间契约。没选是因为缓存按 server 名全局一份、内容没变不重写，表示不了「这个工作区现在连没连上」，而且卡片里 runtime 状态优先于缓存，已经推上来的 `failed` 照样压着它。

## Consequences

收益：点「重载」后卡片一定显示这个工作区 manager 重连后的真实状态，不再被旧推送卡住。

代价和已知缺口：
- 没有活会话订阅时，开机、改配置、服务器自己断线这类变化仍然到不了面板，只能靠点重载刷新。
- 主进程现在会收到同一工作区两份状态（会话推送和重载回报），后到的覆盖先到的。两份都来自同一个 manager，内容一致；只有会话绑在另一个 manager 上时会互相覆盖，那正是本篇没查实的那种断法。
- `mcp.reload` 的返回值是新契约，旧 agent-host 回 null，主进程按旧行为处理。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 先失败、重载后返回 `connected` 和工具全名；重载仍失败时如实返回 `failed` | `cd extensions && npx vitest run mcp/manager.test.ts -t reloadMcpServer` | 通过；先红（返回 undefined）后绿 |
| `McpConfigService.reload` 把返回的状态按 workspace 发布；返回 null 时不发布 | `cd electron-agent && npx vitest run electron/app/mcpConfigService.test.ts` | 通过；发布那项先红后绿 |
| MCP 扩展、agent-host 绑定回归 | `npx vitest run mcp`（extensions）、`npx vitest run electron/agentProcess`（electron-agent） | 196 项、64 项通过 |
| 类型 | `electron-agent` 下 `npx tsc -p tsconfig.node.json --noEmit` | 改过的源文件没有新报错；仓库原有 155 个报错（`index.test.ts` 的 mock 类型、`mcpConfigService.ts:60`、`index.ts` 的 `args/env`）不在本次改动里 |

verify: n/a 真实应用里点「重载」看卡片变绿：正在用的开发版没开 watch，主进程和 agent-host 要重启才加载新代码，重启又会把卡住的旧状态一起清掉，复现不出原来的现场。需要用户重启后再遇到时确认。

结果：部分通过（单测与类型检查通过，没有在应用里实跑）。
