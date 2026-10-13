# Agent Note: 上下文策略：按压力裁旧结果、压缩兼作状态抽取、自动压缩阈值与续跑、不裁思考

Status: implemented

## Problem

### 旧工具结果默认按压力裁并冷时定案；压缩时一次状态抽取兼作摘要

旧工具结果的裁剪默认关闭，打开后按保留轮数整段替换，每次请求都重算。压缩时 `session-memory` 只看对话末尾 12000 字符抽一次状态，Pi 再读全部待丢弃消息写一次摘要，真正读过被丢内容的只有 Pi 那次。状态文件按 sessionId 存，回退或换分支后会带着不在当前分支上的工作。

### 自动压缩触发值按全局加会话覆盖

自动压缩写死在上下文占用 80%。大窗口上 Pi 自己的 `reserveTokens` 触发线接近 100%，压缩请求容易在摘要写满输出上限时失败。手动压缩按钮另外卡在用量 70% 才能点。

### 进行中的自动压缩结束后续跑

占用到触发值时，扩展在 `turn_end` 调用 `ctx.compact()`。这是 Pi 的手动压缩入口：先 abort 当前回合，压完 `willRetry` 为 false，不会再跑。对话还在调用工具或输出被截断时，压缩一结束任务就停了。用户点的手动压缩本来就应该停住。

### 撤回请求前裁剪思考，上下文按完整会话估算

请求前丢掉已结束轮次的思考之后，用量环按裁过的副本估算，和模型实际收到的窗口、以及服务端按未裁剪历史拒绝的请求对不上。截断再发时还会留错一次思考。用量显示已经不能当压缩判断用。

## Decision

### 旧工具结果默认按压力裁并冷时定案；压缩时一次状态抽取兼作摘要

`COMPACTION_POLICY_PRUNE` 未设置时按压力裁。缓存冷时（距最后一条助手消息与最后一次 `cache_warm` 保温中较晚的那个已超过 `COMPACTION_POLICY_PRUNE_TTL_MS`，默认 5 分钟），按未裁占用定一份 `toolCallId → soft | replace` 的计划；热时原样重放这份计划，压缩或换会话后清空。读 `SKILL.md` 的结果不参与压力裁剪，但超过熔断阈值时仍会被熔断。

压缩时 `session-memory` 读 `messagesToSummarize`、上一份摘要、属于当前分支的上一份状态和切轮前缀，做唯一一次抽取。结果写入状态文件，并作为 `{ compaction }` 返回；文件列表按 Pi 的标签附在后面，存进 `details` 由本扩展自己接力。抽取失败、被取消、带附言或准备数据不全时交给 Pi。状态文件第一行写分支锚点，不在当前分支上就不用。`session_compact` 按 `fromExtension` 和 `details.source` 决定是否再注入。

### 自动压缩触发值按全局加会话覆盖

触发值是上下文窗口的百分比，范围 5 到 90。全局值存在设置 `AUTO_COMPACT_PERCENT`，没写时仍是 80。单个会话的覆盖存在 `AUTO_COMPACT_OVERRIDES`，键是会话文件路径；上下文面板的滑块改的是这份覆盖。底部「跟随全局设置」删掉覆盖，下一次判断回到全局值。手动压缩不再看 70% 门槛。

### 进行中的自动压缩结束后续跑

自动压缩若打断的是还会继续的回合（已有工具结果、输出停在 length、或队列里还有消息），压缩成功或非取消失败后，用一条 `display: false` 的自定义消息再开一轮。模型已经正常说完，或这一轮是用户取消，则不续跑。手动压缩仍直接走 `AgentSession.compact()`，不挂这个回调。

### 撤回请求前裁剪思考，上下文按完整会话估算

卸掉 `thinking-replay`。发往模型的历史恢复为 Pi 原样回放，思考块不再在 `context` 钩子里删改。压缩后的用量空窗仍按会话里的完整消息估算，思考字数算回去。

### 涉及文件

- `extensions/compaction-policy/cache-warmth.ts`
- `extensions/compaction-policy/pressure-prune.ts`
- `extensions/compaction-policy/prune.ts`
- `extensions/compaction-policy/index.ts`
- `extensions/session-memory/compaction.ts`
- `extensions/session-memory/serialize.ts`
- `extensions/session-memory/store.ts`
- `extensions/session-memory/writer.ts`
- `extensions/session-memory/index.ts`
- `extensions/compaction-policy/threshold.ts`
- `electron-agent/src/features/chat/input/ContextUsageTag.tsx`
- `electron-agent/src/features/settings/settingsSchema.ts`
- `extensions/compaction-policy/resume.ts`
- `electron-agent/src/stores/agentReducer.ts`
- `extensions/index.ts`
- `electron-agent/electron/app/contextUsageEstimate.ts`
- `extensions/thinking-replay/strip.ts`
- `extensions/thinking-replay/index.ts`

### 来源

- `docs/decisions/extensions/2026-10-04-session-state-as-compaction.md`
- `docs/decisions/extensions/2026-10-02-auto-compact-threshold.md`
- `docs/decisions/extensions/2026-10-03-auto-compact-resume.md`
- `docs/decisions/extensions/2026-09-30-revert-thinking-strip.md`
- `docs/decisions/extensions/2026-09-29-strip-settled-thinking.md`（已被取代）
- da05c866（规格与计划）

## Alternatives considered

### 旧工具结果默认按压力裁并冷时定案；压缩时一次状态抽取兼作摘要

- 每次请求单独判断冷热并重算裁法：热请求会退回未裁前缀，刚写的缓存整段 miss，与 2026-09-30-revert-thinking-strip.md 放弃开关的理由相同（前缀时有时无会打穿提示缓存）。
- 冷热只看最后一条助手消息：Pi 1.0.2 的保温不产生助手消息，会把 Pi 刚保住的缓存裁掉。
- 直接拿周期状态文件当摘要：它只看过末尾 12000 字符，没读过待丢弃的消息。
- 摘要交回 Pi、压缩时不再抽取：同样一次调用，但压缩后注入的状态会偏旧。
- 搬 MiMo 的 checkpoint 写手和边界重建：要接管会话存储，扩展钩子够不到。
- 把触发百分比改成 90：与 2026-10-02-auto-compact-threshold.md 保留的默认 80 冲突，也不改善摘要内容。
- 指望 Pi 下一轮压缩继承 `details` 里的文件列表：`fromHook` 条目不会被继承，改为本扩展合并上一份。
- 按 sessionId 记「本次摘要来自状态」的进程内标记：`session_compact` 已带 `fromExtension` 和条目 `details`，标记还要额外处理失败清理。

### 自动压缩触发值按全局加会话覆盖

- 把百分比折成 Pi 的 `reserveTokens`：同一字段还决定摘要输出上限，大窗口上会把摘要预算放大到几十万 token，而且按模型存，做不到按会话覆盖。
- 只放全局滑块、会话不能单独改：和上下文面板里「这一份会话」的用法不一致。
- 默认改成 Kirocrew 的 70：当前产品已经按 80 触发，未设置的会话保持原行为。

### 进行中的自动压缩结束后续跑

- 把触发百分比折进 Pi 的 `reserveTokens`，让循环里的自动压缩自己接上下一轮：同一字段还决定摘要输出上限，大窗口上会把摘要预算放大到几十万 token，而且按模型存，做不到按会话覆盖。
- 压完插入一条可见的用户消息「继续」：对话里会出现用户没发过的气泡。
- 只要是自动压缩就续跑，包括模型已经说完的回合：会在答完之后再多生成一轮。
- 调用 `agent.continue()`：扩展上下文没有这个方法；abort 还可能在末尾留下一条 assistant，`continue()` 会直接拒绝。

### 撤回请求前裁剪思考，上下文按完整会话估算

- 只修用量环、继续裁请求：环和真实请求会重新对齐，但截断后再发仍会带错思考，这正是要退掉的行为。
- 保留扩展并做成开关：默认关掉等于没装，开关本身还会在切换时打穿提示缓存。

### 已被取代的旧决定：请求前丢掉已结束轮次的助手思考，本轮工具循环原样保留

新增 `thinking-replay` 扩展，挂 `context` 钩子：对发往模型的副本调用纯函数 `stripSettledThinking`，删掉最后一条 `role === "user"` 之前助手消息上的 `type === "thinking"` 块（含 redacted / 空文本带签名）。最后一条用户消息之后的思考、`thinkingSignature`、工具调用上的 `thoughtSignature` 全部保留。会话文件与界面不动。策略固定开启，不做开关。`contextUsageEstimate` 复用同一函数，使压缩后空窗的 chars/4 估计与真实请求一致；供应商已返回的 `contextUsage.tokens` 不改。

当时放弃的方案：

- 改 pi-ai 源码：会绑死我们自己的 fork，升级成本和回归面都更大；扩展钩子已经能在 `convertToLlm` 前改副本。
- 从会话里删思考：界面展开、重试原文、压缩摘要都会丢信息；用户也看不到历史推理。
- 连本轮工具循环一起剥：Anthropic 验签会失败，DeepSeek / Kimi 在 `tool_calls` 上回放缺字段会 400。
- 做成用户开关：中途切换会让前缀时有时无，提示缓存反复失效。
- 把旧思考收成一段摘要：多一次模型调用、延迟与费用都上来，而且摘要质量难保证；本次只做「丢掉已结束草稿纸」。

## Consequences

### 旧工具结果默认按压力裁并冷时定案；压缩时一次状态抽取兼作摘要

- 自动压缩的触发看最后一次请求的实际用量，裁剪会推迟压缩。压缩后到下一次回复之前，Pi 报告的占用是 `null`，这段时间既不裁剪，也不触发自动压缩。
- 裁剪计划只在进程内，重启后第一次热请求不沿用旧裁法，可能 miss 一次。
- TTL 默认对应 5 分钟缓存档；用 1 小时档的提供方要调大 `COMPACTION_POLICY_PRUNE_TTL_MS`，否则会在缓存仍热时重新定案。
- codemode 嵌套调用里读的 `SKILL.md` 不受保护。
- `SESSION_STATE_MODEL` 指向小窗口模型时，压缩抽取可能溢出并回到 Pi 摘要，这次压缩仍是两次调用，状态文件不更新。
- 没有锚点的旧状态文件在下一次写入前不会被使用。

### 自动压缩触发值按全局加会话覆盖

滑块在松手后写入 runtime settings，下一轮 `turn_end` 才用新值。会话还没有文件路径时滑块不可拖，只能跟随全局。覆盖表按路径累积，删掉的会话不会自动清键。

### 进行中的自动压缩结束后续跑

续跑指令会进会话文件，界面不显示，模型看得到。安全扩展用 `terminate` 停掉的工具批，在 `turn_end` 上看不出来，若同一轮正好自动压缩，仍会续跑。压缩本身会先 abort，模型侧可能出现 “Request was aborted”；界面在 `compaction_start` 时清掉这类中断报错。

### 撤回请求前裁剪思考，上下文按完整会话估算

- 已结束轮次的思考会再次进入后续请求，输入 token 回到裁剪之前的水平。
- 会话记录和界面本来就保留全文，这次没有额外要迁的数据。

## Verification

verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证
