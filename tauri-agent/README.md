# grenagent-app（已过时 · DEPRECATED）

> **本目录已过时，代码冻结（frozen）。**
>
> 桌面端主线已切换到 Electron：请前往 [`electron-agent/`](../electron-agent)。Tauri 2 + Rust 这一版不再接受功能开发、缺陷修复与依赖升级，保留仅供历史对照与迁移参考。
>
> - 当前实现：`electron-agent/`（Electron 主进程 + 自研 Agent Data Runtime）
> - 架构与开发说明：根 [`README.md`](../README.md)、[架构文档](../docs/architecture.md)、[开发指南](../docs/development.md)
> - 桌面能力迁移清单：[`electron-agent/docs/tauri-api-inventory.md`](../electron-agent/docs/tauri-api-inventory.md)

## 为什么过时

渲染层的桌面能力已统一收口到 `electron-agent/src/platform/runtime.ts`（`window.gren` 桥），Tauri 侧的能力不再需要重复实现；同时记忆与知识检索改用自研 Agent Data Runtime，TencentDB 托管运行时已从主线移除。前端快照已复制到 Electron 版并继续演进，本目录不再同步。

## 状态

- 不再维护：问题请到 Electron 版复现与修复，不要在此改动。
- 保留原因：迁移期间对照 IPC/命令语义与前端行为。
- 已知残留：`src/features/chat/input/editor/useTauriFileDrop.ts` 沿用旧命名（Electron 版实现已改为 webview drag-drop 事件）、`src/assets/tauri.svg` 未清理。

## 历史构建方式（仅存档）

```bash
bun install
bun run dev                      # 前端开发服务器
bun run tauri dev                # 桌面端（Tauri + Rust）
```

## 历史验证方式（仅存档）

```bash
bunx tsc --noEmit
bun run test
```

## 历史构建产物

- `bun run build`：`tsc && vite build`
- `bun run build:sidecar`：构建 Agent sidecar 二进制
