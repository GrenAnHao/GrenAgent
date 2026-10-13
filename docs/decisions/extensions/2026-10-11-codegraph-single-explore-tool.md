> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-11-code-explore-single-tool.md](../../../.agents/notes/implemented/architecture/2026-10-11-code-explore-single-tool.md) 维护；本文件冻结只读。

---
title: 内置 CodeGraph 升到 1.6.2，模型侧代码检索只留 code_explore
status: active
date: 2026-10-11
scope: extensions
files:
  - electron-agent/package.json
  - electron-agent/electron/app/codeGraph/codeGraphEngine.ts
  - extensions/code-retrieval/tools.ts
  - extensions/agent-mode/modes.ts
  - extensions/fable-behavior/default-agents.ts
  - electron-agent/electron/app/enhancePrompt.ts
supersedes:
superseded_by:
---

## 背景

内置 SDK 钉在 `@colbymchenry/codegraph` 1.6.0。npm `latest` 已是 1.6.2（2026-10-03），抽取版本从 25 升到 27。1.6.2 的 MCP 仍实现 search、callers、node、files、status，但默认工具表 `DEFAULT_MCP_TOOLS` 只列入 `codegraph_explore`：一次调用返回相关源码和调用路径，其余工具是它的窄切片，列出来会把模型带去误选。我们这边给模型注册了 20 个 `code_*` 工具。

## 决定

依赖升到精确版本 `1.6.2`，`CODEGRAPH_SDK_VERSION` 与之一致。

模型能看见的代码检索只剩 `code_explore`，参数与上游公开 schema 对齐：必填 `query`，可选 `maxFiles`（1–20，默认 12）。不暴露 `projectPath`，工作区仍是当前会话的 `cwd`。提示词、ask/plan 白名单、Fable 默认子代理和增强提示词用的工具表一起收成这一个。

工作台和 `codeRetrieval.call` 继续可以调用 search、node、files、callers 等查询。那些是人用的面板和内部 RPC，不是模型工具表。

## 放弃的方案

- 只升 SDK、工具表不动：1.6.2 自己已经认为多列这些工具会把模型带偏，留下它们等于不跟这次接口收缩。
- 把 MCP 里约 17 万字符的 `handleExplore` 排版逻辑抄进查询层：展示格式跟上游版本走，抄一份会马上分叉。模型仍走现有的 `codegraph_explore`，它已经基于 `findRelevantContext` 返回源码片段和边。
- 加一个类似 `CODEGRAPH_MCP_TOOLS` 的开关把其余 `code_*` 重新注册给模型：用户要的就是和上游默认一样的单工具表面；内部 RPC 仍能到达那些查询。
- 在 `code_explore` 上加 `projectPath`：上游用它是因为一个 MCP 进程要查多个仓库。我们的工具已经绑在当前会话工作区上。

## 后果

1.6.0 建的索引抽取版本是 25，1.6.2 是 27。已有项目需要重新索引才能用上新的解析和路由；这次不自动重建。

ask/plan 不再放行旧的 `code_*` 名字。Fable 种子版本改为 `2026-10-11.1`，未改过的默认子代理会在下次加载时换成只含 `code_explore` 的模板；用户改过的子代理文件保持原样，里面若仍写着已删除的工具名，调用会找不到工具。

父包 `@colbymchenry/codegraph` 仍受 pnpm `minimumReleaseAge` 约束。1.6.2 发布已超过 24 小时。平台包继续由既有的 `@colbymchenry/codegraph-*` 排除规则放行。
