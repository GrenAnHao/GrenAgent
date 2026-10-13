> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-18-memory-pipeline-upstream-aligned.md](../../../../.agents/notes/implemented/architecture/2026-09-18-memory-pipeline-upstream-aligned.md) 维护；本文件冻结只读。

---
title: 去重候选改为关键词重叠召回（中文二元组 + 英文词，阈值 0.3）
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/app/memoryTerms.ts
  - electron-agent/electron/app/memoryDedup.ts
  - electron-agent/electron/app/memoryService.ts
  - electron-agent/electron/agentData/memoryStore.ts
supersedes:
superseded_by:
---

## 背景
recallCandidates 用整条新记忆做 lower(content) LIKE '%…%'，只有和旧记忆一字不差的才能命中，所以 memory_deduplicate 在库里一次都没执行过（0 条）。上游 l1-dedup.ts 用向量召回 top-5。

## 决定
新增 memoryTerms：中文按二元组、英文取 3 字符以上的词（去掉结尾的 . _ -）、去停用词，按文本出现顺序出词，查询侧最多取 64 个。

召回分两步：

1. store.searchL1ByTerms 粗筛。只在 L1 JSON 的 content 字段里数关键词子串命中数（非 JSON 内容按原文），不看整段 JSON，否则 type、priority 这些键名会让每行都命中。保留命中数不低于 minShared 的，按命中数从多到少、同分最近更新的在前，取前 50。词去重后最多 64 个，lower(content) 只在 `WITH … AS MATERIALIZED` 里算一次。
2. recallCandidates 在调用方精确打分：查询词在候选词集合里的命中比例不低于 0.3，并且命中词数不低于 min(3, 查询词数)，取前 5。

粗筛的 minShared 取 max(1, min(3, 词数), ceil(0.3 × 词数))，和第 2 步的两条下限同一个函数。SQL 子串命中数不小于 JS 词集合命中数，所以这个下限不会漏掉第 2 步本来会留下的候选。

completeExtraction 对每条新记录只召回一次，「要不要去重」和「组装 matches」共用同一份结果。召回在主进程同步执行，不重复算。

## 放弃的方案
- 上 embedding：要配置 embedding provider、加向量表和索引，放到检索那份计划里一起做。
- SQLite FTS5：中文需要分词器，内置的 unicode61 按字切效果差；而且要新建虚表和触发器。
- 阈值 0.5：中文改写后二元组重合我们估计通常在 0.3 到 0.6 之间，0.5 会漏掉不少。这是经验估计，没有拿真实记忆库实测过。
- 粗筛用 instr 对整段 JSON 做「命中任一词」再按 updated_at 取前 50（第一版做法）：键名让每行都命中，实际退化成「最近 50 条」，库变大后更旧的真重复被挤掉。改成只看 content 并按命中数排序。
- 只用比例阈值、不加命中数下限：查询词多时，共享一个短语（4 个字的词组就有 3 个二元组）就能过 0.3，召回很多不相干的旧记忆。

## 后果
去重任务会真正开始执行，每批有候选时多一次模型调用（输出上限 4096）。如果误召回导致模型频繁判 skip、丢掉新记忆，先把阈值调高再看。

粗筛有 LIMIT 50，按命中数优先：命中词多的先进入候选池，命中少的在库很大时仍可能被截掉，但截掉的是命中最少的，不再是最旧的。minShared 还让命中不足的行根本不进入排序。

shared ≥ min(3, 词数) 的下限会漏掉「只有一两个词的改写」：查询词不足 3 个时按词数算（词全中才算），3 个以上的查询至少要共享 3 个词。这对短记忆偏严，换来的是长记忆不会因为共享一个短语被召回。注意这个下限挡不住共享一个 4 字词组的情况（3 个二元组正好 3 个），要挡它得把下限提到 4 或把比例阈值提高，目前没做。

SQL 里每次要对当前范围内全部 L1 行做 lower、json_extract 和最多 64 次 instr，线性增长。本地实测（内存库、L1 5000 行、查询 55 个词）单次约 50–65 ms，每条新记录召回一次，这段在主进程同步执行。再大的规模要换成预存的小写 content 列或 FTS。
