# Agent Note: 会话标题：首条消息拆掉包装再起名，第一条回复后就生成，可手动重新生成

Status: implemented

## Problem

侧栏标题有两条来源，两条都出问题。

**没有生成标题时的兜底。** 主进程列会话时取首条用户消息原文，压成一行截 80 字（`workspaceService.firstUserTextFromEntry`），渲染层发送瞬间的占位标题也是原文。首条消息带包装时，侧栏显示的就是包装本身。用户本机 111 个会话里有 11 个是这样：粘贴长文本显示 `<pi:attachment type="text" lines="45" chars="4194">…`，用技能显示 `<skill name="brainstorming" location="C:\…`。带图的消息后面还拖着 pi 补的 `[Image: original 2559x1527, displayed at …]`。

**自动标题本身质量差。** 以前写进会话的标题里有这些：`# 生成标题`、`**店掌柜商品管理子页面复刻：目录结构与参考文档**`、`{"isNewTopic":true,"title":"套餐订购页面"}`、`无法生成有意义的标题——对话中只有"继续吧"一句`、`当前环境无法直接读取本地 D:\ 路径。请运行：`。原因是下面几条叠在一起：

- 取错了消息：取的是 `agent_end` 的 `event.messages` 里第一条用户消息。那是**这一轮**的消息，首轮没起成名字时，下一轮的第一条就是「继续吧」。
- 包装块原样给模型：整份 SKILL.md、粘贴块标签都进了输入。
- 输出不清洗：落盘前只做了 `cleanLine`（取首行、去引号），markdown 标题符、加粗、JSON、拒绝句、模型把消息当任务的回答都原样写进去。
- 时机太晚：要等首轮整轮结束。首轮长任务动辄十几分钟，这段时间侧栏只有首条消息。
- 网关吃掉系统提示：实测本地 OpenAI 兼容网关（newapi）上，glm 只要请求带 system 就报 `Incorrect role information`，deepseek 时不时丢掉较长的 system，转而回答用户的问题。
- 思考把额度用完：同样实测，网关关不掉思考（`reasoning: "off"` 仍先想 40~500 个 token），64 的 `maxTokens` 被思考用光，以 `length` 结束，没有正文。

用户机器上 `AUTO_TITLE` 也被关掉了（10/08 之后的会话全都没标题），很可能就是因为标题质量。

## Decision

### 输入整理：`extensions/_shared/session-title.ts`

纯函数模块，扩展、主进程、渲染层共用（渲染层经 `@extensions` 别名引）。

- `parseFirstMessage(raw, images)`：把首条用户消息拆成用户正文和附带内容。拆的东西有：pi 展开的 `<skill name=… location=…>…</skill>`；发送前的 `/skill:名` 和 `/skill:"带 空格"`；prompt-commands 展开的 `<command name=… args=…>`（复用 `findCommandBlocks`，模板正文单独留着）；输入框的 `<pi:attachment type="text|file">` 粘贴块和文件块；`[Image: …]` 和 `[Image omitted: …]`，这两个只计数。
- `fallbackSessionTitle(raw, images)`：侧栏兜底标题。优先用用户正文，`@路径` 换成文件名；有命令时写成 `/命令 参数值 正文`；没有正文时依次用技能（`/skill:名`）、粘贴文本的第一行、文件名；只有图片时写「图片」。按 code point 截到 80。主进程 `workspaceService` 和渲染层两处乐观占位（`ChatView`、`sidebarSessionSync`）都用它，所以发送瞬间和落盘后显示的是同一个标题。
- `titleModelInput(raw, images)`：给标题模型的输入。用户正文放在 `<request>` 里，附带内容按类别列在 `<attachments>` 里（`Skill:` / `Command:` / `Command prompt:` / `Pasted text:` / `Attached file x:` / `Images: n`），总预算约 2400 字符，附带内容最多占一半。没有任何文字（只发了图）时返回空串，不起名。
- `firstUserMessage(entries)`：从会话条目里取第一条有内容的用户消息，图片块计数。

### 提示词和清洗：`extensions/auto-title/title.ts`

- 规则和示例全部放在**一条用户消息**里，系统提示是空串（pi-ai 的适配器遇到空串就不发 system）。只发一条用户消息时，haiku、opus、deepseek、glm 四家都稳定（各 4/4）。
- 规则写明：只回一行标题；用用户请求的语言，判断不出来时用 locale；中文 6~16 字，英文 2~8 个词；写任务或主题，不照抄原文；产品名、文件名、命令、标识符原样保留；不回答、不拒绝、不提问、不解释，请求含糊时就写看得见的东西；`<attachments>` 是附带材料，只在请求为空或太含糊时才拿来起名。另附 5 条示例。
- 只有一个文件路径、文件引用或命令的消息，按那个文件或命令起名。没有这条规则时，haiku 会写一句「The request is only a file reference …」的解释。
- `TITLE_MAX_TOKENS = 1024`。各次用量见 Problem：64 被思考用完，512 在长需求上也被用完过（实测 519）。每个会话只调一次；模型要是写成了回答，1024 也封顶，回答会被清洗拒掉。
- `cleanGeneratedTitle(raw)`：兼容 `{"title": "…"}`（含多行）；取第一行；去掉 `#`、列表符、`>`、「标题：」/ `Title:` 前缀、各种引号和 `*`、末尾标点；去掉行内的 `**` 和反引号。以下情况返回空串（不写，侧栏继续显示兜底）：没有字母或数字；拒绝句，只认「无法/不能 … 生成/确定/提供/给出/概括/总结 … 标题」这种说法，加上 sorry / I can't / unable to generate；句中出现句号、问号、叹号后还有字，说明是两句话；显示宽度超过 64（汉字计 2）。

### 生成时机和来源：`extensions/auto-title/index.ts`

- 触发改成助手消息的 `message_end`（第一条回复结束就起名），`agent_end` 只做兜底。用户消息一进来，pi 1.3 就把会话文件写下来了，所以标题写回后侧栏重读就能看到。
- 输入取会话当前分支（`getBranch()`，没有就用 `getEntries()`）上的第一条用户消息，不用本轮的 `event.messages`。只有读不到会话条目时（测试桩）才退回 `event.messages`。
- 每份会话最多试 2 次（按会话文件记，没有文件就按会话 id，放在 `globalThis` 上，reload 之后接着计）。已有名字、子代理会话、试够次数的记进内存集合，之后每条回复直接返回，不再扫条目。正在生成的会话不重复起任务。
- 标题请求不带 `ctx.signal`：那是当前回合的中止信号，第一条回复之后就起名时，用户停掉这一轮不该连标题一起丢。
- `_shared/summarize.ts` 改走 `ctx.modelRegistry.streamSimple(...).result()`，这是 pi 1.3 文档给扩展嵌套调用模型的推荐做法：请求时取鉴权，虚拟模型、只注册在 ModelRuntime 上的 provider 也能用。没有这个方法时退回 pi-ai 全局的 `completeSimple`。新增 `raw` 选项，返回原文，让调用方自己清洗。
- 换走会话（stale ctx）时的写回逻辑不变，沿用 `docs/decisions/extensions/2026-10-04-auto-title-stale-ctx.md`。

### 重新生成标题

- 会话右键菜单和「更多」里，「重命名」下面新增「重新生成标题」（`buildSessionMenuItems` 的 `onRegenerateTitle`，没传就不显示）。
- 渲染层流程：`pi.generateSessionTitle(path)` 调 IPC `generate_session_title`，主进程的 `electron/app/sessionTitle.ts` 读会话文件，用同一套 `firstUserMessage` → `titleModelInput` → `chainSummaryTitle` → `cleanGeneratedTitle` 起名，经主进程的 `modelRuntimeHost.completeSimple` 调模型。模型依次试：设置里的标题模型 → 会话最后用的模型 → 默认会话模型。主进程只返回标题，写回走 App 现有的 `handleSubmitRename`（和手动重命名同一条路）。
- 提示放在 Sidebar（`App.useApp().message`，同一个 key）：先「正在生成标题…」，然后换成「标题已更新：X」，或者「没有生成出合适的标题，保留原标题」，或者「生成标题失败：原因」。全部报错时主进程把最后一个错误抛给渲染层；有回答但都不能用时返回空串。

### 不变量

- 首条消息的新包装（新的块格式、新的图片说明）要加进 `parseFirstMessage`，否则兜底标题又会显示原文。
- 标题请求必须只有一条用户消息、系统提示为空。往 system 里加东西之前，先在本地网关上实测 glm / deepseek。
- 自动标题不覆盖已有名字（手动的或以前生成的）。只有「重新生成标题」会覆盖，而且是用户点的。

## Alternatives considered

- **兜底标题在渲染层按 `parseMessageTags` 现算**：气泡已经这么拆技能和命令，复用最省事，这是它最强的理由。不用它，是因为兜底标题在主进程列会话时就定了（`SessionInfo.name`），侧栏、归档弹窗、删除确认都直接用这个字段。只在一处现算，其他地方还是原文。共用纯函数，主进程和渲染层算的是同一个结果。
- **把助手第一轮的回复也给标题模型**：「这里用tag」「你看看这个气泡如何」这类很短的首条消息，有回复做背景能起得更准。不用它，一是第一条回复后就起名时，手里通常只有「我先看看代码」；二是 2026-10-04 的决定记过，带上回复和工具结果后，模型会去处理路径和代码，而不是起名。实测这类消息新链路给出的是「气泡样式评估」「截图问题排查」，够用；不满意可以重新生成或重命名。
- **规则留在系统提示里（行业常规写法）**：语义最清楚，provider 也会给 system 更高的权重。实测本地 newapi 网关：glm 带任何 system 都报错，deepseek 在 5 次里有 2~3 次把较长的 system 丢了、去回答问题。规则放进用户消息后，四家都稳定，所以不用 system。
- **继续用 `maxTokens: 64`，`length` 无正文时再用大额度重试一次**：正常情况更省，只有思考型网关才多花一次调用。不用它，是因为 `summarize` 只返回文本，拿不到 stopReason，要为这一个调用方改共享原语的返回形状。而且重试会让标题慢一倍。标题每个会话只起一次，直接给 1024 更简单。
- **继续在 `agent_end` 生成**：输入里能带上整轮结果。不用它，原因见上一条（取不到有用的回复）和 Problem 里的时机。
- **用 `turn_end` 触发**：它在每一步模型回复之后，语义上就是「第一轮交互完成」。不用它，是因为 `turn_end` 是边界事件，挂了处理器之后，pi 每一步都要把整条分支复制进一个内存 SessionManager 来建上下文，长会话里是 O(n²)。`message_end` 是普通事件，没有这个开销。
- **显示时清洗已存的坏标题**（`# 生成标题` → 「生成标题」，JSON 取 title）：旧会话不用操作就变好看。不用它，是因为侧栏分不清标题是模型生成的还是用户手动改的，显示层改写手动标题违背用户意图。改成给一个「重新生成标题」的入口，让用户自己决定。

## Consequences

收益：没有生成标题的会话不再显示 `<pi:attachment` / `<skill` / 图片说明；自动标题在第一条回复结束后几秒就出现；标题是短的任务描述，不会再写进 markdown、JSON、拒绝句或回答；旧的坏标题可以一键重新生成。

代价：

- 标题请求的输出上限从 64 涨到 1024。思考型网关上每个会话多花几百个输出 token，模型写成回答时最多 1024，以前是 64。
- 第一条回复后就起名，输入里只有用户的首条消息。很短、指代不明的首条消息（「这里用tag」）起出来的标题可能偏泛，比如「此处使用 tag 标签」。
- 用户的模型一直给不出能用的标题时，每份会话最多试两次，之后保持兜底，要靠手动「重新生成标题」。
- 以前关掉 `AUTO_TITLE` 时没标题的旧会话，用户之后在里面继续对话，会在下一条回复后补上标题。
- 设置里的 `titleModel` 指向已经不存在的模型时，会静默退回会话模型（`resolveSummaryModel` 原有行为，没改）。用户另一份数据目录（`com.rxstudio.grenagent`）里的 `custom-mqgtbqcj/mimo-v2.5-free` 就是这样，models.json 里已经没有这个供应商了。

相关决定：`docs/decisions/extensions/2026-10-04-auto-title-plain-output.md`（已冻结）里「maxTokens 64」「系统提示用 LobeHub chainSummaryTitle 结构」「agent_end 触发」三条由本篇取代；「只给首条用户消息、不给工具」「请求不带工具、关推理」两条仍然成立。

## Verification

结果：通过。

- 单测：`cd extensions && npx vitest run auto-title _shared/session-title.test.ts`，4 个文件、59 条用例通过。覆盖拆包装、兜底标题、模型输入；清洗：用 8 条历史坏标题当正例，7 条拒绝例，加上「图片无法生成问题排查」「子代理没有可用模型」不误杀；取会话第一条而不是「继续吧」；第一条回复后就起名且只调一次；最多试两次；只有图片时不起名。`auto-title-live.real.test.ts` 用真实 AgentSession 加 faux 模型：标题在第一条回复后落进 `session_info`，经过清洗（`**输入框内容被转义**` → `输入框内容被转义`），请求里只有首条消息；模型回拒绝句时不写。
- 单测：`cd electron-agent && npx vitest run src/features/sessions src/features/chat/ChatView.test.tsx src/lib electron/app/sessionTitle.test.ts electron/app/workspaceService.test.ts`，40 个文件、284 条用例通过。新增：主进程列会话时粘贴块、技能块、带图会话的兜底标题；`generateSessionTitle` 的模型顺序、报错和空结果；菜单项位置。
- 类型：临时 tsconfig 检查改动文件，`npx tsc -p tsconfig.node.json --noEmit` 没有新报错（`ChatView.tsx:293` 的 `beforeCount` 报错是改动前就有的）。
- UI：`cd electron-agent && node ui-harness/check.mjs session-title`，新场景 22 条全部 PASS。覆盖：兜底标题不出现包装；「重新生成标题」紧跟「重命名」；生成中、成功、空结果、报错四种提示；行标题更新；浅色主题。日志和截图在 `.agents/evidence/2026-10-19-session-title-quality/`。只跑了这个场景：`session-row` 场景同时在被另一项改动（会话注意状态）修改，没有动它，也没有跑。
- 真实模型对比：`.agents/evidence/2026-10-19-session-title-quality/title-eval.mts` 取用户本机 59 份真实会话的首条消息（最近 40 份，加上所有带包装或图片的）。旧链路按当时原样跑：旧提示词、首条原文、64 token、只做 `cleanLine`。新链路就是最终提交的代码：`titleModelInput` + 新提示词 + 1024 token + `cleanGeneratedTitle`。三家逐条结果表在同目录的 `eval-*.md`。「旧标题不合格」指以 `#` `*` `{` 开头、含「无法」或「当前环境」、为空、或超过 30 字。

  | 模型（网关） | 旧链路不合格 | 新链路没出标题 |
  |---|---|---|
  | claude-haiku-5-5（本地 anthropic 网关） | 18 / 59 | 1 / 59 |
  | deepseek-v4.1-flash（newapi） | 24 / 59 | 0 / 59 |
  | glm-5.3-flash（newapi） | 41 / 59 | 0 / 59 |

  haiku 没出标题的那条是「worktree 方式升级内核 codegraph sdk Pi sdk …」，网关强制的思考偶尔会很长。单独用 1024 跑了 3 次，都出了标题（输出 431~519 token）。自动标题在下一条回复时还会再试一次。新标题样例：「输入框内容被转义」「客服正式模型通道服务端设计」（首条只有粘贴块，旧链路为空）、「子代理执行 SP4a Agent Gate 计划」「气泡样式评估」。
  - 定位问题用的单条探针结论都写在 Problem 和 Alternatives 里：网关吃 system、思考用完额度、只有文件引用的消息会被模型解释（加了一条规则后按文件名起名）。
- 回归：`node ui-harness/check.mjs session-archive`（真实 Sidebar + 菜单，Sidebar 里新加了 `App.useApp()`）47 条全部 PASS。`--changed --dry-run` 列出 29/30 个场景，是工作区里别的未提交改动带进来的。本次改动只在传了 `onRegenerateTitle` 时才多一个菜单项，其余场景没有传这个参数，没有跑。
- 用户本机：`%APPDATA%\electron-agent` 下 `settings.json`、`app-state.json`、`runtime-settings.json` 的 `AUTO_TITLE` 改成 `"1"`，原文件备份为 `*.bak-autotitle-20261019`。
