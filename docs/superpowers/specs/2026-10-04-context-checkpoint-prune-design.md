# 按压力裁工具结果，并让压缩时的状态抽取同时充当压缩摘要

- 日期：2026-10-04
- 状态：已按审查修订，待实现
- 范围：`extensions/compaction-policy`、`extensions/session-memory`
- 对照：MiMo-Code 的上下文处理（裁工具输出、checkpoint 重建、摘要作后备）。本规格只取能落在 Pi 扩展钩子上的两段，不搬它的会话引擎
- Pi 版本：`@earendil-works/pi-coding-agent` 1.0.2（`electron-agent/node_modules` 与 `extensions/node_modules` 一致）

## 1. 背景

桌面的上下文现在由两处扩展和 Pi 自己的压缩拼起来。

`compaction-policy` 在 `context` 钩子里按时间戳排除消息，并熔断单条超过 8 万字符的工具结果。旧工具结果的裁剪由 `COMPACTION_POLICY_PRUNE` 控制，未设置时关闭；打开后，最近 `COMPACTION_POLICY_KEEP_TURNS` 轮（默认 6）之外、正文达到 `COMPACTION_POLICY_MIN_BODY`（默认 1000 字符）的 `toolResult` 整段换成占位。占用分级写在 `pressure.ts`：不到 50% 是 0，50% 到 70% 是 1，70% 到 85% 是 2，85% 及以上是 3。分级只用于状态栏文案，不参与裁剪。占用达到会话触发值（未设置时 80%）时，`turn_end` 调用 `ctx.compact()`。压完若回合还没结束，用隐藏消息续跑。

`ctx.getContextUsage()` 用最近一条助手消息的 usage 加尾部估算，反映的是实际发出的请求。请求被裁过，下一次读到的占用就是裁过的量。

Pi 1.0.2 带 CacheWarmer：在提示缓存到期前，用 1 个输出 token 重发上一次请求保温。默认模式是 `streaming`，agent 运行中（包括长工具执行期间）会保温。保温不产生助手消息，只在分支上追加 `type: "usage"`、`kind: "cache_warm"` 的条目。

`session-memory` 默认每 8 轮把对话抽成五段 markdown，写到 `<cwd>/.pi/session-state/<sessionId>.md`。抽取输入是 `flattenTranscript` 截出的对话末尾 12000 字符加上一份状态。`session_before_compact` 会再抽一次并等待完成，输入同样是末尾 12000 字符。Pi 默认 `keepRecentTokens` 为 20000，保留区约 8 万字符，所以这次抽取看到的几乎全在保留区里，即将被丢弃的 `messagesToSummarize` 没有进入状态。压缩成功后的下一轮，`before_agent_start` 把状态注入一次。Pi 仍会自己再叫模型写摘要：读全部 `messagesToSummarize`（工具结果每条截到 2000 字符），带上一份摘要迭代，切在一轮中间时另写 turn prefix。一次压缩因此有两次模型调用，真正读过被丢内容的只有 Pi 那一次。

状态文件按 `sessionId` 命名，不随分支。回退/编辑会就地截断会话文件，sessionId 不变；`/tree` 换分支同理。文件里会留着已经不在当前分支上的工作。

Pi 1.0.2 的 `session_before_compact` 可以返回 `{ compaction }`。返回后会话不再调用内置摘要，直接用其中的 `summary`、`firstKeptEntryId`、`tokensBefore` 写入压缩条目，并把 `fromHook` 标为 true。多个处理器里后返回的真值覆盖先返回的，返回 `{}` 也算。当前只有 `session-memory` 注册了这个事件，且没有返回值。清单里它排在 `compaction-policy` 之后。`session_compact` 事件带 `fromExtension` 和刚写入的 `compactionEntry`。

`ctx.compact()` 进入 `AgentSession.compact()`，第一步 abort 当前回合，此后处理器里的 `ctx.signal` 是 `undefined`。用户取消压缩只会 abort 事件里的 `event.signal`。

内置摘要会处理切在一轮中间的情况，并把文件列表以 `<read-files>`、`<modified-files>` 附在末尾（modified = edited ∪ written，read 去掉已改的）。扩展提供的压缩条目 `fromHook` 为 true，Pi 下一轮压缩不会从它的 `details` 继承文件列表。

Pi 1.0.2 和本仓库都没有名为 `skill` 的工具。技能通过 `read` 读取 `SKILL.md` 加载，Pi 的读文件渲染也按这个文件名识别。

相关的旧决策：`docs/decisions/extensions/2026-09-29-strip-settled-thinking.md` 放弃「开关」，理由是前缀时有时无会让提示缓存反复失效；`2026-09-30-revert-thinking-strip.md` 撤回了在 `context` 钩子里删思考。本规格的裁剪同样只改发往模型的副本。第 4 节用「冷时定案、热时沿用」回应前一条。它不碰思考块，占用按实际发出的请求计，与后一条撤回的原因（服务端按未裁历史拒绝、截断后带错思考）不同。

## 2. 目标与非目标

**目标**

1. 占用升高且提示缓存已冷时，按压力等级裁旧工具结果，并把这次的裁法定下来；缓存热着时原样沿用，同一段前缀逐字节不变。会话文件不改。
2. 压缩时只调一次模型：`session-memory` 读 Pi 准备好的待丢弃消息、上一份摘要、上一份状态和切轮前缀，产出五段状态。结果同时写入状态文件、作为压缩摘要返回，Pi 不再调用摘要模型。切点仍用 Pi 的 `firstKeptEntryId`。
3. 抽取失败、被取消、功能关闭、调用方带了 `customInstructions`、或准备数据不全时，摘要走 Pi。
4. 状态文件只在属于当前分支时使用。
5. 摘要来自状态时，压缩后的下一轮不再注入同一份状态。

**非目标**

- 不移植 MiMo 的消息存储、checkpoint 写手、`checkpoint.md` / `MEMORY.md` / `notes.md`、dream、distill、任务树。
- 不改自动压缩的触发百分比，不把百分比折进 Pi 的 `reserveTokens`。未设置时仍是 80%，会话覆盖仍走 `AUTO_COMPACT_OVERRIDES`。触发判断看实际发出请求的占用，裁剪会让它相应推迟。
- 不改自动压缩的续跑、失败后停手、手动压缩不续跑。
- 不让子会话读父会话的状态文件。每个会话只用自己的 `sessionId` 文件。
- 不新做设置页。只新增一个配置键 `COMPACTION_POLICY_PRUNE_TTL_MS`，其余沿用。
- 不在 `context` 钩子里改写思考块。
- 裁剪计划不持久化。进程重启后，第一次热请求不会沿用重启前的裁法，可能 miss 一次。
- 不识别 codemode 嵌套调用（`nestedCalls`）里读的 `SKILL.md`，只认助手消息里直接的 `read` 调用。

## 3. 边界

| 单元 | 职责 |
|---|---|
| `compaction-policy` 的 `context` | 排除、熔断、按压力裁工具结果（冷时定案、热时沿用）。不触发压缩，不读会话状态文件 |
| `compaction-policy` 的 `session_start` / `session_compact` | 清空进程内的裁剪计划 |
| `compaction-policy` 的 `turn_end` | 照旧按占用触发 `ctx.compact()`，并在需要时续跑 |
| `session-memory` | 维护带分支锚点的状态文件。压缩前做唯一一次抽取并决定摘要来源。压缩后按事件字段决定要不要再注入 |
| Pi `prepareCompaction` | 决定留下哪些条目、待丢弃消息、切轮前缀、文件操作。本规格不改 |

`compaction-policy` 不注册 `session_before_compact`。后加载的扩展只要从该事件返回真值（包括 `{}`）就会盖住 `session-memory` 的结果。实现时不要在更后面的扩展里返回该事件的结果。

## 4. 按压力裁工具结果

裁剪只存在于发往模型的副本。`context` 钩子返回新的消息数组，不写会话条目，也不原地修改传入的消息对象：Pi 传进来的数组与它内部共享消息对象，抛错前的原地修改会留下来。

顺序保持：先按时间戳排除，再熔断超大工具结果，再做本节的压力裁剪。熔断不受压力、缓存冷热和保留轮数影响。`COMPACTION_POLICY_FUSE_CHARS` 未设置时仍是 80000，设为 `0` 仍关闭熔断。

### 4.1 开关

`COMPACTION_POLICY_PRUNE` 未设置或不是 `"0"` 时本节生效。显式 `"0"` 关闭压力裁剪，熔断和排除照旧。这把未设置时的含义从「不裁」改成「按压力裁」。原来按保留轮数整段替换的 `pruneMessages` 删除。

### 4.2 冷热与定案

进程内保存一份裁剪计划：`toolCallId → "soft" | "replace"`，以及上一次请求按计划省下的字符数。钩子每次拿到的是 Pi `structuredClone` 出来的副本，计划按 `toolCallId` 认消息，不靠对象身份。

最后活动时间取下面两者中较晚的：

- 钩子消息里最后一条 `role === "assistant"` 的 `timestamp`；
- `ctx.sessionManager.getBranch()` 里最后一条 `type === "usage"`、`kind === "cache_warm"` 条目的 `timestamp`（ISO 字符串）。

两者都取不到时视为已冷。`now - 最后活动 >= TTL` 时为冷。TTL 取 `COMPACTION_POLICY_PRUNE_TTL_MS`，未设置、空或非法（非数字、负数）时为 300000（5 分钟，对应 Anthropic 默认缓存档；用长保留档时调大）。设为 `0` 表示每次请求都按冷处理。

- 热：原样套用已有计划。没有计划就不裁。新出现的消息不在计划里，不受影响。
- 冷：重新定案。按第 4.3 节的等级重算计划，替换旧计划，然后套用。

计划在 `session_start` 和 `session_compact` 时清空。

### 4.3 等级

等级按未裁时的占用算，避免裁剪把自己的触发条件抵消：

`p = percent + savedChars / 4 / contextWindow × 100`

`percent`、`contextWindow` 来自 `ctx.getContextUsage()`，`savedChars` 是上一次请求按计划省下的字符数。`percent` 为 `null`（压缩后到下一次回复前）或取不到时，等级为 0。`p` 交给现有 `classify`。等级 0 时新计划为空。

### 4.4 保护范围与候选

从末尾数 `COMPACTION_POLICY_KEEP_TURNS` 个用户消息（未设置时 6）。用户消息不超过这个数时不裁。最早那条受保护的用户消息及其后的所有消息不裁。

保护范围之前的 `toolResult`，从靠近保护范围的一侧向前逐条累计正文字符。累计到本条（含本条）不超过 160000 时留原文；第一次超过时，本条及更早的全部进入候选。没有 `toolCallId` 的结果跳过。

读技能的结果既不计入累计，也不进入候选。判定：助手消息里 `type === "toolCall"`、`name === "read"`，参数 `path`（缺失时用 `file_path`）按 `/` 和 `\` 切分后最后一段是 `SKILL.md`，该调用 `id` 对应的结果。

正文长度沿用现有算法：只加总 `type === "text"` 块的 `text` 长度。

### 4.5 软裁（等级 1）

候选里正文长度大于 4096 的标为 `soft`，其余不动。

套用时，把所有文本块的 `text` 用 `\n` 接成一个串，取前 1536 个 UTF-16 码元作头、后 1536 个作尾。头段末尾若是孤立高位代理，去掉它；尾段开头若是孤立低位代理，去掉它。结果是一个文本块：

```
<头>
[... trimmed, removed <n> chars ...]
<尾>
```

`n` 是接成的串长度减去头尾的实际长度。这个文本块放在最前，非文本块按原顺序跟在后面。接成的串不超过 4096 时保持原文。

### 4.6 整段替换（等级 2 和 3）

先估算整段替换能省下的字符：候选里正文长度大于或等于 `COMPACTION_POLICY_MIN_BODY`（未设置时 1000）的，每条省下「正文长度减去占位长度」，求和。达到 80000 时，这些候选标为 `replace`，其余候选不动。不足 80000 时按第 4.5 节标 `soft`。

`replace` 套用时，整段内容换成一个文本块：

`[pruned tool output: <toolName>, <正文长度> chars]`

`toolName` 缺失或为空时写 `tool`。非文本块去掉。

等级 2 和 3 行为相同，四级只为状态栏文案保留。

## 5. 压缩时的一次抽取同时充当状态与摘要

只改 `session-memory`。周期写文件的节奏不变：`SESSION_STATE_ENABLED` 未设置时开启，`"0"` 关闭；`SESSION_STATE_EVERY_TURNS` 未设置时 8；周期抽取失败保留上一份文件。

### 5.1 状态文件的分支锚点

状态文件第一行写锚点注释，正文从第二行起：

```
<!-- session-state anchor=<entryId> -->
## Intent
...
```

锚点是写入开始时分支最后一条条目（叶子）的 `id`：周期写入取 `ctx.sessionManager.getBranch()` 的最后一条，压缩时取 `branchEntries` 的最后一条。都在 `await` 之前取。

状态属于当前分支 = 锚点存在、出现在当前分支的条目 id 里（`getBranch()` 或 `branchEntries`），并且正文去掉空白后非空。不满足时视为没有状态：不作为抽取的上一份状态，也不在压缩后注入。没有锚点的旧文件同样不用，下一次写入会补上锚点。

`/session-state` 只显示正文，不显示锚点行。

### 5.2 写入顺序

每次写入（周期或压缩）开始时取一个递增序号。完成时只有序号仍是最新的写入才落盘，先开始后完成的写入作废。周期写入的结果与上一份相同（抽取失败时 `extractState` 返回旧文）时不重写文件。

### 5.3 什么时候交给 Pi

`session_before_compact` 在下列情况返回 `undefined`，Pi 照旧生成摘要：

- `SESSION_STATE_ENABLED` 为 `"0"`：不做任何事。
- `customInstructions` 去掉空白后非空，或 `preparation.firstKeptEntryId` 不是非空字符串，或 `preparation.tokensBefore` 不是有限数字：按今天的方式刷新状态（`branchEntries` 里的消息、末尾 12000 字符、属于当前分支的上一份状态，取消信号用 `event.signal`），等待完成后返回 `undefined`。
- 解析不到模型。
- 抽取抛错、输出去掉空白后为空、或 `event.signal` 已中止。

### 5.4 抽取

模型同今天：`SESSION_STATE_MODEL` 优先，否则 `ctx.model`。取消信号用 `event.signal`，不用 `ctx.signal`。

输入由四段组成，缺的段省略：

1. 上一份状态：按第 5.1 节判定属于当前分支的正文，放在 `<previous-state>` 里。
2. 上一份摘要：`preparation.previousSummary`，放在 `<previous-summary>` 里。
3. 待丢弃的对话：`serializeConversation(convertToLlm(preparation.messagesToSummarize))`，放在 `<conversation>` 里。两个函数都从 `@earendil-works/pi-coding-agent` 导入，与 Pi 内置摘要同一种序列化（工具结果每条截到 2000 字符）。不再走 12000 字符的尾巴。
4. 切轮前缀：`preparation.isSplitTurn` 为真且 `turnPrefixMessages` 非空时同样序列化，放在 `<current-turn-prefix>` 里，并注明保留区从这一轮中间开始，要交代这一轮的用户请求和进展。

不另设输入预算。待丢弃消息本来就在上一次请求里，会话模型装得下。`SESSION_STATE_MODEL` 指向窗口更小的模型时可能溢出，按抽取失败交给 Pi。

系统提示沿用五段格式（`## Intent`、`## Next step`、`## Task progress`、`## Key files`、`## Key decisions`），另外说明：输出会替换被丢弃的历史，要保留继续工作需要的事实（需求和约束、完成与未完成的步骤、文件路径、决定及理由、未解决的错误）；后面的消息会原样保留，不需要复述。

抽取成功后，正文按第 5.1、5.2 节写入状态文件，周期计数清零。

### 5.5 返回的压缩结果

摘要以抽取正文开头，不截断。文件附录非空时，空一行接在后面。

文件附录合并两处来源：本次 `preparation.fileOps`；以及 `branchEntries` 中最后一条 `type === "compaction"` 的条目，若其 `details.source === "session-state"`，取它的 `readFiles`、`modifiedFiles`。最后一条压缩是 Pi 写的时不合并，Pi 已经把它并进 `fileOps`。

modified = 上一份 modified ∪ `edited` ∪ `written`；read = 上一份 read ∪ `read`，再去掉 modified 里有的。两类各自排序。格式与 Pi 一致：

```
<read-files>
a.ts
(<n> more)
</read-files>

<modified-files>
b.ts
</modified-files>
```

每类在摘要里最多列 40 条，多出的数量写成 `(<n> more)`；空的一类不写。

返回：

```ts
{
  compaction: {
    summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { source: "session-state", readFiles, modifiedFiles },
  },
}
```

`details` 里存完整列表，不受 40 条限制。不返回 `usage`。不改 `firstKeptEntryId`。不取消压缩。

### 5.6 压缩后是否注入

`session_compact` 里：`event.fromExtension === true` 且 `event.compactionEntry.details.source === "session-state"` 时不注入（`needReanchor = false`），否则 `needReanchor = true`。不需要进程内标记，也不处理 `session_compact_failed`。

下一轮 `before_agent_start` 注入前按第 5.1 节检查锚点，不属于当前分支就不注入。注入预算仍是 `SESSION_STATE_MAX_CHARS`（未设置时 4000）。

## 6. 错误处理

- 压力百分比缺失：冷时定案为空计划，热时沿用已有计划。熔断照旧。
- 裁剪抛错：Pi 记下扩展错误，继续用钩子之前的消息列表。前提是实现不原地修改消息。
- 状态文件读失败：视为没有状态。
- 抽取失败或超出模型窗口：返回 `undefined`，Pi 生成摘要，状态文件不变。
- 用户取消压缩：`event.signal` 中止抽取请求，处理器返回 `undefined`，Pi 随后检查到信号已中止，按取消结束压缩。
- 状态写盘抛错：Pi 记为扩展错误，本次视为没有返回结果，Pi 生成摘要。

## 7. 测试

`compaction-policy`：

- 冷热：只有助手消息时按它的时间戳；`cache_warm` 条目更晚时以它为准；其他 `usage` 条目不算；都没有时为冷；TTL 为 0 时总是冷；非法 TTL 用 300000。
- 等级 0 时候选保持原文。
- 等级 1：超过 4096 的候选变成头尾两段且 `n` 正确；保护范围内不动；最近 160000 字符内不动，跨界那条进入候选；读 `SKILL.md` 的结果不动且不计入 160000；多个文本块按 `\n` 接成一块，非文本块保留在其后；输入消息不被修改。
- 代理对：头末尾的高位代理、尾开头的低位代理被去掉。
- 等级 2/3：省下达到 80000 时整段替换、去掉非文本块、短于 `MIN_BODY` 的候选不动；不足 80000 时走软裁。
- 定案沿用：冷时定案后，追加一条新的助手消息（变热）再调用，旧结果的输出逐字节相同；占用掉到 0 级也照用。热且没有计划时高占用也不裁。再次变冷时按新等级重算。
- 未裁量：上一次省下的字符折回百分比，等级不因裁剪而下降。
- 钩子集成：未设置开关时按压力裁；热请求沿用；`session_compact` 后计划清空；`COMPACTION_POLICY_PRUNE=0` 时高占用也不裁，熔断仍作用于保护范围内的超大结果。

`session-memory`：

- 锚点读写往返；无锚点、锚点不在分支上、正文为空时视为没有状态。
- 抽取输入含属于当前分支的上一份状态、上一份摘要、序列化的待丢弃对话；切轮时含前缀段；锚点不在分支上时不含上一份状态；抽取请求拿到的是 `event.signal`。
- 准备数据合法、抽取成功：返回的 `firstKeptEntryId`、`tokensBefore` 与准备数据相同，`details.source` 为 `session-state`，摘要以抽取正文开头，状态文件更新为同一正文并带锚点。
- 文件附录：`edited`/`written` 合入 modified，read 去掉已改的；超过 40 条写 `(<n> more)`；合并上一份 `session-state` 压缩条目的列表；最后一条压缩是 Pi 写的时不合并。
- 抽取抛错、输出为空、信号已中止、解析不到模型、功能关闭：返回 `undefined`，状态文件不变。
- `customInstructions` 为 `"focus"`：返回 `undefined`，并按旧方式刷新了状态。
- 写入顺序：先开始的周期写入晚于压缩写入完成时，不覆盖压缩写入的结果。
- 注入：`session_compact` 来自本扩展且 `source` 为 `session-state` 时不注入；其他情况注入；锚点不在分支上时不注入。

## 8. 实现时的决策笔记

与代码同一提交写 `docs/decisions/extensions/2026-10-04-session-state-as-compaction.md`。笔记说明：未设置的裁剪开关改为按压力裁，裁法冷时定案、热时沿用；压缩时由 `session-memory` 读待丢弃消息做唯一一次抽取，结果同时作状态和摘要；状态文件带分支锚点。放弃的方案至少包括：

- 每次请求单独判断冷热并重算裁法：热请求会退回未裁前缀，刚写的缓存整段 miss，与 2026-09-29 笔记放弃开关的理由相同。
- 冷热只看最后一条助手消息：Pi 1.0.2 的保温不产生助手消息，会把 Pi 刚保住的缓存裁掉。
- 直接拿周期状态文件当摘要：它只看过末尾 12000 字符，没读过待丢弃的消息。
- 摘要交回 Pi、压缩时不再抽取：同样一次调用，但压缩后注入的状态会偏旧。
- 把 MiMo 的 checkpoint 写手和边界重建搬进来。
- 把触发百分比改成 90。
- 在 `details` 里传文件列表并指望 Pi 下一轮压缩继承（`fromHook` 不会继承）；改为本扩展自己合并上一份。
- 按 sessionId 记「本次摘要来自状态」的进程内标记：`session_compact` 已带 `fromExtension` 和条目 `details`，标记还要额外处理失败清理。

同一提交更新 `docs/architecture.md` 里 `session-memory` 一行的职责描述。
