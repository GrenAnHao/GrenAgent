---
title: 开发构建定时清掉 React 留下的 performance.measure 条目
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/src/lib/devPerformanceEntries.ts
  - electron-agent/src/main.tsx
supersedes:
superseded_by:
---

## 背景

`electron-vite dev` 下并发跑子代理时，窗口两次整片白屏，主进程随即对每条事件报 `Render frame was disposed`。渲染进程私有内存半小时从约 700MB 涨到 2.1GB，V8 堆一直只有一两百 MB。按分配器拆开看，涨的是 Blink 的 PartitionAlloc buffer 分区（约 670MB）。时间线里有 53 万条 `measure`，名字是组件名，detail 里是「Changed Props」：React 19.2 开发版对每次 props 有变化的组件渲染都调一次 `performance.measure`，给 DevTools 的 Components 轨道用，浏览器不设上限，也没人清。清掉这些条目再 GC，私有内存从 2099MB 降到 1181MB。子代理卡片每秒刷新，弹层、提示和流式消息一直在重渲染，每秒能新增几百条，最后渲染进程 OOM。

## 决定

渲染入口在 `import.meta.env.DEV` 时每 5 秒调一次 `performance.clearMeasures()`。条目在创建时已经写进正在录制的性能 trace，事后清掉不影响 DevTools 里的轨道。生产构建的 React 不打这些 measure，不装定时器。

## 放弃的方案

- 开发时把 react-dom 换成 profiling / production 构建：丢掉开发期警告和 StrictMode 的检查。
- 包一层 `performance.measure`，每条记完立刻按名字清：每次渲染多一次按名字扫描，而且会误清同名的业务 measure。
- 只把渲染进程的堆上限调高：条目照样无界增长，只是晚一点崩。

## 后果

应用自己如果以后要用 `performance.measure` 做测量并在之后回读，开发构建里这些条目最多活 5 秒，要改用 `PerformanceObserver` 现场接。每秒几百条 measure 说明 composer 一带的 Popover、Modal 一类组件在空闲时也每秒重渲染，这是另一处性能问题，这里没有处理。
