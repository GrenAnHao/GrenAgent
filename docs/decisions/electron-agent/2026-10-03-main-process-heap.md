> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-11-packaging-constraints.md](../../../.agents/notes/implemented/architecture/2026-09-11-packaging-constraints.md) 维护；本文件冻结只读。

---
title: 主进程 V8 老生代上限从约 1.5GB 提到 4GB
status: superseded
date: 2026-10-03
scope: electron-agent
files:
  - electron-agent/electron/mainHeap.ts
  - electron-agent/electron/main.ts
  - electron-agent/electron.vite.config.ts
supersedes:
superseded_by: electron-agent/2026-10-03-main-process-heap-fixed.md
---

> 已过时 → 见 [2026-10-03-main-process-heap-fixed.md](2026-10-03-main-process-heap-fixed.md)

## 背景

Electron 主进程未传 `--max-old-space-size` 时，V8 老生代停在约 1.5GB。子代理把流式快照留在这块堆上之后，进程在这个上限处 OOM 退出。

## 决定

启动参数使用 `--js-flags=--max-old-space-size=4096`。`electron-vite` 通过 `ELECTRON_CLI_ARGS` 在拉起 Electron 之前写上。打包后的 exe 若参数里还没有这一项，主进程在创建窗口前 `relaunch` 一次再退出。

## 放弃的方案

- `app.commandLine.appendSwitch('js-flags', ...)`：主进程的 V8 堆在 JS 执行前已经建好，这个开关只影响之后拉起的子进程。
- 只改开发脚本、不处理打包后的 exe：发出去的 GrenAgent 仍停在 1.5GB。
- 提到 8GB：机器内存不一定够，4GB 已经是当前上限的两倍多。

## 后果

开发进程和打包进程的主进程老生代上限都是 4GB。同一条 `--js-flags` 也会作用到随后启动的渲染进程。已经带有 `max-old-space-size` 的启动参数不会被覆盖，也不会反复重启。
