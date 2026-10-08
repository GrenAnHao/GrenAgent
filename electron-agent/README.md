# electron-agent

GrenAgent 桌面应用（当前主线）：React 19 + TypeScript + Vite 渲染层，Electron 主进程（TypeScript 服务层）与自研 Agent Data Runtime。项目整体介绍见仓库根 [`README.md`](../README.md)，架构与开发细节见 [架构文档](../docs/architecture.md) 与 [开发指南](../docs/development.md)。

历史桌面端 `tauri-agent/`（Tauri 2 + Rust）已封存并从工作区移除，完整快照见 git 标签 `archive/tauri-agent`。

## 快速开始

```bash
bun install
bun run dev
```

`cli/` 与 `extensions/` 变更后执行 `bun run build`，由 electron-vite 打进 `out/main/`。不再编译独立 `pi.exe`。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `bun run start` | 日常使用：渲染层生产构建后启动，比 dev 快得多；源码没改时 `bun run start -- --skipBuild` 跳过构建 |
| `bun run dev` | 开发界面：Vite 开发服务器 + HMR（React 开发版，启动和切换明显更慢） |
| `bun run build` | 类型检查后构建（产物 `out/`，渲染层 `dist/`） |
| `bun run test` | 运行测试（`vitest run`） |
| `bun run package` | electron-builder 打包，产物 `release/` |

## 目录

```
src/          # 渲染层：features / stores / lib / platform / components / theme
electron/     # 主进程：main.ts 入口，app（服务层）、agentData（数据运行时）、agent、pi、ipc、preload
docs/         # 桌面端文档（含 Tauri 能力迁移清单 tauri-api-inventory.md）
scripts/      # 构建脚本（package-codegraph.cjs 等）
```

## 约定

- 渲染层只通过 `window.gren` 访问桌面能力，业务代码依赖 `src/platform/runtime.ts` 的 `GrenRuntimeBridge`，不直接引用 Electron；无 bridge 时降级为 `browserPreviewBridge`。
- IPC 命令与事件通道定义见 `electron/ipc/contracts.ts`，命令注册见 `electron/ipc/register.ts`。
- 主进程服务按域拆分在 `electron/app/`，每个服务配套同名 `*.test.ts`。
- 禁止 emoji：源码、注释、UI 文案、文档、commit message 均不得使用（见仓库根 `.cursor/rules/no-emoji.mdc`）。
