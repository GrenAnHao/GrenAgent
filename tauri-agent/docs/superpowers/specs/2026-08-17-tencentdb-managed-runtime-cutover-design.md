# TencentDB 托管运行时与全面切换设计

## 目标

应用使用随安装包分发的 Node.js、MemoryCore 和 MemoryKnowledge。Tauri 启动时自动启动本机运行时并等待健康检查；退出或异常时由进程守卫回收子进程。Pi 只使用 TencentDB SDK 与 MemoryKnowledge MCP。

## 切换边界

- `local` 模式启动并监督两个回环服务；`remote` 模式只连接配置的 HTTPS Gateway。
- `tencentdb-memory` 是唯一长期记忆实现。
- `knowledge-rag`、`long-term-memory`、`codebase-memory` 不再注册、注入或自动初始化。
- 旧 SQLite、旧索引和迁移向导不属于运行时路径；本开发阶段不读取、不迁移、不回退。
- `session-memory` 仍保留，因为它管理会话短期状态，不与 TencentDB 长期记忆重叠。
- UI 中原“记忆/知识库/代码索引”入口统一指向 TencentDB 个人中心或直接移除，不能继续调用旧命令。

## 生命周期

`setup` 创建 `MemoryRuntime` 与 OS 进程守卫，异步确保当前配置对应的运行时就绪。工作区打开只消费已准备好的端点，保留幂等启动作为启动失败后的重试路径。关闭窗口和 Tauri 退出事件先停止 Pi，再停止 MemoryCore/MemoryKnowledge；每个子进程创建后立即加入进程守卫。

本机运行时启动失败时，状态为 `failed` 并在 TencentDB 设置中可见；Pi 不会偷偷回退到旧后端。远程模式不创建本地子进程，连接错误只反映为远程状态失败。

## Pi 环境

每个 sidecar 获得 TencentDB endpoint、API key、稳定身份坐标和 Knowledge endpoint。始终注入旧能力关闭开关，且强制 `CODE_INTEL=off`；不依赖迁移 marker。MemoryKnowledge MCP 由打包 Node runtime 通过 stdio 启动。

## 测试验收

- Rust 单测覆盖运行时根目录、健康检查地址、配置模式和子进程守卫注册。
- TypeScript 单测确认扩展列表和 MCP 默认配置不包含三个旧后端。
- 前端单测确认旧模块/索引入口不再渲染或调用旧命令，TencentDB 中心仍可打开。
- `cargo test`、定向 Vitest、前端构建和真实 `tauri dev` 均通过；日志必须显示两个本机服务健康且退出后无残留进程。
