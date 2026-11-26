# Agent Note: 草稿偏好初始化不得与前景会话争抢 lease

Status: implemented

## Problem

同项目已有会话在跑时新开对话，输入栏弹「无法读取会话偏好 / 无法读取审批档位：… SESSION_OPERATION_LEASE_BUSY: <正在跑的会话 jsonl>」，模型芯片卡在「加载模型…」，三个选项控件进入 loadFailed。2026-11-20 在 Pi 项目实测复现（证据见 `.agents/evidence/2026-11-20-draft-preferences-lease-busy/`）。

两个叠加缺陷：

1. 草稿初始化并发风暴。输入栏三个控件（模型 / 审批 / 模式）挂载时各自调 `ensureComposerPreferences`；会话 owner 有 `inflightEnsure` 去重，**草稿 owner 没有**——`initializeDraft` 只查 `store.peek`，首个调用未返回前其余调用照样各自发 `agent_get_session_defaults`。一次挂载并发 2~3 个相同命令。
2. 无 target 的纯配置读被押上前景会话锁。`PiRuntimeService.send()` 对任何命令都把当前前景会话文件加进 lease 路径集合（`!target` 分支），`agent_get_session_defaults` 因此要去抢正在跑的会话的锁，且 `waitMs = 0`（有界等待只给了带 target 的 `agent_get_state`，见 [跨项目移动](../feature/2026-11-17-session-project-transfer.md)）。而 `readSessionDefaults` 只读 runtime-settings.json，与任何会话状态无关；每次调用还在锁内做一次 `readFile`，持锁窗口是毫秒级文件 IO。回合运行中前景会话锁上另有持续流量（get_state 轮询、prompt preflight、压缩），撞锁几乎必现；空闲时窗口窄、偶发。

后果链：抢锁失败的调用立即抛 busy → 控件 toast + loadFailed；并发调用互相把对方的 defaults 读撞成 busy；模型列表命令同路被撞后落空，草稿的模型初值选不出来。错误只在重挂载时清除，用户看到的稳定症状就是「新对话一打开就报错」。

## Decision

- `ensureComposerPreferences` 对草稿 owner 同样并入 `inflightEnsure` 去重（键仍是 `canonicalOwnerKey`，草稿键原样返回）：一个草稿一次挂载只发一次初始化，后续控件共享同一在途结果；失败结果同样共享，重试靠下一次挂载。
- `PiRuntimeService.send()` 里 `agent_get_session_defaults` 不再把前景会话文件加进锁集合（带 target 时 target 照旧入集合）。它是纯 workspace 配置投影（读默认模式 / 审查 / 模型 / Fast），不读写任何会话状态；并发于会话写安全，最坏读到写前一瞬的默认值。

`agent_get_available_models` 维持原锁行为不变：它读 live 会话的模型快照，把「读会话内存快照」的命令排除出会话锁需要更大的一致性论证；且前端已有按 workspace 的 inflight 去重 + 冷启动轮询，busy 会自愈，不属于本缺陷的最小修复面。

## Existing decisions

- [跨项目移动](../feature/2026-11-17-session-project-transfer.md)：部分重叠。该篇给带 target 的偏好读加了 500ms 有界等待，并明确「无显式目标的状态探测取锁规则不变」；本篇是对无 target 纯配置读这一规则的第一个例外，理由是它根本不访问会话。两篇互链，互不取代。
- 检索 `lease` / `输入栏` / `getSessionDefaults` 未发现其他同主题笔记；Repo Wiki 的 `LEASE_BUSY` 是另一套 AgentData 租约，无关。

## Alternatives considered

- 给 `agent_get_session_defaults` 也加 500ms 有界等待（复制 11-17 的做法）：最强理由是实现最对称、不加新分支。不采用：压缩等长持锁场景下 500ms 等完仍然 busy，用户照旧看到报错；而且去重前三次并发调用会变成串行三次文件读。
- 只修前端去重、不动后端：最强理由是改动面最小。不采用：单个 defaults 调用仍要与运行中的回合（轮询 / preflight / 压缩）抢同一把锁，随机撞上后草稿依旧 loadFailed 且不自愈。
- 失败后前端静默重试：最强理由是不碰后端语义。不采用：把确定性的锁争用藏进重试循环，每次挂载仍是 3 倍命令量；重试期间的「加载模型…」态本身就是本缺陷的可见症状。

## Consequences

- 同项目有回合在跑时新开对话不再弹偏好读取失败；三个控件共享一次初始化，模型初值不再因并发互撞而卡「加载模型…」。
- 代价一：defaults 读可能与 `agent_set_session_defaults` 写并发，读到写前一瞬间——UI 默认值短暂偏旧，下一次挂载即纠正，无持久化后果。
- 代价二：共享在途结果后，初始化失败时三个控件各自 toast（数量与现状相当），但失败定位为一次，`loadFailed` 状态不再互相覆盖。
- 无 target 写入命令（`agent_set_mode` 等落到当前会话的写）与 `agent_get_available_models` 的取锁规则不变；未来若要把更多只读命令挪出会话锁，需按命令逐一论证「不读写会话状态」，不能按命令类型批量放行。

## 验证

计划见 proposed 阶段存档；实跑结果：

1. `cd electron-agent && npx vitest run src/features/chat/input/actions/composerPreferences.test.ts` — 通过（40 tests，含新增草稿并发去重用例：并发 3 次共享同一在途结果，`getSessionDefaults` 恰好 1 次）。
2. `npx vitest run electron/app/piRuntimeService.test.ts -t "不押前景会话锁"` — 通过（外部 owner 持前景会话锁时：无 target `agent_get_state` 仍报 `SESSION_OPERATION_LEASE_BUSY`，`agent_get_session_defaults` 照常返回项目默认）。
3. `npm run ui:check -- session-preferences` — 通过：171 passed / 0 failed，只跑 1/62 场景。
4. 根 `npm run verify-notes` — 通过（本篇转 implemented 同批重跑）。

基线对比：`piRuntimeService.ts` 工作区另有 400+ 行未提交累积改动，15 个既有失败（prompt/park/openAdditional 路径，`INVALID_SESSION_IDENTITY` 等）与本改动无关；只回退本次 6 行重跑全量为 16 failed / 109 passed（新增用例按旧行为失败，即线上 bug 的最小复现），恢复后 15 failed / 110 passed。证据与逐条输出见 [验证记录](../../../evidence/2026-11-20-draft-preferences-lease-busy/verification.md)。
