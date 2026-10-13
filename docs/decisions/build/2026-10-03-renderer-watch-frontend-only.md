> 已迁移：本决定现由 [.agents/notes/implemented/process/2026-10-03-local-run-and-renderer-watch.md](../../../.agents/notes/implemented/process/2026-10-03-local-run-and-renderer-watch.md) 维护；本文件冻结只读。

---
title: 开发时渲染层只侦测前端源码的热更
status: active
date: 2026-10-03
scope: build
files:
  - electron-agent/electron.vite.config.ts
  - electron-agent/electron/dev/frontendWatch.ts
supersedes:
superseded_by:
---

## 背景

`electron-vite dev` 把渲染层 `root` 设成整个 `electron-agent/`。Vite 会侦测这棵目录，再加上配置文件带进来的依赖，以及渲染层从 `extensions/` 引进的那几个模块。主进程、扩展、测试和 `out/` 一有写入，就可能走进热更；走不到组件边界时会整页刷新，启动页重播，窗口一直闪。

## 决定

渲染层的 chokidar 只放下 `src/`（不含 `*.test.*` / `*.spec.*`）、`index.html` 和 `electron.vite.config.ts`。其余路径直接 `ignored`。另加一个 `hotUpdate` 插件：漏进模块图的非前端文件返回空更新，不再整页刷新。`electron-vite dev` 默认不 watch 主进程和 preload，这次不打开。

## 放弃的方案

- 只在插件里丢掉事件、目录照样全量侦测：`electron/` 和 `out/` 的写入仍会进回调，Windows 上容易漏进刷新。
- 关掉渲染层热更：前端改动也要整页刷新，启动页照样闪。
- 给 main / preload 打开 watch：改主进程会杀掉 Electron 再拉起，比渲染层刷新更闪。

## 后果

改 `electron/`、`extensions/`、测试和构建产物不会刷新界面，这些改动要手动重启或自己再改一次前端文件才进页面。改 `src/` 和 `index.html` 仍走原来的热更；没有组件边界的模块仍可能整页刷新。开发服务器要重新启动后，新的侦测范围才生效。
