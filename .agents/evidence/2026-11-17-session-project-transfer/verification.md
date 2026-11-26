# 会话跨项目移动：验证记录

变更：`move-sessions-between-projects`。全部数据来自临时目录、测试夹具或 UI 内存桩；未访问真实用户会话、凭据或付费模型。

## 定向测试

以下命令均从仓库根目录执行。没有运行全仓测试或其他 UI 场景。

| 检查 | 结果 | 输出 |
| --- | --- | --- |
| main 迁移模块、lease、工作区、用量、子代理服务 | 18 文件 / 214 通过 | `final-backend-vitest.log` |
| 补充：迁移后模型不可用时保留请求值、阻止 fallback 请求 | 1 通过，另 7 个运行时用例跳过；这 7 项已包含于前一轮 | `unavailable-model-runtime-vitest.log` |
| renderer action、草稿、来源、旧列表乱序、历史合并 | 9 文件 / 58 通过 | `final-renderer-vitest.log` |
| 扩展 registry／操作保护／历史来源 | 4 文件 / 40 通过 | `final-extensions-vitest.log` |
| UI `session-project-transfer` | 93 通过 / 0 失败；仅 1/56 场景 | `ui-check-session-project-transfer.log` |

```bash
cd electron-agent && npx vitest run --project main --maxWorkers 2 electron/app/sessionProjectTransfer*.test.ts electron/app/sessionOperationLease.test.ts electron/app/workspaceServiceTransfer.test.ts electron/app/usageServiceTransfer.test.ts electron/app/subagentService.transfer.test.ts
cd electron-agent && npx vitest run --project main electron/app/sessionProjectTransferRuntime.test.ts -t "unavailable requested model"
cd electron-agent && npx vitest run --project renderer --maxWorkers 2 src/features/sessions/sessionProjectTransfer*.test.ts src/stores/sessionTransferHistoryMerge.test.ts src/features/chat/transferSource.test.ts src/features/links/transferSourceLink.test.ts src/features/chat/sessionCwd.test.ts src/features/tools/extensionCards.test.tsx
cd extensions && npx vitest run --maxWorkers 2 multi-agent/session-project-transfer.test.ts multi-agent/session-operation-guard.test.ts _shared/session-project-transfer.test.ts _shared/session-transfer-source.test.ts
cd electron-agent && npm run ui:check -- session-project-transfer
```

此前合同与路由的定向验证见 `task-1.1-targeted-tests.log`（4 文件 / 63 通过），子代理写者退出与结算适配见 `adapter-tests.txt`、`subagent-service-tests.txt`。

## 事务与运行时边界

恢复测试共 64 项，其中故障矩阵检查 42 个持久化边界：before／after／registry 快照与 prepared／applying／committed／opened manifest 的 write-temp、flush、rename、rename 后；两份会话替换的准备、刷盘和替换；逐文件替换前后、registry apply／校验及目标校验。

其他用例检查外部追加、CAS 冲突、失锁后停止全部写入、prepare sentinel 并发、终态回执不受后续迁移影响。文件替换在临时文件刷盘后再次校验原摘要和 lease。目录别名下尚不存在的路径在创建前后使用同一锁键。

真实 SDK 运行时测试保持一个目标会话的本地 SSE 请求未结束，确认迁移以 additional handle 打开，原目标会话仍在流式运行。源会话忙碌时迁移被拒绝，未替用户中断。模型缺失时仍保留原 provider／ID，后续 prompt 返回 `SESSION_MODEL_UNAVAILABLE`，本地服务未收到 fallback 请求。

## 生产 IPC 路径

探针使用生产 `hostEntry.ts` 源码入口、真实 Pi SDK／扩展、真实 JSONL／registry／usage SQLite、真实 WorkspaceService 列表和项目删除。主进程侧提供临时授权端点及一次性 resolveWorkspace 故障；loopback 模型按阶段返回确定性工具调用，host fixture 拒绝非 loopback fetch。

```bash
node electron-agent/scripts/session-project-transfer-ipc-check.mjs
```

最终成功记录：`probe-final.log`，46 项断言通过、退出码 0；细节见 `production-ipc-results.json` 和 `production-ipc.md`。主线包括：预览、忙碌拒绝、提交后登记失败、幂等状态／重试、完整树和确认位置、主工具与可续聊子级实际读取目标同名文件、one-shot 只读、null-root、删除源项目、往返迁移和重复 reconcile。

7 次 loopback 请求分别归属于显式忙碌测试、迁移后的主请求、子级续聊及其工具循环／结算。初次移动、状态查询、重试打开和后续迁移阶段的模型请求增量为 0。新请求已计入；反复移动与补录前后均为 84 tokens、11 条调用、夹具费用 0.020052。这是测试数据，并非远程计费。

末端 4 个 operation 的 manifest 均为 `opened`，`readTransferJournalBlocks` 返回空列表，没有未完成事务阻塞。`probe-run1..16.log` 保留探针调试过程；`production-ipc-failure.historical.json` 是旧失败记录，不能当作当前结果。

## UI 与历史来源

6 张截图覆盖初态、确认弹窗、浅色／窄屏、移动后以及源文件缺失。缺失文件检查使用真实 AppLinkGuard → LazyMarkdown → 文件打开链路：源文件不存在、目标存在同名文件，点击仍只读源路径并显示错误，不尝试目标同名文件；原 README 脏标签和未保存计数保持。

本次场景没有额外覆盖每种历史图片／音频卡的真实磁盘加载；这些入口的来源绑定由定向单测检查。未运行其他已定档 UI 场景；没有修改全局样式、主题或 harness 基础组件。

## 类型检查与边界

执行后端与 renderer 的定向 `tsc --noEmit`，两次均以 1 退出。已有 agentData 重复函数、OAuth 类型引用、聊天／文件查看器等依赖诊断仍存在；本次迁移新模块没有直接诊断，诊断也没有落在当前 git diff 的新增行。未修无关代码，不能将整个类型检查记为通过。

原始输出见 `final-backend-typecheck.log`、`final-renderer-typecheck.log`；逐项定位见 `final-typecheck-diagnostics.json`。输入配置保存在 `tsconfig.session-transfer-input.json` 和 `tsconfig.session-transfer-renderer-input.json`，重现时先复制回 `electron-agent/` 并使用原 `.tmp.json` 文件名，再执行 `npx tsc -p <配置> --pretty false`。临时实现脚本／配置及会遮蔽 TypeScript 的旧生成文件已移到系统临时备份，映射见 `temporary-inputs-quarantine.json`、`stale-source-siblings.json`。

未验证安装包入口、真实用户目录或远程供应商；本次验收不宣称这些范围。没有修改 SDK、增加依赖、提交 Git 或自动 archive 此 OpenSpec change。

## 笔记与规格校验

- 根目录 `npm run verify-notes`：通过，退出码 0；156 篇笔记的树／格式、22 篇归档封印及证据检查通过，仍有 6 条既有笔记的结果措辞警告，本笔记无新增警告。
- `openspec validate move-sessions-between-projects --strict`：通过，退出码 0。
- 决策笔记已转到 `.agents/notes/implemented/feature/2026-11-17-session-project-transfer.md`；本 change 的 22 项任务按实跑证据完成，不自动 archive。
