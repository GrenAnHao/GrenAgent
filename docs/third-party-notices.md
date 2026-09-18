# 第三方来源说明

Electron 版的 Agent Data 模块为 TypeScript 自研实现，以下开源项目和公开资料提供了设计参考或局部实现依据。引入代码时应继续遵守各自仓库的许可证和署名要求。

## CodeGraph

- 项目：https://github.com/colbymchenry/codegraph
- 用途：CodeGraph 资产模块通过内置 MCP client 调用其 Rust 索引服务；工具协议沿用上游 `codegraph_*` 接口。
- 边界：本项目不复制或修改 CodeGraph 的 Rust 索引器，运行时由用户安装或打包提供 `codegraph` 命令。

## Hermes Agent

- 项目：https://github.com/nousresearch/hermes-agent
- 用途：后续 Skill 资产管理将参考其 Skill 发现与加载流程。
- 当前状态：Skill/自定义 Agent 仅保留扩展接口，本阶段未复制其实现。

## TencentDB Agent Memory

- 项目：TencentDB-Agent-Memory（MemoryCore）
- 许可证：MIT
- 用途：`electron-agent/electron/agent/memoryPrompts.ts` 中的 L1 记忆抽取系统提示词（`MEMORY_EXTRACT_WORK_SYSTEM_PROMPT`、`MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT`）为**逐字移植**，取自上游 `MemoryCore/src/core/prompts/l1-extraction.ts`。
- 上游版本锚点：HEAD `0468a2a5b50eaafc54758ed1e2e6609472e5b6ce`；该文件最后一次变更 `41444344ce11467a5b5ad6aa032f5e261da1f4d2`（2026-07-22，v2.0.0-beta.1）。
- 边界：仅移植提示词文本常量，未复制其运行时、存储层或调度实现。

## LLM Wiki

- 资料：https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- 用途：Wiki RAG 将 Markdown 文档视为可持续维护的知识产物，并保留来源路径、标题分块和行号引用。

本文件不替代各上游项目随代码发布的完整许可证文本；发布 Electron 安装包时应一并核对依赖清单和许可证归档。
