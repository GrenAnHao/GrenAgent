> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-04-official-codemode-no-builtin-mcp.md](../../../../.agents/notes/implemented/architecture/2026-10-04-official-codemode-no-builtin-mcp.md) 维护；本文件冻结只读。

---
title: codemode 卡片按 pi 1.1.0 的合并文本块拆回各项，兼容 1.0.2 历史
status: active
date: 2026-10-08
scope: electron-agent
files:
  - electron-agent/src/features/tools/codemodeModel.ts
  - electron-agent/src/features/tools/CodemodeCard.tsx
  - electron-agent/ui-harness/codemodeFixtures.ts
  - electron-agent/ui-harness/probes/codemode-card.mjs
supersedes:
superseded_by:
---

## 背景
pi 1.1.0 的 codemode 改了结果形状：多个 text() / 返回值各以 `==> text N/M <==` 行开头，console 行收进末尾的 `<console_output>` 块，失败时再接 `Script error:`，而且 `joinAdjacentText` 把结果头之后的相邻文本并成一块（图片把它隔开）。卡片原来按块分类，1.1.0 下整段成了一个文本块：标记和标签原样显示，返回值不再缩进成 JSON，脚本错误也不再单独标红。

## 决定
`parseCodemodeOutput` 对每个文本块先从尾部拆：未展示图片的提示、`Script error:`（仅当结果头不是 completed 时才认）、`<console_output>`（必须在行首且是剩余文本的结尾），剩下的文本只在块首行就是标记时按总数 M 相同的标记行切成各项，每项再按 JSON / 文本分类，相邻文本照旧合并。控制台输出成为新的 `console` 块，卡片里带「控制台」小标题单独画。1.0.2 的历史结果每项一块、没有标记，走同一路径时整块原样分类，显示不变。

## 放弃的方案
- 只把标记行和标签删掉、整块当文本显示：返回值 JSON 不再格式化，脚本错误混在普通输出里不标红，回到升级前要解决的问题。
- 按全文搜标记行切分、不要求块首行是标记：脚本自己打印出 `==> text 1/2 <==` 时会被误切；pi 只在多于一项时加标记，且第一项必在块首。
- console 行并进文本块（1.0.2 的观感）：1.1.0 已把 console 统一挪到末尾，和 text() 的先后关系没了，混在一起反而让人误读顺序。
- 在完成的结果里也识别 `Script error:`：普通输出里出现这一行时会被错标成错误。

## 后果
截断过的输出（`Warning: truncated output` 开头）首行不是标记，整块按文本显示，里面残留的标记和标签不去掉，完整内容看 `fullOutputPath`。识别依赖 pi 1.1.0 `extensions/codemode/execute.js` 的 `formatOutput` / `joinAdjacentText` 格式，升级 pi 时对一下；`ui-harness` 的 `codemode-card` 场景实时用 1.1.0 形状、历史用 1.0.2 形状，形状变了它会先挂。
