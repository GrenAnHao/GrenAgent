# Ultra 验证证据

本轮实现：独立 Ultra 模式、专属默认/角色/白名单配置、模式规则、逐节点推理与路由域持久化。所有模型请求均使用本地可控端点，没有调用外部付费模型服务，也没有改写实际账户配置。

决策记录：[Ultra 实施](../../notes/implemented/feature/2026-10-28-ultra-mode.md)、[规则集成边界](../../notes/implemented/bug-fix/2026-10-28-ultra-rule-boundaries.md)。

## 通过的验证

| 范围 | 结果 | 日志 |
| --- | --- | --- |
| 扩展整组（agent-mode / multi-agent / context-rules / Fable / prompt metadata / Ultra context） | 55 文件通过，1 文件跳过；722 项通过，2 项跳过 | [extensions-final-green.log](extensions-final-green.log) |
| 父回调域修复后的生命周期/路由/真实 SDK 复验 | 5 文件，141 项通过（与整组有重叠，不相加） | [parent-domain-final.log](parent-domain-final.log) |
| 主进程、规则管理、IPC、设置和模式相关逻辑 | 29 文件，320 项通过 | [electron-final.log](electron-final.log) |
| 真实 Electron Ultra 模式/设置场景 | 74 项通过 | [ui-ultra-mode.log](ui-ultra-mode.log) |
| 真实 Electron 规则编辑场景 | 29 项通过 | [ui-prompt-library-panel.log](ui-prompt-library-panel.log) |
| 规则模式/SDK 身份/上下文所有权边界 | 2 文件，18 项通过 | [rule-boundaries-green.log](rule-boundaries-green.log) |
| 主目录与 chunks 规则资源复制 | 3 项通过 | [ultra-assets-green.log](ultra-assets-green.log) |
| 完整生产构建 | npm run build 退出 0 | [build-final.log](build-final.log) |
| 打包 agent-host 端到端 | 6 项通过，5 个本地请求 | [packaged-ultra-smoke-final.log](packaged-ultra-smoke-final.log) |
| 本次生产/场景源文件定向类型检查 | 30 文件无目标诊断；依赖的其它文件有 46 项诊断，不称全项目通过 | [typecheck-ultra.log](typecheck-ultra.log) |
| 独立审查 | 无新增阻塞；已知实际问题修复并复验 | [review.md](review.md) |
| 最终笔记校验 | 退出 0，114 篇路径/格式/证据检查通过；6 条既有警告 | [verify-notes-final.log](verify-notes-final.log) |

打包链路真实经过生产 IPC 选择目标会话 Ultra → 主模型 list_subagent_models → spawn_agent → Ultra Worker 模型与 high 档请求 → 主模型汇总 → 切 Ask 后不带 Ultra 编排规则 → 正常关停。Fable 关闭、普通 SUBAGENT_MODE=disabled，Ultra 仍使用自己的配置。

真实 SDK 测试还覆盖双供应商路由、low/high 请求、会话模型/档位记录、冷恢复沿用原模型、删除历史模型后拒绝恢复。代码为 extensions/multi-agent/ultra-sdk.integration.test.ts。

## 范围与限制

UI 仅运行 ultra-mode 和 prompt-library-panel 两个相关场景，没有运行其余场景。截图在 [screenshots/](screenshots/)，共 11 张。

额外全项目 node tsc 未通过，日志 [typecheck-node.log](typecheck-node.log)；本轮通过的定向检查不等于全项目通过。可用 [typecheck-ultra.mjs](typecheck-ultra.mjs) 重现定向检查，完整依赖诊断在 [typecheck-scoped-all.log](typecheck-scoped-all.log)。

没有验证外部真实供应商差异、任意长 fork 历史可移植性，也没有升级为全量 UI 或全仓测试。没有新增 CLI 模型配置命令，没有提交或重启当前用户应用。

## 失败与修复记录

routing-red / revocation-red / sdk-first-run / sdk-missing-model-red / parent-callback-red 保存了核心回归；ultra-assets-red / rule-boundaries-red / rule-ownership-red 保存了规则集成缺口。extensions-final.log 是最后规则工厂重载边界修复前的一次失败；对应修复后整组结果在 extensions-final-green.log。

最初的 packaged 冒烟失败属于夹具：未提供独立工具授权服务，以及把模式写到项目默认而未指定已有会话。修正后的夹具使用临时 HOME/agentDir、独立本地权限端点和 targetSessionPath，不连接实际账户配置。旧失败日志保留溯源，最终以 packaged-ultra-smoke-final.log 为准。早期诊断记录了未改动 Armin 字节码模块的动态 import 告警，本轮未修改该 SDK/字节码机制。

最终笔记校验见 [verify-notes-final.log](verify-notes-final.log)。
