# Electron Agent Data 管理面板设计

日期：2026-08-31  
状态：视觉方案已确认，待实现

## 1. 目标

把当前 Agent Data UI 空白入口替换为可操作的 Electron 管理中心。面板必须直接呈现自研 Runtime 的真实状态和数据，不再显示抽象说明或伪造的第三方流程。

第一阶段覆盖：

- Runtime 总览与健康状态；
- 任务列表、进度、详情和取消；
- Memory L0-L3 浏览、筛选、引用链和重建入口；
- Wiki 页面、来源引用、搜索和工作区同步；
- CodeGraph 索引状态、快速检索和图谱入口；
- 审计事件与脱敏诊断入口。

Skill 和自定义 Agent 继续只保留导航/接口扩展位置，不在本次实现具体资产管理。

## 2. 已确认的视觉方案

采用“固定模块栏 + Agent 数据二级导航 + 单一工作区”的组合布局：

```text
┌ 56px 模块栏 ┬ 210px Agent 数据导航 ┬──────────────────────────────┐
│ 对话        │ 概览                  │ 页面标题       刷新  新建任务 │
│ 连接        │ 任务                  │ Runtime 状态                  │
│ 扩展        │ Memory                │ KPI / 状态卡 / 任务表         │
│ 用量        │ Wiki RAG              │ 当前模块工作台                │
│ Agent 数据  │ CodeGraph             │                              │
│ 设置        │ 审计与诊断            │                              │
└─────────────┴───────────────────────┴──────────────────────────────┘
```

视觉约定沿用 Electron 现有 UI：Ant Design token、深色背景、细边框、8px 卡片圆角、紧凑表格和明确的选中态。页面不使用营销式大标题、渐变背景或嵌套卡片；操作按钮使用现有图标和文字组合，危险操作必须有确认。

概览是默认入口，显示四个 KPI（记忆条目、Wiki 页面、CodeGraph 节点、运行任务）、模块健康状态、最近任务和最近活动。二级导航切换时保留主应用模块栏和页面头部，不卸载聊天模块状态。

## 3. 页面与组件

### 3.1 AgentDataCenter

职责：加载 Runtime 状态和任务摘要，渲染二级导航与页面头部，统一处理刷新、加载失败和空状态。

状态：`loading`、`ready`、`failed`、`closed`。Runtime 未启动时提供“启动 Runtime”动作；刷新失败时保留上一次成功数据并显示错误提示。

### 3.2 JobsPanel

提供任务搜索、状态筛选、进度条、创建、详情和取消。任务行必须显示任务类型、工作区、进度、状态和更新时间；运行中任务允许取消，已完成/失败任务允许查看结构化错误和审计记录。取消后立即刷新行状态，不假设任务已经完成。

### 3.3 MemoryPanel

默认展示记忆条目表格，支持层级筛选（L0/L1/L2/L3）、workspace/session 作用域和文本搜索。每行显示内容、作用域、更新时间和引用来源；详情抽屉展示引用链。提供“重建层级”和“删除条目”入口，操作返回 job id 或明确结果并刷新列表。

### 3.4 WikiPanel

展示当前工作区页面列表，包含标题、摘要、来源路径、分块数、索引时间和状态。支持全文搜索、打开页面详情、查看源码行号引用、同步工作区和删除页面。同步为后台任务，显示进度和失败原因，不阻塞页面。

### 3.5 CodeRetrievalPanel

展示当前工作区 CodeGraph MCP 连接和索引状态（未初始化、索引中、就绪、待同步、失败），显示文件/节点/边统计。提供同步、重建、打开图谱和快速检索入口；检索结果显示符号、文件、行号和关系类型。无 `.codegraph/` 时显示可恢复提示，不自动修改工作区。

### 3.6 AuditDiagnosticsPanel

以只读表格展示管理操作、操作者、目标、结果和时间；诊断区展示 Runtime、数据库迁移、磁盘占用、模块健康和最近错误。敏感字段必须脱敏，支持复制诊断摘要但不暴露 token 或 API key。

## 4. 数据流与接口

Renderer 只调用 `src/lib/agentData.ts` 的类型化 API，不拼接 JSON-RPC、不读取 SQLite、不直接启动 CodeGraph。

首批 API 映射：

- `agentDataApi.status()` → Runtime 状态和版本；
- `agentDataApi.jobs.list/get/cancel()` → 任务工作台；
- `agentDataApi.config.get/update()` → 后续模块设置入口；
- `agentDataApi.audit()`、`diagnostics()` → 审计与诊断；
- `agentDataApi.export/import()` → 后续数据管理入口；
- 新增模块专属查询函数时保持 `memory.*`、`wiki.*`、`codeRetrieval.*` 命名，不引入旧供应商名称。

长任务统一返回 job id。面板使用轮询或事件订阅刷新任务，不在 Renderer 中实现定时写入或重试 Runtime 的逻辑。

## 5. 错误、空态和安全

- 首次加载显示骨架或居中的加载状态，禁止把“加载中”当作空数据；
- 无数据时显示模块相关的空态和下一步动作；
- Runtime 关闭或连接失败时显示可重试操作和错误摘要；
- 删除、重建、导入和取消均需确认，并在完成后刷新审计列表；
- 所有用户可见路径限制在当前工作区边界内；
- 错误文本不得包含 Runtime token、环境变量值或完整敏感请求。

## 6. 测试范围

- AgentDataCenter：首次加载、刷新失败、Runtime closed、导航切换；
- JobsPanel：状态筛选、进度显示、取消成功/失败、错误详情；
- MemoryPanel：层级/作用域筛选、引用链展示、重建和删除确认；
- WikiPanel：搜索、来源路径、同步进度、失败保留旧页面；
- CodeRetrievalPanel：索引状态映射、无索引提示、检索结果和同步动作；
- AuditDiagnosticsPanel：脱敏字段和空态；
- Electron IPC：每个面板动作映射到正确的 `agentData_admin_*` 或模块 API；
- 构建验证：Electron TypeScript、Vite 构建和相关 Vitest 测试。

不在本次范围内：完整图谱画布迁移、后台任务执行器、独立 Runtime 子进程改造、Skill/Agent 资产实现。

## 7. 实现边界

本设计只约束 Renderer 视觉和交互，不改变已经通过测试的 Memory、Wiki RAG、CodeGraph MCP 和 Runtime 存储协议。需要新增后端查询能力时，先扩展类型化 IPC 与 Runtime 方法，再接入组件；不在组件内绕过边界读取数据库或调用 MCP。
