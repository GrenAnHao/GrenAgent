# TencentDB 托管运行时与全面切换设计

## 目标

应用使用随安装包分发的 Node.js、MemoryCore 和 MemoryKnowledge。Tauri 启动时自动启动本机运行时并等待健康检查；退出或异常时由进程守卫回收子进程。Pi 只使用 TencentDB SDK 与 MemoryKnowledge MCP。

## 切换边界

- `local` 模式启动并监督两个回环服务；`remote` 模式只连接配置的 HTTPS Gateway。
- `tencentdb-memory` 是唯一长期记忆实现。
- `knowledge-rag`、`long-term-memory`、`codebase-memory` 不再注册、注入或自动初始化。
- 旧 SQLite、旧索引和迁移向导不属于运行时路径；本开发阶段不读取、不迁移、不回退，也不提供兼容开关。
- `session-memory` 仍保留，因为它管理会话短期状态，不与 TencentDB 长期记忆重叠。
- UI 中原“记忆/知识库/代码索引”入口统一由 TencentDB 个人中心提供，不能继续调用旧命令。
- 个人中心必须接入真实的 Chat Memory、Skill、Wiki、CodeGraph 管理接口；静态能力说明不算实现。

## 管理面与本机工作区

前端不直接持有 Gateway 或用户密钥。Tauri 为 Core 提供精确路由白名单代理，为 Knowledge 提供 Wiki/CodeGraph 类型化命令；两者都由 Rust 注入 Bearer、`x-tdai-service-id` 与当前 `x-tdai-user-key`，并强制覆盖当前身份坐标。

本机模式从随机 Gateway 密钥单向派生符合 TencentDB 格式的 User Key，首次启动通过仅回环可达的内部管理路由创建固定单用户身份 `local / personal-local / pi-personal`，后续启动验证三者一致性。Local 保存入口在写入凭据或配置前拒绝其他身份坐标；团队或跨设备身份由 remote 模式连接的服务管理。远程模式由用户分别配置 Gateway API Key 和 TencentDB User Key；两项密钥只写入系统凭据库，不进入前端状态或配置文件。

本机 CodeGraph 通过显式“登记工作区”建立索引。Tauri 将规范化路径写入应用数据目录的 allow-list，Knowledge LocalSourceFetcher 每次 fetch/sync 重新读取 allow-list，只能复制登记目录；不会接受任意 `file://` 路径或网络路径。远程模式仍只接受上游 Git fetcher 支持的 HTTPS 仓库。

## 生命周期

`setup` 创建 `MemoryRuntime` 与 OS 进程守卫，异步确保当前配置对应的运行时就绪。工作区打开只消费已准备好的端点，保留幂等启动作为启动失败后的重试路径。关闭窗口和 Tauri 退出事件先停止 Pi，再停止 MemoryCore/MemoryKnowledge；每个子进程创建后立即加入进程守卫。

本机运行时启动失败时，状态为 `failed` 并在 TencentDB 设置中可见；Pi 不会偷偷回退到旧后端。远程模式不创建本地子进程，连接错误只反映为远程状态失败。

## Pi 环境

Tauri 在启动 sidecar 时提供 TencentDB 连接信息；sidecar 入口随即把 Gateway API Key 和 User Key 捕获到模块私有内存，并在加载 Agent 工具前从 `process.env` 删除。内置记忆与 Skill 客户端通过私有配置读取密钥，通用配置快照和工具子进程不可见；MemoryKnowledge MCP 只显式获得它需要的 `KNOWLEDGE_API_TOKEN` 与 `KNOWLEDGE_USER_KEY`。非敏感 endpoint、身份坐标、旧能力关闭开关和 `CODE_INTEL=off` 仍按进程配置注入，不依赖迁移 marker。

## 测试验收

- Rust 单测覆盖运行时根目录、健康检查地址、配置模式和子进程守卫注册。
- TypeScript 单测确认扩展列表和 MCP 默认配置不包含三个旧后端。
- TypeScript 单测确认 TencentDB 密钥从工具子进程环境移除，且仅显式传给 Knowledge MCP。
- 前端单测确认旧模块/索引入口不再渲染或调用旧命令，TencentDB 中心可以真实列出、创建、同步和删除四类资产。
- Rust 与前端单测确认 Local 固定单用户身份，Remote 身份字段仍可编辑。
- Knowledge 单测覆盖 service-id header、allow-list LocalSourceFetcher 和本地同步不破坏源目录。
- `cargo test`、定向 Vitest、前端构建和真实 `tauri dev` 均通过；日志必须显示两个本机服务健康且退出后无残留进程。
