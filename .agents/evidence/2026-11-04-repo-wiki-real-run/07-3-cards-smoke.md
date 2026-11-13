# 真机冒烟：知识卡（7.3 第一项）

日期：2026-11-04
变更：`retire-agentdata-and-split-wiki-codegraph`（任务 7.3 的一部分）

## 目的

7.3 要求「生成一次 Repo Wiki、生成一次知识卡、建立或同步一次代码索引、触发一次工具审批」四项都能完成。
本文件只覆盖其中**知识卡**一项，且结论是**部分达成**。

## 装配

一次性 driver（已删除）：照抄 `electron/app/repoWikiKnowledgeKernel.integration.test.ts` 的装配，
把 loopback fixture provider 换成真实 `KnowledgeModelPort`（`custom-mvjk9w7k/deepseek-v4.1-flash`）；
运行时按 `electron/main.ts` 的方式在进程内 `assembleAgentData`（`agentdata-host` 已下线），
知识库落在独立的 `knowledge.sqlite`。

项目：`D:\System Dir\Downloads\note-pocock-flow`，domain = `cards`。

## 结果：部分达成

| 项 | 值 |
| --- | --- |
| 终态 | `failed` |
| 计划 / 完成 / 失败 / 阻塞 | 10 / 8 篇独立卡片 + prepare + plan 共 10 项 prepared / 1 / 1 |
| 发布 | **0**（失败即整次不发布） |
| 模型请求 | 17 次，无 provider 错误 |

失败项：

```
generate  card:modules/notes   failed   INVALID_MODEL_JSON（可重试 false）
generate  card:repository      blocked  BLOCKED_BY_DEPENDENCY（依赖未完成）
```

已完成的 10 项覆盖 `card:overview`、`card:architecture`、`card:getting-started`、
`card:modules/{bin,examples,pocock,scripts,templates}` 等。

## 失败原因

`card:modules/notes` 在两次尝试后仍没有返回合格的 JSON。证据（`knowledge_build_items.evidence`）
显示它确实读了 8 个文件 —— `notes/METHOD.md`、`notes/UPSTREAM.txt`、6 个 `notes/scripts/*.ts` ——
也就是说模型做了探索，但最终回复不是要求的 JSON 结构。

这与本次 Repo Wiki 修复的那两类问题**同源不同点**：

- 同源：都是「模型没有严格按格式回答」；
- 不同点：Repo Wiki 的 `parseReferenceCatalogue` 现在容忍单对象与未转义引号，而知识卡走的是
  `INVALID_MODEL_JSON` 这条独立路径（`knowledgeKernel` 的 stage 校验），本轮没有改动它。

## 结论与未做的事

- 知识卡**能跑起来、能完成 10/10 个独立项**，但「一次完整生成成功」这条判据**未满足**。
- 7.3 的判据是四项都能完成，因此 7.3 仍应保持未完成。
- 若要修，方向与 Repo Wiki 的修复一致：让知识卡的 stage 输出校验容忍等价的 JSON 外形，
  或提高它的重试分类。这属于另一个变更的范围，不在本轮。
- 代码索引同步与工具审批两项依赖桌面界面，且代码索引的同步入口本身是断的（阶段二未做），
  本轮未执行。
