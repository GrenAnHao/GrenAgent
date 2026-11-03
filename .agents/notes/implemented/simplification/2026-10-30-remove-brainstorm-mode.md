# Agent Note: 移除 Brainstorm 产品模式

Status: implemented

## Problem

Brainstorm 与 Agent 使用同一套完整工具，主要差异是模式提示词和 brainstorm-deliver 命令。用户认为该独立模式没有保留必要，希望收窄模式选择。

## Decision

产品只保留 Agent / Ask / Debug / Plan / Ultra。移除 Brainstorm 的模式项、图标、注册、交付命令、专用 Fable 提示词及由此废弃的代码；普通 brainstorming 技能、消息标题解析夹具及视觉预览 API 不属于该产品模式，不删除。

新模式输入不再接受 brainstorm。仅恢复旧配置、旧会话日志和草稿时把旧 brainstorm 映射为 Agent，保留 owner、revision 和其他字段；最新旧模式不能因被过滤而复活更早 Ask / Plan。规则范围中的旧值也不能因为过滤为空而扩展成所有模式。保留 Plan 确认与 Ultra 隔离。

## Related notes

已检索 Brainstorm / brainstorm / 头脑风暴。与[会话偏好](../../implemented/feature/2026-10-28-session-preferences-behavior.md)、[Ultra 独立模式](../../implemented/feature/2026-10-28-ultra-mode.md)、[Plan 模式](../../implemented/feature/2026-10-23-plan-mode-redesign.md)部分重叠，只收窄模式枚举并增加旧值恢复，不取代其其他决定。[会话标题](../../implemented/feature/2026-10-19-session-title-quality.md)命中通用技能夹具，与模式移除无关。

## Alternatives considered

- 只隐藏选项能减少改动；但旧会话和命令仍能进入 Brainstorm，并继续注入其提示词，因此移除完整产品路径。
- 将全部旧 brainstorm 当作非法值丢弃，解析最简单；但会让较早的 Ask / Plan 或项目默认重新生效，因此在读取边界显式恢复为 Agent。
- 为 Brainstorm 保留只读设计阶段可以强化与 Agent 的区分；用户明确希望减少模式，且 Ask 与 Plan 已提供只读与规划流程，因此不引入新的权限/确认状态机。

## Consequences

选择器与 /mode 只提供五种模式，不再维护独立的 Brainstorm 提示片及交付入口。旧会话、项目默认和草稿不需要重写历史文件，读取时恢复为 Agent；代价是原有 Brainstorm 工作流不再单列。

恢复与新写入分开：完整快照解析兼容旧值，patch parser 与 setter 继续严格拒绝。renderer 的快照、默认、status 与回执读取均使用恢复解析，同时保留 revision 的缺失语义，不能因为完整解析默认 revision=0 而把旧回执变成版本倒退。owner、字段 seq、在途修改与删除墓碑仍由既有逻辑保护。

仅限 Brainstorm 的旧规则保持已有的严格失败关闭：解析后 disabled，保存旧模式范围也拒绝，不自动放宽成 Agent 或全局。用户需要保留该规则时应显式选择新的适用模式。共享偏好解析仍为 browser-safe，不引入 modes.ts 的 Node 运行时依赖。

## Verification

- 扩展定向 12 文件、164 项通过，覆盖模式、Plan 流程、Ultra 注入、Fable、规则、prompt metadata 和共享偏好。移除入口/命令与旧值恢复先观察红灯，再实现；共享偏好单独红灯为 5 失败、26 通过，绿色为 31 通过。
- 主进程 PiRuntimeService / PromptLibraryService / 真实 SDK 会话偏好集成：3 文件、147 项通过；包括旧默认回退但不重写原配置、新 Brainstorm 设置拒绝、旧规则保存不覆盖原文件。
- renderer 模式选择器、store、命令保留名：3 文件、29 项通过；旧快照/草稿/回执兼容：4 文件、73 项通过，红灯为 8 失败、65 通过。合计本次定向 22 文件、413 项通过，不代表全量测试。
- `npm run ui:check -- ultra-mode session-preferences`：75 + 171 项通过，仅执行 2/41 个相关场景，未运行其他 39 个场景。五项选项且无 Brainstorm、未确认 Plan 阻止 Ultra、Ask/Ultra 互斥、A/B 偏好隔离、草稿、重挂载与重载恢复、浅色可读均通过。
- 证据：`.agents/evidence/2026-10-30-remove-brainstorm/`。真实组件与受控宿主/SDK 测试不覆盖真实账号或安装包验证；通用 brainstorming 技能夹具与视觉桥保留。
