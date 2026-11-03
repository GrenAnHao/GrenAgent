# Fast 会话独立验证

实现目标：Fast 成为第五项会话偏好，不再按供应商＋模型共享；同项目同模型的 A/B 分别保存、读取和发请求。旧记录缺字段默认关闭；显式项目默认可以开启，普通开关不改默认。

## 已验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 共享布尔协议 | 27 条通过：true/false 解析、合并、部分记录回读与字段比较 | [shared-green.log](shared-green.log)，[shared-red.log](shared-red.log) |
| 宿主、IPC、真实 SDK | 3 文件 153 条通过：原路径提交、false 关闭、A/B 隔离、重载、初始草稿值、派生及显式默认 | [backend-green.log](backend-green.log)，[backend-red.log](backend-red.log) |
| 实际 provider 请求 | 5 条通过：真实 Pi schema/ModelRuntime/HTTP serializer，Claude 与 OpenAI Responses/Completions/Codex；旧共享 true 不影响 missing/false；思考和已发请求不变 | [wire-green.log](wire-green.log)，[wire-red.log](wire-red.log) |
| 共享协议与请求钩子类型 | 两个实际源文件检查退出码 0 | [shared-hook-types-green.log](shared-hook-types-green.log) |
| 渲染层单测 | 9 文件 118 条通过：pi 桥 `agent_set_fast_mode` 带路径与缺省、`mergePreferences` 保留 false、写分支/回执 unavailable、草稿默认关闭与显式默认覆盖、旧会话缺字段补 false、A/B 隔离与迟到回执、owner/attempt 守卫含卸载 | [frontend-final.log](frontend-final.log)、[frontend-red.log](frontend-red.log)、[frontend-race-red.log](frontend-race-red.log)、[frontend-race-interim.log](frontend-race-interim.log)、[frontend-unmount-red.log](frontend-unmount-red.log)、[frontend-unmount-green.log](frontend-unmount-green.log) |
| UI 场景 model-fast | 94 条通过：新 A 开/B 关、往返、重载、失败回滚、能力撤销保留保存值；原两供应商 × 8 模型能力矩阵、悬停、两态配色、Space 键、中英文、窄屏全部保留 | [frontend-ui-model-fast.log](frontend-ui-model-fast.log) |
| UI 场景 session-preferences | 171 条通过：第五字段 A/B、草稿显式默认、能力撤销、重挂载与页面重载恢复 | [frontend-ui-session-preferences.log](frontend-ui-session-preferences.log) |

只执行本需求的 model-fast 与 session-preferences，共 265 条断言通过（2/39 个场景），没有运行全量 UI，也没有重构其它界面。截图：[A/B 与能力](screenshots/model-fast-capabilities.png)、[关闭状态](screenshots/model-fast-fast-off.png)、[会话恢复](screenshots/session-preferences-restored.png)、[窄屏](screenshots/model-fast-narrow.png)。

## 验证命令

在 extensions 目录：`npx vitest run _shared/session-preferences.test.ts`。

在 electron-agent 目录：

```bash
npx vitest run --project main electron/app/piRuntimeService.test.ts electron/app/sessionPreferences.integration.test.ts electron/ipc/register.test.ts
npx vitest run electron/app/fastMode.integration.test.ts
npx vitest run --project renderer src/lib/sessionPreferences.test.ts src/lib/pi.sessionPreferences.test.ts src/features/chat/input/actions/composerPreferences.test.ts src/features/chat/input/actions/ModelThinkingAction.test.tsx src/features/chat/input/composerOwner.test.ts src/stores/sessionPreferencesStore.test.ts src/stores/sessionPreferencesStore.storage.test.ts src/features/chat/input/actions/ApprovalAction.test.tsx src/features/chat/input/actions/ModeAction.test.tsx
npm run ui:check -- model-fast
npm run ui:check -- session-preferences
```

完整 RED/GREEN、guard/卸载回归、类型检查和截图保存在本目录。race-interim 保留了一次仍失败的中间断言；最终 25 条组件回归与 118 条套件均通过，不把该中间日志当通过证据。独立 reviewer 与父线程均已完成本次负责范围的复核。

根 `npm run verify-notes` 通过（116 篇，保留 6 篇既有非阻断警告），`git diff --check` 退出码 0，见 [verify-notes.log](verify-notes.log)、[diff-check.log](diff-check.log)。

## 审查与边界

独立 reviewer 对 shared/请求作用域/false/能力门/既有 wire 字段给出无阻断结论，并复跑 shared 27、wire 5 条。父线程另核对后端 targetSessionPath 提交与默认分离、输入栏 owner/attempt 回执保护和旧会话缺字段设为默认的关闭值。

实际 include Fast 渲染代码与两个场景的类型检查发现新 fixture 的 unknown model 类型，已改成 SessionPreferences 后复跑；当前仅剩既有 StreamingCodeView.tsx:81 的主题类型诊断，见 [renderer-types-first.log](renderer-types-first.log)、[renderer-types-final.log](renderer-types-final.log)。根 tsconfig.json 的 files:[] 不作为 renderer 检查证据。没有宣称全工程 tsc 或全量测试通过。

没有访问外部付费 provider：集成测试在 fetch 传输边界返回受控 400。没有重启当前用户应用、提交或推送。新宿主 API 需重新构建并重启应用加载；旧 fast-mode.json 保留兼容 API 数据，但输入栏与请求都不再读它。
