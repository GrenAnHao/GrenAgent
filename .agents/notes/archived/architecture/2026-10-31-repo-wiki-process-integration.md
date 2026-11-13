# Agent Note: Repo Wiki v3 独立进程接入

Status: implemented
Archived: 2026-11-13

## Problem

已认可的 TypeScript Repo Wiki v3 需要进入 GrenAgent 的真实导航、工作区与模型配置，不能用 standalone demo 代替宿主集成。扫描、索引、生成和 SQLite 不能占用 Electron 主进程，也不能与 AgentData Wiki 共用数据库。

## Decision

产品入口及后台任务归属现由 [AgentData 持久化任务](2026-11-01-repo-wiki-agentdata-durable-tasks.md) 取代：Repo Wiki 位于 AgentData 标签，生成进入共享 agent_jobs 账本和执行器，页面不再拥有生成生命周期。本篇独立工作进程、构建许可与文档存储语义仍有效；下文旧页面取消约定不再用于生产生成任务。

将 SHA256 `899862f29c20f402e379dcab35bc2fa603f61aa4e3c52e1e015a47ac4c7988b5` 的源码包作为 `electron-agent/vendor/repo-wiki` 保存，保留 MIT 许可与原始集成说明。使用源码中已有的 typed contracts、process supervisor、Electron registration、renderer adapter 和 RepoWikiPanel。只适配宿主边界，保留浅色森林绿界面。

主进程只创建 supervisor、验证窗口与已登记工作区、转发 `repoWiki_*` 及定向进度事件。首版直接调用 ModelRuntimeHost、手工连接项目的流程已由 [宿主工作流修正](../bug-fix/2026-10-31-repo-wiki-host-workflow-alignment.md) 取代：现经 AgentDataService / WikiService 现有知识调度再到 ModelRuntimeHost，项目自动跟随 WorkspaceService 与 activeWorkspace；该笔记记录当前模型配置、取消、上下文及恢复契约。独立 dataDir 使用 userData/repo-wiki。子入口由宿主构建为独立资源并解包到 app.asar.unpacked；关闭应用等待 supervisor.stop。

## Integration

- `RepoWikiService` 校验真实窗口与顶层 frame、宿主登记和当前上下文。全项目首屏准备与旧进程替换流程由 [项目文件与按需服务](2026-10-31-repo-wiki-project-files-and-lazy-service.md) 取代：普通切换只释放旧 scope 并复用 child，模型按生成 run 绑定；数据访问前核验当前根。空目录集合不落入上游 unrestricted 模式，无模型仍可阅读，真实生成保留源码外发确认。
- `RepoWikiWorkspace` 连接平台 invoke/listen 与 activeWorkspace；原版 Panel 的关闭动作回到对话，模块离开 guard 保护草稿与在途保存，卸载释放订阅与轮询。`repo-wiki` 场景走真实导航和页面。
- `repoWikiHostBuild.ts` 用 esbuild 生成 Node 22 单文件 `repo-wiki-host.cjs`，开发和生产分别进入 out/main 与 out-pkg/main；builder 单独 unpack。child 没有共享 chunk 或运行时 npm 依赖。主进程不导入 engine、scanner 或 SQLite。
- `tsconfig.repo-wiki.json` 检查实际新源码并进入 build 门禁；`test:repo-wiki` 使用临时构建、真实 Electron child 和并发 2 的上游回归。Windows 仅扩大完整工作流测试上限，单次请求及 run 等待时限不变。
- 许可证收集从已安装的 pnpm 生产依赖闭包取真实包名、版本与 peer/optional 依赖，多版本分别保留；加入 vendor MIT 与来源。既有依赖版本保持不变。

## Alternatives considered

- 直接把 engine 放进主进程最少 IPC，易调试；不用，因为扫描、SQLite 和生成会阻塞宿主，且违反用户明确的独立进程要求。
- 单独启动网页 demo 可以完全保留页面行为；不用，因为它绕开工作区、真实模型与应用生命周期，无法交付宿主集成。
- 与 AgentData Wiki 合并可复用存储与工具；不用，因为两者数据和接口语义不同，混用会破坏现有知识库契约。
- 由主构建的 mainInput 字节码流程编译 child 能复用既有入口；不用，因为单文件 CJS 明确隔离重型依赖与共享 chunk，降低 RunAsNode 解包加载的耦合。
- 沿用旧 npm-lock 许可证清单改动最小；不用，因为当前安装使用 pnpm，旧清单缺少新依赖和同名多版本。

## Behavior

导航可以进入原版项目列表、Wiki、知识卡片与阅读页面；真实 IPC 可创建已批准仓库、持久化和查询；子进程 PID 与主进程不同；模型请求可取消，退出时清理；崩溃受限恢复且不重放修改；开发和生产入口有可验证构建产物。只运行本次 repo-wiki 场景，不升级到全部 UI 场景。

## 验证

以下为首阶段证据，位于 `.agents/evidence/2026-10-31-repo-wiki-process-integration/`；不代表后续宿主流程修正的最终验收，当前证据见 `.agents/evidence/2026-10-31-repo-wiki-host-workflow-alignment/`。首阶段 `npm run build` 与真实 RepoWiki strict typecheck 通过；后端定向 52 项、前端定向 33 项、构建/许可 21 项通过。`npm run ui:check -- repo-wiki` 在正常权限的静默 Electron 中 37/37 通过，只跑 1/44 场景；三张截图已检查。初次沙箱 GUI 启动失败不作为最终结论。

`npm run test:repo-wiki` 最终 194/194 通过、无失败/取消/跳过，使用实际 Electron 子进程；上游面板 9 文件 71/71 回归通过（可用 `npm run test:repo-wiki-ui` 重跑），示例 3/3 通过。初次发现的 Windows Git 空设备、未提交 WAL 夹具与 HTTP 413 连接重置均有失败复现和修复后回归记录；没有跳过原始用例。

根目录 `npm run verify-notes` 通过，131 篇笔记与相对链接、归档和证据门禁有效，仅保留 6 条旧警告。

真实 Electron child 三组工作流通过，覆盖持久化、人工编辑冲突、取消/重试和崩溃恢复。实际生产产物复制到临时 app.asar.unpacked 路径后启动通过，PID 56796 与父 PID 30600 不同，停止完成。另用真实 BrowserWindow、正式 preload 和 registerIpcHandlers 验证创建/读取、跨窗口拒绝与导航后拒绝，主 PID 24960、child PID 85456，关闭无残留。模型仅用确定性桩，没有付费调用。独立审查无重要发现。

## Consequences

项目文件事实来源与首屏按需准备现由 [项目文件与按需服务](2026-10-31-repo-wiki-project-files-and-lazy-service.md) 记录。独立进程、构建和许可约束继续有效，当前验收见 `.agents/evidence/2026-10-31-repo-wiki-project-files-and-lazy-service/`。

独立进程保留界面和生成能力，同时增加一套 supervisor、资源路径和 vendor 维护成本。现有 AgentData Wiki 与数据库不受影响。当前整个旧工程的 node / harness 壳类型检查仍有既有诊断；本次新生产代码的独立 strict 工程与真实场景通过，没有把这些旧错误混入接入修复。未生成安装包、提交或发布；付费供应商响应未实调。
