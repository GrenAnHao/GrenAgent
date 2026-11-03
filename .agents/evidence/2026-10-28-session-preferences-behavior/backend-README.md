# 会话偏好（session-preferences）后端落实证据

核对面：2026-10-28。范围：后端与扩展（`extensions/`、`cli/src/gren-runtime.ts`、`electron-agent/electron/**`），
不含 renderer `src/**`、harness、App/ChatView/session store。全部为先 RED 后 GREEN。

## 新增/修改文件

新增：

- `extensions/_shared/session-preferences.ts` —— browser-safe 共享类型与纯解析（renderer 直接 re-export）。
- `extensions/_shared/session-preferences.test.ts`
- `electron-agent/electron/app/sessionPreferences.integration.test.ts` —— 真实 SDK 冷恢复 / setter 路径。

修改：

- `extensions/agent-mode/index.ts`、`extensions/agent-mode/index.test.ts`
- `extensions/approval/index.ts`、`extensions/approval/index.test.ts`
- `cli/src/gren-runtime.ts`、`cli/src/gren-runtime.test.ts`
- `electron-agent/electron/app/piRuntimeService.ts`、`.test.ts`
- `electron-agent/electron/app/settingsService.ts`
- `electron-agent/electron/ipc/register.ts`、`.test.ts`

## 关键行为

- 会话日志 `session-preferences` 条目保存**请求值**；`getState` 顶层 `model`/`thinkingLevel` 是 SDK 钳制后的**有效值**。
- 模型/思考恢复保留 canonical 请求值，并处理后续原生显式模型选择；SDK 的 thinking echo/能力钳制不把保存 high 抹成 off。模式/审查保持 last-wins，Plan 确认等自动行为继续生效。
- 模型切换后按请求值重算 effective（能力不够就交给 SDK 钳成 `off`），请求值保留。
- 不可用模型：保留请求值，`applied` 不含该字段，`unavailable` 含 `model`；目录刷新时**不**自动退到第一项
  （`refreshHandleModel` 只换同模型引用，模型消失就保留旧选择让用户重选，回到目录后恢复）；`agent_prompt` 拒绝
  `SESSION_MODEL_UNAVAILABLE`；目录恢复后 prompt 前把 live 切回请求的模型并重套档位（只改 effective，不改 canonical）。
- 写入按会话串行：入队时锁定 sessionId + sessionPath，执行前校验；handle 期间被换成别的会话就按原 path
  `openAdditional` 建非前景 handle，拿不到则 `SESSION_NOT_LOADED`。session 对象与 sessionManager 在写开始时冻结，
  全程不再重读 `handle.session`。
- 会话替换（switch/new/fork/clone/rewind）与 `releaseSessions` 都会先等在途偏好写收口。
- auth 预校验 → canonical 先落 → live 后应用；canonical 落盘失败摘除失败的内存条目，live 应用失败则恢复原 live/canonical，抛 `PREFERENCES_PERSIST_FAILED`，不假报成功。
  SDK 的 `_appendEntry` 会先改 `fileEntries/byId/leafId` 再 `_persist`，故障注入验证了内存与重开值保持旧请求；模型回滚使用可写的 `session.state.model`，不赋值只读 getter。
- 每次成功提交推 `setStatus('session-preferences', JSON.stringify(快照))`（T12 跨视图同步）；失败不推。
- 新命令：`agent_get_session_defaults` / `agent_set_session_defaults`（workspace 键规范化 + resolved 双写，
  不动现存会话）；`agent_new_session` 支持 `initialPreferences` 并回传 `sessionId/sessionPath/sessionFile/preferences`。
- 冷恢复：`cli/src/gren-runtime.ts` 恢复 canonical 思考请求及后续显式原生模型选择；模型不在目录时不传。主线程追加了真实工厂入口的 native 换模 RED→GREEN，见 `factory-native-restore-green.log`。

## 日志

- `backend-red-01-shared.log`：共享模块缺失（RED）
- `backend-red-02-extensions.log`：扩展固化初值未实现（RED）
- `backend-red-03-runtime.log`：12 条偏好行为未实现（RED）
- `backend-green-01-runtime.log` / `backend-green-02-runtime.log`：runtime 单元 GREEN
- `backend-green-03-gren-runtime.log` / `backend-green-06-gren-runtime.log` / `backend-green-11-gren-runtime.log`：冷恢复 GREEN
- `backend-green-05-targeted.log` / `backend-green-07-targeted.log` / `backend-green-09-targeted.log` / `backend-green-13-targeted.log`：定向 GREEN
- `backend-green-10-extensions.log`：扩展 GREEN
- `backend-green-13-targeted.log` / `backend-green-14-final-targeted.log`：定向回归
- `backend-green-15-gren-runtime.log`：冷恢复最终结果
- `backend-green-16-review-fixes.log`：独立 review 四项高 + 中项修复后的定向回归
- `backend-green-17-t15-refresh.log`：目录移除模型不再静默 fallback（T15）后的定向回归
- `backend-green-12-main-project.log`：`--project main` 全量（含与本任务无关的既有失败套件）

## 结果

- `electron/app/piRuntimeService.test.ts`：106 条通过。
- `electron/app/sessionPreferences.integration.test.ts`：9 条通过（真实 ModelRuntime + SessionManager + AgentSession，
  假 apiKey，`allowModelNetwork:false`，零外网）。
- `electron/ipc/register.test.ts`：28 条通过。
- `extensions/_shared/session-preferences.test.ts` + `agent-mode/index.test.ts` + `approval/index.test.ts`：94 条通过。
- `cli/src/gren-runtime.test.ts`：最终 8 条通过。
- 合并定向回归（`piRuntimeService` + `sessionPreferences.integration` + `register` + `workspaceHandle` + `agentHost` + `settingsService`）：207 条通过。
- 类型检查：根 `tsc --noEmit` 的空 files 不作证据。主线程实际执行 `tsc -p tsconfig.node.json --noEmit`，修复了本次 Ack 有效字段和工厂 unknown model 的新增诊断；工程仍有既有测试/声明/AgentData 错误，完整日志见 `main-process-types-final.log`，不宣称全工程通过。

## 未覆盖限制

- 未在多窗口 / 分屏真实 Electron 里实跑；跨窗口同步只验证到宿主推 `session-preferences` 状态这一步
  （renderer 侧 `applyServer(sessionPath, revision)` 由前端 worker 负责）。
- 内存回滚依赖 SDK 私有的 `fileEntries` / `byId` / `leafId` 字段；找不到或形状变化时不回滚（保守不动内存），
  该分支未做故障注入验证。
- canonical 粘性对「扩展直接 `pi.setModel`」是保守判定的：原生 `model_change` 一律视为显式选择；
  thinking 需要钳制判定才能区分「用户切换」与「SDK 钳制 artifact」，判不出时保留请求值。
  我们自己的 setter 写下派生 effective 时会登记 echo 并跳过读取，用户之后真的切到同一档位仍能被识别（只吞一次）。
- 会话替换（switch/new）只等当前前景会话在途写；多个后台 handle 的并发写各自串行，未做全局屏障。
- 未实跑付费供应商；真实 SDK 测试用假 key 且不发请求（只到 auth 校验与会话状态层）。
- `agentData` / `tencentdb` / `subagentService` 等套件在 `--project main` 全量里有既有失败，单独跑同样失败，
  与本次改动的模块无引用关系。
- 历史会话缺字段首次补齐在扩展侧写 session-preferences；旧 agent-mode/session-controls 仍兼容读取。
