# grenagent-app

GrenAgent 桌面应用：React 19 + TypeScript + Vite 前端，Tauri 2 与 Rust 后端。项目整体介绍见仓库根目录的 [README](../README.md)，架构与开发细节见 [架构文档](../docs/architecture.md) 与 [开发指南](../docs/development.md)。

## 开发

```bash
bun install
bun run build:tencentdb-memory   # 首次运行或上游版本更新后执行
bun run dev                      # 前端开发服务器
bun run tauri dev                # 桌面端（Tauri + Rust，自动托管 TencentDB）
```

本机模式无需单独启动服务或配置 TencentDB User Key，并使用固定单用户身份。远程模式支持填写服务端已有的 Team、Agent 和 User 身份，同时需要 Gateway API Key 与 User Key；密钥只写入系统凭据库，Agent 工具子进程不会继承它们。

应用启动时会托管随安装包分发的 MemoryCore、MemoryKnowledge 和 MemoryPanel。连接设置中的「打开原生后台」会通过系统默认浏览器打开原生 MemoryPanel；应用只返回回环地址和一次性短时 bootstrap token，User Key 不进入 URL、浏览器历史或普通日志。Local 模式先启动本机 Core/Knowledge，再启动 Panel；Remote 模式只启动 Panel 并连接配置的远程服务。

## 构建

```bash
bun run build                    # 校验已打包运行时后执行 tsc && vite build
bun run build:sidecar            # 构建 Agent sidecar 二进制
bun run build:tencentdb-memory   # 构建当前平台的 TencentDB MemoryCore/Knowledge 运行时
```

## 验证

```bash
bunx tsc --noEmit
bun run test
node --test scripts/tencentdb-runtime-patches.node-test.mjs
```
