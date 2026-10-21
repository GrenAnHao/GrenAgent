# Agent Note: 带参数命令展开成 <command> 块、规则经 contextFiles 注入；网页抓取收成 fetch_url

Status: implemented

## Problem

### 带参数的命令展开成 <command> 块，规则走 contextFiles 注入

需要全局命令（预置提示词，支持命名参数并在输入框里填空）和全局、项目两级的规则。Pi 已有 prompt template（只支持 `$1` 位置参数，参数解析不支持转义）和 AGENTS.md context files（整文件，不能逐条开关）。会话里存的是展开后的文本，气泡要显示成命令胶囊。

### 网页抓收取成一个 fetch_url

网页抓取拆成 13 个工具：格式各一个（`fetch_html` / `fetch_markdown` / `fetch_txt` / `fetch_json` / `fetch_url` / `fetch_llms`），再加上 `fetch_web_content` 和 CSDN、掘金、Linux.do、GitHub README 的站点抓取。模型面对的是同一件事的多扇门。`fetch_url` 的 schema 里已经有 `format`，执行时却忽略它。

## Decision

### 带参数的命令展开成 <command> 块，规则走 contextFiles 注入

- 命令复用 Pi prompt template 文件。正文里有 `{参数}` 的模板由 `prompt-commands` 扩展在 `input` 钩子里展开成 `<command name="…" args="{JSON}">正文</command>`，参数解析用自己的转义规则（双引号内 `\"` `\\`）。气泡识别这个块，还原成只读胶囊，参照现有 `<skill>` 块折回 chip 的做法。
- 输入框胶囊是 Lexical DecoratorNode 内嵌原生 `<input>`，事件在胶囊上原生截住，不让 Lexical 和 React 根节点处理。读正文时胶囊位置写私用区字符，发送前换成调用文本。正文直接从 Lexical 树读纯文本、不经 remark，见 [输入框正文原样发出](../bug-fix/2026-10-19-composer-plain-text.md)；markdown 写出仍写同一个标记。
- 发送 / 存草稿时由 `readComposerText` 把私用区标记换成调用文本，且调用文本总放在最前面：标记前后的正文各自 trim 后用一个空格接在调用文本后。用户用方向键把光标移到胶囊前打字时，命令仍然生效。
- 胶囊只能在输入开头，所以不提供「跳到胶囊前面」：第一个参数上 Shift+Tab、开头按 ← 都不动，只有最后一个参数上 Tab / 末尾 → / Esc 跳到胶囊后。离开胶囊时先把焦点交还编辑器根节点再移动选区——lexical 0.42 的 `updateDOMSelection` 见 activeElement 是装饰器里的 input 就不写 DOM 选区，`editor.focus()` 不够。
- 规则一条一个文件，由 `context-rules` 扩展在 `before_agent_start` 追加到 `systemPromptOptions.contextFiles`，和 AGENTS.md 同一段。

### 网页抓收取成一个 fetch_url

只注册 `fetch_url`。`format` 为 `markdown`（默认）时走多提供商爬虫；`text` / `html` / `json` 走直接 HTTP；`llms` 探测该 URL origin 的 `/llms.txt`，`full=true` 时优先 `llms-full.txt`。站点专用抓取、`fetch_web_content` 和其余 `fetch_*` 工具名删除，不留别名。搜索引擎里的 CSDN、掘金来源保留。

### 涉及文件

- `extensions/prompt-commands/syntax.ts`
- `extensions/prompt-commands/index.ts`
- `extensions/context-rules/index.ts`
- `electron-agent/src/features/chat/input/editor/CommandPill/CommandPillNode.ts`
- `electron-agent/src/features/chat/messageTags.tsx`
- `extensions/web-fetch/index.ts`
- `extensions/web-search/index.ts`
- `extensions/_shared/tool-groups.ts`
- `extensions/agent-mode/modes.ts`

### 来源

- `docs/decisions/extensions/2026-10-08-command-block-and-context-rules.md`
- `docs/decisions/extensions/2026-10-02-single-fetch-url.md`
- eea5ae06（实现计划）
- `docs/superpowers/specs/2026-10-08-commands-and-rules-design.md`

## Alternatives considered

### 带参数的命令展开成 <command> 块，规则走 contextFiles 注入

- 自建 JSON 存储加 `registerCommand`：和 Pi 原生 prompts、AGENTS.md 并存两套，CLI 和 App 看到的不一致。
- 规则直接编辑两份 AGENTS.md：不能逐条开关。
- 前端代入参数后直接发全文：气泡会是长正文，CLI 也用不了命名参数。
- 胶囊用 ElementNode 加原生 TextNode：规范化处理量大，和 @lobehub/editor 的快捷键插件冲突。
- 胶囊 markdown 直接写调用文本：remark 会转义参数里的 `\`、`*`、`_`。
- 允许 Shift+Tab / ← 跳到胶囊前面（规格初稿的写法）：光标停在胶囊前，用户在那里打字会让胶囊不再位于开头，扩展认不出命令。
- 用 `systemPrompt` 整体替换注入规则：绕开 Pi 的分段机制，比 `contextFiles` 复杂。

### 网页抓收取成一个 fetch_url

- 保留站点抓取：这三个站点和 GitHub README 都能用通用 `fetch_url` 读页面，仓库 API 仍走 `github`。
- 每种格式继续各留一个工具：调用面不缩小，`format` 参数就是为了替代这些名字。
- 默认改成直接 HTTP：JS 渲染和反爬页面会退回，爬虫（naive、Jina，以及配了 key 的 Firecrawl / Exa / Search1API）仍是普通页面的默认路径。

## Consequences

### 带参数的命令展开成 <command> 块，规则走 contextFiles 注入

- `<command>` 块格式是会话里的持久数据，改格式要兼容旧会话。
- Pi 原生模板展开不认 `{参数}`：带 `{}` 的模板在没有加载 `prompt-commands` 的环境里会原样发出占位符。
- 发送失败回填走 `writeComposerText`（`setDocument('text')`），胶囊会变回调用文本；文本直接发送仍然有效。草稿恢复（切会话 / 重启）已改成按 Lexical JSON 整份写回，胶囊原样回来，见 [输入框草稿整份保留](../feature/2026-10-19-composer-draft-full-restore.md)。
- 如果 Pi 将来原生支持命名参数，重新评估是否去掉 `prompt-commands` 的展开逻辑。

### 网页抓收取成一个 fetch_url

旧会话里的 `fetch_csdn_article` 等工具名不再可调用；界面卡片映射保留，历史记录仍能渲染。Ask / Plan 白名单和 `NET_TOOLS` 只认 `fetch_url`。文档站要先读索引时，模型需传 `format=llms`，不再有单独的 `fetch_llms`。

## Verification

verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证
