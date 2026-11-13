# CLI 与 Pi SDK

`cli/` 同时提供独立命令行入口、桌面会话工厂和 worker 入口。桌面交互由 Electron 的 `agent-host` 运行，通过 Pi SDK 创建会话；不依赖独立 CLI 进程。进程拓扑见[架构文档](../docs/architecture.md)。

| 入口 | 用途 |
| --- | --- |
| [src/main.ts](./src/main.ts)、[src/runtime.ts](./src/runtime.ts) | 独立 CLI：将参数交给 Pi 的官方 `main()`，并注入 GrenAgent 扩展。 |
| [src/pi-sdk.ts](./src/pi-sdk.ts)、[src/gren-runtime.ts](./src/gren-runtime.ts) | SDK 适配与 `makeGrenRuntimeFactory`：供桌面宿主和子代理 worker 装配会话、模型、扩展及用量跟踪。 |
| [src/pi-worker.ts](./src/pi-worker.ts) | `--mode subagent` 托管一个子会话，经 IPC 与宿主通信；`--mode json` 和默认 print 路径交给官方 `main()`。 |
| [src/json-event.ts](./src/json-event.ts) | 将 SDK 事件转换为桌面渲染层消费的 JSON 形状。 |

桌面的 [worker 入口](../electron-agent/electron/pi-worker-entry.ts) 由 electron-vite 构建，随桌面应用分发。子代理默认在宿主进程内运行，选择 worker 后端时才启动独立子进程。

## 本地开发

按[开发指南](../docs/development.md#安装)安装依赖后，从仓库根目录运行：

```sh
pnpm --dir cli exec node --import tsx src/main.ts --help
pnpm --dir cli test
pnpm --dir cli typecheck
```

需要单独构建 CLI 时，运行 `pnpm --dir cli build`，产物为 `cli/dist/main.js`，可用 `node cli/dist/main.js --help` 查看命令。桌面构建不读取这份产物。

升级 SDK 时，按 [Pi SDK 升级清单](../docs/pi-sdk-upgrade-checklist.md)核对三处依赖和调用边界。
