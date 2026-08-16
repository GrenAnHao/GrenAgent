# TencentDB 托管运行时切换实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框跟踪进度。

**目标：** 让 Tauri 自动托管打包 TencentDB，并立即停用旧记忆、知识库和 codebase-memory 运行链路。

**架构：** `MemoryRuntime` 在 setup 阶段启动 MemoryCore/MemoryKnowledge，并把子进程加入现有 `ProcessGuard`。sidecar 环境始终带 TencentDB 连接信息和旧能力关闭开关；旧扩展、MCP 默认注入、原生旧命令和旧 UI 入口从正常应用路径移除。

**技术栈：** Tauri 2、Rust、Tokio、React/TypeScript、Pi extension API、Vitest。

---

## 文件结构

- `tauri-agent/src-tauri/src/lib.rs`：应用启动、退出生命周期和 managed state。
- `tauri-agent/src-tauri/src/pi/guard.rs`：把 TencentDB 子进程纳入 OS 级回收。
- `tauri-agent/src-tauri/src/tencentdb/mod.rs`：运行时监督器与健康检查。
- `tauri-agent/src-tauri/src/commands/tencentdb.rs`：启动状态和 sidecar 环境。
- `tauri-agent/src-tauri/src/commands/agent.rs`：移除旧 code-intel 自动初始化。
- `extensions/index.ts`、`extensions/mcp/config.ts`：仅注册 TencentDB 记忆与知识 MCP。
- `tauri-agent/src/features/{layout,workspace,settings}`：移除旧记忆/知识/索引入口并保留 TencentDB 中心。

## 任务 1：运行时在应用启动时托管

**文件：** `src-tauri/src/lib.rs`、`src-tauri/src/tencentdb/mod.rs`、`src-tauri/src/pi/guard.rs`、`src-tauri/src/commands/tencentdb.rs`

- [ ] 为 `MemoryRuntime` 增加可选 `ProcessGuard`，每次 spawn 后立即 assign 两个子进程 PID。
- [ ] 增加 app-level ensure 启动函数，在 setup 注册 state 后异步启动 local runtime；remote 只发布状态。
- [ ] 关闭窗口与 Tauri exit 统一调用 stop，并保持 stop 幂等。
- [ ] 将 `cutover_env_for_app` 改为无条件旧能力关闭，不再读取 workspace marker。
- [ ] 添加 Rust 测试覆盖 guard 注册、启动状态和无 marker 硬切。

验证：`cargo test --manifest-path tauri-agent/src-tauri/Cargo.toml tencentdb -- --nocapture`

## 任务 2：移除旧 Pi 后端运行链路

**文件：** `extensions/index.ts`、`extensions/mcp/config.ts`、`commands/agent.rs`、旧 commands 注册处

- [ ] 从 extension registry 删除 `knowledge-rag`、`long-term-memory`、`code-intel` 的导入、导出和 named registration。
- [ ] 删除 codebase-memory 默认 MCP 注入分支，只保留用户明确配置的外部 MCP 与 TencentDB Knowledge MCP。
- [ ] 删除 workspace 打开后的 codebase-memory 自动 init。
- [ ] 从 Tauri invoke handler 移除旧 `knowledge`、`memory`、`code_intel` 命令注册，保留文件以便编译历史测试迁移。
- [ ] 保持 `session-memory` 和 `tencentdb-memory` 注册。

验证：Vitest 检查 registry 与 `injectDefaultServers`，并运行 Rust 编译。

## 任务 3：清理旧 UI 入口

**文件：** `moduleStore.ts`、`ModuleRail.tsx`、`ModuleContainer.tsx`、`App.tsx`、`WorkspaceTabs.tsx`、`settingsSchema.ts`

- [ ] 移除全局旧 memory 模块和 workspace knowledge tab，避免调用旧 API。
- [ ] 从 App/module container 删除旧面板分支与导入。
- [ ] 从设置 schema 删除旧 KB/MEMORY 配置字段，TencentDB 中心作为唯一入口。
- [ ] 移除 IndexPanel 的自动入口或将其明确标记为 TencentDB 资产中心，不得调用 `code_intel_*`。
- [ ] 更新相关测试，验证旧入口不存在、TencentDB 设置仍可访问。

验证：`bunx vitest run src/features/layout src/features/workspace src/features/settings src/features/tencentdb`；`bun run build`。

## 任务 4：真实运行验证与提交

- [ ] 清理本次测试生成的 `.playwright-cli` 产物。
- [ ] 运行定向 Rust/TypeScript 测试和前端构建。
- [ ] 启动 `bun run tauri dev`，确认启动日志有 MemoryCore/MemoryKnowledge health 200，打开工作区后 sidecar 仅出现 TencentDB 环境。
- [ ] 关闭应用并检查两个服务 PID 已退出。
- [ ] 仅提交本次相关文件，保留用户已有未提交修改。

