# Agent Note: 会话显示实际注入的规则

Status: implemented

## Problem

规则管理页只能看到配置，不能确认全局和项目规则经过当前模式筛选后是否进入了某一轮模型上下文。已有[命令与规则决定](../../implemented/architecture/2026-10-02-commands-rules-and-tool-surface.md)继续负责注入；Ultra 内置提示、AGENTS.md 和 rulebook 的纠偏消息各走原流程。

## Decision

使用 SDK 的 `context_with_system` 检查组装好的系统上下文，按实际的规则文件路径和正文核对，每轮只记录一次。通过 `appendEntry` 保存标题、文件标识和范围，不复制规则正文。桌面事件和当前分支历史用同一个会话条目 ID 投射提示；较长的 UI 历史也以已确认分支的规则条目为准。

## Alternatives considered

- 在规则面板读取启用项或发 toast：实现短，但不知道某一轮哪些规则生效，也无法回看。
- 返回可见的 SDK 自定义消息：可以复用现有气泡，但会进入模型历史，重复已在系统提示中提供的信息。

## Consequences

用户能在当轮回复前展开提示，区分全局和项目来源，重开会话不依赖现时开关或文件。已结束的旧会话不推测补记。检查点反映已组装的系统上下文，不用来判定供应商收到请求或模型是否遵守；核对逻辑依赖 Pi SDK 的项目规则段格式，由真实请求回归防止升级后静默漂移。

## 验证

- `vitest run context-rules`：18 例通过。
- `contextRuleInjection.sdk.integration.test.ts`、`ruleInjectionHistory.test.ts`、`sessionMessageSync.test.ts`：12 例通过。真实 SDK 注入 fetch 后核对请求体、同规则跨轮、后续钩子移除规则、消息排序、重新开档与切分支。
- `npm run ui:check -- rule-injection`：9 项通过，检查键盘展开、实时与历史去重和浅色窄窗，核对深浅截图。
- Electron Node `tsc --noEmit` 仍有既有诊断（包括未改动的 `context-rules/rules.test.ts`），本次新增或修改的 Node 源文件未报诊断。
