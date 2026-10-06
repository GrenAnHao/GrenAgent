---
title: 任务列表走覆盖索引、记忆任务不碰表行，会话列表在 SQL 里截片段，解决 AgentData 页面卡顿
status: active
date: 2026-10-06
scope: electron-agent/agentdata
files:
  - electron-agent/electron/agentData/taskViewStore.ts
  - electron-agent/electron/agentData/storage.ts
  - electron-agent/electron/agentData/memoryStore.ts
supersedes:
superseded_by:
---

## 背景
进入 AgentData 页面、切回概览、切换视图时界面明显卡顿。AgentData 运行在 Electron 主进程里，用的是同步的 `node:sqlite`，查询期间主进程整个停住，点击和 IPC 都要等。

在本机库（292 MB，`service_tasks` 398 行共 50 MB）的副本上给页面用到的接口计时：`admin.tasks.list` 每次 280–640 ms，`memory.conversations.list` 50–150 ms，其余都在 20 ms 以内。`tasks.list` 进入页面就调，有进行中任务时每 2 秒轮询一次。

`tasks.list` 慢有两层原因。第一层看得见：UNION 里对每条 `service_tasks` 做 `json_valid(input)` 和 `json_extract(input,'$.kbId')`，等于把全部历史记忆载荷解析一遍。第二层光看代码看不出：`attempts`、`error`、`created_at`、`updated_at` 在表里排在 `input` 之后，SQLite 要读这几列就得沿 `input` 的溢出页链走完整行。所以哪怕只查 `SELECT id,kind,status,error,attempts,created_at,updated_at FROM service_tasks`，也要 90–150 ms。

`memory.conversations.list` 为了切 1200 字的片段，把每条 transcript（单条可达数百 KB）整份读进了主进程。

## 决定
新建覆盖索引 `service_tasks_task_view(updated_at, id, kind, status, source_project_id, attempts, created_at, error)`。`TaskViewStore.union()` 的系统任务部分拆成两支：记忆任务（`kind LIKE 'memory\_%'`）只引用索引里的列，`kb_id` 只看 `wiki_task_targets`；其余 kind 照旧从 `input` 解析 `kbId`。这些 kind 的 input 很小，`kind` 又排在 `input` 之前，过滤时不会读到溢出页。

`listConversations` 没有搜索词时用 `substr(transcript,1,1200)` 取片段；有搜索词时片段要以命中位置为中心，仍读整份。

同一副本上复测：`tasks.list` 4–15 ms，`conversations.list` 无搜索词时 20–50 ms。首次启动建索引约 0.2 秒。

## 放弃的方案
- 重建 `service_tasks`，把大列挪到末尾：要迁移整张表、改所有 INSERT 列序，风险远大于加一个索引。
- 只在 SQL 里让 `json_valid` 短路：实测仍要 90–300 ms，瓶颈在溢出页链，不在 JSON 解析。
- 把 AgentData 挪进 worker 线程或子进程：方向对，但属于架构改动；先把明显的慢查询去掉。
- 降低轮询频率：没有进行中任务时本来就不轮询，卡顿主要发生在进入和切换页面时。

## 后果
往 `service_tasks` 加新列时，凡是任务视图要用到的，都要加进这个覆盖索引，否则记忆任务那一支会退回扫表行。用 `EXPLAIN QUERY PLAN` 应该能看到 `USING COVERING INDEX service_tasks_task_view`。

`memory_captures` 和 `items` 也是大列在前、`updated_at` 在后的布局，会话搜索、`item_list` 也有类似风险。如果它们出现卡顿，按同样的思路处理。
