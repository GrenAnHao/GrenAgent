> 已迁移：本决定现由 [.agents/notes/implemented/process/2026-10-03-local-run-and-renderer-watch.md](../../../.agents/notes/implemented/process/2026-10-03-local-run-and-renderer-watch.md) 维护；本文件冻结只读。

---
title: 本机日常用 npm run start：生产渲染层 + ESM 主进程，不走 Vite 开发服务器
status: active
date: 2026-10-08
scope: build
files:
  - electron-agent/electron.vite.config.ts
  - electron-agent/package.json
supersedes:
superseded_by:
---

## 背景

日常一直用 `electron-vite dev` 跑。同一台机器实测：开发模式页面 DOMContentLoaded 23.2 秒，生产渲染层 0.84 秒；首次进设置、用量页 2.6~2.7 秒，生产 40~70ms；切会话首帧 0.5~1.1 秒，生产 0.12~0.24 秒。开发模式的成本在 Vite 逐个模块转译和 React 开发版（jsxDEV、createTask、组件渲染日志）。现成的生产产物又跑不起来：`electron-vite build` 把主进程打成 CJS 字节码，外置的 `@earendil-works/pi-coding-agent` 只有 `import` 导出条件，`require` 直接抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`；`electron-vite preview` 还按 package.json 的 `out/main/main.js` 找入口，生产产物是 `main.cjs`。

## 决定

新增 `npm run start` = `electron-vite preview --mode localrun`。`localrun` 模式下 `production` 为假：主进程不出字节码、不改 CJS、不写 `out/main/package.json`，和开发时一样输出 ESM `main.js`；渲染层照常生产构建到 `dist/`，主进程没有 `ELECTRON_RENDERER_URL` 就 `loadFile`。源码没改时 `npm run start -- --skipBuild` 直接启动。模式名不能叫 `local`，Vite 拿它和 `.env.local` 冲突。

## 放弃的方案

- 直接 `electron out/main/main.cjs`：上面的 `require` 错误，主进程起不来。
- 把 pi 包从外置依赖里排除、打进 CJS：要处理 pi 的相邻资源、`import.meta` 和 worker 路径，属于修打包，不是本机运行该背的风险。
- 开发服务器加 `optimizeDeps` / 预热：只能缩短首次转译，React 开发版的渲染开销还在，切会话仍慢 4~6 倍。
- `cross-env` 传环境变量：要新加依赖；`--mode` 是 Vite 自带的开关。

## 后果

- 渲染层改动要重新 `npm run start` 才看得到，没有 HMR；改界面时仍用 `npm run dev`。
- `localrun` 产物和安装包不同（ESM、无字节码），只用于本机，不要拿它打包。
- 安装包的主进程 CJS 入口仍 `require` 不到 pi 包，这个问题本条没有处理；修好打包后应重新评估 `start` 是否改走真实生产产物。
