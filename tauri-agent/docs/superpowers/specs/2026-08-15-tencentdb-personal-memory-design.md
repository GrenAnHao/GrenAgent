# TencentDB 个人记忆空间设计

## 目标

将 `tauri-agent` 现有的长期记忆、知识检索、代码索引和本地 Skill 能力迁移至 TencentDB Agent Memory，建立一个以个人为中心、可在多台设备间使用同一知识记忆空间的原生体验。

第一阶段覆盖 Chat Memory、Skill、Wiki、CodeGraph 和 Agent 装备；不实现成员、角色、ACL、任务、系统管理员或 API Key 管理界面。底层身份和资产模型保持 TencentDB v3 兼容，为后续团队控制面预留接口。

## 非目标

- 不嵌入或 WebView 承载官方 Memory Hub。
- 不在第一阶段实现团队成员、角色、ACL、任务和账号管理。
- 不做本地与远程 Gateway 双写、双向数据库同步或自动把个人记忆发布到团队。
- 不迁移 Pi `session-memory` 的短期工作状态。

## 统一身份与连接

每个个人记忆空间使用稳定身份坐标：

```text
serviceId: personal-memory
teamId:    personal:<account-id>
userId:    <account-id>
agentId:   pi-personal | coding | research
sessionId: Pi session ID
taskId:    可选；使用 Git remote URL 或项目 UUID，不能使用本机绝对路径
```

所有设备使用同一 `account-id` 和同一远程记忆空间时，L0--L3、Skill、Wiki、CodeGraph 即可跨设备读取。`sessionId` 保持每个 Pi 会话独立。

连接由一个抽象的个人记忆空间配置管理，Pi extension 只通过 TencentDB TypeScript SDK 与 Gateway 通信，不直接访问任何 TencentDB 或旧本地记忆数据库文件。

| 模式 | Gateway 生命周期 | 数据真源 |
| --- | --- | --- |
| `local` | Tauri 后端启动、健康检查并停止本机 MemoryCore | 本机 Gateway |
| `remote` | 客户端只连接个人 NAS/VPS 上的 HTTPS Gateway | 远程 Gateway |

两种模式互斥。跨设备同步使用 `remote`；`local` 用于离线、试用或隔离。后续离线能力应设计为远程真源加本地待上传队列，不能做数据库层双向同步。

凭据由 Tauri 后端存放和注入。前端只能获取脱敏后的连接配置和状态；Pi sidecar 只获取当前运行所需的最小配置。

## Pi 运行时集成

保留 `extensions/session-memory`。它维护压缩后会话的短期工作状态，不与 TencentDB 的长期记忆重叠。

| 现有能力 | 第一阶段处理 | 替代能力 |
| --- | --- | --- |
| `long-term-memory` | 移除 | `tencentdb-memory` Pi extension，通过 SDK 操作 L0--L3 |
| `knowledge-rag` | 移除 | TencentDB Wiki 与 CodeGraph |
| `codebase-memory-mcp` | 移除 | TencentDB MemoryKnowledge MCP |
| 本地记忆工具 | 移除或替换 | TencentDB L1/L0 查询工具 |
| 本地 Pi Skills | 受控缓存 | TencentDB Skill 同步出的 Pi `SKILL.md` 与资源 |

新的 `tencentdb-memory` extension 使用 Pi 生命周期：

1. 在 `before_agent_start` 并行召回 L1、L2、L3。L3 拼接进该轮 `systemPrompt`，L1 作为有明确边界的自定义消息注入。
2. 在 `agent_end` 使用回合游标或消息指纹，只异步上传本轮新增 user/assistant 内容到 L0。不得重传完整会话历史。
3. 暴露按需查询 L1 与 L0 的工具，不暴露后端数据库细节。
4. Gateway 失败时记录可见状态并跳过本轮召回或写入；不回退到旧本地记忆，避免双后端分叉。

Wiki 和 CodeGraph 经现有 MCP 扩展连接 TencentDB MemoryKnowledge stdio MCP Server。Skill 由 Tauri 按当前 `agentId` 查询已装备资产，安全地缓存为 Pi 可加载资源；版本变更后增加 `PI_RELOAD_REV`，让 sidecar 重载资源。

## 原生个人记忆中心

不复刻官方 Web 样式，而是在现有 Tauri 导航和设置体系中提供功能等价的个人模式体验。

### 设置：个人记忆空间

- 切换 `local` / `remote`，编辑端点、身份和凭据引用。
- 测试连接，显示 Gateway 健康、版本、本地数据目录和脱敏凭据状态。
- 远程模式显示最近成功连接时间；本地模式显示进程状态。

### 资产管理

- Chat Memory：按项目和 Agent 浏览 L0--L3、检索、查看来源会话、删除或清空。
- Skills：浏览版本和资源、查看同步状态、启停与手动刷新 Pi 缓存。
- Wiki：导入来源、查看构建状态、检索和阅读页面。
- CodeGraph：导入仓库、查看索引状态、符号搜索、调用关系和影响分析。

### Agent 装备与运行状态

- 为个人 Agent 选择可用 Skill、Wiki 与 CodeGraph 资产。
- 装备修改立即同步：Skill 触发 Pi 资源重载，知识工具通过 MCP 连接状态生效。
- 状态栏显示 Gateway 在线、资源同步以及 MCP 已连接或失败。
- 远程不可用时可以显示本地缓存的元数据，但不得显示为已同步，也不得伪造远程检索成功。

## 迁移与切换

迁移遵循“导入或重建，验证后停用”的单向流程。旧数据在验证成功前只读保留，不自动物理删除。

| 现有数据 | 目标 | 迁移方式 |
| --- | --- | --- |
| 项目/全局 `long-term-memory` SQLite | Chat Memory L1 | 导入为带来源标记的记忆，先给出预览和数量统计 |
| Pi 会话 JSONL | Chat Memory L0 | 按用户选择批量导入，由 TencentDB 后台提炼 L1--L3 |
| 本地 `SKILL.md` 与资源 | TencentDB Skill | 导入为个人 Skill，保留版本和资源清单 |
| `knowledge-rag` 文档来源 | Wiki | 重新导入原始文档并重建 |
| `codebase-memory` 索引 | CodeGraph | 从原始 Git 仓库重建，不迁移二进制索引 |
| `session-memory` 文件 | 本地状态 | 保留，不迁移 |

切换向导分为四步：

1. 扫描：只读发现来源、数量、体积和缺失的原始文件。
2. 预览：选择资产和目标空间，明确冲突与不能自动迁移的项。
3. 执行：按资产类型记录迁移批次、源 ID、目标 ID、结果与失败原因，支持重试。
4. 验证与停用：核对数量、抽样检索、Gateway 健康和 Pi 实际召回；全部通过后才禁用旧扩展。

知识和代码索引均是可再生缓存，必须从原始文档或仓库重建。原始来源缺失时向导必须显示为需要人工处理，不能静默跳过。

## 错误处理与安全

- 远程 Gateway 必须置于 HTTPS、私有网络或认证代理之后。
- 客户端不得持有可任意访问全部资产的共享管理员凭据。
- 所有迁移操作可追踪、可重试；源数据在用户明确删除前保留。
- 连接、同步、MCP 和资产加载的失败状态均应在原生界面中可见。

## 验收标准

1. 单设备可在 `local` 模式下完成 L0--L3、Skill、Wiki、CodeGraph 的使用和管理。
2. 两台设备连接同一个 `remote` 个人空间时，一台设备写入的 Chat Memory、Skill、Wiki 和 CodeGraph 在另一台设备可见并可被 Pi 使用。
3. 单轮不会重复上传历史消息，断网也不会启用旧本地长期记忆作为隐式回退。
4. 已装备 Skill 会以 Pi Skill 资源形式生效，Wiki 和 CodeGraph MCP 工具可调用。
5. 迁移向导不会在验证完成前删除任一旧数据源。
6. 现有 `session-memory` 继续在压缩后重锚会话状态。

## 后续阶段：团队控制面

后续如需团队协作，新增账号、成员、角色、ACL、任务、API Key 和资产发布流程。第一阶段的 `teamId`、`agentId`、`userId`、资产绑定与 SDK 边界保持不变，因此不需要重写 Pi 生命周期或个人记忆空间实现。
