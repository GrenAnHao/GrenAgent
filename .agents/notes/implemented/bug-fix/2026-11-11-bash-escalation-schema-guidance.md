# Agent Note: bash 升权参数在采样阶段拒绝空理由

Status: implemented

## Problem

截图对应的 2026-11-11 会话记录表明，普通 bash 调用传了 `sandbox_permissions: "workspace-write"`、`justification: ""`，两次被 `readEscalationArgs` 拒绝。补上理由后又因当前已是 `danger-full-access` 而拒绝非严格放宽。codemode 的同命令省略这两个字段，因此成功。不是 shell 执行差异，也不是 null 被强制转成空字符串。

现有理由 schema 仅为 String，接受空字符串；运行时却要求 trim 后非空。strict-prefer 把可选字段变为必填 nullable 时，模型虽可选 null，但字段说明未明确普通调用应省略或填 null，容易填一个真实升权目标作为占位。Pi 1.5.1 实测 strict schema 保留 null，validateToolArguments 会删除 optional null，无需修补 SDK。

历史审计：[沙箱事实和同调用升权](../architecture/2026-10-05-sandbox-denial-as-fact-and-escalation.md)部分重叠，既有审批和严格放宽决定继续有效；本篇只补 schema 与说明的缺口。其余 strict 命中为沙箱 OS 隔离/类型检查笔记，无关。

## Decision

justification 的 schema 增加 minLength: 1，让约束采样在产生调用时就不能输出截图中的空理由。升权字段说明明确：普通命令省略两个字段；被要求填全字段时两个都填 null，不能把 workspace-write 当默认值。继续保留运行时 trim 校验、成对校验、严格放宽和审批；不把错误升权偷偷降级成普通执行。

## Alternatives considered

- 执行时忽略空理由或已经拥有权限的请求：最强理由是旧的错误调用立即可执行；不采用，因为这会吞掉真实的错误升权意图，模糊审批和权限边界。
- 为 schema 显式增加 nullable、在 bash 手工清除 null：最强理由是普通调用可表达不升权；不采用，因为 SDK 已提供这条路径，无法阻止实际记录里的真实枚举加空字符串，重复处理还会扩大变更。

## Consequences

普通调用有明确的不升权表达，空理由限制前移到约束采样 schema；没有修改执行器、SDK 或权限裁决。minLength 只排除空字符串，纯空白继续由运行时 trim 拒绝。

模型仍可能在非 strict 供应商上发出错误参数，或编造非空理由。非法参数、不满足严格放宽或审批条件时运行时照旧拒绝；理由真实性仍由用户审批判断。不声称 schema 可彻底消除模型误用，也未实调供应商采样。

## 验证

- 红灯：`cd extensions && npx vitest run --config .tmp-bash-escalation.vitest.config.ts sandbox/bashTool.test.ts -t 'strict sampling rejects'`，原 schema 接受空理由，新增用例如期失败（1 failed）。
- 绿灯：`cd extensions && npx vitest run --config .tmp-bash-escalation.vitest.config.ts sandbox safety prompt-metadata.test.ts`，33 个文件通过、1 个文件跳过，431 项通过、26 项跳过，退出码 0。覆盖真实 SDK strict schema（无强转 Check）、原 schema 对 optional null 的归一化、真实 Git Bash 两种普通调用的相同输出，以及原有沙箱/升权/审批回归。26 项跳过不计通过。
- 证据：`.agents/evidence/2026-11-11-bash-escalation-schema-guidance/` 中的 `red.txt`、`green.txt`、`verification-config.txt`。临时配置仅让源码优先于工作区已有的未跟踪 `.js` 编译产物，已删除临时文件，配置副本保留在证据中。未改动这些既有产物。
- 测试首次实现错误地把带 coerce 的 SDK parser 当成无强转 wire validator；它会把 strict nullable string 的空串转为 null。已改用 TypeBox Check 检查真实 SDK 生成的 wire schema，并重新在原生产 schema 上跑出红灯后恢复修复。真实 SDK parser 只用于归一化路径。另一处新增用例的正则转义错误已修正后重跑，无生产回归。
- `npm run verify-notes` 通过，退出码 0；保留 6 条其他历史笔记的既有证据措辞警告，输出见 `verify-notes.txt`。
- 无对应 verify-* skill，使用上述真实 SDK + shell feature 测试提供实跑证据。无渲染改动，未跑 UI 场景；未重启用户应用、未实调付费供应商或声称 codemode 全链路端到端验证。
