---
title: Mermaid 预检结果按源码缓存，修复虚拟列表重挂载导致的滚动上弹
status: active
date: 2026-09-28
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/Mermaid.tsx
supersedes:
superseded_by:
---

## 背景
含 Mermaid 图的长助手消息在视口上方被 virtua 卸载、再挂回时，Mermaid 组件每次挂载都清空状态并异步重跑预检，首帧退回「Loading diagram…」占位，整条消息先矮约 860px 再长回去。virtua 据此修正 scrollTop，叠加浏览器对最大滚动距离的夹取，视口会自己往上弹。

## 决定
按图的源码缓存预检结果（成功与失败都缓存，最多 200 条，超出丢最早的），组件 state 直接用缓存初始化；命中缓存时跳过「清空再异步预检」，重挂载首帧即终态，高度不变。

## 放弃的方案
- 改 `.pi-md table` 或给 virtua 条目加宽度：实测两种状态下表格宽高完全一致，VList 条目本来就有 `width: 100%`，不是原因。
- 在 onScroll 里检测 scrollSize 突变后 scrollTo 拉回：高度缩小时最大滚动距离被夹住，贴底逻辑再把视口拽到末尾，来回弹更明显。
- 只把 BOTTOM_THRESHOLD 从 120 改成 8：只影响贴底吸附，与 860px 的跳动无关。
- 让 virtua 保留上方条目不卸载：放大内存与渲染开销，也只是掩盖任意异步占位组件的同类问题。

## 后果
缓存是模块级、跨会话共享，上限 200 条。首次渲染仍会长高一次；交给 lobe-ui 在线渲染的图类型每次挂载仍先显示 Loading。若以后出现其他异步占位组件导致同类跳动，应考虑在列表层统一保存条目高度。
