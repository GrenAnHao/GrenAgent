# electron-agent

GrenAgent 桌面应用（当前主线）：React 19 + TypeScript + Vite 渲染层，Electron 主进程（TypeScript 服务层）与自研 Agent Data Runtime。项目整体介绍见仓库根 [`README.md`](../README.md)，架构与开发细节见 [架构文档](../docs/architecture.md) 与 [开发指南](../docs/development.md)。

历史桌面端 `tauri-agent/`（Tauri 2 + Rust）已过时并冻结，不再维护。

## 快速开始

```bash
bun install
bun run build:sidecar   # 首次拉取，或 cli/、extensions/ 变更后
bun run dev
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `bun run dev` | 启动桌面端（electron-vite 同时拉起主进程与渲染层） |
| `bun run build` | 类型检查后构建（产物 `out/`，渲染层 `dist/`） |
| `bun run build:sidecar` | 用 Bun 把 `cli/` 编译为 `resources/pi/pi(.exe)` |
| `bun run test` | 运行测试（`vitest run`） |
| `bun run package` | electron-builder 打包，产物 `release/` |

## 目录

```
src/          # 渲染层：features / stores / lib / platform / components / theme
electron/     # 主进程：main.ts 入口，app（服务层）、agentData（数据运行时）、pi、ipc、preload
docs/         # 桌面端文档（含 Tauri 能力迁移清单 tauri-api-inventory.md）
scripts/      # 构建脚本（build-sidecar.mjs）
```

## 约定

- 渲染层只通过 `window.gren` 访问桌面能力，业务代码依赖 `src/platform/runtime.ts` 的 `GrenRuntimeBridge`，不直接引用 Electron；无 bridge 时降级为 `browserPreviewBridge`。
- IPC 命令与事件通道定义见 `electron/ipc/contracts.ts`，命令注册见 `electron/ipc/register.ts`。
- 主进程服务按域拆分在 `electron/app/`，每个服务配套同名 `*.test.ts`。
- 禁止 emoji：源码、注释、UI 文案、文档、commit message 均不得使用（见仓库根 `.cursor/rules/no-emoji.mdc`）。
