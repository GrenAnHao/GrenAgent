# electron-agent

GrenAgent 桌面应用：React / Vite 渲染层经 preload 桥访问 Electron 主进程。Pi 会话由 `agent-host` 托管，代码索引由 `codegraph-host` 提供。整体介绍见[仓库 README](../README.md)，进程边界见[架构文档](../docs/architecture.md)。

历史桌面端 `tauri-agent/`（Tauri 2 + Rust）已封存并从工作区移除，完整快照见 git 标签 `archive/tauri-agent`。

## 快速开始

按[开发指南](../docs/development.md#安装)安装依赖。从仓库根目录运行：

| 用途 | 命令 |
| --- | --- |
| 日常启动 | `pnpm --dir electron-agent start` |
| Vite 热更新 | `pnpm --dir electron-agent dev` |
| 复用本机启动产物 | `pnpm --dir electron-agent start --skipBuild` |
| 测试 | `pnpm --dir electron-agent test` |
| 生产构建 | `pnpm --dir electron-agent build` |
| 生成本地安装包 | 构建后运行 `pnpm --dir electron-agent package --publish never` |

开发主进程产物在 `out/`，`start` 从 `dist/` 加载界面。打包读取 `out-pkg/`，安装文件输出到 `release/`。

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
- 禁止 emoji：源码、注释、UI 文案、文档、commit message 均不得使用（见[开发指南](../docs/development.md#代码风格)）。
