---
title: 子代理登记表加覆盖索引，按会话列表先取短列再按主键取行
status: active
date: 2026-10-04
scope: electron-agent
files:
  - extensions/multi-agent/registry.ts
  - electron-agent/electron/app/subagentService.ts
  - electron-agent/src/features/chat/input/workspace/TaskTray.tsx
supersedes:
superseded_by:
---

## 背景

`subagents` 表里 `transcript` 排在 `sessionPath`、`parentId`、`createdAt` 前面。一个项目攒了 237 行、119MB transcript 后，`ORDER BY createdAt` 要顺着每一行的溢出页链读到行尾，一次 `subagent_list` 在主线程上同步耗时 140 到 160 毫秒。任务托盘又对同项目的每个工具起止事件都重拉一次，子代理自己的工具事件也算在内，并发八个子代理时主线程一秒要做好几次。

## 决定

registry 打开时建 `idx_subagents_listing(createdAt, id, parentId, sessionPath)`。不带会话的列表走它排序，只读 50 行。按会话列表先用覆盖索引取 `id / parentId / sessionPath` 做归属计算，再按主键取最多 50 行的完整列。实测从约 150 毫秒降到 3 毫秒。任务托盘不再因 `source: subagent` 的事件或别的会话的事件重拉。

## 放弃的方案

- 把 transcript 挪到单独的表：要迁移数据并改两边读写，覆盖索引已经让列表不碰大行。
- 只给 `createdAt` 建单列索引：不带会话的列表够了，但按会话归属仍要读 500 行的 `parentId`，同样慢。
- 用递归 CTE 在 SQL 里收归属：要把「子会话文件名里的 sessionId 也算父级」搬进 SQL，和现有 `rowsOwnedBy` 规则分叉。

## 后果

索引由写入端（扩展）在打开 registry 时建，第一次在大库上要扫一遍，约 0.2 秒。主进程只读打开，老库在扩展打开它之前仍走慢路径。以后在 `subagents` 上加要参与列表排序或归属的列，需要同步进这个索引。
