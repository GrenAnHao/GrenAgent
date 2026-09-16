# 子项目 D.1：跨会话历史检索（设计/规格）

- 日期：2026-06-16
- 状态：草案 — 已实地核验（npm 运行时 `@earendil-works/pi-coding-agent@0.79.x`），待用户审查
- 主题：把历史会话 JSONL 的消息文本建索引，提供 `history_search` 工具 + `/history` 命令
- 载体：纯新扩展 `extensions/session-search/`，复用 `_shared/sqlite`
- 上游总览：`docs/superpowers/specs/2026-06-16-pi-enhancement-roadmap-design.md` §4.D.1

> 锚点约定：`session-manager.d.ts`/`.js` = `extensions/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.*`；`config.js` = 同包 `dist/config.js`；`_shared` = `extensions/_shared/`。

## 0. 重大修正（实地核验推翻总览的路径假设）

总览 §4.D.1 设会话文件在项目本地 `.pi/sessions/*.jsonl`。**实际路径不同**：

```216:224:session-manager.js
function getDefaultSessionDirPath(cwd, agentDir = getDefaultAgentDir()) {
    const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(resolvedAgentDir, "sessions", safePath);
}
```
- 真实模式：`~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<sessionId>.jsonl`（`config.js:404-441` 的 `getAgentDir`/`getSessionsDir`；写入 `session-manager.js:643`）。
- 即**按 cwd 分区、存储位置全局**，不属于项目 `.pi/` 树（与 `.pi/memory`、`.pi/knowledge` 的项目本地模型不同）。
- 覆盖：`settings.sessionDir` 或 env `PI_CODING_AGENT_SESSION_DIR`（`config.js:390`）。

**枚举方式不应硬拼路径**，改用官方 API（见 §2）。索引 DB 仍放项目本地 `<cwd>/.pi/history/index.db`（与 `knowledge-rag` 的 `.pi/knowledge/` 一致）。

## 1. 目标与范围

### 1.1 MVP
- 把当前项目历史会话的消息文本（user/assistant/toolResult 文本）索引进 SQLite。
- 工具 `history_search({ query, topK? })` 返回命中会话 + 片段（含 sessionId、时间、role、snippet）。
- `/history` 命令：列最近会话 / 关键词搜索。
- 增量：按文件 mtime 跳过已索引未变更的会话。

### 1.2 成功标准
1. 在含多个历史会话的项目里搜关键词，能返回出现该词的会话与片段。
2. 重复运行不重复全量索引（mtime 增量）。
3. 无索引/无命中时返回空 + 提示，不报错。

### 1.3 不在范围（增强）
- embedding 语义检索（归一到 D.3 的 `_shared` 向量设施后再加）。
- 跨项目搜索（`listAll`，见增强）。
- 命中后跳转/恢复会话（需 command-context 的 `switchSession`）。

## 2. 代码依据（实地核验）

| 能力 | API（锚点） |
|---|---|
| 当前项目会话目录 | `ctx.sessionManager.getSessionDir(): string`（`session-manager.d.ts:136,186`） |
| 枚举本项目会话（推荐） | `SessionManager.list(cwd, sessionDir?, onProgress?): Promise<SessionInfo[]>`（静态，`session-manager.d.ts:324`） |
| 枚举全部项目（增强） | `SessionManager.listAll(sessionDir?, onProgress?): Promise<SessionInfo[]>`（`:329-330`） |
| 解析 JSONL | `parseSessionEntries(content): FileEntry[]`（`session-manager.d.ts:141`，主入口导出 `index.d.ts:17`） |
| 条目类型 | `SessionMessageEntry { type:"message"; id; parentId; timestamp; message: AgentMessage }`（`session-manager.d.ts:23-26`）等 union（`:101`） |
| SQLite | `_shared/sqlite.ts` 的 `DatabaseSync`（`exec`/`prepare`/`close`；node:sqlite 或 bun:sqlite，`sqlite.ts:17-38`） |
| 配置 | `_shared/runtime-config.ts` 的 `getConfig`（`sqlite`/`runtime-config` 同款复用） |

> FTS5 提示（核验）：`_shared/sqlite` 只暴露 `exec`/`prepare`，**未封装 FTS、仓库无先例**；底层 node:sqlite/bun:sqlite 通常编译启用 FTS5。故 MVP 采「试建 FTS5 虚表，失败回退关键词扫描」（§5）。

## 3. 架构与组件

`extensions/session-search/`：
- `index.ts` —— 工厂。注册 `history_search` 工具 + `/history` 命令；`session_start` 时惰性确保索引。
- `indexer.ts` —— `ensureIndex(ctx)`：`SessionManager.list(ctx.cwd)` 枚举 → 对每个 mtime 变更的会话 `parseSessionEntries` → 抽消息文本 → 写 SQLite。`extractText(entry)` 复用 `long-term-memory` 的 message→text 思路（`index.ts:34-48`）。
- `store.ts` —— SQLite schema + upsert + 搜索；FTS5/关键词双模式（见 §5）。基于 `_shared/sqlite` 的 `DatabaseSync`。

DB：`<cwd>/.pi/history/index.db`，表 `entries(session_id, session_file, ts, role, text, mtime)` + 可选 FTS5 虚表 `entries_fts(text)`。

## 4. 数据流
```
session_start / 工具首次调用     → ensureIndex(ctx)
history_search({query, topK})    → ensureIndex → store.search(query, topK) → [{sessionId, ts, role, snippet}]
/history [query]                 → 无 query 列最近会话；有 query 同 search
```

## 5. FTS5 与回退（核验驱动）
- 建库时 `try { exec("CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(text, content='entries', content_rowid='rowid')") }`。
- 成功 → 搜索用 `entries_fts MATCH ?`（中英文：FTS5 默认 unicode61 分词器，中文可加 `tokenize='trigram'` 兜底）。
- 失败（驱动未启用 FTS5）→ 回退 `entries` 表 + 关键词 LIKE/打分（复用 `long-term-memory/store.ts` 的 `keywordScore` 思路，`store.ts:47-62`）。
- 两路对调用方透明（`store.search` 内部分支）。

## 6. 错误处理（统一 fail-soft）
- 无会话/空索引 → 工具返回「无历史命中」+ 提示，不抛。
- 单个会话解析失败 → 跳过该文件、继续（`.catch` 局部）。
- SQLite 不可用 → 工具降级为「仅当前会话不可搜」提示。
- 路径覆盖（env/settings）→ 用 `getSessionDir()`/`list` 的返回，不硬拼。

## 7. 配置（`getConfig`）
- `HISTORY_SEARCH_ENABLED`（默认开）。
- `HISTORY_SEARCH_SCOPE`（`project`(默认) | `all`）：`all` 用 `listAll`（增强）。
- `HISTORY_SEARCH_MAX_CHARS`（片段长度，默认 300）。

## 8. 测试
- `indexer.test.ts`：构造临时会话目录 + 假 JSONL → 索引 → mtime 增量不重复。
- `store.test.ts`：FTS5 可用路径 + 回退关键词路径，各自命中/排序；空库降级。
- `extractText`：各 entry 类型抽文本正确。
- jiti smoke。

## 9. 实现文件清单
| 文件 | 职责 |
|---|---|
| `extensions/session-search/index.ts` | 工厂 + 工具 + 命令 |
| `extensions/session-search/indexer.ts` | 枚举/解析/抽取/增量 |
| `extensions/session-search/store.ts` | SQLite + FTS5/关键词双模式 |
| `*.test.ts` | 单测 |
| `extensions/package.json` | 追加 `./session-search/index.ts` |

## 可选增强（YAGNI）
- embedding 语义检索：等 D.3 把向量设施 hoist 到 `_shared` 后复用同一 `embedTexts` + 向量表。
- 跨项目（`listAll`）+ 按项目/时间过滤。
- 命中跳转：`/history` 选中后 `ExtensionCommandContext.switchSession`（`types.d.ts:276`）。

## 规格自检（2026-06-16）
- [x] 无占位；§0 路径修正贯穿全文（枚举用 API 不硬拼）
- [x] FTS5 不确定性已用「试建+回退」消解
- [x] 范围可单一实现计划覆盖
- [x] fail-soft 明确

## 代码核对修订（2026-06-16，实地核验 v1，来自 D 区只读审计）
- [x] 会话真实路径属实：`session-manager.js:216-224`、`config.js:404-441/390`
- [x] 枚举/解析 API 属实：`SessionManager.list/listAll`（`session-manager.d.ts:324-330`）、`parseSessionEntries`（`:141`）、`getSessionDir`（`:186`）
- [x] `_shared/sqlite` 驱动属实：node:sqlite/bun:sqlite `DatabaseSync`（`sqlite.ts:17-38`）
- [x] FTS5 无先例：shim 未封装、仓库零 `fts5`/`MATCH` 用例 → 采回退策略
- [x] 索引 DB 项目本地，对齐 `knowledge-rag` `.pi/knowledge/`（`knowledge-rag/index.ts:31`）
