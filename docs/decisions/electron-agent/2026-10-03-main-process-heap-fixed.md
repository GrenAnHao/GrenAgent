> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-11-packaging-constraints.md](../../../.agents/notes/implemented/architecture/2026-09-11-packaging-constraints.md) 维护；本文件冻结只读。

---
title: 主进程堆上限固定为 4GB，写在启动配置里
status: active
date: 2026-10-03
scope: electron-agent
files:
  - electron-agent/electron/mainHeap.ts
  - electron-agent/electron.vite.config.ts
supersedes: electron-agent/2026-10-03-main-process-heap.md
superseded_by:
---

## 背景

主进程老生代默认约 1.5GB。上一则笔记用 `app.relaunch` 在参数缺失时重启进程，把 4GB 补进去。那不是固定配置，打包进程和开发进程的启动方式也不一样。

## 决定

上限固定为 4096MB。`electron.vite.config.ts` 在 `electron-vite` 拉起 Electron 之前把 `--js-flags=--max-old-space-size=4096` 写入 `ELECTRON_CLI_ARGS`。已经带有 `max-old-space-size` 时不追加。主进程不再因为堆上限重启。

## 放弃的方案

- 缺参数就 `app.relaunch`：多一次进程启动，而且上限不是启动配置的一部分。
- `app.commandLine.appendSwitch('js-flags', ...)`：主进程的 V8 堆在 JS 执行前已经建好，这个开关改不到它。

## 后果

`electron-vite dev` 和 `preview` 拉起的主进程老生代上限是 4GB。同一条 `--js-flags` 也会作用到随后启动的渲染进程。不经过 `electron-vite` 直接打开的打包 exe 仍使用 Electron 默认上限。
