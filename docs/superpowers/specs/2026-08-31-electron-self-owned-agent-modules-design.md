# Electron 自研 Agent 模块替换 TencentDB 设计

日期：2026-08-31
状态：已确认，待实现

## 1. 目标与范围

Electron 版完全移除 TencentDB Agent Memory 的运行时、SDK、身份模型、Gateway 路由和 Panel 流程，改为本项目拥有的 TypeScript 模块。第一阶段只实现三类能力：

1. 代码检索：通过 CodeGraph Rust 索引器提供的 MCP 服务获取代码图查询结果。
2. LLM Wiki RAG：移植 TencentDB Agent Memory 的 Wiki/知识检索实现，但由本项目控制数据目录、任务和调用接口。
3. 记忆系统：移植 TencentDB 的 L0-L3 分层记忆流程，由 Pi 当前模型完成抽取与归纳。

Skill 资产和自定义 Agent 管理暂不实现，只留下稳定的 provider 接口和 Electron UI 占位，不得阻塞上述三项能力。

## 2. 已确认的约束

- 实现语言统一为 TypeScript，运行在 Electron 主进程、TypeScript Data Runtime 和 Pi 扩展中；Rust 不承担本项目业务核心。
- CodeGraph 的 Rust 解析、索引和 `.codegraph/codegraph.db` 由上游项目负责，本项目不重写解析器。
- Pi 扩展可以访问 `ctx.model` 和 `completeSimple`；Data Runtime 进程不能直接访问当前会话模型。
- 因此所有需要 LLM 的工作必须留在 Pi 扩展内，Data Runtime 只负责持久化、确定性检索、队列和 RPC。
- 新模块的数据作用域使用 `user`、`workspace`、`session`，不再要求 TencentDB 的 service/team/agent/user 身份链。
- 上游 TencentDB Agent Memory 与 CodeGraph 均为 MIT 许可；移植代码必须保留对应版权和 MIT 声明，并在源码目录记录来源、版本和本项目改动。

## 3. 目标架构

```text
Electron 主进程
 ├─ Agent Data Runtime（TypeScript 子进程）
 │   ├─ Memory Store：SQLite + Markdown
 │   ├─ Wiki Store：SQLite FTS5/BM25 + Markdown
 │   ├─ CodeGraph 元数据与查询缓存
 │   └─ loopback JSON-RPC
 ├─ Pi Sidecar
 │   └─ 内置扩展
 │       ├─ memory：ctx.model + Data Runtime RPC
 │       ├─ wiki-rag：ctx.model + Data Runtime RPC
 │       └─ codegraph：MCP client → CodeGraph Rust MCP 服务
 └─ Renderer：Electron IPC → 主进程 → Data Runtime
```

Data Runtime 是三个自研模块的存储所有者。Renderer 不直接访问 SQLite 或 CodeGraph 文件；Pi 扩展不直接写 Data Runtime 的数据库。所有跨进程访问使用带版本号的 JSON-RPC 契约、loopback 随机 token、超时和结构化错误。

## 4. 代码检索模块

模块建议命名为 `code-retrieval`，不再使用 `tencentdb` 前缀。

### 4.1 接入方式

内置 Pi 扩展启动或复用 CodeGraph MCP 子进程，使用其 stdio MCP 协议。项目只实现 MCP client/adapter、生命周期管理、请求超时、项目路径校验和结果格式化；CodeGraph 的 daemon、watcher、Rust kernel 和 SQLite 图数据库保持为外部依赖。

### 4.2 工具契约

首批工具与 CodeGraph MCP 对齐：

- `codegraph_explore`：自然语言或符号集合查询，返回相关源码、调用路径和影响摘要。
- `codegraph_node`：读取文件或单个符号，包含行号、签名和依赖提示。
- `codegraph_files`：返回索引文件树。
- `codegraph_callers` / `codegraph_callees`：查询调用关系。
- `codegraph_impact`：查询指定深度的影响范围。

未发现 `.codegraph/` 时返回可恢复提示并允许 Pi 使用原生文件工具，不自动执行 `codegraph init`。查询结果限制输入长度、输出字符数和路径范围，避免把大型源码一次性注入上下文。

### 4.3 Electron 接口

Electron IPC 暴露项目无关的 `codeRetrieval.*` API（索引状态、查询、同步、删除缓存）。现有 `tencentdbApi` 中的 CodeGraph 类型和调用点迁移到该接口，UI 不再拼接 `/v3/*` 路由。

## 5. LLM Wiki RAG 模块

模块建议命名为 `wiki-rag`。

### 5.1 数据与索引

- 工作区源码、Markdown、配置和 Git 元数据作为输入。
- 分块保留相对路径、标题、起止行号、内容哈希和更新时间。
- Markdown Wiki 页面是人工可读的事实源；SQLite FTS5/BM25 保存可重建索引和块元数据。
- Embedding 不是第一阶段的必需依赖，检索接口预留可选向量排序器。

### 5.2 LLM 工作流

Wiki 同步由 Pi 扩展发起，扩展使用当前 `ctx.model` 生成页面摘要、主题归纳和页面链接，然后把结果及引用写入 Data Runtime。生成失败时保留旧页面和索引状态，返回结构化错误，不阻塞聊天。

### 5.3 接口

Data Runtime 提供 `wiki.sync`、`wiki.list`、`wiki.read`、`wiki.search`、`wiki.status`；扩展注册同名或语义一致的 Pi 工具。每条搜索结果必须带 workspace、source path 和行号引用，以便回到原文核查。

## 6. 记忆系统

模块建议命名为 `memory`，替换现有 `extensions/tencentdb-memory`。

### 6.1 分层数据模型

- L0：会话原文和必要的工具输出摘要。
- L1：当前模型抽取的原子事实、偏好、约束和事件。
- L2：模型归纳的场景 Markdown，保留到 L1/L0 的引用。
- L3：用户偏好和工作方式画像，保留到场景的导航引用。

SQLite 保存结构化字段、全文索引和引用元数据；Markdown 保存 L2/L3 的可读内容。每层均可单独重建，生成失败不得破坏较低层证据。

### 6.2 Pi 钩子与模型复用

- `before_agent_start`：根据当前 prompt 召回 L1/L2/L3，按字符预算构造可识别的上下文注入。
- `agent_end`：捕获本轮新增 L0，进入按 session 串行的异步队列。
- 队列任务在 Pi 扩展中调用共享 `askLlm`，模型解析优先使用 `ctx.model`，不读取独立 TencentDB/Memory API Key。
- 模型输出使用容错 JSON/Markdown 解析；空输出、超时或调用失败时保留旧状态。

### 6.3 工具与作用域

注册 `memory_search`、`conversation_search` 和受控的 `memory_rebuild`。默认作用域为当前用户和工作区，可显式限定 session；不得要求 service/team/agent 元数据。所有自动捕获必须幂等，使用 session cursor 和 transcript fingerprint 防止重复写入。

## 7. Data Runtime 与存储边界

Data Runtime 由 Electron 启动、监控和关闭。它提供：

- 版本化 JSON-RPC 方法路由；
- Memory、Wiki、CodeGraph 三套独立 schema/迁移版本；
- SQLite 写入串行队列和读取超时；
- 文件路径边界检查、原子写入和备份入口；
- 结构化健康状态和日志。

建议数据目录为 Electron `userData/agent-data/`：`memory/`、`wiki/`、`code-retrieval/` 分开保存。运行时不得读取或写入 TencentDB 目录，也不得暴露 TencentDB 环境变量。

## 8. 迁移与淘汰顺序

1. 建立 `agent-data` 包、RPC 契约、存储迁移器和测试夹具。
2. 将现有 TencentDB memory 钩子迁移到自研 `memory`，先保持工具语义和注入行为。
3. 接入 CodeGraph MCP adapter，切换 Electron UI 和工作区上下文调用。
4. 移植 Wiki RAG 的扫描、分块、Markdown 和 FTS5 检索，接入当前模型生成页面。
5. 提供一次性旧数据导入/导出工具；导入失败不得覆盖新数据。
6. 删除 TencentDB Core/Knowledge/Panel runtime、SDK、构建脚本、凭据存储、`/v3/*` 调用和旧设置页面。
7. 增加 SkillProvider、AgentProvider 空实现和占位 UI，留待后续独立设计。

迁移期间允许保留只读兼容诊断，但生产启动路径不能再启动 TencentDB 进程或向其发送请求。

## 9. 错误处理与安全

- RPC 只监听 loopback，并要求每次启动生成的随机 token；请求包含方法版本和 request id。
- 所有路径相对于已验证的 workspace/data root 解析，拒绝目录穿越和系统敏感路径。
- CodeGraph、Wiki 和 Memory 的失败彼此隔离；检索失败返回空结果和诊断信息，不中断主对话。
- LLM 任务设置 AbortSignal、超时和最大输入/输出长度；不记录 API Key 或完整敏感 prompt。
- UI 展示来源、更新时间和失败状态，不把错误字符串当作可执行指令。

## 10. 测试与验收

### 10.1 单元和契约测试

- Memory L0 cursor/fingerprint、L1-L3 解析、召回预算和降级路径。
- Wiki 分块、引用行号、FTS5 搜索、原子写入和失败保留旧版本。
- CodeGraph MCP 请求映射、超时、无索引提示和路径校验。
- Data Runtime RPC schema、鉴权、迁移、并发写入和进程重启。
- Electron IPC 与 Pi 扩展钩子的集成测试。

### 10.2 功能验收

在不安装、不启动任何 TencentDB 运行时的环境中：

- 一轮对话能被捕获为 L0，并由当前 Pi 模型生成可检索的 L1；
- 新 prompt 能召回记忆并按预算注入；
- 已初始化的 CodeGraph 项目可完成六类 MCP 查询；
- Wiki 可同步、读取、全文检索并显示源文件引用；
- Skill/Agent 占位页面不阻塞聊天和设置加载。

## 11. 来源与许可记录

移植 TencentDB Agent Memory 的记忆/Wiki 管线时，在对应目录附带 Tencent MIT License、来源仓库 URL、上游 commit/tag 和改动说明。CodeGraph adapter 及任何复制的协议/格式化代码同样附带 CodeGraph MIT License 和版权声明。未明确属于 MIT 代码的依赖只可参考行为，不直接复制实现，需单独核对许可证。

