# AGENTS.md

本仓库的 Agent / 扩展约定。Pi 会从工作区向上查找并加载本文件。

## 重要改动必须留笔记

1. 非平凡改动（行为、架构、跨文件契约、流程/工具链、测试策略、落盘/网络/配置格式）前，按 .agents/skills/write-notes-like-deepseek/SKILL.md 写或更新笔记；纯机械小改直接交。
2. 先搜 .agents/notes/ 同主题旧笔记：能原地更新就更新；新想法放 proposed/，落地随代码转 implemented/；彻底取代旧决策时同批归档并标明被谁取代。
3. 被放弃的方案先写最强理由，再写为什么不用。
4. 提交前跑 npm run verify-notes，红了先修再交。
5. 「非平凡」的补充判定（沿用原 docs/decisions 触发清单）：改了对外契约、接口签名或数据格式；新增、移除或替换依赖；在多个可行方案之间做了选择；修了「光看代码看不出原因」的 bug；推翻了以前的决定。
6. 开工前先搜 .agents/notes/（需要考古时再 grep 冻结的 docs/decisions/），确认该模块没有已否决的方案。
7. pre-commit 钩子会跑根目录 `pnpm run verify-notes`。


## 注册工具必须带官方提示词字段

`pi.registerTool()` 的 `description` 只进工具 schema。自定义工具如果没有 `promptSnippet`，**不会**出现在默认系统提示词的 Available tools 里。后面新增或覆盖任何工具都要按官方字段补齐，不要只写 `description`，也不要把工具清单再抄进 Fable / 长系统提示词——Pi 会按当前激活工具自动拼 Available tools 与 Guidelines。

| 字段 | 作用 | 本仓库要求 |
| --- | --- | --- |
| `description` | 给模型看的工具说明与参数语义 | 必填 |
| `promptSnippet` | 一行摘要，写入 Available tools | 必填。没有这一行，自定义工具不会出现在该段 |
| `promptGuidelines` | 工具激活时追加到 Guidelines 的条目 | 有路由或纪律时必填；每条必须写出工具名，禁止写 `this tool` |

官方说明见 [pi.dev Extensions](https://pi.dev/docs/latest/extensions)：`promptGuidelines` 是扁平追加、没有工具名前缀，必须写成 `Use my_tool when...`。覆盖内置工具时，`promptSnippet` / `promptGuidelines` **不会**从原工具继承，覆盖定义里要自己写。

### 写法

```ts
import { toolPrompt } from "../_shared/toolPrompt.js";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "完整说明：做什么、关键参数、和相邻工具怎么分工。",
  ...toolPrompt("一行说明，供 Available tools 使用。", [
    "Use my_tool when ...; pass every relevant parameter from its schema.",
  ]),
  parameters: Type.Object({ /* ... */ }),
  async execute(_id, params, _signal, _update, ctx) {
    return { content: [{ type: "text", text: "done" }] };
  },
});
```

- `promptSnippet` 只写一行，不要复述整个 schema。
- `promptGuidelines` 只写模型不看字段就会用错的纪律。不要给每个工具都堆一条复述 snippet 的空话，以免撑爆 Guidelines、反复重建系统提示前缀缓存。
- AgentData 一族只在主工具上写 `promptGuidelines`（`code_explore` / `wiki_search` / `memory_search`）。代码检索只注册 `code_explore`，不要再加 `code_search` 等兄弟工具。wiki / memory 不要把同一段纪律复制到每个兄弟工具上。索引是否存在只由 `code-retrieval` 每轮 hint 说一次。Fable 默认只注行为核，不要把工具手册再抄回去。
- 动态投射的 MCP 工具用 server 给出的 description 填 `promptSnippet`；不要在 Fable 里枚举 `mcp__*` 名字。
- 懒加载、会话中途才激活的工具：加上 `promptSnippet` / `promptGuidelines` 会重建系统提示。需要进 Available tools 的产品工具仍然要写 snippet；纯发现/代理类工具可以只靠 `description`。

### 验收

新增或改工具后跑：

```bash
cd extensions
npx vitest run prompt-metadata.test.ts
```

该测试要求所有静态注册工具都有非空 `promptSnippet`，并检查 AgentData 工具的 guidelines 点了名。

## 决策记录（docs/decisions/ 已冻结）

`docs/decisions/` 自 2026-10-11 起冻结为只读历史，不再新增或修改；仍有效的决定已迁入 `.agents/notes/implemented/`，源文件顶部有「已迁移」墓碑。决策只写 `.agents/notes/`，规则见上文「重要改动必须留笔记」和 [单一决策记录](.agents/notes/implemented/process/2026-10-11-single-decision-record-system.md)。`docs/architecture.md` 仍只写系统现状事实，不写「为什么」。


## UI 检查（ui-harness）

工具卡片、对话时间线、弹层开合、动画、主题色、布局对齐、键盘交互这类改动，jsdom 单测盖不到。`electron-agent/ui-harness/` 把真实组件渲染进 Electron 窗口，用 `sendInputEvent` 发真实的鼠标键盘事件，再读 DOM 断言。

改了上面这类 UI，要新增或更新对应的场景，并把它跑到全部 PASS。只跑当前需求对应的场景，已经定档、不在本次需求里的场景不跑（见下面「跑哪些场景」）。纯逻辑改动写 vitest 单测；要真实主进程、pi 子进程或 IPC 的不归它管。

    cd electron-agent
    npm run ui:check -- codemode-card               # 日常：只跑当前需求对应的场景（可以点名多个）
    npm run ui:check -- --changed --dry-run         # 只看不跑：未提交的改动还波及哪些别的场景
    npm run ui:check -- --changed                   # 跑受改动影响的场景（改了多个场景共用的代码、确实要验证别的场景时）
    npm run ui:check -- --changed=main              # 对比 main：整个分支改动波及的场景
    npm run ui:check                                # 全部场景：用户明确要求时才跑
    npm run ui:check -- codemode-card --show        # 显示窗口跑（看过程、量性能），同样不抢焦点
    npm run ui:check -- codemode-card --rebuild     # 强制重建（默认源码没变就复用上次构建）

用 npm 跑，`--xxx` 参数必须放在 `--` 后面，否则 npm 会把它吃掉（场景名不受影响）。直接 `node ui-harness/check.mjs <参数>` 不用加。

默认静默运行：离屏渲染，不弹窗、不进任务栏、不抢焦点，跑的时候可以照常用电脑，主仓库和 worktree 也能同时跑。`check.mjs` 会强制生产版构建，任一断言失败时退出码非 0。源码没变就复用上次构建（构建约 5 秒，输出里会写为什么重建）。构建产物和截图在系统临时目录（`%TEMP%\grenagent-ui-shots\` 等），按代码路径分目录，主仓库和 worktree 互不覆盖。

### 跑哪些场景

原则：只验证当前需求。已经定档、不在本次需求里的场景，收尾时不要顺带拉出来重跑，也不要自己把范围升级成全量。目前有 `codemode-card`、`bash-job-card`、`visual-panel`、`subagent-conversation`、`subagent-history`、`session-row`、`command-pill`、`prompt-library-panel`、`chat-follow`、`provider-diagnostics`、`provider-model-list`、`file-explorer`、`panel-resize`、`subagent-approval`、`agent-message`、`subagent-detached`、`agentdata-overview`、`code-retrieval-panel`、`code-index-sync`、`dock-session-binding`、`invalid-arguments-card`、`goal-round-card`、`isolated-workspace`、`steer-cancel`、`session-archive`、`composer-text`、`composer-chips`、`sidebar-sections`、`attention-toast`、`session-title`、`plan-panel`、`chat-find` 三十二个场景，全量就是它们。

- 改了某个工具卡 / 时间线组件的 UI：点名对应的场景（查下面「现有场景」），可以是几个，但都属于本次需求。
- 新增组件 / 面板：先写新场景 + probe，只跑这个新场景。其他场景一个不跑。
- 只改了 probe / 断言：点名那个场景。probe 不走 vite，不会触发构建。
- 改了多个场景共用的代码（`HarnessRoot.tsx`、`src/index.css`、`src/theme/`、`ThemeBridge`、`themeStore` 这类）：先跑本次需求的场景，再 `--changed --dry-run` 看波及范围。别的场景行为确实可能变了，才用 `--changed` 跑它们，并把跑了哪些、为什么告诉用户；没有就不跑。
- 改了 harness 自身（`run.mjs` / `probe.mjs`）：用 `electron-ui-harness` skill 的 `scripts/smoke.mjs --app electron-agent` 再加 1~2 个场景，不用全量。
- 全部场景：用户明确要求，或合并 / 发版前由用户决定。

`--changed` 按构建时记下的依赖图（`depsGraph.mjs`）选场景，规则在 `affected.mjs`：只被某几个场景引用的文件只选它们；公共文件（`main.tsx` 静态引入的 `index.css`、主题、`HarnessRoot.tsx`、构建配置、`run.mjs` / `probe.mjs`）选全部；全局样式按改动落在哪条规则、选择器里的类名被哪些场景的源码用到来缩小，拿不准（`:root` 变量、`@font-face`、没人引用的 `@keyframes`、类名在源码里找不到）就退回全部，输出里写原因。`electron-agent/src` 下没人引用的组件 / 样式文件（tsx、css）会列为「没有场景覆盖」，该补场景了；纯 `.ts` 逻辑、`electron/`、`extensions/` 这类场景看不到的文件忽略（`harness.config.mjs` 的 `sourceRoots` 只列了 `../src`）。结尾会写「只跑了 a/b 个场景」，汇报时说清跑了哪些、没跑哪些。

    electron-agent/ui-harness/
      harness.config.mjs   # 别名 @extensions、dedupe @pierre/diffs（对齐 electron.vite.config.ts renderer 段）、
                           #   sourceRoots（只列渲染层 ../src）、视口 1420×880、frameRate（null = 跟主显示器）、
                           #   webPreferences、hiddenSelector（antd 的 .ant-popover-hidden / -dropdown- / -tooltip-hidden）
      check.mjs / run.mjs  # 构建（源码没变就复用）+ 逐场景起 Electron / 加载场景、跑 probe、汇报
      depsGraph.mjs        # vite 插件：记场景用到哪些源文件，跳过多余构建、算 --changed
      affected.mjs         # 改动的文件 → 受影响的场景（git + 依赖图，全局样式按规则缩小范围）
      probe.mjs            # 工具箱 t：click / dblclick / rightClick / hover / mouse / drag / wheel / key / type / insertText /
                           #   waitFor / waitUntil / waitForText / text / count / countVisible / style / rect / hitTest / js /
                           #   data / events / act / setTheme / resize / shot / sample / scrollFps /
                           #   check / ok / checkNear / checkColor / info
      main.tsx             # 按 #名字 加载场景，引入 src/index.css，forceEagerImages()
      HarnessRoot.tsx      # @lobehub ThemeProvider（github 方案、cssVar 固定 key）+ ConfigProvider + ThemeBridge；
                           #   明暗跟 <html data-theme> 走（默认 dark），首次 commit 后设 __uiReady
      stubs.ts             # window.gren 桩：installBridge / track / exposeData / exposeActions / delay / deferred
      codemodeFixtures.ts  # codemode 事件 / 历史消息：liveDoneEvents / liveRunningEvents / liveFailedEvents /
                           #   historyMessages / manyCallsMessages（按 pi 1.0.2 真实形状）
      scenarios/<名字>.tsx # 造数据、装桩、渲染，只默认导出一个组件
      probes/<名字>.mjs    # 断言，默认导出 async (t) => {}

### 现有场景

- 子代理详情：`subagent-conversation`（真实 SubAgentConversation → ChatMessageItems；单轮 180 次工具循环按时间线行虚拟化，上下文分组和嵌套调用保持完整；完成态长思考沿用 160px 上限并可内部滚动；顶部历史与最终正文可以来回滚动，离屏条目卸载，整轮仅一个复制入口；列表末尾留 96px 空白，贴底时最后一行和「正在处理…」不压在面板底边上；主对话 / 子代理行距几何对照；真实 SubAgentBody 在后台启动工具已返回时仍跟随运行态，折叠思考追加文字时逐帧滑动，展开限高、重新折叠恢复预览，真正完成后结束运行状态；后台回执不带 sessionPath 时靠登记表路径接上事件流、完成并释放轮询后正文不丢，终态挂载缺路径只补查一次 `subagent_list`；虚拟列表里点击 / 滚轮前先 `settleHit` 等目标被指针命中满 300ms）
- 子代理历史卡：`subagent-history`（已完成的卡片重新挂载后恢复任务标题、模型与思考档；历史缺字段时共享一次注册表查询；并行子代理任务同名时按 agentId 匹配模型）
- 后台 bash 工具卡：`bash-job-card`（走真实 reducer → groupMessages → TurnTimeline，主进程那头的 `job_snapshot` / `job_kill` / `pi://jobs` 用桩，数据形状照真实会话里 `run_in_background` 的结果；实时 / 历史回放 / 任务已不在三种情况；折叠行的行图标跟着后台任务走（在跑是转圈、不是 ✓）、时长从任务起算并在结束后定格、「后台运行中 / 已完成 / 正在停止」状态、展开后的终端与底栏、输出帧追加、停止、结束、任务已不在时回退到工具结果；运行中的前台命令跟随它的匿名 job：默认展开、底栏只说状态不写 id、输出帧追加、停止只发 job_kill、结束后同一张卡换成最终结果并自动收起，可手动重新展开；前台转后台等待快照不误收起，历史首次终态快照保持手动展开、找不到 job 时静默回退到 partial 文本；沙箱事实：前台被拒的行写「沙箱拒绝 · 只读」、展开后底栏一句中文、终端正文保留给模型的标记，已升权的行和底栏写明权限，后台任务被拒时底栏换成中文、不贴升权提示原文）
- 工具卡：`codemode-card`（走真实 reducer → groupMessages → TurnTimeline；实时完成 / 运行中 / 失败 / 历史回放 / 调用很多五种情况；标题摘要与调用次数、嵌套调用列表的状态和服务器标签、历史靠 details.calls 还原、展开后脚本与输出、去掉结果头、JSON 缩进、脚本错误标红且排在脚本前、MCP 结果 markdown / JSON 渲染与全文路径、超过 6 条折叠、浅色主题）
- 视觉设计面板：`visual-panel`（真实 VisualPanel + HtmlPreview + `buildSrcDoc(fill)`，`extension_ui_respond` 用桩；iframe 里的几何靠主进程 `webFrameMain.executeJavaScript` 读；长页面滚到底选项 B 完整露在确认条上方且 hit test 命中、确认条保持 fixed 单行横排且样式节点不画成文字、点 B 只选中、点确认才回传 `change`；矮页面比较区仍撑满、选项贴在确认条预留区上方）
- 会话归档：`session-archive`（真实 Sidebar + 真实 `archiveActions`，`set_sessions_archived` / `subagent_get_session_messages` 用桩、桩里维护一份「磁盘」会话与归档登记，形状照 `workspaceService`（归档的带 `archived: true`）；已归档的不在侧栏、对话只显示最新一份；运行中的会话菜单「归档」置灰且点了不发请求、悬停也没有归档按钮；空闲行悬停时「更多」左边紧挨一个同尺寸的归档按钮，点了立即归档、不弹确认、不触发整行打开；归档后行消失、底部「已归档 N」跟着变、不弹确认；归档对话时目录下两份一起归档、次新的不顶上来；弹窗按时间倒序、项目写目录名、对话写「对话」；查看是只读弹窗（正文加载、没有输入框）；取消归档回到侧栏；删除先确认、取消不删；浅色主题弹窗浅底；Esc 关闭后入口仍在。会话行按标题文字找、antd 弹窗按 `wrapClassName`（`archived-modal` / `archived-viewer` / `archived-delete`）找）
- 侧栏分区折叠：`sidebar-sections`（真实 Sidebar + 真实 sidebarPrefsStore，新建对话 / 新建项目只记事件；置顶 / 对话 / 项目三个区头点标题或标题右边空白收起 / 展开，收起只剩区头和新建按钮、下一个区头紧接上来；箭头在标题后面，展开时只在悬停或键盘聚焦时出现，收起时常驻朝右；Enter / Space 切换；折叠写进 localStorage `pi-sidebar` 的 `collapsedSections`；新建对话按钮展开时不折叠、收起时先展开，新建项目打开下拉不展开、选了菜单项才展开；收起置顶后置顶会话哪里都不出现，右键置顶一项后置顶区自动展开；标题距左沿 14px、新建按钮与标题垂直居中；浅色主题。区头按 `[data-testid="sidebar-section"][data-section=…]` 找，`t.click` 点完 80ms 就移开鼠标，读箭头淡出前先等 300ms）
- 会话内查找：`chat-find`（真实 ChatMessageItems（virtua 虚拟化、Markdown、代码块）+ 真实 `useSessionFind` / `FindBar` / `FindShortcutHost`，外层按 ChatView 的结构摆（根带 `data-find-scope`、查找栏绝对定位在顶部、列表顶边下移 40px、底部悬浮输入区），没有挂真实 ChatView；80 条消息里关键词 9 处，位置和个数写死在 `EXPECTED`。焦点在底部输入框时 Ctrl+F 仍拦截、范围外输入框的 document 级 Ctrl+F 监听不被抢、点了消息文字后按最后点击的范围认领；查找栏占独立一行、不压消息不碰输入区、控件靠右；计数覆盖没渲染的消息，逐个跳转每步当前项完整可见、末尾循环、跳到离屏代码块精确定位；高亮走 CSS Highlight（`CSS.highlights.get('gren-find')` 读条数，不改 DOM，加粗 / 行内代码 / 链接 / 部分匹配都在）；无结果空状态、Enter / Shift+Enter、Esc 关闭清高亮并把焦点还给输入框、新消息到来计数更新、换会话关闭、浅色主题高亮计算色。Ctrl+F 用 `t.key('f', ['control'])` 发）
- 会话标题：`session-title`（真实 Sidebar + 真实 `fallbackSessionTitle`，首条消息按真实会话的形状造（输入框粘贴块、pi 展开的技能块、图片说明），`generate_session_title` 用桩、每次返回由 probe 经 act 放行的 deferred；没有生成标题的会话侧栏不出现 `<pi:attachment` / `<skill` / `[Image`，粘贴块会话显示粘贴内容第一行、技能会话显示用户正文；右键菜单「重命名」下面紧跟「重新生成标题」，点了先出「正在生成标题…」、行标题不动，放行后行标题换成新标题、提示「标题已更新：X」替换掉生成中的提示；空结果提示保留原标题、不改名；主进程报错提示原因；浅色主题提示浅底。提示的底色画在哪一层随 antd 版本变，取 `.ant-message-notice` 里第一个不透明的底色）
- 侧栏会话行：`session-row`（真实 SessionItem，回调只记事件；运行中的行转圈和「更多」共用行尾同一格：静止只有转圈，悬停整行或鼠标正好停在转圈上，转圈在原位换成「更多」，标题宽度和占位格都不变、按钮中心就是转圈原来的位置、格子与按钮同尺寸、鼠标下面点得到按钮；点按钮只开菜单不触发整行点击，点行本身仍打开会话；移开变回转圈；空闲行照旧悬停才出现「更多」，位置和运行行同一列；五种注意状态角标（等待批准 / 需要选择 / 失败 / 受阻 / 完成未读）的图标与颜色对照主题 token、审批压过转圈、选择在呼吸，悬停时角标同样在原位让给「更多」；整行悬停 400ms 后出状态 Tooltip（长报错截断加「…」），不到 400ms 不出；折叠的分组头显示汇总角标和需要处理的会话数，展开的不显示；浅色主题。`t.hover` 自己停 240ms，量「400ms 前不出」要在 hover 返回后立即读）
- 应用内提示：`attention-toast`（真实 AttentionHost + sessionAttention + 通知器，外面包 antd App；主进程 `attention_notify` / `attention_badge` / `attention_window_focused` 用桶、`route` 固定 in-app，pi 事件和审批请求由 probe 经 act 推；Goal 续跑（一轮结束 300ms 后又开）不冒完成；后台会话完成出提示、不计入任务栏数字、10 秒内自己收起；失败提示带报错、「前往」打开会话并收起、打开后计数回到 0；审批提示 9 秒后仍在、答复后收起，计数 1 → 0；当前会话在前台时不问主进程、不提示；深 / 浅色主题下提示背景是对应的浮层色。提示按 `[data-testid="attention-toast"][data-kind=…]` 找，入场动画里不透明度接近 0，量可见性和颜色前先等 400ms；不要把鼠标停在提示上，antd 悬停会暂停自动收起）
- 命令胶囊：`command-pill`（真实 lobehub Editor + CommandPill 插件，插入走 `INSERT_COMMAND_PILL_COMMAND`，`list_prompt_commands` 用桩；插入后焦点在第一个参数；Tab / Shift+Tab 轮转，最后一个参数上 Tab 跳出到胶囊后，第一个参数上 Shift+Tab / ← 不动；必填参数空着时 Enter 被拦下、焦点回到缺的参数并标红；发送文本是调用文本 `/名 "值" ""` 加补充正文；空参数 Backspace 回退、第一个参数里删整个胶囊；气泡里 `<command>` 块整块成胶囊且正文不出现，刚发出的调用文本也成胶囊、空参数显示默认值；浅色主题）
- 输入框正文原样发出：`composer-text`（真实 lobehub Editor，参数照 MessageEditor（type text、chat、纯文本粘贴、关 markdown），发送走 `readComposerText`、回填走 `writeComposerText`；真实键入 `* [ ~ _ & <`、Shift+Enter 换行、缩进行、`* ` / `+ ` / `# ` 开头的行，回车发出的和键入的一字不差；多行代码的缩进和制表符原样发出（系统剪贴板写不进去时写 INFO，改走 lobehub `handlePlainTextPaste` 之后派发的 `CONTROLLED_TEXT_INSERTION_COMMAND`）；文件标签发成 `@路径`；回填不出列表、每行一个段落、读出和写进去相同，CRLF 统一成 LF；旧路径 `getDocument('markdown')` 的输出只用 INFO 记录对照；整份草稿走 `readComposerDraft` / `writeComposerDraft`：胶囊（参数填了一半）+ 文件标签 + 文字存成 JSON 草稿、清空、恢复后胶囊和标签仍是装饰器节点、参数值不变、读出文本相同，只有文本的旧草稿恢复成纯文字。胶囊插入自带尾随空格、跳出后光标在它前面，要在后面接着打字先 `Delete` 掉它；恢复后不要 `t.click` 输入框左沿，那里是胶囊、会进第一个空参数）
- 输入框上方的图片 / 粘贴块：`composer-chips`（真实 InputChips + 真实 composerFiles store（挂着 IndexedDB persist），图用 canvas 画、base64 经 exposeData 交给 probe；缩略图 48px，点第一张弹出 lobehub Image 预览（`[role="dialog"] img`）、计数「1 / 2」、点右侧箭头切到第二张、Esc 关掉；IndexedDB 存档里图片没有 url 只有 data；模拟重启（`dropMemoryKeepStorage`：内存清空、先读出存档再写回，因为 setState 会触发 persist 把空内容写进去）后 `rehydrate` 图片和粘贴块都回来、url 由 data 重建；内存里已有的桶在 rehydrate 时优先；X 移除到空后存档里没有这个 key。预览里的 ArrowRight 在离屏模式下按不到，用点按钮切图）
- 命令与规则面板：`prompt-library-panel`（真实 CommandsPanel / RulesPanel，主进程命令用内存桩；命令列表项是胶囊带参数个数；改提示词时参数实时识别、占位符背景高亮；与保留名重名就地报错、保存不可点；规则开关立即写盘；没有工作区时项目范围置灰）
- 供应商测活：`provider-diagnostics`（真实 ProvidersSettings + ProviderDiagnostics，`get_provider_config` / `list_models_global` / `diagnose_provider_model` / `diagnose_provider_model_abort` 用桩，分片和放行由 probe 用 `t.act` 推；详情分两层，设置层单独滚动、测活层贴住详情列底边，滚设置时测活层不动；思考档位按模型映射列出，null 档隐藏、原生名不同附在后面；发送中锁住模型和档位、出现取消，思考和正文分开流式显示；取消只发当前 requestId 的 abort，保留已收到的正文、不出指标、回到可发送；Ctrl+Enter 发送，完成后标题栏写成功与总耗时、指标含思考 tokens、模型和档位解锁；分隔条上拖变高、拖到顶仍给设置层留高度；测活层默认收起只有标题栏，标题栏收起 / 展开；内置供应商也能测，换供应商清掉上一次结果；浅色主题）
- 供应商模型列表：`provider-model-list`（真实 ProvidersSettings + SortableModelCards；测活层默认收起（展开时贴底会盖住列表），再把卡片滚进可视区；只有卡片左侧手柄能拖、从输入框开始拖不排序，拖到第三张下面后顺序变化且没有残留位移，键盘空格拿起 / ↓ / 空格放下也能排；展开后有缓存读 / 写价，加一档分段默认阈值 100,000、四价抄基础价，分段行在卡片里、窄视口也不撑破；保存后 models.json 顺序跟着拖动、带 tiers；浅色主题）
- 文件管理器：`file-explorer`（真实 FileTreeBody → FileExplorer，内存文件树做桩，`files://changed` 由 `act('externalEdit' / 'addFile')` 按主进程形状推；只列根、展开才列、展开的目录交给主进程监听；2000 个文件只渲染可视区、滚到底见最后一个；.md 默认预览、只看不挂编辑器，Ctrl+E 进编辑、宽屏左右分栏、窄屏只有编辑器，Ctrl+S 写盘，Esc 回预览；.ts 默认只读敲字不进文档，切编辑后可改可存；文件标签栏：打开的文件各一个标签、再打开只切过去不重读盘，有未保存修改时打开别的文件不问、切回来修改还在，关脏标签弹「保存 / 放弃 / 取消」、放弃后激活右边的，同名文件附目录，标签多了横滚且没有滚动条占高、当前标签滚进可视区、滚轮横滚，中键关闭不动当前标签和滚动位置，右键「关闭其他 / 全部关闭」，全关后回到空提示；文件树右键菜单（「添加到对话」经 `registerComposerInsertFile` 交给场景里只记事件的输入框桩，`revealItemInDir` 用桩）：四项两条分隔线、出现在鼠标右下方、被右键的行标出且不打开文件，Esc / 点项 / 点别处收起，复制路径 / 相对路径、在资源管理器中显示、添加到对话各自发对东西，浅色下菜单浅底；切主题编辑器 DOM 不换、颜色跟着变，预览也变；二进制不支持预览可用系统打开，超大文件标已截断且进不了编辑，svg 显示；外部改动无本地修改静默换新、有本地修改出冲突提示可保留；CRLF 保存后原有行仍是 CRLF；新文件出现在树里；筛选只留命中项和祖先；文件树在内容右边，可以收起再展开；分隔条往左拖文件树变宽；外部入口（交付卡、审查标签）经 `useFileOpenRequests` 请求打开文件时，`act('requestOpen')` 发请求：目录自动展开并选中、树宽 / 标签宽 / 收起状态不变、同一文件重复请求不重读盘不重复视图、不存在的文件显示错误与重试、出错后再请求其他文件恢复；预览里的链接（`docs/links.md` 夹具，走真实 `MarkdownPreview` → `openLink`，`openUrl` 用桩、内置浏览器标签读真实 dock store）：相对 / `../` / 含空格 + query + hash 的链接打开对应文件并选中、外链开内置浏览器标签且同地址不重复、Ctrl 点击走系统浏览器、缺失 / 项目外 / mailto / 目录的提示、锚点把标题滚到预览顶部，每条之后应用页面没被导航走；文件树底部路径栏（悬停优先于选中、相对 / 绝对切换、复制、窄栏长路径只截目录并在悬停显示完整值）；面板窄于 400px 时文件树与内容区一次只显示一个（内容区不卸载）；文件内查找（场景里挂了应用的 `FindShortcutHost`）：Markdown 预览里 Ctrl+F 弹出查找栏（在工具栏和预览之间、控件靠右）、命中滚到可见区、循环、无结果、Esc 焦点回预览；代码编辑器里 Ctrl+F 不是 CodeMirror 默认面板，`.cm-searchMatch` / `-selected` 两层高亮、只读不改文档；开着查找栏切文件用同一查询重查；图片不拦 Ctrl+F。CodeMirror 的文档读 `.cm-line`，往编辑器里敲字先 `t.click('.cm-content', 40)` 再 Ctrl+End；切走的文件标签藏着不卸载，内容区的选择器一律限定在 `[data-testid="file-tab-pane"][data-active="true"]` 里，否则会命中藏起来的那份；中键用 `t.win.webContents.sendInputEvent` 发 `button: 'middle'`）
- 对话列表贴底：`chat-follow`（真实 VirtualizedMessageList，条目是定高文字块、其中一条带内部滚动区；流式增长一路贴底；在内部滚动区上滚轮、会话不满一屏时上滚都不停止贴底；一次追加大段内容不因测高超前丢掉贴底；真的把列表往上滚（滚轮或键盘 PageUp，含远小于旧阈值的小幅上滚）才停止贴底，流式增长时阅读位置不动并露出「回到底部」；发出新消息、点「回到底部」、滚回底部都恢复贴底；真实对话模式走真实 reducer → ChatMessageItems（Markdown、代码块、表格、bash 工具卡），每 10~100ms 一段快速输出时持续贴底、没有被往上推离底部的帧（document capture 阶段读 scroll 事件，抓「推上去再拉回」的抖动；内容缩短时浏览器钳制 + virtua 跳变补偿会把视图推离底部），快速输出中读者上滚照样离开底部、停在原处并露出「回到底部」）
- 面板分隔条：`panel-resize`（真实 ResizeHandle，左边长对话、右边文件浏览器打开长 markdown；拖动宽度跟手，拖动中面板没有宽度过渡，松手恢复 0.2s，双击回到初始尺寸，往两边拖停在最小 / 最大宽度；折叠有中间帧并收到 0，展开回到原宽度；对话列表滚动时 virtua 仍写 inline pointer-events: none，但计算值保持 auto）
- 子代理审批卡：`subagent-approval`（真实 ExtensionUiHost → uiPromptStore → PromptRequestCard，pi://ui-request 信封由 probe 经 act 推、形状照 sessionUiAdapter，`extension_ui_respond` 记成事件；子代理的请求卡头写「子代理请求批准」、标题写出子代理（孙代理带父链）、按收到的时刻倒计时；几条同时来只显示第一条并写「还有 N 条」，答完下一条顶上来，双击不会顺手答掉顶上来的那条；`dismiss` 收回显示中的那条后下一条顶上来，收回排队中的那条不动显示中的；主会话自己的审批没有倒计时；剩 10 秒以内倒计时变警示色；浅色主题）
- 不唤醒的消息：`agent-message`（真实 reducer → renderMessageBody；`send_message` wake: false 写进对话的自定义消息显示成「来自 X 的消息（未唤醒）」提示条，不是通用的「已注入上下文」；默认收起、展开看 markdown 正文、再点收起；普通注入通知不受影响；probe 经 act 推一条实时的（message_start / message_end）同样显示；浅色主题。只放通知，用户 / 助手气泡要订阅真实会话 store）
- Goal 续跑卡片：`goal-round-card`（真实 reducer → renderMessageBody；Goal 每一轮续跑的 `goal-round` 自定义消息是 display: false，仍画成「目标续跑 · 第 N 轮」卡片，正文用真实 `buildGoalRoundPrompt` 造；标题不写轮次预算；默认收起、展开看这一轮的完成条件、再点收起；别的 display: false 消息照旧不显示；probe 经 act 推一轮实时的（message_start / message_end）只出一张；浅色主题）
- 等待中的引导取消 / 编辑：`steer-cancel`（真实 createAgentStore → renderMessageBody，`agent_cancel_steer` 用桩、正文是「已经在注入的那条」时回 cancelled: false，输入框只装 composerBridge 的回填接缝；等待中的引导悬停才浮现操作栏，按钮是取消引导（X）/ 编辑 / 复制、没有「更多」；点 X 按正文撤这一条、气泡去掉、输入框不动；撤不回来时提示并保留气泡；编辑先取消、撤下后原文和图片回到输入框；已引导的消息没有取消；浅色主题 X 可见）
- Agent 数据概览：`agentdata-overview`（真实 OverviewPanel，数据直接给 props；「最近任务 / 知识库 / 最近记忆」内容多少不一时，宽屏一行三列拉到同高、顶边底边都对齐，空的知识库卡片里空状态在标题栏下面剩余高度里垂直居中；窄视口一列时各卡片按自身内容高度排开）
- Agent 数据代码索引：`code-retrieval-panel`（真实 CodeRetrievalPanel + AgentDataTaskProvider，外面套 AgentDataCenter 的 `styles.panel`，`agentData_code_*` / `agentData_tasks_list` / `read_file` 用桩，项目 3000 个文件、两份源码（400 行小文件、12000 行大文件，每 200 行一条折成多行的长注释）；搜索框留空时桩按 limit / offset 分页返回并把每次请求记成事件，只画已加载的页、尾部「显示更多」滚得到点得到、点一次向主进程要一页、一路点到底 3000 个全在且按钮消失（不退回前端切页）、没有一次请求返回超过一页，顶部写真实总数；外层面板不被撑长、结果列表在左栏内滚动；原始结果展开前不画内容、展开后高度有上限并标注已截断；换成搜索后页数重置、不足一页没有「显示更多」；点结果进详情，详情栏与列表栏同高并在栏内滚动，小文件整块渲染，大文件虚拟化（DOM 里只有窗口附近的行、索引行居中、跳到第 9000 行居中、折行行高不一不重叠、滚到头尾都对）；矮窗口保住卡片 320px 的下限、放不下的部分由外层面板滚动；窄视口只显示详情栏时同样有上限）
- 代码索引自动同步：`code-index-sync`（真实 CodeRetrievalPanel，`agentData_code_status` 的返回由 probe 经 act 切换，形状照 codegraph-host 的 `CodeGraphThreads.status`（state + phase / progress / lastError / watcher），每次读状态记一条事件；增量同步中标签「同步中」、搜索框可用、文件列表照常查出、title 带阶段与进度；调度器推进期间静默轮询、标签一帧不闪「检查中」，回到空闲后数字更新、轮询停下；被别的程序占锁写「等待重试」不写失败；全量重建「索引中」、搜索框不可用；熔断后横幅写明已暂停、轮询停下；文件监听不可用时提示手动同步）
- 前台 run 转后台：`subagent-detached`（真实 messagesFromAgent → renderMessageBody，`subagent_list` 用桩，probe 经 act 在注册表里把转后台的子代理改成已完成；单任务回执 status: running / detached 时卡片按后台子代理画运行中；并行组里已完成的那项是已完成、转后台的那几项是运行中而不是出错，组头写「N 个在后台运行」且没有失败计数；卡片第一次读注册表时还没建出来的那一行从挂载起一次也不画成已中断（工具返回后再读一次确认），注册表里确实没有的那一行画「已中断」、不算失败也不算在后台，转后台时没有 agentId 的那一行按任务文字跟上注册表；注册表结束后经轮询变成已完成、后台计数消失；都结束后不再轮询（轮询停掉、store 清空时不能退回运行中再把轮询拉起来））
- 右侧边栏跟会话走：`dock-session-binding`（真实 DockDndProvider（useDockSessionSwitch）+ RightPanelShell + DockPanel，左边两个会话行按侧栏 handleOpenSession 的字段写会话 store，「右栏」按钮走真实 toggleRightPanel，启动页点「文件管理器」开真实 FileTreeBody、目录用内存桩；启动页入口和 dock 标签条都写「文件管理器」；A 里打开的右栏和文件标签切到 B 不跟过来、B 默认收起，B 再打开只看到自己的空启动页；切回 A 按离开时的样子展开、标签是同一个 body 实例没被重建；B 自己开的文件标签是另一份，两份各自挂着、只显示当前会话那份；各会话的展开 / 收起互不带动）
- 参数无法解析的工具调用：`invalid-arguments-card`（真实 reducer → groupMessages → TurnTimeline；pi 1.3.0 对参数不是合法 JSON 的调用给空 args 加 `Invalid arguments for tool "…": … Received arguments: …` 的错误结果，场景里的错误文本按 pi-ai `parseToolCallArguments` + `validateToolArguments` 实测造；实时 bash、历史回放 bash（toolCall 带 argumentsError）、MCP 工具三种都画成「<工具> 参数无法解析 · 未执行」，不画成空命令的 bash 卡、没有终端块；折叠行给解析错误，默认收起，展开后错误块在上、模型原样发来的参数在下；MCP 工具保留服务器标签、不出现 mcp__ 原名；普通 bash 失败仍是 bash 卡；浅色主题下错误块底色跟着变）
- 计划侧栏：`plan-panel`（真实 ExtensionUiHost → planStore → openPlanDockTab → DockPanel / PlanPanel，对话流是真实 PlanSummaryCard，输入栏是真实 ModeAction；agent-mode 扩展与主进程用桩：`agent_prompt` 收面板发的 `/plan-update` `/plan-confirm` `/plan-cancel` `/plan-finish` 并按扩展规则改桩里的计划、推 `setStatus('agent-plan')` / `notify`，`agent_set_mode` 照 `writeAgentMode` 在未确认时回 `PLAN_UNCONFIRMED`；created 推送自动打开右栏标签、步骤全文进编辑框；改字 / 下移 / 加步骤后保存为第 2 版 · 已手动修改，`/plan-update` 带同一 planId、基准 rev、全文步骤并打到计划所属会话；有改动时确认执行不可点并写原因；用户改着时模型修订出冲突提示，载入最新换成新版本；手切 Agent 被拦后选择器退回 Plan、toast 宿主原文；确认执行发 `/plan-confirm <id> <rev>` 后模式变 Agent、面板只读、进度随 [DONE:n] 推进、标记完成进已完成；新计划使旧摘要卡写「已被新的计划取代」、按钮不可点；取消要 Popconfirm 二次确认；浅色主题。模式下拉是 base-ui Select，选项按 `[role="option"]` 的文字找，先打 data 属性再 `t.click`）
- 独立工作区：`isolated-workspace`（真实 buildProjectGroups → ProjectHeaderRow、WorkspaceBar、IsolatedWorkspaceDialogs，`isolated_workspace_*` / `get_settings` / `subagent_get_session_messages` / git 概况用桥，形状照 `electron/app/isolatedWorkspaceService.ts`；独立工作区的组紧跟父项目、缩进、默认名 `gren/<id>`、「独立」标签，探测为 missing 的标「已删除」；独立工作区菜单有回传、没有再建，普通项目菜单有新建；新建弹窗默认 fresh、head 收在「其他基准…」里且选中显示冲突风险、fetch 默认跟设置、head 下 fetch 不可选、主进程报错原文显示且不自动改选、换基准收起报错、创建成功按项目打开；WorkspaceBar 在独立工作区里显示父项目名、「独立工作区」标签和回传按钮；管理弹窗的状态标签、未回传删除要「仍然删除」并带 force、已回传普通确认；已删除工作区的会话只读查看、没有输入框；浅色主题。antd Radio / Checkbox 的 data-testid 落在隐藏的 input 上，状态读 input、可见性和点击用 `label:has(input[data-testid=…])`；弹窗截图前等开合动画放完）

harness 自检不在这个清单里，也不常驻 `scenarios/`。怀疑 harness 本身坏了（所有场景都「页面没就绪」、输入全部失效、升级 Electron / Vite 之后），用 electron-ui-harness skill 的 `scripts/smoke.mjs --app electron-agent` 跑一次，它跑完会自动删掉临时场景。在 `scenarios/` 里看到 `harness-smoke` 就是漏删的，直接删掉。

### 写场景

照 `scenarios/codemode-card.tsx` 写。

- 对话时间线类场景用真实的 `applyEvent` / `messagesFromAgent` 造消息，再 `groupMessages` → `TurnTimeline`，不要手写 segments。事件和结果的形状照 pi 的实现造（node_modules 里 `@earendil-works/pi-coding-agent/dist/...`）。
- 工具卡依赖 `AgentStoreContext`：场景里包一层 `AgentStoreContext.Provider`，`store` 给占位、`workspaceReady: false`；不要给 `TurnTimeline` 传 `timestamp`，否则会去订阅占位 store。
- 滚动容器定高 `100vh`、背景用 `var(--gren-content-bg)`，切浅色时才跟着变。
- 只给用到的 `window.gren` 方法装桩。期望值用 `exposeData` 暴露，probe 里用 `t.data()` 读。
- 数据要确定，不用随机数，不用当前时间。reducer 自己记的 `startedAt` / `durationMs` 会变，probe 不断言这两个值。

### 写 probe

- 交互只用 `t.*` 的真实事件，不在页面里调 `element.click()`。
- 判断弹层开合用 `countVisible`。颜色用 `checkColor`。尺寸近似值用 `checkNear`。动画用 `sample` 逐帧断言。
- 异步加载的内容（`LazyHighlighter`、`LazyMarkdown` 都是懒加载）用 `waitForText` / `waitFor` 等到再断言。
- label 写清预期（「失败：脚本错误单独标红」），FAIL 时输出的就是这一行。

### 断言的坑

- 弹层开合用 `countVisible`，不用 `count`：antd 关掉的弹层还留在 DOM 里。
- 点工具行没反应 → `ConvRow` 的行用 `margin: 0 -7px` 把 hover 底色往外扩，最左 7px 被外层裁掉，`t.click(sel)` 默认点左沿 +6px 会落到 `<html>` 上 → 用 `t.click(sel, 20)`，并先 `scrollIntoView({ block: 'center' })`（上方卡片展开后下面的行会被推出视口）。
- 展开体里没有任何内容、也没有页面报错 → 工具卡的 `ErrorBoundary` 静默降级 → 查 `[data-testid="error-boundary-fallback"]`。
- `t.setTheme('light')` 在这里会连 Provider 一起切（`HarnessRoot` 监听 `data-theme`），可以断言组件库在浅色下的颜色。
- `t.style` 的入参写 kebab-case，返回的 key 是 camelCase。
- 从计算样式里取数要带指数：用 `/-?[0-9.]+(?:e[-+]?[0-9]+)?/gi`，不用 `/[0-9.]+/g`。动画快结束时值会写成 `9.96e-05px`，旧正则把它拆成两个数，只在采样恰好落在那一帧时失败，看起来像偶发。
- 传给 `t.js` / `t.sample` 的页面代码写在模板字符串里，`\d`、`\s` 的反斜杠会被吃掉，正则里写 `[0-9]`、`[ ]`。

### 运行的坑

- 静默模式靠两件事，缺一不可（都在 `run.mjs`）：一是离屏渲染（`webPreferences.offscreen`），不能换成「普通窗口 + `show: false`」——从没显示过的窗口不推进 CSS 过渡、不应用 hover、滚轮不滚，antd 的弹层关不掉；二是 CDP 焦点模拟（`Emulation.setFocusEmulationEnabled`）——离屏窗口永远不是系统前台，没有它 `el.focus()` 不发 focus 事件，靠 focus 记状态的组件会忽略后面的按键。只留前一件，键盘断言会挂；只留后一件，动画和弹层会挂。焦点模拟必须在 `loadFile` 之后发，加载前发的 CDP 命令会一直挂着，每个场景都等到超时。改完 `run.mjs` 要跑一遍 skill 的 `scripts/smoke.mjs`。
- 静默模式下不要在 probe 里抢系统焦点（`win.focus()`、`webContents.focus()`、等 `win.isFocused()`），也不要直接改窗口尺寸；量窄视口用 `t.resize`，它按 `innerWidth` / `innerHeight` 校正（离屏渲染会大 1~2px）。
- `--show` 时窗口用 `showInactive` 显示，不抢焦点；但别把鼠标停在测试窗口上，会干扰 hover 类断言。
- 输出重定向到文件（`> ui-check.log 2>&1`），不要用管道截断，否则会 EPIPE 崩在半途。
- 连跑多个场景时偶发单条失败，先单独复跑那个场景，再下结论。逐帧采样类的偶发失败先查取数解析（见「断言的坑」）。升级依赖、换 Electron 后加 `--rebuild`。
- Vite 8（rolldown）没有 rollup 的 `getWatchFiles`，`depsGraph.mjs` 已经容错；构建报这个错说明用的是旧文件，照 skill 模板更新。
- 渲染层没有 tsc 工程（`tsconfig.json` 的 `files` 是空的），场景和组件的类型错误不会拦住构建。要查类型就临时写一份 extends `tsconfig.json`、include 目标文件的配置跑 `npx tsc -p`，只看目标文件的报错。
- 沙箱 iframe（`srcdoc` 且没有 `allow-same-origin`，例如 `HtmlPreview`）是独立进程：页面里读不到它的 DOM，离屏渲染下 `sendInputEvent` 的鼠标事件也进不去（先移动再点也一样，`seen` 里一个事件都收不到）。读几何、触发点击走 `t.win.webContents.mainFrame.framesInSubtree` 里 `url === 'about:srcdoc'` 的那一项的 `executeJavaScript`；「点击」写成对 `elementFromPoint(x, y)` 的最上层元素派发 `click`，被遮住就会点到遮挡物上，和用户点同一个位置等效。换页面后 iframe 会重建，句柄每次现取。截图前多等几百毫秒，跨进程 iframe 滚动后合成帧刷新有延迟，否则截到滚动前的旧帧。
- fps 只用 `t.info` 记录，同一台机器上会抖 ±30%。判断快慢只看生产构建。静默模式不上屏，fps 只作参考，要下性能结论用 `--show` 跑。
- Linux 上离屏渲染也要显示服务，CI 照旧用 `xvfb-run -a node ui-harness/check.mjs`。

## 落地必须有实跑证据

1. 写 proposed 笔记时，在 `## 验证` 段先写计划：要用哪个 `verify-*` skill 跑哪些 feature、看到什么算通过。
2. 改完代码，用项目的 `verify-*` skill（在 .agents/skills、.claude/skills 或 .cursor/skills 下）真实启动程序、按用户路径操作，证据存到 `.agents/evidence/<笔记文件名>/`。
3. 笔记转 implemented 前，`## 验证` 段写明：跑了哪些 feature、证据路径、结果（通过 / 失败 / 部分通过）。只跑了测试的，写出具体命令（如 `pnpm exec vitest run …`、`pnpm ui:check <场景>`）和结果，也算证据。失败就不要转，先修。
4. 确实没法实跑的改动写 `verify: n/a <原因>`，原因必须具体。
5. 跑 verify 时发现的回归或 harness 失效，单独开一篇 bug-fix 笔记，不要在原笔记里一笔带过。
