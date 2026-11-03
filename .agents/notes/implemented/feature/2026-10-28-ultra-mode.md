# Agent Note: Ultra 独立执行模式与隔离的子代理编排配置

Status: implemented

## Problem

普通子代理设置已有模型默认值、档位别名和路由白名单。旧 agent-flow 方案把编排做成正交开关、固定 Opus、自动匹配器和顾问配额，无法满足用户确认的配置隔离，也会产生 Ask / Plan 与 Ultra 组合状态。用户于 2026-10-28 选择独立 Ultra 模式，并授权写笔记和实施。

## Decision

### 模式与规则

Ultra 是与 Agent / Ask / Plan / Debug 并列的互斥 AgentMode，使用同一会话模式存储和入口，不增加开关。Brainstorm 的移除与旧值恢复见[模式收敛](../simplification/2026-10-30-remove-brainstorm-mode.md)。它使用 Agent 的执行能力及原有沙箱、审批、只读约束和共享执行器资源上限，不扩大权限。未确认 Plan 不能手切 Ultra；侧栏确认执行仍进入 Agent。

Ultra 主会话每轮通过 contextFiles 加载内置调度规则，Fable 关闭及后台唤醒回合仍有效；切出模式会移除，子代理不成为编排主代理。规则按需分派、简单任务自行完成、独立工作并行、角色权限不同则拆独立调用，不固定供应商、模型或顾问名额。context-rules 增加可选 modes，规则编辑面保存范围；缺省旧规则仍适用全部模式。

规则 Markdown 由现有 copyPiAdjacentAssets 同时复制到 main/chunks。模式范围及上下文所有权的集成修复另记于 [规则边界](../bug-fix/2026-10-28-ultra-rule-boundaries.md)。

### 配置与解析

设置仍由现有 SettingsService 的 settings.json / runtime-settings.json 字符串字典持久化，供应商、凭据和模型目录复用；普通和 Ultra 的选模键分开。

| Ultra 键 | 值 | 空值行为 |
| --- | --- | --- |
| ULTRA_SUBAGENT_MODEL | provider/id | 调用者实际模型 |
| ULTRA_SUBAGENT_MODEL_SCOUT | provider/id | Ultra 默认 → 调用者 |
| ULTRA_SUBAGENT_MODEL_WORKER | provider/id | Ultra 默认 → 调用者 |
| ULTRA_SUBAGENT_MODEL_PLANNER | provider/id | Ultra 默认 → 调用者 |
| ULTRA_SUBAGENT_MODEL_REVIEWER | provider/id | Ultra 默认 → 调用者 |
| ULTRA_SUBAGENT_MODEL_ALLOWLIST | JSON string[] | 无额外可自选路由；Ultra 预设模型仍可选 |

Ultra 模型顺序：节点/单任务显式且获准的 model → Ultra 角色模型 → Ultra 默认 → 调用者实际模型。显式模型须属于 Ultra 配置、额外白名单或实际父模型。cheap 只映 Ultra scout/default，strong 只映 Ultra worker/default；未配置不能冒用普通别名。

Ultra 不采用普通 SUBAGENT_MODE / SUBAGENT_MODEL*、普通自选开关和白名单、agent frontmatter.model 或 profile.model 作为模型来源；角色提示词、工具和 profile 权限照旧。普通模式的模型优先级、旧空值与共享批次 profile 行为保持。共享 backend、并发、深度等资源限制仍是系统级约束，设置页明确标注。

工具 schema 稳定保留可选 model / thinking_level 和发现工具，调用期按当前域授权；普通自选关闭仍拒绝显式选择，开关与白名单可在新调用中生效。schema 不因切模式重建。

### 推理与错误

新增 tasks[i].thinking_level / chain[i].thinking_level，优先于顶层值。普通再读取新增的 agent frontmatter.thinking_level；Ultra 不套用普通角色默认。未显式指定沿用 SDK 的目标模型偏好 / 全局默认与能力钳制；显式指定逐节点对照最终模型校验。

Ultra 完整预检全部节点，明确配置非法值立即报错，不回退掩盖错误；错误包含 task/tasks[i]/chain[i]、agent、设置键或参数来源、值和原因。规范路由使用 provider/id；普通合法历史短名沿用原 SDK 解析。上下文窗口使用目标模型已有元数据，不新增 agent.contextWindow。

本次调用使用解析快照，已运行子代理不自动换模。启动前再次检查模式和撤权；链中途停止时已完成步骤保留在结果 details 中。

### 子会话域

内部 PI_SUBAGENT_ROUTING_MODE 与 subagent_meta.routingMode 固定 ordinary/ultra，创建、驻留、冷恢复及 worker RPC 都沿用；旧子会话无标记视 ordinary，不随父会话切模式改变。标记只控制选模来源，不授予权限。

SDK 自身会话身份优先：有子元数据按固定域，根会话按其真实 AgentMode；只有没有 SDK 会话对象时才从子 ALS/env 推断。父会话被子代理消息或结算回调唤醒时，不误用发送方 ALS 的路由域。

Ultra 冷恢复按当前分支最后 model_change，退 subagent_meta.model，显式恢复该模型。模型或认证缺失明确失败，不允许 SDK 自动改用其它模型；普通旧恢复路径不变。

## Alternatives considered

- Agent 内开关：模式枚举改动少；但需维护基础模式与开关两项状态，用户明确选择独立模式，因此不用。
- 共用普通选模键：配置量和代码最少；但违背用户要求的配置隔离，普通禁用/白名单会污染 Ultra，因此不用。
- 固定 Opus + matcher + 顾问配额：能强制特定派工习惯；但限制多供应商、与显式覆盖冲突，因此改为用户配置模型、规则按需派工。
- 新建 YAML 引擎/配置文件：可结构化控制完整流程；但现有 SettingsService、规则和 spawn_agent 已可承载，因此不用。

## Consequences

Ultra 是可恢复的单一模式，普通模型配置不被迁移或覆盖；用户可独立配置默认和四角色模型，也可在一次调用混合模型与推理档位。现有固定链命令保持，Ultra 不强制每次派工。

代价是需要维护两组模式内选模配置，以及子域元数据、SDK 恢复和 worker 透传契约。混合 tasks/chain 的权限 profile 仍按现有整次调用共享，规则提示权限不同时使用独立调用。本次不实现运行中的换模、逐节点权限重构、新 CLI 配置命令或费用/质量门禁。

跨供应商验证采用两个本地可控兼容端点，未对真实外部供应商或任意长 fork 历史作通过承诺。额外全项目后端类型检查仍有非本次模块的错误；本次生产与场景文件单独检查没有目标诊断，不能把构建通过解释为全仓类型检查通过。

## 旧笔记审计

- [激活与路由](../architecture/2026-09-13-subagent-activation-and-routing.md)：普通优先级和别名授权分类保留；工厂冻结 schema 由本篇替代，旧理由保留。
- [子代理重设计](../architecture/2026-10-11-subagent-redesign.md)：复用其后端、权限和生命周期。
- [Plan 重设计](2026-10-23-plan-mode-redesign.md)：执行守卫扩展到 Ultra，确认入口不变。
- [完整授权后启动](../bug-fix/2026-10-28-subagent-authorization-before-launch.md)：保留，不恢复 launchEarly。
- 外部 agent-flow 七份现有文档已同步新基线，原归档与 bak 不改；本工作区既有未提交改动保留，未建 worktree、未提交。

## 验证

证据：`.agents/evidence/2026-10-28-ultra-mode/`。仓内未发现 verify-* skill，使用实际 SDK、项目 vitest、UI harness 和生产构建验证。

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| extensions: env -u PI_RUNTIME_CONFIG npx vitest run agent-mode multi-agent context-rules fable-behavior prompt-metadata.test.ts _shared/ultra-context.test.ts --maxWorkers=4 | 55 文件通过 / 1 跳过，722 项通过 / 2 跳过 | extensions-final-green.log |
| 父回调补充后：ultra-context、index、生命周期、worker-session、ultra-sdk 定向复验 | 5 文件 141 项通过 | parent-domain-final.log |
| electron: 宿主/规则服务/IPC/资产/模式/设置/输入动作相关定向 vitest | 29 文件 320 项通过 | electron-final.log |
| npm run ui:check -- ultra-mode | 74 项通过 | ui-ultra-mode.log、screenshots/ |
| npm run ui:check -- prompt-library-panel | 29 项通过 | ui-prompt-library-panel.log、screenshots/ |
| 真实 SDK 双本地供应商、不同 effort、子会话记录、冷恢复、删模型后拒绝恢复 | 通过，包含在扩展与父域复验中 | ultra-sdk.integration.test.ts、相关日志 |
| npm run build | 通过，main/preload/renderer 及相邻规则资源生成 | build-final.log |
| 生产 agent-host：IPC 选 Ultra、发现模型、spawn 配置 Worker/high、Fable 关闭仍注入、切 Ask 移除规则、关停 | 6 项通过，5 个本地模型请求，无外部付费调用 | packaged-ultra-smoke-final.log、packaged-ultra-smoke.mjs |
| 30 个本次生产/场景文件定向类型检查 | 0 目标诊断；依赖的未改文件另有 46 项诊断，不称全项目通过 | typecheck-ultra.log、typecheck-scoped-all.log |
| 独立只读审查 | 无新增 Critical/Important；实际阻塞已修复并复验 | review.md |

红→绿记录包括 routing-red、revocation-red、sdk-first-run、sdk-missing-model-red、parent-callback-red 及规则边界日志。最初打包冒烟夹具缺权限服务/未带目标会话，后来改为独立本地权限端点与目标会话 IPC，最终链路通过。UI 只运行上述两个相关场景，未跑其余场景。

npm run verify-notes 的最终输出保存在 verify-notes-final.log；以该实际退出码验收。
