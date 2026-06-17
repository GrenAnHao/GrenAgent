# Pi 对标 oh-my-pi 补齐路线图（总览设计）

- 日期：2026-06-17
- 状态：设计已批准（brainstorming 产出），待逐子项目拆 规格 → 计划 → 实现
- 范围：本文是**总览参考设计**，盘点 Pi 相对 oh-my-pi（下称 omp）的全部剩余差距，按 ROI + 依赖分波次，并穿插「已有扩展对标改进」。每个子项目后续各自走 规格 → 计划 → 实现 周期。
- 约束：**纯扩展 / 零核心改动 / 零 fork**（运行时 = npm 包 `@earendil-works/pi-coding-agent`，仓库无 `pi/` fork）。
- 对标源码：omp 本地 `D:\System Dir\Downloads\oh-my-pi`（`packages/coding-agent`）。

## 0. 与第一轮借鉴评估的关系

第一轮 omp 借鉴评估已挑 5 项并落地为扩展（均有 spec + `extensions/` 实现）：

- `hashline`（`2026-06-17-hashline-edit-design.md`）
- `lsp`（`2026-06-17-lsp-integration-design.md`）
- `code-exec`（`2026-06-17-persistent-code-execution-design.md`，**仅 Python**）
- `dap`（`2026-06-17-dap-debugger-design.md`）
- `rulebook` / TTSR（`2026-06-17-stream-rules-ttsr-design.md`）

本路线图覆盖**剩余差距** + 对上述已落地扩展的**质量对标改进**（如 code-exec 补 JS 内核、hashline 补锚点恢复）。与更早的 `2026-06-16-pi-enhancement-roadmap-design.md`（对标 MiMo-Code 的 A/B/C/D）正交，不重叠。

## 1. 背景与目标

omp 是 Pi（pi-mono）的重型 fork，自我定位「batteries-included coding surface」：`32` 内置工具、`14` LSP ops、`28` DAP ops、约 `55,000` 行 Rust native core、`40+` providers。Pi 走「极简核心 + 可插拔扩展」，核心仅 7 工具，能力靠 `extensions/` 钩子补齐。

经 omp 源码核实（`packages/coding-agent/src/tools/index.ts` 的 `BUILTIN_TOOLS` / `HIDDEN_TOOLS` 注册表），Pi 已对齐绝大多数核心编码能力；剩余差距集中在三类：

1. **结构化编辑与代码主机**：`ast_edit`/`ast_grep`、`github`+`pr://`。
2. **基建机制**：internal-urls 协议族、统一工具发现、`resolve`/预览接受、`job` 后台任务、LSP 写后自动诊断回灌。
3. **重投入/低频**：`browser`、autolearn（`learn`/`manage_skill`）、`mnemopi` 近似、`inspect_image`/`ssh`/`irc`。

目标：把以上差距设计成可独立拆分、纯扩展可落地的单元，按 ROI + 依赖分波次，并对已有扩展做 omp 对标改进。

## 2. 全局约束与决策

| 决策 | 选择 | 说明 |
|---|---|---|
| 实现载体 | **纯扩展**，零核心改动、零 fork | 钩子够不到的能力降级 / 近似，绝不改核心。 |
| 组织方式 | **ROI + 依赖分波次** | 高收益、无前置依赖的先做；基建次之；重投入可缓。 |
| 已有扩展 | **改进穿插进波次** | 质量对标改进与功能补齐多在同一扩展，合并到对应波次而非独立排期。 |
| 完成度 | 分层：MVP + 可选增强 | 每项 MVP 先落地，增强按需。 |
| 降级 | 全部 fail-soft | 缺依赖 / 调用失败不阻断主流程。 |

## 3. omp 能力全集 vs Pi 现状（源码核实对照）

omp 工具注册表（`packages/coding-agent/src/tools/index.ts:415` `BUILTIN_TOOLS` + `:448` `HIDDEN_TOOLS`）：
`read bash edit ast_grep ast_edit ask debug eval ssh github find search lsp inspect_image browser checkpoint rewind task job irc todo web_search search_tool_bm25 write memory_edit retain recall reflect learn manage_skill` + `yield report_finding report_tool_issue resolve goal`。

| omp 工具/特性 | Pi 现状 | 状态 |
|---|---|---|
| read/write/edit/bash/find/search | 核心 7 工具 + `read_files` + `hl_*` | 已对齐（read 缺 `://`）|
| ast_grep / ast_edit | 无 | 缺（波1）|
| eval（py+js 双内核+工具桥）`eval.ts:30` | `code-exec` 仅 Python `code-exec/index.ts:38` | 部分（波1）|
| lsp（写后自动回灌 `diagnosticsLedger`）| `lsp` + 手动 `diagnostics` | 部分（波1）|
| debug（DAP）| `dap` 9 工具 | 已对齐 |
| task（typed schema + irc + agent://）| `multi-agent` `spawn_agent` | 已对齐（缺 schema/irc，波2）|
| github + `pr://` `internal-urls/issue-pr-protocol.ts` | 仅 `fetch_github_readme` | 缺（波1）|
| internal-urls 11 协议 `internal-urls/` | 无 | 缺（波2）|
| resolve / job / search_tool_bm25 | 无 | 缺（波2）|
| browser | 无 | 缺（波3）|
| retain/recall/memory_edit | `memory_save/recall/update` | 已对齐 |
| reflect / learn / manage_skill | 无（`kb_search` 近似 reflect）| 部分（波3）|
| checkpoint(对话态)/rewind | `checkpoint`(git 快照,语义异)/`compaction-policy` | 语义差异（波3）|
| inspect_image / ssh / irc | 无 | 缺（波3）|
| goal / ask / todo / tts / image-gen | `goal` / `ask_user` / `todo` / `speak` / `generate_image` | 已对齐 |
| ACP（`ClientBridge` `index.ts:275`）| 无 | 不做（须上游）|
| Rust native core（约 55k 行）| 依赖上游运行时 | 不做（架构）|

## 4. 纯扩展可达性矩阵

依据 `docs/pi/extension-capability-map.md`：可 **override 内置工具**（read/edit/write/bash）、`context` hook、`before_agent_start`、`setActiveTools`/`getActiveTools`、`registerTool`、tool 前后钩子。

| 差距点 | 可达性 | 关键手段 |
|---|---|---|
| ast_edit/ast_grep | 可达 | `@ast-grep/napi` + `registerTool` |
| github + pr:// | 可达 | gh CLI 工具 + override read 解析 `pr://` |
| eval JS 内核 | 可达 | Node 子进程常驻 kernel |
| eval 工具回灌桥 | 近似 | 取决于 ctx 能否 invoke 其他工具，可降级为仅 read/search 桥 |
| LSP 写后自动回灌 | 可达近似 | override edit/write 或 after-tool hook + 现有 lsp |
| internal-urls 协议族 | 可达 | override read/search + 路由表（工作量大）|
| resolve / 预览接受 | 可达 | tool-choice 队列 / 状态机 + `registerTool` |
| job 后台任务 | 可达 | 子进程 + 注册表（参考 multi-agent 背景控制面）|
| 工具发现 search_tool_bm25 | 可达 | `setActiveTools` 隐藏 + BM25 索引 |
| autolearn / inspect_image / ssh / irc | 可达 | `registerTool` + 文件 / 子进程 |
| browser | 可达（重）| puppeteer 子进程 |
| ACP | **够不到** | runtime 入口协议，须上游 |
| Rust native core | **够不到** | 架构层，依赖上游 |

## 5. 波次划分

### 波1 — 编码闭环直接收益（高 ROI，先做）

1. **ast_edit / ast_grep**（新扩展 `ast-tools/`）：`@ast-grep/napi` 注册 `ast_grep`（结构化查询，50+ 语法）+ `ast_edit`（结构化重写，预览→接受）。
2. **github + pr://**（新扩展 `github/`）：`github` 工具（gh CLI：repo/PR/issue/code search/Actions）+ override read 解析 `pr://`/`issue://`。
3. **LSP 写后自动诊断回灌**（增强 `lsp` + `diagnostics`）：after-tool hook 或 override edit/write，编辑后自动跑 LSP 诊断、deferred 回灌给模型；带 ledger 去重与 stale 丢弃。
4. **eval 加 JS 内核**（增强 `code-exec`）：常驻 JS kernel（Node 子进程）、cell 批量、`display()` 富输出；工具回灌桥做可行性验证。

### 波2 — 基建与机制（解锁后续）

5. **internal-urls 路由骨架**（新 `_shared/internal-urls/`）：统一 `://` 解析路由，先接 `pr://`/`issue://`/`artifact://`，为后续协议铺路。
6. **resolve + 预览接受机制**（新 `preview/` 或并入 ast-tools）：staged action + `resolve` 工具（apply/discard）。
7. **job 后台任务**（增强 bash / multi-agent）：后台作业 wait / cancel / status。
8. **统一工具发现**（新 `tool-discovery/`）：`setActiveTools` 隐藏非必要工具 + BM25 `search_tool` 按需激活。

### 波3 — 重投入 / 低频（可缓）

9. **browser**（新 `browser/`）：puppeteer 驱动（headless + CDP 附着）。
10. **autolearn**（增强 memory）：`learn` / `manage_skill`，agent 自写技能。
11. **mnemopi 近似 + reflect**（增强 memory）：session mental model + `reflect` 综合。
12. **inspect_image / ssh / irc**：按需补。

### 明确不做（YAGNI / 够不到）

- **ACP**：runtime 入口协议，扩展层够不到，须上游 npm 包支持。
- **Rust native core**：架构层，依赖上游。
- **40+ providers / 14 web backends 全量**：按实际需要增量加。

## 6. 已有扩展对标改进（穿插波次）

| 已有扩展 | omp 对应 | 可采纳的更优做法 | 波次 |
|---|---|---|---|
| `hashline`（独立 `hl_*`，锚点过期直接拒绝 `hashline/index.ts:70`）| edit 补丁 + stale-anchor recovery + noop-loop-guard（`index.ts:319/340`）| 锚点过期**自动恢复**（快照重建模型锚定版本）而非直接拒绝；连续 no-op 编辑**升级为错误**防子代理死循环 | 波1 |
| `code-exec`（仅 Python `py_run/py_reset`）| eval 双内核 + 工具桥 + display | 加 JS 内核、cell 批量、display 富输出 | 波1 |
| `multi-agent`（`spawn_agent`，文本输出）| task（typed output schema + irc + agent://）| **输出 schema 校验**（机器可读结果）、agent 间 irc、`agent://` 取字段 | 波2 |
| `diagnostics`（手动）| lsp 写后自动回灌 | edit/write 后**自动诊断** | 波1 |
| `long-term-memory`+`knowledge-rag` | hindsight + mnemopi + learn | `reflect` 综合、autolearn、session mental model | 波3 |
| `web-fetch`/`web-search` | web_search 14 源 + read 站点感知提取 | 站点感知提取器（github/arxiv/npm/SO 结构化）、安全库（NVD/OSV/CISA）| 波2/3 |
| `code-review`（`git_diff`+`review_note`）| review（reviewer 子代理并行 + verdict）| reviewer 子代理并行扫描、P0-P3 + 裁决 | 波2 |
| `compaction-policy` | checkpoint / rewind / snapcompact | `rewind` 语义（裁剪探索保报告）、结构化 checkpoint | 波3 |

## 7. 拆分与依赖关系

```
波1: ast-tools ── github+pr:// ── LSP回灌 ── eval-JS   (互相独立，可并行)
                     │
波2: internal-urls 骨架 ◄── github/pr:// 的 :// 解析收敛到此
     resolve ◄── ast-tools 的"预览→接受"雏形演进
     job · tool-discovery                              (各自独立)
波3: browser · autolearn · mnemopi近似 · 杂项          (各自独立)
```

- ast-tools 落地的「预览→接受」雏形 → 演进为波2 的 `resolve` 通用机制。
- github/pr:// 先各自实现 `://` 解析 → 波2 抽出 internal-urls 路由骨架统一收敛。
- 其余互不依赖，可按资源穿插。

## 8. 第一个深入子项目：ast_edit / ast_grep

选定 `ast_edit`/`ast_grep`（波1 #1）作为第一个深入到可实现的子项目：

- **ROI 最高**：结构化编辑/查询是 omp benchmark 卖点；命中率高、跨文件重写可靠。
- **纯扩展完全可达**：`@ast-grep/napi`（MIT）成熟，注册工具即可。
- **无前置依赖**：不依赖 internal-urls 骨架。
- **铺路效应**：顺带落地「预览→接受」雏形，为波2 `resolve` 复用。

详细设计另起 `docs/superpowers/specs/2026-06-17-ast-tools-design.md`（待 brainstorming 细化后产出），覆盖：工具 schema（`ast_grep` 查询 / `ast_edit` 重写）、ast-grep 库集成、预览→接受流程、语言支持范围、错误与降级、测试。

## 9. 横切关注点

- **持久化**：状态统一落 `.pi/` 下；索引类（若有）复用 `_shared`。
- **成本**：额外 LLM / 子进程调用应可配置开关与模型，默认低开销。
- **降级**：所有外部依赖（gh CLI、puppeteer、ast-grep、LSP server）缺失时 fail-soft + 明确提示。
- **模式适配**：涉及 `ctx.ui.*` 的功能用 `ctx.hasUI`/`ctx.mode` 判断，RPC/print 模式降级静默。
- **安全**：新增执行类工具（github gh、ssh、browser）继承 `safety`/`mcp-policy` 约束。
