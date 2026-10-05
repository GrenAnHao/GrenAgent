---
title: <一句话说明这条决策是什么>
status: active            # active | superseded
date: YYYY-MM-DD
scope: <模块或子系统，用于 grep，例如 runtime / build / api>
files:
  - src/...
supersedes:               # 若推翻旧结论，填旧笔记相对路径；否则留空
superseded_by:            # 被推翻时回填；通常由新笔记提交时补
---

## 背景
<触发现状的问题。只写与本次决策相关的事实，1-3 句。>

## 决定
<最终采用了什么。>

## 放弃的方案
<每个备选一行：方案 + 放弃原因。这一节是笔记存在的理由，务必写。>

## 后果
<这个决定带来的代价与约束，以及将来什么条件下应该重新评估。>
