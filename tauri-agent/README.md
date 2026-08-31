# grenagent-app

GrenAgent 桌面应用：React 19 + TypeScript + Vite 前端，Tauri 2 与 Rust 后端。项目整体介绍见仓库根目录的 [README](../README.md)，架构与开发细节见 [架构文档](../docs/architecture.md) 与 [开发指南](../docs/development.md)。

## 状态

Electron 是当前主桌面实现，统一使用自研 Agent Data Runtime（Memory、Wiki RAG 和 CodeGraph 扩展）。Tauri 目录仅保留历史客户端代码，不再承载 Agent 数据运行时。

## 开发（历史客户端）

```bash
bun install
bun run dev                      # 前端开发服务器
bun run tauri dev                # 桌面端（Tauri + Rust）
```

## 构建

```bash
bun run build                    # tsc && vite build
bun run build:sidecar            # 构建 Agent sidecar 二进制
```

## 验证

```bash
bunx tsc --noEmit
bun run test
```
