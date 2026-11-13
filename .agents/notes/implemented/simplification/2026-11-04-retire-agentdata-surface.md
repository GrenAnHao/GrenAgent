# Agent Note: 退役 AgentData 产品面与运行时，只保留共享基础设施

Status: implemented

## Problem

AgentData 同时承担五件事：Agent 数据工作台（产品入口）、知识运行时（Repo Wiki 的任务账本、模型并发槽、Kernel 转发、准入锁）、资料 Wiki、通用任务投影、以及共享基础设施持久化。

前四类被判定收益不足，用户决定下线而非继续修补。但代码证据显示依赖强度差异很大：**Repo Wiki 的 native 执行、KnowledgeKernel、模型并发槽和共享准入锁物理建立在 `agentdata-host` 与 `agent-data.db` 之上**。直接删除会打断 Repo Wiki 生成、知识卡和工具授权。

同时下线过程中暴露了一个更基础的问题：构建闸门失效。`tsconfig.json` 是 `files: []`，`npx tsc -p tsconfig.json` 退出码 0 且不检查任何文件；`tsconfig.node.json` 有数百行既有错误。这让"删掉的东西还在被引用"可以长期存在而不被发现。

## Decision

**一、先迁移所有权，再删产品面。**

Repo Wiki 与 codegraph 各自持有自己的任务与模型运行时，然后才移除 AgentData 入口：

- `repo-wiki/tasks.sqlite`（`WikiTaskStore`）取代 `agent_jobs` 里的 `repoWiki.generate`；
- `repo-wiki/knowledge.sqlite`（`KnowledgeBuildStore`）持有 Kernel 的任务、构建项、用量账本与租约；
- `repo-wiki/write-gate.sqlite`（`WriteGate`）持有跨域写入门；
- `repo-wiki/native-tasks.sqlite`（`NativeWikiProjection`）持有 native 任务投影；
- 模型并发槽改为进程级单例（`knowledgeModelScheduler`），不再借资料 Wiki 的实例。

**二、删除是分层的，不是整体的。**

- 移除 `agentdata-host` 子进程、`AgentDataService` 门面、`agentData/**` 运行时、资料 Wiki（`wikiEngine`、`wiki-rag` 的三个工具）、任务体系产品面（`JobsPanel`、`TaskViewStore`、`agentData_jobs_*`）、审计诊断面板。
- **保留** `threads` / `turns` / `items` / `permission_rules` / `tool_audit` / `plugin_state`：它们是工具审批的安全前置与会话持久化，不是"审计诊断"的产出。
- 运行时改为进程内 `assembleAgentData` 装配（`agentData/assemble.ts`），不再有独立宿主进程。

**三、本机知识、任务与审计数据直接丢弃，不建归档。**

项目目录下的 Wiki 正文、人工编辑、合并基线与冲突候选**保留**。

## 拆除顺序与依赖

先让 wiki 与 codegraph 自己拥有任务与模型运行时，再移除产品面，最后删数据与进程。任何一组的完成判据未通过时，不得进入下一组——因为中间态一旦既能没有旧入口又没有新入口，就没有可验证的路径。

## Alternatives considered

- **整体删除 AgentData** — 表面最干净。否决：Repo Wiki 的 native 执行、Kernel 与准入锁物理建立在它之上，直接删会打断三条仍在使用的链路。
- **继续修补 AgentData 而不是下线** — 能保留统一入口。否决：用户已判定收益不足，修补等于在无价值抽象上继续投入。
- **保留 `agent_jobs` 作为跨域任务表，让 wiki / codegraph 共用** — 减少表数量。否决：两者的消费方只有各自的面板与 Agent 提示，没有跨域查询需求；共用正是被判定为无独立价值的抽象。
- **为退役数据建归档副本长期保留** — 保留恢复能力。否决：用户明确要求清理；实际删除前这些表合计只有 2 行（1 条过期租约、1 条已完成的旧 wiki 任务），没有可保留的业务数据。
- **顺手清掉 `runtime.ts` 的重复成员** — 同一批改动里更彻底。否决：那是复制粘贴造成的既有问题，与本变更无关；混在一起会让"谁弄坏的"无法判断。

## Consequences

- **收益**：AgentData 产品面与运行时不再存在；`agent-data.db` 从 899 MB 降至约 856 MB（删除 13 张表后 `VACUUM` 之外的自然收缩有限，主要收益是表结构收窄）。
- **收益**：Repo Wiki 与 codegraph 可以独立演进，任务与状态各自持有。
- **代价**：`agent_jobs` 25 行、`knowledge_build_items` 242 行、`agent_audit` 8,766 行、`wiki_assets` 1 行、`wiki_sources` 2 行及对照副本已销毁，**永久不可恢复**。`tool_audit` 98,309 行保留。
- **代价与已知上限**：`electron/agentData/runtime.ts` 仍有整段重复成员（`openKnowledgeDb`、`requestAdmin`、`nativeAdmin` 等各出现两次），`tsconfig.node.json` 仍有数百行既有错误。**这两项是既有红，不是本变更引入**；在它们清掉之前，任何触及该文件的改动都无法判断是自己弄坏的还是本来就坏。
- **必须重访的信号**：若再次需要"用户在界面看到历史任务"，应引入有明确读者的小表，而不是复活 `agent_jobs` 语义。

## Verification

- 后端定向：codeGraph + wikiService 32 文件 225 项、toolPermission + plugin + ipc 12 文件 135 项，全部通过。
- 前端定向：codeIndex + agentData 12 文件 154 项、settings 16 文件 120 项全部通过。`repoWiki` 目录 209 通过 / 10 失败，其中 `RepoWikiWorkspace.knowledge.test.tsx` 9 项与 `RepoWikiWorkspace.test.tsx` 1 项在 HEAD 未改动版本上同样失败，属既有红。
- UI harness：`repo-wiki` 78 项、`repo-wiki-primary` 29 项、`repo-wiki-native` 22 项、`code-index-sync` 与 `code-retrieval-panel` 61 项全部通过。此前的场景仍 import 已删除的 `TaskDetailDrawer` 与 `AgentDataTaskProvider`，导致**整个 harness 构建失败**——已修。
- 数据：单事务 DROP 13 张表；删除前后 `threads` 629、`turns` 1640、`permission_rules` 17、`plugin_state` 5 均不变，`items` 与 `tool_audit` 只增（应用仍在写）；静置 45 秒复查未复活。
- 对照副本销毁前 `PRAGMA integrity_check` = `ok`，内容行数存档于 `.agents/evidence/2026-11-04-agentdata-data-retirement/`。
- 真机冒烟：Repo Wiki 生成已完成（20/20 发布）；知识卡经后续修复已完成（10/10 发布）；**代码索引同步与工具审批未执行**——前者入口本身是断的（阶段二未做），后者需要桌面界面。
