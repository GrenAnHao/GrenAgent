---
title: 去重候选改为关键词重叠召回（中文二元组 + 英文词，阈值 0.3）
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/app/memoryTerms.ts
  - electron-agent/electron/app/memoryDedup.ts
  - electron-agent/electron/agentData/memoryStore.ts
supersedes:
superseded_by:
---

## 背景
recallCandidates 用整条新记忆做 lower(content) LIKE '%…%'，只有和旧记忆一字不差的才能命中，所以 memory_deduplicate 在库里一次都没执行过（0 条）。上游 l1-dedup.ts 用向量召回 top-5。

## 决定
新增 memoryTerms：中文按二元组、英文取 3 字符以上的词、去停用词。store.searchL1ByTerms 先用 instr 粗筛命中任一关键词的 L1，再在调用方按「查询词命中比例」打分，低于 0.3 的丢掉，取前 5。比对只看 L1 JSON 里的 content 字段。

## 放弃的方案
- 上 embedding：要配置 embedding provider、加向量表和索引，放到检索那份计划里一起做。
- SQLite FTS5：中文需要分词器，内置的 unicode61 按字切效果差；而且要新建虚表和触发器。
- 阈值 0.5：中文改写后二元组重合通常在 0.3 到 0.6 之间，0.5 会漏掉不少。

## 后果
去重任务会真正开始执行，每批有候选时多一次模型调用（输出上限 4096）。如果误召回导致模型频繁判 skip、丢掉新记忆，先把阈值调高再看。
