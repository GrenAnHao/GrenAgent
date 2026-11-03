# Agent Note: 用真实模型跑通 Repo Wiki 知识内核

Status: implemented

## Problem

知识内核的单元和集成测试全部使用回放理想答案的假 provider，从没对着真实模型跑过。用户在 `note-pocock-flow` 上连续遇到六种失败（Git 所有权、截断、预算估算、轮数、JSON 代码块，以及本篇这些），每次只能修一个。

## Decision

本篇的两层目录阈值继续用于历史 v1 任务；新任务由 [Qoder 对齐实现](../architecture/2026-11-02-repo-wiki-qoder-alignment.md) 使用分层有界并发、冻结节点/深度/规划项上限和用途预算。路径错误恢复、来源纪律和本地最终校验的理由仍有效。

新增按需运行的真实模型端到端测试 `electron/app/repoWikiRealModel.e2e.test.ts`：用与内核集成测试相同的两个真实子进程，克隆指定仓库，调用用户配置的系统知识模型，完整执行 prepare → overview → plan → catalogue → generate → validate → publish，并输出每次模型调用、最终答复和用量报告。设置 `REPO_WIKI_REAL_E2E=<仓库路径>` 才会运行，平时跳过，不产生费用。

在 `deepseek-v4.1-flash` 上反复运行，又暴露并修复了：

| 现象 | 原因 | 修复 |
|---|---|---|
| `Timed out: agentdata.admin` | 测试夹具对每个 RPC 限 25 秒，真实模型一轮可达 40 秒（生产无此限制） | 夹具增加 `requestTimeoutMs`，真实测试用 300 秒 |
| `INVALID_SOURCE` | 模型写的来源是 `{path, note}`、`start_line`，或漏掉 64 位哈希 | `normalizeStageSources()`：哈希从 manifest 补，行号从实际读取范围补，读不到的引用丢弃，无法核实的 Markdown 来源链接降为纯文本，之后仍严格校验；提示词给出精确格式 |
| 169 次请求仍在拆目录 | 每个目录项都跑完整工具循环，深度上限 6 | `MAX_CATALOGUE_DEPTH = 2`，更深的项直接作为页面；目录提示要求尽量不拆、最多 6 个子项 |
| `FORBIDDEN_PATH` 让整页失败 | 任何工具异常都当作致命错误 | 路径不可读、二进制、rg 拒绝模式（如字面 `\n`）作为工具错误返还给模型继续；预算、快照变化、中止仍然致命 |
| 页面缺来源 | 模型用 Grep 看到的行不算证据 | Grep 返回的行记录为可引用的读取范围；完全没有来源时，引用正文点名且实际读过的文件 |
| validate 阶段耗尽预算 | 模型驱动的 validate 把整个仓库又读一遍 | validate 改为本地完成：每页提交时已校验，依赖保证所有页面齐全 |

## Alternatives considered

- 按 Qoder 架构整体重做：用户提出过；不采用，以上问题都出在模型与仓库的真实行为上，换架构同样要逐一处理，而现有内核已具备分阶段、工具会话、可恢复的结构。
- 放宽校验、允许无来源页面：最容易跑通；不采用，会让页面声称未读过的证据。

## 验证

- 真实运行（2026-11-01，`deepseek-v4.1-flash`，`D:\System Dir\Downloads\note-pocock-flow` 的本地克隆）：`REPO_WIKI_REAL_E2E=... pnpm exec vitest run electron/app/repoWikiRealModel.e2e.test.ts` 通过，任务 completed，计划 3 页、发布 3 页（overview / getting-started / architecture，87–164 行）；共 84 次模型请求、198 次工具调用，未缓存输入 32 万 token、输出 6.9 万 token，用时约 9 分钟。报告与页面在 `.agents/evidence/2026-11-01-repo-wiki-real-model-run/`。
- `pnpm exec vitest run electron/agentData/knowledgeKernel electron/knowledgeProcess electron/app/repoWikiKnowledgeKernel.integration.test.ts`：22 文件 137 项通过。

## Consequences

改动内核或提示词后，合并前的真实模型质量与费用验收仍需授权；2026-11-02 用户要求暂不跑付费模型测试，新 v2 只完成本地回环验收。目录最多两层是 v1 的边界；新任务的上限、并发及验证范围以 Qoder 对齐笔记为准，不能用之前本地克隆的一次成功保证原项目的每轮生成。
