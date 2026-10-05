# 决策记录

这里放「代码装不下的为什么」——**不是**系统现状。

系统现状见 [`../architecture.md`](../architecture.md)。那份文档只写事实：当前如何运转、子系统职责、数据流。本目录只写因果：当初为什么这么选、否定了哪些方案、留下了什么代价。

两者不能混写。把历史决策塞进 architecture.md，找一条功能描述要翻半天；把现状抄进决策笔记，笔记会随代码腐化，而它本来不该跟着代码走。

## 约定

- 只在**非平凡改动**后新增一篇。判定见仓库根 [`AGENTS.md`](../../AGENTS.md) 的触发清单。
- 与代码在同一次提交里落地。
- 文件名 `YYYY-MM-DD-<短横线短语>.md`，按 `scope` 分目录。
- 正文永不修改。要推翻结论就写新笔记，在 frontmatter 里 `supersedes` 指向旧的，并在旧笔记顶部加一行墓碑 `> 已过时 → 见 <新笔记相对路径>`。
- 不维护任何总索引文件。本 README 也不列笔记清单，检索靠 `scope` 目录 + grep。

## 使用

新建一篇：

```bash
mkdir -p docs/decisions/<scope>
cp docs/decisions/_template.md docs/decisions/<scope>/$(date +%F)-<短语>.md
```

提交前校验（`_` 开头的文件与顶层文件自动跳过）：

```bash
node scripts/check-notes.mjs
```

已挂到 `.git/hooks/pre-commit`，提交时自动执行。

格式示例见 [`_examples/fixed-worker-pool.md`](_examples/fixed-worker-pool.md)。
