# Repo Wiki 项目文件与按需服务验收

2026-10-31。本轮落实宿主项目即时显示、重任务按需执行及项目文件事实来源。前两阶段的 [进程接入](../2026-10-31-repo-wiki-process-integration/README.md) 和 [调度接线](../2026-10-31-repo-wiki-host-workflow-alignment/README.md) 保留为历史记录；其中全项目首屏准备、固定频率扫描及 SQLite 唯一文档存储已被本轮取代。

## 当前行为

左侧 Repo Wiki 首帧直接显示宿主已加载项目及当前项目壳，模型、服务或文件系统尚未准备好时也可展示和选择。`activate` 只绑定视图与工作区；后台 `hydrate` 仅准备当前项目。普通 A-B-A 与关闭/重进复用 child，token / view_id / run scope 隔离旧响应，释放不会撤销后来的视图。

正文、计划和元数据落在 `<项目>/docs/repo-wiki/<语言>/`。Markdown 与 JSON 保存人工文本、生成基线、冲突候选、来源、历史 namespace 和 revision；`project-index.sqlite3` 只是可重建投影与生成缓存。旧 `workspace.sqlite3` 原件保留，仅当前项目按需迁移。文件 portable 身份可携带，运行 id 按当前规范化目录、语言和 portable id 派生，避免克隆目录串写。

```text
首屏：宿主已加载项目 → renderer 摘要/当前项目壳
准备：hydrate → 当前根授权 → Repo Wiki OS child → 项目文件/索引
生成：固定 model lease → AgentDataService → AgentData child / WikiService
      → 主进程 ModelRuntimeHost / Pi SDK → provider
```

扫描和旧库快照在后台可取消；旧库 Worker 使用同一 host bundle，无额外打包资源。状态读取不扫描，watch 按变化通知节流，产物不反馈进源码。固定 2.5 秒全量扫描已移除；运行状态事件优先，兜底查询不重叠。模型只在生成前准备，继续复用 WikiService 共享预算。

## 测量边界

| 测量 | 最新结果 | 证据与范围 |
| --- | --- | --- |
| 生产渲染首显 | **318.8ms** | [JSON](task-4-first-visible.json)、[真实 Electron 日志](task-4-harness-raw-utf8.log)；模块真实点击到七摘要及当前壳 DOM 可见，activation / host snapshot 故意阻塞到断言和截图后才放行 |
| 七项目冷 activation | **7.576ms** | [样本](cold-activation-sample.json)；实际 WorkspaceService 隔离登记及旧库 fixture，无模型解析、逐根授权 I/O、child 启动或目录写入 |
| 源码扫描中 health / run | **11.427ms** | [样本](scan-responsiveness-sample.json)；1000 文件隔离夹具，取消后模型调用为 0 |
| 1ms 扫描请求超时后重试 | **1096.168ms** | 同一 [样本](scan-responsiveness-sample.json)；超时不发布扫描身份，后续重试成功 |
| 约 50MiB 旧库迁移 | 控制查询可先返回，取消/stop 清理通过 | [Worker/服务回归](task-2-migration-regression-final.log)、[报告](task-2-report.md)；不混入上面的源码扫描耗时 |

首次隔离 activation 曾为 8.095ms / UI 首显曾为 319.6ms，保留在中间日志；上表是最终源码对应样本。UI 单独生产构建 5.9 秒另计，不计入首显。旧 OneDrive 现场 activation 33.48 秒只是前次诊断样本，数据及计时边界不同，不能计算为同环境倍速；本轮没有重启用户实例或对真实七项目复测/迁移。

集成样本关联 [源码指纹](task-5-source-snapshot.json)：`694c72cb01ed81c40bd46f72882346582b9f9c5459a236939adcc855b28cf775`。独立审查与当前源码核对无差异。

## 验证结果

各组存在重叠，不相加为总数。受影响修复通过后，只重跑对应检查，未扩大到其他 UI 场景。

| 检查 | 结果 | 最终证据 |
| --- | --- | --- |
| core 完整回归 | 7 文件 144/144；后续受影响 5 文件 98/98 | [完整](task-1-core-final-2.log)、[最终修复](task-1-identity-core-final.log)、[报告](task-1-report.md) |
| 异步迁移 hook | 15/15 | [日志](task-1-green-snapshot-hook.log) |
| service / process，实际 Electron-as-Node | 68/68 | [日志](task-2-migration-regression-final.log) |
| Windows watch 与权限边界追加回归 | 24/24、2/2 | [watch](task-2-windows-watch-green.log)、[权限](task-2-permission-green.log) |
| 宿主/工作区/生命周期 | 65/65；view ownership 23/23；测试类型修复 19/19 | [宿主](task-3-host-regression-final.log)、[ownership](task-3-view-ownership-green.log)、[类型边界](task-3-test-boundary-cast.log) |
| React / vendor UI | 30/30、71/71 | [React](task-4-react-final.log)、[vendor](task-4-vendor-ui-final.log) |
| 静默 Electron UI | 76 PASS / 0 FAIL，**仅 repo-wiki 1/44** | [原始 UTF-8 日志](task-4-harness-raw-utf8.log)、[报告](task-4-report.md) |
| 最新真实双 child / SDK 工作流 | 3 文件 12/12，6.90 秒 | [日志](task-5-integration-identity-final.log)、[报告](task-5-report.md) |
| 专用严格类型检查 | exit 0 | [日志](typecheck-final.log) |
| 最终生产构建 | exit 0 | [日志](build-final.log) |
| 实际生产 bundle 的 unpacked 路径 smoke | Worker 迁移/文件保存/旧 token 拒绝/同 PID 重进/退出通过，模型 0 调用 | [日志](production-smoke.log)、[结果](production-smoke-result.json) |
| 独立规格与质量审查 | Important 未决 0，三项发现均修复 | [审查](review-report.md)、[源文件清单](review-source-final-manifest.json) |
| 本轮定向空白检查 | exit 0 | [记录](diff-check.log) |
| 最终笔记门禁 | exit 0，133 篇、1 归档，6 条旧警告 | [日志](verify-notes-final.log) |

真实集成使用 WorkspaceService / opened-projects.json、Repo Wiki child、AgentData child / runtime / WikiService、真实 ModelRuntimeHost / Pi SDK，最终为 loopback HTTP provider；仅无关 CodeGraph I/O 是桩。覆盖旧 ingest 占共享预算、排队/运行取消、同 PID A-B-A、关闭释放、旧事件、模型与同 ID 配置变更保护。没有付费模型请求。

迁移 fixture 包含七条旧记录及人工页面；只当前根发布文件，其他六根没有知识目录，旧库字节不变。[迁移事实副本](task-5-current-root-migration/) 和 [删除新索引后恢复副本](task-5-index-rebuild/) 保留可检查的 Markdown / 元数据。

最终生产 bundle SHA256 为 `c81d045d72c39d243342d04582d04582f5f6542d4feea478b2bc76e84112b006`。复制到 `resources/app.asar.unpacked/out/main/repo-wiki-host.cjs` 形式路径后，实际 child PID 46732、父 PID 66948，停止完成；未生成安装包。既有动态导入提示未导致构建失败。

## 修改范围

工程路径相对 `electron-agent/`；完整文件清单见最终 source manifest。

| 范围 | 主要文件 |
| --- | --- |
| 宿主与生命周期 | `electron/app/repoWikiService.ts`、`workspaceService.ts`、`electron/main.ts`、`vendor/repo-wiki/packages/contracts/src/host.ts` |
| 项目文件与异步扫描 | `vendor/repo-wiki/packages/core/src/{engine,project-files,scanner}.ts` |
| 请求取消/Worker/模型 lease | `vendor/repo-wiki/packages/process/src/{client,child,legacy-snapshot}.ts`、`packages/service/src/service.ts`、`packages/contracts/src/index.ts` |
| 即时宿主 UI | `src/features/repoWiki/RepoWikiWorkspace.tsx`、其 runtime fixture/tests、vendor `App.tsx` / `RepoWikiPanel.tsx` / `workspace/ProjectCollection.tsx` / `api.ts` / `collection.css` |
| 验收 | core/service/process 对应 tests、宿主 lazy / lifecycle / workflow 集成、`ui-harness/scenarios/repo-wiki.tsx` / `probes/repo-wiki.mjs` |
| 文档 | 根 `AGENTS.md`、[文件使用说明](../../../docs/repo-wiki.md)、[实现计划](https://github.com/GrenAnHao/GrenAgent/blob/7cea05eac673e7046ee92748c2f01bc649764ba4/docs/superpowers/plans/2026-10-31-repo-wiki-project-files-and-lazy-service.md)、[决策](../../notes/implemented/architecture/2026-10-31-repo-wiki-project-files-and-lazy-service.md) |

## 边界

- 全 Node 类型检查仍失败，150 条原有诊断；本轮测试 fake 引入的两条已修，见 [最终检查](full-node-typecheck-final.log)。本次生产 strict 工程通过，不能据此声称全仓类型通过。
- 修改模型设置会拒绝尚未派发的旧配置请求；已经派发的 HTTP 不因设置变化自动 abort，明确取消/切项目/关闭仍传递 abort。每个 run 的模型缓存身份固定。
- 损坏缓存明确报错，本轮不自动 quarantine / 删除；事实文件保留，可以重建。任意外部编辑器不参与本工具锁时，不宣称具有内核级文件 CAS。
- 未重复跑全部无关后端或其他 43 个 UI 场景。未重启用户应用、批量迁移真实七项目、删除用户缓存、提交、推送或发布。开工时 567 项已有 dirty 状态保留，没有回滚无关内容。

修复前失败日志与最终成功日志一并归档，不将 sandbox 文件/HTTP 权限失败当作功能 RED。旧隐式扫描测试调整后仍保留来源、冲突、编辑、生成和隔离的语义断言。
