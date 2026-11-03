# GrenAgent 集成说明：已核对的宿主接口与新模块接缝

## 适用范围与验证边界

本说明基于只读检查的 **GrenAnHao/GrenAgent `master` 提交 `310e57280b58766ad1f67cd5b2ff7e5d61667ee2`**（2026-10-30 检查）。以下区分「宿主已有」与「本项目新增」，不把建议当成现成宿主 API。

**本项目没有修改、推送、安装到 GrenAgent，也没有完成真实 Electron 集成。** 当前交付有独立 Node 子进程、编译检查过的结构化接线示例、桥接单测，以及实际 Node 22/24 测试；单文件 CJS 子入口已在实际 Node 22 子进程中冒烟运行。这些都不等于 Electron 二进制、打包应用、窗口导航或应用退出路径的实机验收。

## 1. 进程边界：Repo 服务不在主进程运行

```text
GrenAgent renderer / RepoWikiPanel
  → window.gren.invoke / subscribe（现有 preload）
  → Electron main：命令鉴权、路由、进程 supervisor、模型 broker
  → 独立 repo-wiki-host OS 进程：service、扫描、Git、SQLite、任务、watcher
  ← 带 project / run / instance / sequence 的进度事件
```

本项目对应文件：

| 文件 | 实际入口与职责 |
| --- | --- |
| `packages/process/src/client.ts` | `RepoWikiProcessClient`；`start()`、`invoke(action,input)`、`subscribe(handler)`、`onLifecycle(handler)`、`stop()`、`pid`。主进程安全依赖，不导入 engine、service、scanner、SQLite。 |
| `packages/process/src/child.ts` | 唯一创建 RepoWiki `WorkspaceService` 的子入口；拥有工作区引擎、存储和 watcher；处理关闭、断连及模型反向请求。这里的 WorkspaceService 是本项目类型，不是 GrenAgent 同名类。 |
| `packages/electron/src/index.ts` | `registerGrenRepoWiki(client, host)`，注册新命令并校验 sender / workspace；返回 disposer。仅做边界授权所需的路径规范化，不扫描、建索引或打开 SQLite。 |
| `packages/renderer/src/index.ts` | `createGrenRepoWikiClient(runtime)`；只依赖 renderer-safe contracts。 |
| `apps/web/src/RepoWikiPanel.tsx` | `<RepoWikiPanel client={client}/>`；嵌入模式 `syncLocation=false`，不占用宿主路由。样式随组件导入，仍需宿主检查样式冲突。 |
| `examples/grenagent/integration.ts` | 可编译的结构化端口示例：`mountRepoWikiMain`、`repoWikiRenderer`、`bindRepoWikiAppQuit`；不是已经应用到宿主的补丁。 |

宿主已有的 [AgentProcessClient][host-process] 使用 `node:child_process.spawn`，不是 `utilityProcess`：以 `process.execPath` 启动入口，设置 `ELECTRON_RUN_AS_NODE=1`、Node IPC、`serialization:'advanced'`、`windowsHide:true`。已有 [agentdata-host 子入口][host-data-entry] 单独拥有 `agent-data.db`，后台 Wiki/记忆任务不占主进程。

本项目沿用这一**进程模式**，不是复用宿主私有类或冒充同一协议：它自己的 supervisor 使用 `spawn`，默认可执行文件为 `process.execPath`，通信格式由 `packages/contracts/src/index.ts` 定义。宿主的 `RpcPeer` 实际在 [extensions/_shared/rpc-peer.ts][host-rpc]，其 `t:'req'/'res'/'evt'` 格式与本项目的版本化 `type` 消息不同，不能直接混接。

子进程退出会拒绝在途请求、取消尚在主进程执行的模型调用；重启有预算限制，不自动重放已经提交的修改。renderer 重新读取项目/任务状态，不凭一次事件推断任务完成。

## 2. Renderer 与现有 IPC 的衔接

宿主 [src/platform/runtime.ts][host-runtime] 已有：

```ts
interface GrenRuntimeBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  subscribe<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
  // 宿主还提供窗口、选目录和打开路径等方法；新适配器只需要以上子集。
}
```

宿主 [preload.ts][host-preload] 将 `invoke` 转为 `gren:invoke` 上的 `{command,args}`，订阅 `gren:event:${event}`；[ipc/contracts.ts][host-contracts] 定义这些通道。[ipc/register.ts][host-register] 导出 `registerCommand(command, handler(event,args)): void`，并由已有 `registerIpcHandlers` 分发。

本项目新增 `repoWiki_*` 命令与 **`repoWiki://progress`** 事件；命令完整列表以 `ACTIONS` 为准。宿主当前不存在这些命令，必须显式调用 `registerGrenRepoWiki` 才能使用。

接线需要提供：

```ts
registerGrenRepoWiki(client, {
  registerCommand,                    // 接宿主已有注册表
  isTrustedSender(event) { /* 验证当前顶层 URL、受信窗口与 frame */ },
  async allowedWorkspaces(event) { /* 从宿主已批准状态返回目录 */ },
  // 可选 sendEvent(recipient, eventName, payload)
});
```

上面是端口示意，不是可复制即用的权限实现。`isTrustedSender`、`allowedWorkspaces` 是**本项目要求宿主实现的新回调**，不能从 renderer 自报的路径/URL推导权限。生产不得用 `() => true` 代替 sender 验证。

默认事件发送是对已授权 recipient 的 `sender.send('gren:event:repoWiki://progress', payload)`，不是宿主原有的全窗口广播；发送前重新检查权限。嵌入模式禁止 `clone`，仅接收宿主已批准的本地仓库。renderer 用 `createGrenRepoWikiClient(window.gren)` 或等价结构化端口，不直接引用 Node/Electron，也不启动另一个 HTTP 服务。

宿主 `registerCommand` 当前不返回注销函数；本适配器接受这种签名，dispose 后旧闭包拒绝调用并停止推送。热重载/重复注册时应先 dispose 旧实例；若宿主增加注销能力，可返回 remover。不要为了新功能再次注册现有 `gren:invoke` handler。

## 3. 模型：借用短调用，不占用交互会话

宿主 [ModelRuntimeHost][host-model] 的主进程实例在 [main.ts][host-main] 中创建；交互 agent-host 内还有另一实例。RepoWiki 接主进程短调用实例：

```ts
complete: (input, signal) => modelRuntimeHost.completeSimple({
  ...input,  // user, systemPrompt, maxTokens
  signal,
})
```

`ProcessOptions.complete` 以反向 IPC broker 暴露给 child，不将 API key、OAuth 状态或 `ModelRuntimeHost` 对象传给 renderer。子进程的 `modelRequest` / `modelCancel` 对应主进程 AbortController；signal 与函数不跨进程序列化。`modelCacheKey` 必填，应是宿主选定 provider/model/配置版本的非秘密稳定标识；切换模型后更新标识并重建对应 supervisor，避免沿用旧模型缓存。

这是对宿主现有模式的适配：其 [agentDataProcess/host.ts][host-data-host] 将模型调用转换为 `main.model.complete {requestId,input,withUsage}` 与 `main.model.abort {requestId}`，主进程保留鉴权能力。本项目使用自己的消息类型，不声称已经注册这两个宿主 RPC 方法。

宿主 `completeSimple` 返回 `Promise<string>`，实际转发 `signal` 和 `maxTokens`；不要因输入类型中存在 temperature/reasoning/samplingParams 就承诺这些字段对非流式调用生效。宿主虽有 `streamSimple`，本项目当前 broker 是完成文本接口，不宣称提供模型 token 流；页面阶段进度是另一条事件通道。

不要用宿主 `agent_prompt` / `agent_abort` 运行 RepoWiki 后台生成。这些命令经 [PiRuntimeService][host-pi] 控制交互/目标/子代理会话，并涉及 `targetSessionPath`、停靠会话和前台状态；Wiki 作业不应改变这些状态。取消只尽力终止调用，已在飞的模型请求仍可能计费。

## 4. 工作区、数据与内置 Wiki 的区别

宿主 [WorkspaceService][host-workspace] 的 `ensureWorkspace(workspace):Promise<string>` 做 realpath、路径显示规范化和项目登记；它**不是 Git 根目录探测 API**。应由宿主提供规范化、已批准的目录给本模块：

- `ProcessOptions.allowedRoots` 限制 child 可用的目录范围；`GrenRegistration.allowedWorkspaces` 则针对当前 sender 再做授权。两者都要设置，不能只做 UI 过滤。
- 需要扩大 child 根目录集合时重建 supervisor；不要假定动态 renderer 授权自动修改 child 启动配置。
- 保留 worktree 的独立实际目录身份，不按共享 Git common-dir 将两个工作区混成一个。
- 宿主 `ensureWorkspace` 可能登记/创建其临时工作区；不要把它当无副作用的纯读取工具。

宿主已有 [WikiService][host-wiki]、`agentData_wiki_*` 和 `userData/wiki`，主要处理原始文本/Markdown知识库，**不是本项目的仓库 Wiki**。宿主 `userData/agent-data.db` 默认由 agentdata-host 独占；新 RepoWiki 必须使用宿主指定的独立 `dataDir`（例如 `join(app.getPath('userData'),'repo-wiki')`），不得直接打开、迁移或覆盖宿主数据库、内置 Wiki 或旧 Python 工程目录。

## 5. 构建入口、asar 与退出

本项目 `npm run build:electron` 生成单文件 CJS 子入口：

```text
dist/electron/repo-wiki-host.cjs
```

有两种明确的宿主装配选择，二选一，并检查实际打包产物：

1. **使用本项目现成 CJS bundle**：将其复制进宿主生产 main 输出（例如 `out-pkg/main/repo-wiki-host.cjs`），在 builder `asarUnpack` 中包含该文件，运行时解析 `resources/app.asar.unpacked/out/main/repo-wiki-host.cjs`。开发时也应传入实际构建产物路径，而不是未编译的 `.ts`。
2. **由宿主 electron-vite 构建 child**：参考 [electron.vite.config.ts][host-vite] 的 `mainInput`，新增独立子入口；沿用宿主 CJS/字节码产物格式时，需把对应 `.js/.jsc`、必要 chunks 与 loader 纳入 unpack。

宿主 [workerEntry.ts][host-worker-entry] 已将 dev 子入口解析为 `join(mainDir,name)`，生产解析为 `join(resourcesPath,'app.asar.unpacked','out','main',name)`；[electron-builder.yml][host-builder] 将 `out-pkg/main` 映射到 `out/main` 并显式 unpack 各 child。**当前不存在 repo-wiki-host 对应宿主入口/配置，以上需要宿主实际修改。** 不要假设从 `app.asar` 内直接 spawn 可行，也不要随意给宿主字节码入口添加改变 V8 指纹的参数。

退出必须等待 `dispose()` / `client.stop()` 完成。宿主 main 已有 `before-quit` 防重入及异步 shutdown 链，应把 RepoWiki cleanup 纳入该链；`bindRepoWikiAppQuit` 是独立示例，不应不加协调地再装一套竞争的 quit handler。保持模型 broker 可用直到子进程停止并收回模型调用，随后再释放相关模型能力。

## 6. Node / Electron 版本与仍需验收的事项

宿主 [package.json][host-package] 声明 Electron `^38.0.0`，[pnpm-lock.yaml][host-lock] 锁定 **38.8.6**。[Electron 官方发布页][electron-release] 确认其嵌入 **Node 22.22.0**，并明确 **Electron 38 已结束支持**。这里是兼容基线，不是继续使用 EOL Electron 的安全推荐；升级宿主应单独评估与回归，不由本项目静默改版本。

本项目 Node 最低要求为 `>=22.13.0`，目标 bundle 为 Node 22；宿主已经使用 `node:sqlite/DatabaseSync`，但不能因为开发环境是 Node 24 就引入其专有 SQLite API。

接入前仍需在真实 GrenAgent 中验证：

- 开发版与打包版 child 能启动，PID 与 main 不同，入口位于正确的 unpack 路径。
- 真实窗口/frame 信任检查、跨窗口与切换工作区后的权限撤回、事件收件人隔离。
- UI 卸载/重挂、反复打开、HMR、导航后旧 sender 不能继续取得数据。
- 真实模型配置切换、失败、取消、退出时在途调用清理；确认 source 外发的用户提示。
- 崩溃恢复、任务状态恢复、应用退出等待，以及无遗留 child / watcher / 数据库锁。

[host-process]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/agentProcess/agentProcessClient.ts
[host-data-entry]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/agentDataProcess/hostEntry.ts
[host-rpc]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/extensions/_shared/rpc-peer.ts
[host-runtime]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/src/platform/runtime.ts
[host-preload]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/preload.ts
[host-contracts]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/ipc/contracts.ts
[host-register]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/ipc/register.ts
[host-model]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/agent/modelRuntimeHost.ts
[host-main]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/main.ts
[host-data-host]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/agentDataProcess/host.ts
[host-pi]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/app/piRuntimeService.ts
[host-workspace]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/app/workspaceService.ts
[host-wiki]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/agentData/wikiEngine/service.ts
[host-vite]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron.vite.config.ts
[host-worker-entry]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron/agent/workerEntry.ts
[host-builder]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/electron-builder.yml
[host-package]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/package.json
[host-lock]: https://github.com/GrenAnHao/GrenAgent/blob/310e57280b58766ad1f67cd5b2ff7e5d61667ee2/electron-agent/pnpm-lock.yaml
[electron-release]: https://releases.electronjs.org/release/v38.8.6
