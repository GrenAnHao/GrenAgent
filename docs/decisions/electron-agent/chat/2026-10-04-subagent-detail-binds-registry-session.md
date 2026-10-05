---
title: 子代理详情用登记表里的子会话路径绑定事件流，事件在流时不重读 JSONL
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/src/features/panels/SubAgentConversation.tsx
  - electron-agent/src/features/panels/useChildSessionBinding.ts
  - electron-agent/src/hooks/useSubAgentLive.ts
supersedes:
superseded_by:
---

## 背景

进程内子代理的事件已经带着 `sessionPath` 推到渲染层，但后台 one-shot 的工具结果在子会话建立前就返回了，里面没有 `sessionPath`。详情面板于是退回每 2.5 秒拉一次 registry 里的 64KB transcript 尾巴回放，registry 本身又按 1 秒节流落盘，内容一跳一跳地出来。已经绑定事件流的面板也每 2.5 秒让主进程同步解析整份子会话 JSONL。

## 决定

`useSubAgentLive` 把登记表行的 `sessionPath` 一起返回。详情面板优先用工具结果里的路径，没有就用登记表的，有路径就走 `useChildSessionBinding`：首帧读一次 JSONL，之后吃流式事件。运行中只在超过 5 秒没收到这个子会话的事件时才补读一次 JSONL，进程子代理不推事件，仍靠这条补读。

## 放弃的方案

- 让后台 spawn 的工具结果事后补上 `sessionPath`：工具调用已经返回，要再改一次结果，牵扯会话历史；登记表本来就有这一列。
- 去掉 JSONL 补读：进程子代理没有事件流，详情会停在首帧。
- 降低 registry transcript 的轮询间隔：主进程读写更频繁，也还是回放尾巴，不是实时流。

## 后果

登记表轮询还没拿到这一行时，详情先走原来的 transcript 回放，拿到路径后切到事件流。中途打开面板时，正在流的那条消息要等下一个增量或 `message_end` 才补全。
