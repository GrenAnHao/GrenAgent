---
title: 输入框待发的图片和粘贴块按会话分桶，不再放组件本地 state
status: active
date: 2026-10-06
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/ChatInput.tsx
  - electron-agent/src/features/chat/ChatInput.test.tsx
  - electron-agent/src/features/chat/input/composerFiles.ts
  - electron-agent/src/features/chat/input/composerFiles.test.ts
supersedes:
superseded_by:
---

## 背景
文字草稿早就按 `draftKey`（会话文件路径，草稿对话回退到 workspace）存取，切会话会先存旧的再载入新的。但图片 `attachments` 和粘贴块 `pastedTexts` 是 `ChatInput` 里的 `useState`，没有跟 `draftKey` 绑定。在草稿页贴了图，切到别的会话，图片原样出现在那个会话的输入框里，发送时会一起发出去。

## 决定
新增不持久化的 zustand store `useComposerFilesStore`，`byKey[draftKey]` 存一个会话的图片和粘贴块。`ChatInput` 直接按当前 `draftKey` 读桶，增删、发送清空、发送失败放回都带上 key。切会话不需要任何同步动作：换了 key 读到的就是另一个桶，切回来内容还在。桶空了就删 key，不会越攒越多。

## 放弃的方案
- 切会话时在 `draftKey` effect 里把本地 state 存走、再载入新会话的：切换那一帧 state 还是旧会话的内容，任何「镜像写入」都会把旧图片记到新 key 下；开发模式下 effect 会跑两遍，卸载清理也会把还没载入的空 state 写回去，内容丢失。
- 给 `ChatInput` 加 `key={draftKey}` 强制重挂载：编辑器实例和焦点跟着重建，成本比分桶高得多，附件照样要另存。
- 把图片并进 `chatDraftStore` 持久化到 localStorage：图片是 base64，几张就会超出 localStorage 配额。
- 切会话时直接清空附件：回到原会话后用户已经贴好的图没了。

## 后果
- 图片和粘贴块只在内存里，重启应用不恢复；文字草稿仍然会恢复，两者行为不再一致。
- 会话被删除后，它那个桶会留在内存里直到重启（桶只在发送、移除、失败放回时变动）。量很小，需要时再在删除会话时清。
- 任何新增的「待发内容」类状态都应该放进按 `draftKey` 分桶的 store，不要再放在 `ChatInput` 的本地 state。
