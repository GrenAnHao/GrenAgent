# grenagent-app

GrenAgent 桌面应用：React 19 + TypeScript + Vite 前端，Tauri 2 与 Rust 后端。项目整体介绍见仓库根目录的 [README](../README.md)，架构与开发细节见 [架构文档](../docs/architecture.md) 与 [开发指南](../docs/development.md)。

## 开发

```bash
npm install
npm run dev          # 前端开发服务器
npm run tauri dev    # 桌面端（Tauri + Rust）
```

## 构建

```bash
npm run build                    # 校验已打包运行时后执行 tsc && vite build
npm run build:sidecar            # 构建 Agent sidecar 二进制
npm run build:codebasememory     # 构建 codebase-memory 二进制
npm run build:tencentdb-memory   # 构建当前平台的 TencentDB MemoryCore/Knowledge 运行时
```

## 验证

```bash
npx tsc --noEmit
npm run test
```
