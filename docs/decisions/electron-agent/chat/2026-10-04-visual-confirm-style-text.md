---
title: 视觉设计撑满布局不能给 style 设 display
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/src/features/visual/frameAssets.ts
supersedes:
superseded_by:
---

## 背景
面板和全屏预览用 `body > *:not(script) { display: flex }` 把比较区撑满。确认条的样式是运行时创建的 `<style>`，并挂在 `body` 上。`<style>` 的默认 `display` 是 `none`；一旦被改成别的值，浏览器会把 CSS 原文画进页面。

## 决定
撑满规则排除 `style`。确认条样式仍挂在 `body` 上，只是不再参加这条 flex 布局。

## 放弃的方案
- 只把确认条的 `<style>` 挪到 `head`：能躲开这一条 `body > *`，但撑满规则仍会命中别的 `style`。没有 `head` 的整页文档，折行补丁本来就插在 `body` 末尾。
- 在样式里写 `style { display: none !important }`：能盖住当前这条没有 `!important` 的规则，选择器却还把 `<style>` 当成布局节点。以后补上 `!important`，原文会再漏出来。

## 后果
以后给 `body` 直接子节点加 `display`，必须继续排除 `style`。否则确认条的 CSS 原文会再出现在预览底部。
