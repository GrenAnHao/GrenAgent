---
title: 后台任务托盘只列当前会话派出去的子代理
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/electron/app/subagentService.ts
  - electron-agent/electron/ipc/register.ts
  - electron-agent/src/lib/pi.ts
  - electron-agent/src/features/chat/input/workspace/TaskTray.tsx
supersedes:
superseded_by:
---

## 背景
输入栏的「后台任务」托盘调 `subagent_list(workspace)`，返回项目登记库里最新 50 条子代理，不分会话。同项目能同时跑多个会话以后，在 B 会话里能看到 A 派出去的子代理，还能把它取消。

## 决定
`subagent_list` 多一个可选参数 `sessionPath`。给了它，主进程从文件名取出这份会话的 sessionId，按登记行的 `parentId` 往下收：先收 `parentId` 等于它的行，再把这些行的 agentId 和子会话文件里的 sessionId 当作下一层的父级，这样子代理再派出的孙级也会收进来。按会话筛时最多扫 500 行，最后返回 50 条。登记库没有 `parentId` 列（老库）时返回空。托盘传当前画面的 `activeSessionPath`，草稿不发请求；只采用最后一次请求的结果，避免切会话后旧响应晚到盖掉新列表。不传 `sessionPath` 时行为不变，子代理卡片的实时状态轮询仍按项目取。

## 放弃的方案
- 前端拿全量列表自己筛：返回值里没有 `parentId`，要扩字段，最新 50 条还可能全被别的会话占满，筛完是空的。
- 按父会话 catalog（`foldCatalog`）筛：只认得登记了 catalog 条目的嵌入式子代理，one-shot 和进程子代理没有子会话路径，会被漏掉。
- 登记库加一列父会话路径：要改 multi-agent 的写入和迁移，而 `parentId` 已经是父会话的 sessionId，够用了。

## 后果
- 依赖 Pi 会话文件名是 `<时间戳>_<sessionId>.jsonl`，子代理会话的 sessionId 等于它的 agentId。任一约定变了，归属会断，托盘会显示空。
- 进程子代理没有子会话路径，它再派出去的孙级只能靠 agentId 挂上；如果孙级的 `parentId` 记的是别的 id，就收不进来。
- 没有 `parentId` 的老记录不会再出现在任何会话的托盘里。
