---
title: 主进程把 fs.realpathSync 换成系统调用版，失败退回原实现
status: active
date: 2026-10-08
scope: electron-agent/startup
files:
  - electron-agent/electron/fastRealpath.ts
  - electron-agent/electron/main.ts
supersedes:
superseded_by:
---

## 背景

启动后主进程 CPU 剖析里，pi 的 `canonicalizePath`（`utils/paths.js`，内部就是 `realpathSync`）累计 4.1 秒：每建一个工作区运行时，`mergePaths`、`mapToResolved`、`addSkills` 各对约 110 个技能路径解析一次，启动时连同切到的冷项目一共建了 9 个运行时。Node 的 JS 版 `realpathSync` 在 Windows 上逐段 `lstat`，Electron 里实测每次 1.19ms；`realpathSync.native` 每次 0.25ms，结果相同。

## 决定

`main.ts` 模块体最前面调 `installFastRealpath()`：`fs.realpathSync` 换成先走 `fast.native`、抛错再调原实现的包装，保留 `.native` 属性，然后 `syncBuiltinESMExports()`，让 pi 的 `import { realpathSync } from "node:fs"` 具名绑定也指向新函数。选项对象带 Symbol 键的调用（CJS 加载器 `toRealPath` 传的 `realpathCacheKey` 缓存）仍交给原实现：native 返回磁盘上的大小写，原实现保留传入的大小写，否则从 `c:\` 这类小写路径启动时，同一个 CJS 包经 `import` 和 `require` 会按两个 key 各加载一份，node-pty 这类原生插件可能重复加载。同样场景复测，`canonicalizePath` 从 4.1 秒降到约 0.3 秒，切到冷项目的首帧从 0.57~1.08 秒降到 0.39~0.76 秒。

## 放弃的方案

- 改 pi 的 `dist/utils/paths.js`：pnpm 的包文件硬链接到全局 store，原地改会波及别的项目，重装又会丢。
- 进程级缓存 realpath 结果：技能目录、符号链接会变，缓存要失效策略；换 native 已经去掉大头。
- 只在建运行时期间临时替换：建运行时是异步的，期间其它代码也在跑，临时替换的范围反而更难说清。

## 后果

- 整个主进程的 `fs.realpathSync` 都走 native。native 遇到 subst 盘、某些网络盘会解析到底层路径或报错；报错时退回原实现，结果不同的情况需要路径比较的代码自己容忍。路径比较出问题时先查这里。
- ESM 加载器用启动时留下的原函数，CJS 加载器靠 Symbol 键绕开，模块解析都不受影响；`fs.promises.realpath` 和子进程（pi-worker）也不受影响。Node 若改了 CJS 加载器传给 `realpathSync` 的参数，绕开会失效，升级 Electron 后跑一遍 `fastRealpath.test.ts` 并按笔记背景里的场景复查。
- pi 升级后如果改成 `realpathSync.native` 或自带缓存，这一层可以删掉。
