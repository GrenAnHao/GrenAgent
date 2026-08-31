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

## LLM Wiki

- 资料：https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- 用途：Wiki RAG 将 Markdown 文档视为可持续维护的知识产物，并保留来源路径、标题分块和行号引用。

本文件不替代各上游项目随代码发布的完整许可证文本；发布 Electron 安装包时应一并核对依赖清单和许可证归档。
