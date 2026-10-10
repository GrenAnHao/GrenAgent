---
title: 设置页用应用内窗口完成 Devin OAuth
status: active
date: 2026-10-05
scope: extensions
files:
  - electron-agent/electron/app/devinOAuthWindow.ts
  - electron-agent/electron/app/devinAccount.ts
  - electron-agent/src/features/settings/DevinAccountCard.tsx
  - extensions/devin-client/oauth.ts
supersedes:
superseded_by:
---

## 背景

Devin 登录已经是主进程上的 PKCE 回调，但授权页用系统浏览器打开，回调页还写着回到命令行。设置里的「登录」看不出这是 OAuth，也接不回设置页。

## 决定

设置页按钮为「OAuth 登录」。主进程弹出只加载 `https://app.devin.ai` 的窗口，本机回调仍然落到 `127.0.0.1`。授权成功后窗口显示「回到设置」并关闭。用户关掉窗口则取消登录。

## 放弃的方案

- 继续 `shell.openExternal`：授权发生在应用外面，设置页只能干等，回调文案也还是 CLI。
- 在设置页里嵌 webview：和主窗口抢焦点、和页面生命周期绑在一起，关掉设置就中断不了授权。

## 后果

授权窗口的初始地址只允许 `app.devin.ai`；之后的跳转（包括本机回调）仍由该窗口自己走。没有自动刷新，过期还是要再走一次 OAuth。
