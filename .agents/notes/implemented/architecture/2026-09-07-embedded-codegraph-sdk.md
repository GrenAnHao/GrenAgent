# Agent Note: CodeGraph 以内嵌 SDK 运行，不起 CLI / MCP

Status: implemented

## Problem

代码检索引擎几经更换：Tauri 时期先把内置引擎从 codegraph 换成 codebase-memory CLI（d90d4d12、24f694ea，2026-07-01）；Electron 侧 2026-09-05 先做了 CodeGraph MCP 实例池（a15920c5，惰性加载、空闲回收）；2026-09-07 af51de67「Embedded CodeGraph SDK: engine, query, sync jobs and packaging script replace the external instance pool and sync runner」。

原因（用户说明）：最初的候选都实际体验过，最后选 CodeGraph 是因为技术栈融合得更好；做成内嵌 SDK 是为了方便统一管理。

## Decision

- 主进程 `CodeGraphService` / `CodeGraphEngine` 内置 CodeGraph SDK，不启动 CLI / MCP，不读 `GREN_CODEGRAPH_COMMAND`。
- 实例按工作区共享，空闲 15 分钟关闭；查询与同工作区索引写入互斥。
- 只有用户显式建立 / 同步才写索引，不启用 SDK watcher；缺索引不自动创建。
- SDK 是固定版本的应用依赖；`asarUnpack` 解出，`scripts/package-codegraph.cjs` 补齐平台包；没有平台包时报告安装包问题，不回退到全局 CLI 或在线安装。
- 模型侧只暴露 `code_explore`，见 [code_explore 单工具](./2026-10-11-code-explore-single-tool.md)；平台二进制见 [CodeGraph 平台二进制](./2026-09-29-codegraph-platform-binaries.md)。

### 涉及文件

- `electron-agent/electron/app/codeGraph/`
- `electron-agent/scripts/package-codegraph.cjs`

### 来源

- d90d4d12
- 24f694ea
- a15920c5
- af51de67
- `docs/architecture.md`「Agent Data Runtime」

## Alternatives considered

- **codebase-memory CLI（d90d4d12 / 24f694ea）**：单文件二进制、checksums 校验。已放弃：候选都体验过，CodeGraph 技术栈融合更好（用户说明）。
- **CodeGraph MCP 实例池（a15920c5）**：复用上游 MCP，惰性加载。被内嵌 SDK 取代：为了方便统一管理（用户说明）。
- **启用 SDK watcher 自动增量索引**：暂未启用：还没来得及做，已列入计划（用户说明）。后续跟进：接入 SDK watcher 做自动增量索引。

## Consequences

- 升级 SDK 是一次显式的依赖变更，要核对抽取版本与查询面。
- 不回退到全局 CLI 意味着安装包缺平台包时功能不可用，而不是降级。

## Verification

verify: n/a 回填的历史决定，源提交未记录验证
