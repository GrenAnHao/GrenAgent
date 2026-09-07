# AgentData 扩展接入修复计划

> 执行方式：当前会话内按任务分工，先复现、后修复，并做规格与代码审查。保留现有未提交修改，不自动提交。

**目标：** 使 Electron 对话能实际加载并调用 AgentData 的记忆、Wiki 和代码检索扩展，验证真实 RPC 与存储行为。

**架构：** 使用现有 PluginManager / manifest 白名单，不增加不受管理的工具例外。记忆和 Wiki 使用 AgentData RPC；Wiki 正文按用户确认的设计导出并保存为 Markdown，SQLite 保留索引和状态；代码检索通过受限 RPC 复用主进程 CodeGraph 实例池。保留 Pi 会话 JSONL、既有数据及项目/全局作用域规则。

**技术栈：** TypeScript、Pi SDK、Node TCP JSONL RPC、SQLite、Vitest、node:test。

## 范围与取舍

- 采用正式插件注册；不使用“放行所有无 manifest 扩展”的方案。
- 复用后台任务和 CodeGraph 池；Wiki 文件主存储与兼容迁移按 `../specs/2026-09-05-agent-data-markdown-wiki-design.md` 执行。
- 只修复可复现的链路断点。没有索引时报告不可用，不自动运行索引创建或安装 CLI。
- 自动记忆必须尊重现有开关及子代理隔离；数据查询默认当前项目与已有全局记忆，不扩大跨项目范围。
- 不改无关 UI、权限模型、会话标题方案，不读取真实凭据，不发付费模型请求。

## 任务 1：托管扩展清单

文件：`extensions/index.ts`、相关扩展的轻量 manifest、`electron-agent/electron/app/plugin/builtinPlugins.ts`、`electron-agent/electron/main.ts`、`cli/src/agent-data-plugins.test.ts`。

- [x] 用真实 `manifestExtensions` 与 `filterManagedExtensions` 编写回归，确认默认 Electron 注册列表不能加载 `memory` / `wiki-rag` / `code-retrieval`。
- [x] 给三个扩展补正式 manifest，并将主进程内置插件定义抽出为可测试模块。
- [x] 对比两端 manifest；`PluginManager.startAll()` 后真实过滤结果包含这三项，停止一项后该项不再加载。
- [x] 锁定 `code-exec` 等无关扩展仍被过滤，空白名单仍只保留现有基础服务。

验证：在 `cli` 运行 `node --import tsx --test src/agent-data-plugins.test.ts src/extension-profile.test.ts`。

## 任务 2：记忆自动交互

文件：`extensions/memory/index.ts`、`extensions/memory/capture.ts`、对应测试；经复现后修复 `electron-agent/electron/app/memoryService.ts`、`electron-agent/electron/pi/systemWorkerManager.ts` 的相关断点。

- [x] 使用真实 SDK 事件形状验证 `agent_end.messages` 的单轮语义，避免将单轮数据误当累积会话。
- [x] 验证并修复 `MEMORY_AUTO_INJECT` / `MEMORY_AUTO_CAPTURE` / `MEMORY_EXTRACT` 和子代理隔离。
- [x] 用确定性测试验证捕获、去重、后台提炼、失败重试，以及 L1 项目范围 / L2-L3 全局范围。
- [x] 验证记忆任务与 Wiki 任务共用系统 worker 时不会互相覆盖响应或串会话。

验证：在 `extensions` 运行 `npx vitest run memory`；在 `electron-agent` 运行 `npm test -- electron/app/memoryService.test.ts electron/pi/systemWorkerManager.test.ts electron/agentData/memoryStore.test.ts`。

## 任务 3：Wiki 与代码检索通道

文件：`extensions/wiki-rag/sync.ts`、`extensions/code-retrieval/tools.ts`、`extensions/code-retrieval/mcpClient.ts`、`electron-agent/electron/app/wikiSyncService.ts`、`electron-agent/electron/app/codeGraph/codeGraphService.ts`、`electron-agent/electron/agentData/runtime.ts` 及对应测试。

- [x] Wiki 源文件使用实际路径边界检查，验证目录链接不能越过工作区；取消后不写入生成结果。
- [x] 增加受限 `codeRetrieval.call`，只接受现有七个只读 CodeGraph 工具，固定请求所属 workspace，返回原始 MCP 结果。
- [x] 保持 UI 使用的 `codeRetrieval.search` 不变；扩展通过 AgentData 复用实例池，不自行创建进程。
- [x] 验证非法工具、跨项目参数、缺索引、服务不可用时明确失败，不自动建索引。

验证：在 `extensions` 运行 `npx vitest run wiki-rag code-retrieval`；在 `electron-agent` 运行 `npm test -- electron/agentData/runtime.test.ts electron/app/codeGraph electron/app/wikiSyncService.test.ts`。

## 任务 4：真实端到端与交付

### 用户确认新增：Markdown Wiki 主存储

文件：`electron-agent/electron/agentData/wikiStore.ts` 与新的文件存储辅助模块/测试、`runtime.ts`、`extensions/wiki-rag/index.ts` / `sync.ts`、`electron-agent/electron/app/wikiSyncService.ts`。

- [x] 编写真实文件回归，断言 `replacePage` 落盘 Markdown 和原文快照，`readPage` 返回文件内容。
- [x] 实现页面元数据、工作区目录映射、原子文件更新和从文件重建索引；旧库只读导出且不覆盖现存文件。
- [x] 增加 `wiki.read` / `wiki.list` / `wiki.reindex` RPC 与三个同名用途工具；权限校验先于重建。
- [x] 打通 sourceContent，从扩展和主进程同步两条生成链路保存实际原文。
- [x] 验证编辑、删除、索引丢失、重启、导出冲突、人工锁定及源路径安全。

验证：`cd electron-agent` 后运行 `npm test -- electron/agentData/wikiStore.test.ts electron/agentData/extensionIntegration.test.ts electron/agentData/runtime.test.ts`；`cd extensions` 后运行 `npx vitest run wiki-rag`。

### 集成验收

文件：`electron-agent/electron/agentData/extensionIntegration.test.ts`、`docs/architecture.md`。

- [x] 用临时 SQLite / 真实回环 RPC 启动 AgentData，注册扩展并调用真实工具执行函数；只替换模型结果和外部 CodeGraph 进程边界。
- [x] 验证记忆捕获 → 提炼落盘 → 搜索/注入，以及 Wiki 写入 → 搜索；验证无其他项目私有数据泄露。
- [x] 运行相关测试、改动文件类型检查和构建，区分既有错误与本次新增错误。
- [x] 交叉审查全部改动，更新实际接入文档，报告测试证据和未覆盖的真实模型/GUI 验收项。

## 交付记录

- 加载链路：真实 Electron 插件状态、manifest、扩展工厂一起验证，14 个数据工具可注册。
- 传输：64 KiB 分片，单物理帧 1 MiB、单逻辑请求 32 MiB；真实 1.1M 字符会话首尾均可检索。大 capture 回执只返回状态，服务端完整保存原文。
- 迁移：临时库验证旧正文保留、同 ID 冲突备份、不复活已删除页面；未主动打开用户真实库执行迁移。
- 交叉审查发现的重启任务接续、会话重置取消、长帧限制、Wiki 回滚和目录链接问题均有先失败后通过的回归。
- CLI 全量测试 16 项及 `npm run typecheck` 通过；Electron/CLI `npm run build` 通过。Electron 独立全量主进程类型检查仍有原有 threadStore、IPC、权限测试等错误，未把它们当作本次通过项。
- 既有作用域测试因同毫秒写入顺序偶发失败，改为检查准确的结果集合；生产排序逻辑未改。
- 使用说明：`docs/agent-data-wiki.md`。未调用真实付费模型、未启动真实 CodeGraph 索引、未执行 GUI 端到端；模型鉴权由真实 SDK + 可控 provider 检查。
