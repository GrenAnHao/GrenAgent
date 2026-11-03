# Ultra 模式 / 设置 / UI — 子任务证据（模式·设置·UI worker）

范围：`extensions/agent-mode/{modes,planState}.ts`、`electron-agent/src/stores/modeStore.ts`、
`ModeAction.tsx`、`settingsSchema.ts` 及对应单测、新增 `ui-harness/scenarios|probes/ultra-mode.*`。
未触碰 `agent-mode/index.ts`、fable-behavior、context-rules、RulesPanel、multi-agent。

## 红 → 绿

| 日志 | 内容 |
| --- | --- |
| `vitest-agent-mode-red.log` | 新增 ultra / planState 用例先红（4 failed） |
| `vitest-electron-red.log` | modeStore / ModeAction / settingsSchema / scrub 新用例先红（9 failed） |
| `vitest-extensions-agent-mode-green.log` | `npx vitest run agent-mode`：7 files / 90 tests passed |
| `vitest-electron-green.log` | 本子任务相关 electron 用例（modeStore + actions 全目录 + settings 全目录 + planStore）：24 files / 184 passed |
| `vitest-electron-regression.log` | settings + actions + modeStore 回归：23 files / 176 passed |
| `vitest-electron-piRuntimeService.log` | 宿主模式写入 / Plan 守卫既有回归：69 passed |
| `vitest-extensions-agent-mode.log` | agent-mode + sandbox：438 passed / 26 skipped（既有） |

新文件单测：`extensions/agent-mode/planState.test.ts`、`electron-agent/src/stores/modeStore.test.ts`、
`electron-agent/src/features/chat/input/actions/ModeAction.test.tsx`；扩写 `modes.test.ts`、
`settingsSchema.test.ts`、`scrubLinkedModelSettings.test.ts`。

## 实现要点

- `AgentMode` 增加 `ultra`（扩展与渲染层枚举、`isAgentMode`、徽章、`AGENT_MODES` 顺序在 brainstorm 之后）。
- Ultra 工具能力同 Agent：`toolWhitelist` 返回 undefined；`gateToolCall` 不额外拦；`upsert_plan` 仍按规划专属工具拦。
- `isExecutingMode` 包含 ultra → 未确认 Plan 时手切 Ultra 在 `planBlocksModeSwitch` 就被拦；
  Plan 确认仍走 `applyMode("agent")`（未改 index.ts）。
- 设置新增独立 `ultra` 分类（能力组，紧跟「子代理」）：`ULTRA_SUBAGENT_MODEL`、
  `_SCOUT/_WORKER/_PLANNER/_REVIEWER`（type=model）、`_ALLOWLIST`（type=model-list）；
  均无 `showWhen`、无 validate；说明写明「角色空 → Ultra 默认 → 当前主模型」，以及
  cheap → Scout / strong → Worker 的 Ultra 映射。旧键不改值、不迁移。
- 供应商删除清理自动覆盖：`scrubLinkedModelSettings` 按 schema 遍历，Ultra 键无需改代码即被清理。
- 按主线程补充口径：普通「并发与上限 / 超时与回收」文案注明与 Ultra 共用同一套执行器资源；
  普通「模型策略」文案注明仅非 Ultra 生效；不新增第二套资源配置、未改任何资源默认值。

## 新增 UI 场景（未运行 ui:check，按分工由主线程统一构建运行）
- `ui-harness/scenarios/ultra-mode.tsx`：真实 `ModeAction` + 真实 `SettingsPanel`（SettingField /
  ModelSelectField / ModelListField）；桥桩里 settings 字典即落盘状态，`agent_set_mode` 按
  `writeAgentMode` 对 agent/debug/brainstorm/ultra 在未确认 Plan 时回 `PLAN_UNCONFIRMED`。
- `ui-harness/probes/ultra-mode.mjs`：模式列表含带图标的 Ultra 且只出现一次；未确认 Plan 切 Ultra 被拦、
  选择器退回 Plan、toast 显示宿主原文；确认后可切 Ultra，再切 Ask 不叠加；Ultra 分组无普通子代理键；
  只设 Ultra 键 → 切普通分类 → 改普通 cheap → 切回 Ultra 未保存值不丢 → 保存后两套键各存各的、
  未设角色保持为空（不复制普通键）→ 重挂载按落盘恢复 → 浅色主题。

## 场景就绪状态

- `ui-harness/scenarios/ultra-mode.tsx` + `ui-harness/probes/ultra-mode.mjs` 已落盘，可立即跑
  `npm run ui:check -- ultra-mode`（本 worker 未构建，避免与另一 worker 的场景构建冲突）。
- 场景只依赖本 worker 已改的 `modeStore` / `ModeAction` / `settingsSchema` 和真实 `SettingsPanel`；
  不依赖规则 worker 的 `ultra-rules` 或主实现的 routing，因此可与它们的实现并行跑。
- 若同时改了 `SettingsPanel` / `SettingField` / `ModelSelectField` 的 DOM 结构，
  场景里的 `set-field-*` / `set-cat-*` testid 需一起核对。

## 需要主线程跟进的点

- `electron-agent/ui-harness/check.mjs ultra-mode` 需要在主线程统一构建时跑一次（本 worker 未跑）。
- `AGENTS.md` 的场景清单（`plan-panel` 等条目旁）可能要补一条 `ultra-mode` 说明，不在本 worker 文件所有权内。
- 扩展侧 `agent-mode/index.ts` 的 Ultra 规则注入、会话 modes 恢复（`session-controls` 经 `isAgentMode`）
  已因枚举扩展自动接受 `ultra`，但提示词 / 规则部分由规则 worker 负责。
- fable-behavior 的 `FableAgentMode` 仍是五值联合：Ultra 若要有专属 mode slice，需要在那边处理；
  本 worker 未改（按所有权）。当前 ultra 下不会误注入 brainstorm/plan slice，因为 resolve 只认五值。
