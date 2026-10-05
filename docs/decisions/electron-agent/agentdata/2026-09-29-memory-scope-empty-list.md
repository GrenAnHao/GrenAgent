---
title: 归属筛选把某一层滤空时，空态要指出角标仍是全部项目的总数
status: active
date: 2026-09-29
scope: electron-agent/agentdata
files:
  - electron-agent/src/features/agentData/MemoryPanel.tsx
supersedes:
superseded_by:
---

## 背景
Memory 页的 L0–L3 角标来自 `overview({ includeOtherProjects: true })`，固定是全部项目的总数。列表则按右侧归属筛选。本地库里 608 条 L1 全是 `memory_scope='project'`，17 条 L2 全是 `global`。筛选停在「全局」再看 L1 时，列表为空，角标仍是 608，空态写成「暂无记忆」。

## 决定
角标继续表示全部项目的总数。当前归属把这一层滤空、且该层全部项目计数大于 0 时，空态写明「某范围内没有 Lx 记忆」和角标含义，并提供「查看全部项目」把筛选切回 `scope: 'all'`。真正没有记录时仍显示「暂无记忆」。

## 放弃的方案
- 让角标跟随归属筛选：会推翻「数量是全部项目总数」的约定，L2 的 17 在切到某个项目时消失，总数也不再能当目录用。
- 全局筛选下列出项目记忆：归属筛选就不再表示 `memory_scope`。
- 只改文案、不给切回入口：用户仍然要自己在下拉里找到「全部项目」。

## 后果
搜索无命中仍是「暂无匹配记录」，不提供「查看全部项目」，避免把关键词清掉。对话记录没有分层计数，空态维持原样。
