---
title: 带参数的命令展开成 <command> 块，规则走 contextFiles 注入
status: active
date: 2026-10-08
scope: extensions/prompt-commands, extensions/context-rules, chat-input
files:
  - extensions/prompt-commands/syntax.ts
  - extensions/prompt-commands/index.ts
  - extensions/context-rules/index.ts
  - electron-agent/src/features/chat/input/editor/CommandPill/CommandPillNode.ts
  - electron-agent/src/features/chat/messageTags.tsx
supersedes:
superseded_by:
---

## 背景
需要全局命令（预置提示词，支持命名参数并在输入框里填空）和全局、项目两级的规则。Pi 已有 prompt template（只支持 `$1` 位置参数，参数解析不支持转义）和 AGENTS.md context files（整文件，不能逐条开关）。会话里存的是展开后的文本，气泡要显示成命令胶囊。

## 决定
- 命令复用 Pi prompt template 文件。正文里有 `{参数}` 的模板由 `prompt-commands` 扩展在 `input` 钩子里展开成 `<command name="…" args="{JSON}">正文</command>`，参数解析用自己的转义规则（双引号内 `\"` `\\`）。气泡识别这个块，还原成只读胶囊，参照现有 `<skill>` 块折回 chip 的做法。
- 输入框胶囊是 Lexical DecoratorNode 内嵌原生 `<input>`，事件在胶囊上原生截住，不让 Lexical 和 React 根节点处理。markdown 写出时写私用区字符，发送前换成调用文本，避开 remark 对参数里 `\ * _` 的转义。
- 发送 / 存草稿时由 `readComposerText` 把私用区标记换成调用文本，且调用文本总放在最前面：标记前后的正文各自 trim 后用一个空格接在调用文本后。用户用方向键把光标移到胶囊前打字时，命令仍然生效。
- 胶囊只能在输入开头，所以不提供「跳到胶囊前面」：第一个参数上 Shift+Tab、开头按 ← 都不动，只有最后一个参数上 Tab / 末尾 → / Esc 跳到胶囊后。离开胶囊时先把焦点交还编辑器根节点再移动选区——lexical 0.42 的 `updateDOMSelection` 见 activeElement 是装饰器里的 input 就不写 DOM 选区，`editor.focus()` 不够。
- 规则一条一个文件，由 `context-rules` 扩展在 `before_agent_start` 追加到 `systemPromptOptions.contextFiles`，和 AGENTS.md 同一段。

## 放弃的方案
- 自建 JSON 存储加 `registerCommand`：和 Pi 原生 prompts、AGENTS.md 并存两套，CLI 和 App 看到的不一致。
- 规则直接编辑两份 AGENTS.md：不能逐条开关。
- 前端代入参数后直接发全文：气泡会是长正文，CLI 也用不了命名参数。
- 胶囊用 ElementNode 加原生 TextNode：规范化处理量大，和 @lobehub/editor 的快捷键插件冲突。
- 胶囊 markdown 直接写调用文本：remark 会转义参数里的 `\`、`*`、`_`。
- 允许 Shift+Tab / ← 跳到胶囊前面（规格初稿的写法）：光标停在胶囊前，用户在那里打字会让胶囊不再位于开头，扩展认不出命令。
- 用 `systemPrompt` 整体替换注入规则：绕开 Pi 的分段机制，比 `contextFiles` 复杂。

## 后果
- `<command>` 块格式是会话里的持久数据，改格式要兼容旧会话。
- Pi 原生模板展开不认 `{参数}`：带 `{}` 的模板在没有加载 `prompt-commands` 的环境里会原样发出占位符。
- 草稿发送失败恢复时走 `setDocument('markdown')`，胶囊会变回调用文本；文本直接发送仍然有效。若以后要恢复成胶囊，在恢复路径上复用 `resolvePromptPill`。
- 如果 Pi 将来原生支持命名参数，重新评估是否去掉 `prompt-commands` 的展开逻辑。
