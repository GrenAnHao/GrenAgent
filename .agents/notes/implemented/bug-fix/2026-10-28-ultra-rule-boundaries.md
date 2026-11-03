# Agent Note: Ultra 规则的模式范围与打包资源边界

Status: implemented

## Problem

[Ultra 实施](../feature/2026-10-28-ultra-mode.md) 的集成验证发现四处新实现缺口：规则 Markdown 未纳入打包资源；未知 modes 过滤为空后意外适用所有模式；缺 ALS 身份时按项目默认过滤；按目录名清理会误删其它来源的 rules/AGENTS.md。这里单独记录验证发现的回归，不把新增字段问题归咎既有发布版本。

## Decision

ultra-rules.md 进入现有 copyPiAdjacentAssets，复制到 main 与 chunks 旁。无 modes / 空数组仍适用全部模式；显式未知值或非法类型报错，文件规则禁用并显示 error，保存失败不覆盖原文件。模式过滤优先 SDK 当前会话 id，再回退 ALS/项目默认。

清理旧 contextFiles 只匹配在配置的规则目录实际发现或本扩展曾注入的路径，不以泛目录名猜测所有权。工厂重载后仍能移除磁盘上已知的旧模式规则；其它来源上下文保留。

## Alternatives considered

- 删除未知值继续：兼容交换格式较宽松；但可能从专属范围扩大为全部，因此拒绝。
- TS 内嵌全部正文：无需拷贝资源；但独立 Markdown 更便于维护，现有资产复制仅需一项清单，因此保留 Markdown。
- 只靠 ALS：桌面常见路径可用；直接 SDK/CLI 或恢复路径可能缺身份，因此优先 SDK 会话。
- 按 rules 目录名清理：代码短且能跨目录；但无法区分其它来源的约束文件，因此跟踪实际规则路径。

## Consequences

旧无模式规则格式兼容；新模式字段拼写错误会明确拒绝，需要用户修正，不能默默扩大范围。打包主文件和 chunks 都有规则正文。保存服务接受原始模式字符串并在写盘前归一化为 AgentMode，IPC 不做未经验证的类型断言。

## 验证

证据均在 `.agents/evidence/2026-10-28-ultra-mode/`。

- 红：ultra-assets-red.log 两个资源 ENOENT；rule-boundaries-red.log 两个模式失败；rule-ownership-red.log 一个其它来源上下文被误删。
- 绿：copyPiAdjacentAssets.test.ts 3 项通过（ultra-assets-green.log）；context-rules 2 文件 18 项通过（rule-boundaries-green.log）；相关宿主/IPC/服务测试随 electron-final.log 的 29 文件 320 项全部通过，含非法模式不覆盖旧文件。
- 真实规则 UI 29 项通过（ui-prompt-library-panel.log）；生产 npm run build 通过（build-final.log），main/chunks 规则资源存在；生产 agent-host 6 项冒烟通过（packaged-ultra-smoke-final.log），Fable 关闭仍有 Ultra 规则、切 Ask 后移除。
- 最终 npm run verify-notes 结果见 verify-notes-final.log。
