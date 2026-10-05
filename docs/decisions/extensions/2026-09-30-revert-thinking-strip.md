---
title: 撤回请求前裁剪思考，上下文按完整会话估算
status: active
date: 2026-09-30
scope: extensions
files:
  - extensions/index.ts
  - electron-agent/electron/app/contextUsageEstimate.ts
supersedes: 2026-09-30-keep-completed-thinking-over-truncated-stub.md
superseded_by:
---

## 背景
请求前丢掉已结束轮次的思考之后，用量环按裁过的副本估算，和模型实际收到的窗口、以及服务端按未裁剪历史拒绝的请求对不上。截断再发时还会留错一次思考。用量显示已经不能当压缩判断用。

## 决定
卸掉 `thinking-replay`。发往模型的历史恢复为 Pi 原样回放，思考块不再在 `context` 钩子里删改。压缩后的用量空窗仍按会话里的完整消息估算，思考字数算回去。

## 放弃的方案
- 只修用量环、继续裁请求：环和真实请求会重新对齐，但截断后再发仍会带错思考，这正是要退掉的行为。
- 保留扩展并做成开关：默认关掉等于没装，开关本身还会在切换时打穿提示缓存。

## 后果
- 已结束轮次的思考会再次进入后续请求，输入 token 回到裁剪之前的水平。
- 会话记录和界面本来就保留全文，这次没有额外要迁的数据。
