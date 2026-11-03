# 会话独立记忆：实现与验证证据

日期：2026-10-28。实现说明：[Fast 与同项目会话独立记忆](../../notes/implemented/feature/2026-10-28-session-preferences-behavior.md)。全部在现有共享工作区完成，保留其它未提交改动，未创建 worktree、未提交、未推送。

本轮已落实四项会话偏好持久化、带原会话身份的读写与回执、显式项目默认、独立草稿及首发过户、删除清理、展开状态恢复。当时 Fast 保持按供应商＋模型共享；用户后续明确要求它也独立，现由 [Fast 第五项会话偏好](../2026-10-28-session-fast-mode/README.md)取代该共享部分。以下验证记录保留本轮历史。双 scope UI 和宿主/存储测试通过，不等同于已经实跑两个原生 BrowserWindow。

## 最终验证结果

| 验证范围 | 实际命令/结果 | 日志 |
| --- | --- | --- |
| 主线程生命周期/存储 | `cd electron-agent && npx vitest run src/features/chat/ChatView.test.tsx src/features/chat/ChatInput.test.tsx src/stores/chatDraftStore.test.ts src/features/chat/input/composerFiles.test.ts src/lib/pendingSession.test.ts src/lib/lastOpen.test.ts src/stores/agent.test.ts`：7 文件、155 条通过 | [最终主线程](main-review-fixes-green.log) |
| 后端最终父代理复核 | `npx vitest run electron/app/piRuntimeService.test.ts electron/app/sessionPreferences.integration.test.ts electron/app/settingsService.test.ts electron/app/fastMode.integration.test.ts`：4 文件、124 条通过，含真实 SDK/JSONL 与 Fast wire | [最终后端](backend-parent-final-green.log) |
| 后端合并定向 | runtime、SDK、IPC、workspaceHandle、agentHost、settingsService：207 条通过；扩展 94 条通过 | [后端明细](backend-README.md)、backend-green-17-t15-refresh.log |
| 冷恢复工厂 | `cd cli && node --import tsx --test src/gren-runtime.test.ts`：8 条通过；含 canonical 后原生显式换模不被旧选择覆盖 | [工厂最终](factory-native-restore-green.log) |
| Renderer 控件/回执 | 19 文件、157 条通过；另有输入相关 61 文件、509 条回归通过 | [前端明细](frontend-renderer-report.md)、frontend-green.log |
| 视图展开兼容 | store/hook/真实工具与时间线组件：6 文件、96 条通过 | [视图最终](view-final-compat-green.log) |
| 真实 Electron 新场景 | `npm run ui:check -- session-preferences`：98 条通过，双作用域 A/B、单项隔离、Ask/Plan、有效档提示、项目默认、草稿、工具展开、页面重载、浅色 | [98 项 UI](view-ui-session-preferences.log) |
| Fast 既有行为 | `npm run ui:check -- model-fast`：63 条通过 | [Fast UI](ui-model-fast-green.log) |
| 模式与计划控制面 | `npm run ui:check -- ultra-mode plan-panel`：74＋59 条通过；桥已更新为会话快照协议 | [Plan/Ultra](ui-plan-ultra-green.log) |
| 工具卡 | `npm run ui:check -- codemode-card invalid-arguments-card`：55＋27 条通过 | [工具卡 UI](view-ui-tool-cards.log) |
| 真实附件恢复 | `npm run ui:check -- composer-chips`：30 条通过，真实 IndexedDB、去 URL、复位不改存档、恢复两图/粘贴块 | [附件 UI](ui-composer-chips-green.log) |

UI 只点名与本次修改直接相关的 7/39 个场景，共 406 条断言通过，未运行其余全量。独立审查后的修复包括：删除自动选择复用 token、迟到发送仍经过原会话 lane、侧栏带原路径、未绑定草稿不猜旧会话归属、legacy-only 附件桶原子迁移、works 已使用草稿不重用，以及真实 SDK 的只读 getter/内存追加失败回滚。

## 红绿证据

- 身份：draft-red.log → draft-green.log。
- 过户/删除：composer-adopt-red.log → composer-adopt-green.log。
- 多窗口存储：attachments-cross-window-red.log、draft-cross-window-green.log、draft-attachments-cross-window-green.log。
- 迟到输入/首发：chat-input-red.log、chat-view-red.log、draft-create-failure-red.log → main-review-fixes-green.log。
- 审查修复：review-main-red.log、review-detached-send-red.log → main-review-fixes-green.log。
- 工厂原生换模：factory-native-restore-red.log → factory-native-restore-green.log。
- 展开 setter 回归：view-updater-red.log → view-updater-green.log / view-final-compat-green.log；单独的[回归笔记](../../notes/implemented/bug-fix/2026-10-28-session-view-updater-compat.md)。

部分新 store/helper 的初版是先实现再补测试，不能声称所有文件都严格先 RED。两份子任务报告保留实际偏差；新增竞态、持久化故障与后续修复的 RED/GREEN 均如实留存。第一轮新 UI 的失败是 probe 使用 radio.value（恒为 on）和本地化标签/旧标记，不是已验证的产品失败，修正选择器后再跑到通过，见 ui-session-preferences-first.log。

## 工程限制与未通过项

`tsc -p tsconfig.json` 的 files 为空，不作为渲染层证据。主线程用实际 include 的临时 config 检查，修掉本次新增的 setter、owner、有效值回执和工厂 model 类型问题。`renderer-types-final.log` 与 `main-process-types-final.log` 仍有工程既有错误（AgentData/wikiContracts、旧组件/测试声明等），所以不宣称整个工程类型检查通过。

主进程全量 `--project main` 另有既有失败，定向复跑仍可见超时/缺模块，见 backend-green-12-main-project.log 与后端报告；未借本任务修改这些无关模块。测试有 Node localStorage 路径/SQLite 实验性警告，Electron 有资源 pak 警告，均未导致上述通过项失败。

未访问付费供应商验证 Fast 加速或账单；Azure wire 未测。真实双 BrowserWindow 端到端与同一未落盘 draft 的跨窗口冲突合并未实跑；后者当前为后写覆盖。SDK 回滚依赖已安装 1.3.0 的内部 manager 字段，升级须重跑故障注入测试；dock 的既有整表持久化未改成跨窗口合并。

根笔记校验最终通过：115 篇目录、链接、格式与证据门禁通过；6 篇既有笔记的非阻断警告未改动。`git diff --check` 退出码 0。日志：[verify-notes.log](verify-notes.log)、[diff-check.log](diff-check.log)。附件场景中途 25 通过/5 失败来自旧复位动作把 owner 桶删除后仅恢复整表镜像，已按[独立回归笔记](../../notes/implemented/bug-fix/2026-10-28-composer-chips-reset-owner-storage.md)修为测试内短暂禁写，复跑 30 条通过。项目目录未发现 verify-* skill，采用定向 vitest、真实 SDK 故障注入与 electron-ui-harness。

截图：[会话恢复](shots/session-preferences-restored.png)、[浅色](shots/session-preferences-light.png)、[Fast 状态](shots/model-fast-trigger-fast.png)、[Fast 窄屏](shots/model-fast-narrow.png)。
