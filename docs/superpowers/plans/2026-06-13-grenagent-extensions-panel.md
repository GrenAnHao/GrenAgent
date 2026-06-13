# GrenAgent「扩展」面板（MCP + Skills 管理）实现计划

- 日期：2026-06-13
- 来源：用户 GUI 反馈（A5 之后）
- 目标：把 MCP 从「连接」面板抽出，新建独立「扩展」侧边栏模块（plug 图标），统一管理 **MCP servers**（实时状态 + 主动刷新）与 **skills**（每个可启用/禁用）。

## 关键发现（已验证）

1. **模块系统**：`ModuleRail`（MODULES 数组 + plug 图标当前给 connections）→ `moduleStore.ModuleId`（持久化）→ `ModuleContainer`（switch 渲染面板）。加模块 = 改这三处 + 新面板。
2. **skills = pi 命令的一种**（`apiSource:'skill'`），从目录加载（`loadSkillsFromDir`，扫 `SKILL.md`/`.md`），`/skill:name` 调用。`Skill = { name, description, filePath, baseDir, disableModelInvocation }`。
3. **pi 无运行时按名 toggle 单个 skill**；但 `DefaultResourceLoaderOptions.skillsOverride?: (base:{skills,diagnostics}) => {skills,diagnostics}` **已验证存在**，`createAgentSessionServices({ resourceLoaderOptions })` 接受它 → 可在自建 runtime 里过滤禁用 skills。**无需改 pi 源码。**
4. **A3 现状**：`cli/main.ts` 用 `main(argv,{extensionFactories})`（为子代理 print 模式）。要过滤 skills 需自建 runtime（`createAgentSessionServices` + `skillsOverride`）+ `runRpcMode`。→ **混合 runtime**：rpc 用自建 runtime（可过滤 skills），print/其他用 `main`。
5. **MCP 状态**：A5 用 `setStatus("mcp", JSON)` 在 session_start 推送 → `mcpStatusStore` → 面板。"待连接"= 未对话时 store 空。
6. **skills 列表来源**：前端 `pi.getCommands` 已返回含 `apiSource:'skill'` 的命令，可直接列。

## 方案

### 后端
- **cli/main.ts 混合 runtime**：
  - 解析 argv 判断模式（复用 A3 思路）。
  - **rpc 模式**：`createAgentSessionServices({ resourceLoaderOptions:{ extensionFactories: allExtensions, skillsOverride } })` → `createAgentSessionFromServices` → `runRpcMode`。`skillsOverride` 读 `SKILLS_DISABLED`（逗号分隔名单）过滤。
  - **print 模式**（子代理）：维持 `main(argv,{extensionFactories})`（A3，子代理不需 skills 过滤）。
- 验证：rpc 连接不回归、print 子代理仍 6.6s、`SKILLS_DISABLED` 生效。

### 前端
- **新模块** `extensions`（plug 图标）：`moduleStore.ModuleId` 加 `extensions`；`ModuleRail` 加项（plug）+ `connections` 换图标（如 `Webhook`/`Radio`）；`ModuleContainer` 加 case → `ExtensionsPanel`。
- **ExtensionsPanel**：
  - **MCP 区**：从 ConnectionsPanel 迁移（编辑 `MCP_SERVERS` + 实时状态 ●已连/工具数/○失败）+ 主动刷新说明/按钮。
  - **Skills 区**：`pi.getCommands` 筛 `apiSource:'skill'` 列出（名称+描述）；每个一个开关；禁用写入 `SKILLS_DISABLED`（settings，保存+重启生效）。
- **ConnectionsPanel**：移除 MCP 区（回归纯 IM 网关）。
- **settings**：`SKILLS_DISABLED` 字段（隐藏/由扩展面板管理）。

## 任务拆解

- [ ] **任务 1**：cli/main.ts 混合 runtime（rpc 自建 runtime + `skillsOverride` 读 `SKILLS_DISABLED`；print 用 main）+ 重建验证（rpc 不回归、print 子代理 OK、skills 过滤生效）
- [ ] **任务 2**：前端新模块骨架（moduleStore `extensions` + ModuleRail plug + connections 换图标 + ModuleContainer + 空 ExtensionsPanel）+ 测试
- [ ] **任务 3**：MCP 区迁移到 ExtensionsPanel（含实时状态）+ ConnectionsPanel 移除 MCP + 测试
- [ ] **任务 4**：Skills 区（列出 `apiSource:'skill'` + 每个开关 → `SKILLS_DISABLED`）+ 测试
- [ ] **任务 5**：MCP 主动刷新（ExtensionsPanel 挂载/按钮触发状态刷新；评估最简机制）
- [ ] **任务 6**：重建 + 端到端冒烟（扩展模块显示、MCP 状态、skill 禁用生效）

## 风险

- **混合 runtime 不能破坏 A3 的 print 子代理**（任务 1 必须同时验证 rpc + print）。
- skills toggle 是**保存 + 重启生效**（pi 无即时 toggle），UI 需明示（像 IM 网关「保存并重启」）。
- MCP 主动刷新若需新 RPC 通道则成本高；MVP 可先「发起对话后更新 + 手动刷新提示」。

## 非目标（YAGNI）
- 不改 pi 源码（用 `skillsOverride`）。
- 不做 skills 的即时（无重启）toggle。
- 不做 MCP OAuth / 远程状态轮询。
