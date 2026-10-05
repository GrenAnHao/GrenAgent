---
title: Git 历史按页加载全部分支的提交，不再固定拉 80 条
status: active
date: 2026-10-05
scope: electron-agent
files:
  - electron-agent/electron/app/gitService.ts
  - electron-agent/electron/ipc/register.ts
  - electron-agent/src/lib/pi.ts
  - electron-agent/src/features/chat/input/workspace/GitGraphPanel.tsx
  - electron-agent/src/features/chat/input/workspace/BranchPicker.tsx
supersedes:
superseded_by:
---

## 背景
「Git 图谱」弹窗写死 `getGitLogGraph(workspace, 80)`，主进程跑 `git log -n 80`，而且只走当前 HEAD。本仓库 HEAD 上有 1309 个提交，加上其它分支共 1334 个，弹窗只画出最新 80 个，其它分支上的提交一个都不显示，看起来就是节点没加载全。入口同时改名为「Git 历史」。

## 决定
`get_git_log_graph` 多一个可选参数 `skip`（非负整数，默认 0），`GitService.logGraph` 改为 `git log --branches --remotes --tags HEAD --date-order -n <limit> [--skip <skip>]`。前端每页 300 条，VList 滚到离底部不足 60 行时拉下一页；某一页不满 300 条就认为到底了。两页之间如果出现新提交，`skip` 会错位，所以合并时按 hash 去重。底部状态行显示已加载条数，加载完显示总数。

## 放弃的方案
- 一次拉全量（不带 `-n`）：小仓库没问题，但十万级提交的仓库会一次性传几十 MB 过 IPC，还可能超过 `execFile` 默认 1 MB 的 maxBuffer，弹窗要等很久才出第一行。
- `--all`：会把 `refs/stash` 也带进来，stash 提交有两三个父提交，会在图里多出几条没有意义的 lane。
- 沿用 git 默认排序：有多个起点 ref 时默认按提交时间排，时钟有偏差就会出现父提交排在子提交前面。`buildGraph` 的 lane 算法依赖「子在父前」，顺序一乱就会断线。`--date-order` 能保证这个顺序，翻页时顺序也稳定。`--topo-order` 也能保证，但它会把一条分支整段排在一起，日期列看着是乱的。

## 后果
- `--date-order` 要先遍历完历史才输出第一页。仓库没有 commit-graph 文件时，大仓库首屏会比原来 `-n 80` 慢；真成了问题，可以考虑 `git commit-graph write`，或者在设置里加一个「只看当前分支」。
- 远端分支和 tag 都会显示。远端分支很多时 lane 会变宽；如果用户只想看当前分支，需要再加开关。
- 首页之后的数据要滚动才会加载，所以底部状态行没显示「共 N 条」之前，最下面一行不代表最早的提交。
