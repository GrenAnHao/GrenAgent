---
title: codemode 卡片自己画嵌套调用列表，历史回放靠 details.calls，展开体先输出后脚本
status: active
date: 2026-10-05
scope: electron-agent
files:
  - electron-agent/src/features/tools/codemodeModel.ts
  - electron-agent/src/features/tools/CodemodeCard.tsx
  - electron-agent/src/features/tools/ToolExecution.tsx
  - electron-agent/src/features/chat/TurnTimeline.tsx
  - electron-agent/src/features/chat/conv/ConvRow.tsx
  - electron-agent/src/features/tools/CodeCard.tsx
  - electron-agent/src/features/tools/RunDuration.tsx
  - electron-agent/ui-harness/scenarios/codemode-card.tsx
  - electron-agent/ui-harness/probes/codemode-card.mjs
supersedes: electron-agent/chat/2026-10-04-nest-codemode-tool-cards.md
superseded_by:
---

## 背景
codemode 走的是通用工具行：标题是 `codemode · code: // @options: {...` 截断，展开只有带 `Script completed / Wall time / Output:` 头的原始文本，脚本本身看不到。嵌套 MCP 调用由 `TurnTimeline` 挂在卡片下面，显示 `mcp__anysearch__batch_search · queries: [{"query":...` 这样的原名和 JSON。切回会话后嵌套事件不存在，调用列表整段消失，虽然 pi 在 `details.calls` 里留了每次调用的名字、参数预览、状态、耗时和错误。

## 决定
codemode 的 `ToolExecution` 换成专用分支，`TurnTimeline` 不再替它渲染 children，而是把 children 传进去。卡片里按 `details.calls` 的顺序合成调用列表：id 对得上的、以及运行中 `<父id>/?` 配同名未占用的实时段，用原来的 `ToolExecution` 画（能展开看完整结果，耗时取 pi 记录值）；配不上的记录（历史回放、`models.*`）画成只读记录行，失败的可展开看错误；记录里还没出现的实时段排在最后。超过 6 条只露最后 5 条，前面折成一行。

标题是「运行脚本 · 脚本耗时 · 去重后的 `server.tool` 列表」，右侧「N 次调用 · M 失败」。调用列表常驻在标题下（`ConvRow` 新增 `inline`），展开体先输出后脚本：输出去掉结果头，JSON 块缩进高亮，`Script error:` 块单独标红，图片直接画；脚本用 JS 高亮、限高。

`mcp__*` 工具（嵌套或 direct）标题拆成服务器标签 + 工具名，参数按书写顺序取前两个有内容的值；结果把 `全文: 路径` 尾巴拆成单独一行，JSON 缩进高亮、markdown 渲染、其余等宽文本。

## 放弃的方案
- 继续由 `TurnTimeline` 在卡片外渲染 children（2026-10-04 的做法）：卡片拿不到 children，没法和 `details.calls` 合并，历史回放仍然是空的。
- 调用列表放进展开体：收起时只剩一行标题，看不出脚本调了什么、哪次失败；运行中也看不到进度，除非像 bash 那样运行中自动展开，而 codemode 展开体里的脚本和输出很长。
- 展开体按 pi TUI 的顺序先脚本后输出：脚本限高 260px 也会把失败时的错误推到折叠线以下，用户先要的是结果。
- 只用 `details.calls` 画列表、不用实时段：记录里的参数被 pi 截在 200 字，也没有结果，实时会话里会丢掉现在能展开看的 MCP 结果。
- 对 MCP 结果统一走 markdown：JSON 会被渲染成一整段文字，`全文: 路径` 也会混在正文末尾。

## 后果
历史回放的调用行只能看参数预览和错误，看不到结果；要看结果得从记录里的 `全文` 临时文件或重新运行。markdown 判定是启发式（标题、列表、表格、代码围栏、链接、加粗任一命中），纯文本里碰巧有 `- ` 开头的行也会按 markdown 渲染。`details.calls` 的形状来自 pi-coding-agent 1.0.2 的 `extensions/codemode/execute.js`，升级 pi 时要对一下字段和 `Script completed` 头的格式，`ui-harness` 的 `codemode-card` 场景按真实形状造数据，形状变了它会先挂。
