---
title: 子代理中断时不把更早的进度句当成完成结果
status: active
date: 2026-10-03
scope: extensions
files:
  - extensions/multi-agent/assistant-output.ts
  - extensions/multi-agent/embedded-runner.ts
supersedes:
superseded_by:
---

## 背景

进程内子代理被中断时，最后一条 assistant 往往只有 thinking、没有正文，stopReason 是 `aborted`。抽出父代理结果时从后往前跳过空正文，停在更早那条带字的进度句上，再把那条的 `toolUse` 当成 `completed`。父代理因此收到开头一句「我先读要求文档和规格，再读实现文件。」并照它继续。

## 决定

跟 DSH `finalAssistantOutput`：选最后一条内容非空的 assistant。thinking、toolCall 都算非空，所以中断时停在最后一轮，不会退回开头那句进度。只有内容数组为空的消息才让位给更早的一条。父代理拿到的字符串只取被选中那条里的 text；这条没有 text 就不补更早的正文。streamingDelta 只在整段都没有非空消息时使用。stopReason 另算，不拿来决定选哪一条。空闲超时的 abort 记入中断，不能因为正文非空就标成功。

## 放弃的方案

- 只按 text 从后往前找，跳过只有 thinking 的消息：会落回第一条进度句，这就是这次故障。
- 中断时一律丢弃更早正文：DSH 对真正的空消息仍保留上一条非空输出，半截结论不该被空的 usage 消息抹掉。
- 把 thinking 全文交给父代理：DSH 交的是内容块，我们的工具结果只有文本；没有 text 就空结果，不把推理当结论。

## 后果

中断落在只有 thinking 的一轮时，父代理看到失败，看不到开头那句。最后一条自己带了 text 时，这段 text 作为未完成输出返回。尾部空消息仍保留它前面最后一条非空消息的 text。
