# Ultra 规则与规则范围 — worker 实现记录（rules 分支）

范围：Ultra 内置调度规则注入、Fable 模式识别、context-rules 模式范围、规则面板模式范围编辑与保存/加载。
不包含（主线程负责）：Ultra 路由域/宿主恢复、Ultra 设置 UI、ultra-rules.md 打包拷贝。

## 生产文件

| 文件 | 改动 |
| --- | --- |
| `extensions/agent-mode/ultra-rules.ts`（新增） | `ULTRA_RULES_CONTEXT_PATH`、`ultraSchedulingRules()`（lazy 读 md，读失败只报错降级空串，不让扩展加载崩）、`ULTRA_SCHEDULING_RULES`、`applyUltraRules(event, { mode, subagent })`、`isSubagentSession`、`subagentProbeOf` |
| `extensions/agent-mode/ultra-rules.md`（新增） | 英文调度规则正文：按需派工 / 简单任务自己做 / 先 `list_subagent_models` 再选 / 独立子任务并行且不共享文件 / 权限不扩张、profile 整次共享要拆成独立 spawn_agent / 子代理只执行不接管 / 配置由运行时决定。不写死供应商、模型、顾问名额 |
| `extensions/agent-mode/index.ts` | 只动 `before_agent_start`：`live` 提前算好，`applyUltraRules` 放在 plan 上下文与 custom 回合的所有返回分支之前；头注释补 Ultra。未改 modes.ts / planState.ts |
| `extensions/context-rules/rules.ts` | `RuleFile.modes?`、`normalizeRuleModes`、`ruleAppliesToMode`、`activeRuleContextFiles(rules, mode?)` |
| `extensions/context-rules/index.ts` | 模式取 `getAgentMode(projectCwd(ctx), currentSessionId())`；每次先剥离上一轮追加的规则条目再追加，切换不残留、不误删其他扩展条目；内容不变不重建数组 |
| `extensions/fable-behavior/loader.ts` | `FableAgentMode` 加 `ultra`；`resolveAgentModeFromEntries` 同时认 `agent-mode` 与 `session-controls`，取最后一条已知模式 |
| `extensions/fable-behavior/prompts/modes/ultra.md`（新增） | Ultra 模式切片：派工是选择、先发现模型、权限边界；调度细节仍由 runtime 注入的 context 给出 |
| `electron-agent/electron/app/promptLibraryService.ts` | `SaveRuleInput.modes?`；`ruleMarkdown` 只在有范围时写 `modes: [..]`（旧文件格式不变）；`saveRule` 归一化去重；`setRuleEnabled` 保留 modes |
| `electron-agent/electron/ipc/register.ts` | `save_context_rule` 透传可选 `modes`（`readOptionalRuleModes`，非字符串数组报错） |
| `electron-agent/src/lib/promptLibraryIo.ts` | `RuleInfo.modes?`、`saveContextRule` 入参 `modes?` |
| `electron-agent/src/features/extensions/RulesPanel.tsx` | 编辑区「适用模式」多选胶囊（`rule-mode-<mode>`，`aria-pressed`）、列表模式徽标（`rule-modes-<scope>-<id>`，无范围显示「全部模式」）；保存时全不选 → 不传 modes |
| `electron-agent/src/features/extensions/libraryStyles.ts` | `modesBadge` / `modePicker` / `modeChip` 样式 |
| `electron-agent/ui-harness/scenarios/prompt-library-panel.tsx` | 规则 fixtures 带 modes；`save_context_rule` 桩保存并刷新列表；`exposeActions({ lastSavedRule })` |
| `electron-agent/ui-harness/probes/prompt-library-panel.mjs` | 新增：旧规则标「全部模式」、Ultra 规则标「Ultra」、编辑区回显、加选 Plan、保存后 `lastSavedRule.modes` 含 plan+ultra、列表刷新为「Plan、Ultra」 |

## 行为要点

- **只在主会话 Ultra 生效**：`applyUltraRules` 先按固定伪路径摘除旧条目，再按当轮 `live` 模式决定追加；`subagent`（`subagent_meta` 条目 / `PI_IS_SUBAGENT=1` / ALS `origin=subagent`）一律不注入，`goal` 回合不算子代理。
- **切出不残留**：SDK 1.3 的 `before_agent_start` 把同一个 `systemPromptOptions` 对象顺序传给所有扩展；实现每次都先剔除自己的条目，所以复用的 event 上不会留下上一轮规则。
- **custom / settlement 回合仍生效**：注入在 `plan-execution-context`、`plan-edited-context` 等返回分支之前完成，不依赖 fable-behavior（`FABLE_BEHAVIOR=0` 时规则仍在）。
- **规则模式范围**：解析兼容 YAML 数组 / 逗号串 / 单串；没有 `modes` 的旧规则在所有模式生效；过滤用真实会话模式而不是会话条目（条目可能落后于宿主切换）。
- **保存/加载**：没有范围时不写 `modes` 行（旧版本客户端/旧规则格式不受影响）；`setRuleEnabled` 只改 `enabled`，保留范围。

## 测试证据（.agents/evidence/2026-10-28-ultra-mode/）

| 日志 | 内容 | 结果 |
| --- | --- | --- |
| `rules-ultra-and-fable.vitest.log` | `npx vitest run agent-mode fable-behavior`（含 `ultra-rules.test.ts`、`ultraRulesInjection.test.ts`） | 13 文件 / 141 用例通过 |
| `rules-context-rules.vitest.log` | `npx vitest run context-rules` | 见文件：主线程接手的 2 条边界红测（显式未知 modes、无 ALS 时会话身份）在我这轮结束时仍未落实现 |
| `rules-electron.vitest.log` | `RulesPanel.test.tsx` + `promptLibraryService.test.ts` + `ipc/register.test.ts` + `modeStore.test.ts` | 4 文件 / 65 用例通过 |
| `rules-multiagent-regression.vitest.log` | `env -u PI_RUNTIME_CONFIG npx vitest run multi-agent prompt-metadata.test.ts` | 39 文件通过 / 1 跳过，552 用例通过 |
| `rules-extensions.vitest.log` | 上述三者合集的一次运行 | 见文件（包含 pending 的 2 条边界红测） |

注意：`multi-agent/runner.test.ts` 在本机直接跑会因环境里的 `PI_RUNTIME_CONFIG` 指向真实 runtime-settings.json 而失败（`SUBAGENT_MODEL` 被真实配置覆盖），与本次改动无关；用 `env -u PI_RUNTIME_CONFIG` 跑得到全绿，证据日志即该次运行。

## 未做 / 交给主线程

- `ui:check prompt-library-panel` 实跑（我只改 scenario/probe 与组件；主线程已报规则 UI 29/29 通过）。
- `copyPiAdjacentAssets` 拷贝 `ultra-rules.md`（主线程写红测接手）。
- `normalizeRuleModes` 对「显式写了 modes 但全是未知值」的语义（扩大为全部模式 vs 视为错误禁用），以及 context-rules 优先用 `ctx.sessionManager.getSessionId()` 再回退 ALS。
