# Agent Note: Repo Wiki catalogue 生成失败的三个根因与修复

Status: implemented

## Problem

用户界面长期停在「生成失败 · 已发布 0 篇 · 当前阶段 catalogue」，错误码只有 `CATALOGUE_FAILED`，看不出模型错了、输出被截断，还是输出格式不合规。

真实任务 `0e480941-57e5-4d45-8035-593a0aad1ca7`（项目 `note-pocock-flow`，zh，父任务 `c9513086`）可用只读 SQLite 取证：

- 29 次模型请求全部结算（`usage` 表 29 条 `actual`，无 unknown、无在途），不是额度或鉴权问题。
- `overview`、`plan` 都是 `done`；只有 `catalogue-root` 两次尝试都 `failed`。
- 两次原始响应都在 `checkpoint_history.value.raw`：attempt 1 是 `<documentation_structure>` 里放 ```yaml 围栏的 YAML 列表；attempt 2 是合法 JSON，但 `dependent_file` 是字符串、`children_plan` 是数组、`has_children` 是布尔。
- 任务 `state=failed, error="CATALOGUE_FAILED"`，`agent_jobs` 里同样是这个裸码。

## 决定

三个独立故障都在 catalogue 这一段，修法分别如下。

**1. 解析只认一种序列化**（`wikiService/referenceParsers.ts`）。`taggedJson()` 只扫 `{`/`[` 再交给 `JSON.parse`，YAML 与等价标量外形一律判死，即使内容完全可用。现在：先走原 JSON 路径（含 `json` 围栏与 `repairJson`）；只有完全拿不到可解析 JSON 时，才尝试 `<documentation_structure>` 或 ```yaml 围栏里的**完整** YAML 文档。`normalizeSections()` 只做无损归一——`dependent_file` 字符串→单元素数组、`children_plan` 数组→换行串、`has_children` 布尔→`YES`/`NO`。字段缺失、重名兄弟、截断（无闭合围栏或节点不完整）仍然失败。

**2. 模板渲染少一次 trim**（`wikiService/referencePrompts.ts`）。`render()` 用 `tokens.slice()` 重渲染 `range` 块，而 `{{- end }}` 的 trim 只作用在解析出的 `yes.text` 上，重渲染路径拿不到，于是 `</coding_intent>` 后多一个空行。`BlockResult` 现在带 `trimmed`，`range` 分支在整段渲染完成后按 `{{- end }}` 裁剪一次——与 Go 语义一致，不是每项裁一次。这曾让 `referencePrompts.test.ts` 的 4 个 golden 用例长期红着。

**3. 错误码抹掉失败类别**（`wikiService/fullGeneration.ts`）。`store.settle()` 只保留 `/^[A-Z][A-Z0-9_]{0,99}$/`，而 `runFull` 统一 `throw new Error('CATALOGUE_FAILED')`，三种不同处置方式在界面上长得一模一样。新增 `stageFailureCode()`：从同 stage 最后一条 failed checkpoint 读已分类的原因，产出 `CATALOGUE_MODEL_ERROR` / `CATALOGUE_OUTPUT_TRUNCATED` / `CATALOGUE_OUTPUT_INVALID`，overview / plan / catalogue-child 同理。只提升类别，不携带任何模型原文。

## 影响面

改动集中在三个文件；`parseReferencePage`、增量解析、重试与预算逻辑、`store.ts` 的码校验、`RepoWikiService` 对外契约、native RPC 字段、UI 展示逻辑均未动（UI 本来就把 `operation.error` 原样显示，新码立即可见）。

新增 `wikiService/fixtures/*.txt`（两份真实失败响应）与 `scripts/verify-repo-wiki-catalogue.mjs`（一条命令复验解析 + 真实 child 端到端）。

## Alternatives considered

- **只放宽正则或去掉校验** — 会让截断、空目录也被接受，发布半截 Wiki；不选。
- **在提示词里再强调一遍"必须 JSON"** — 已经强调两轮，真实模型照样给 YAML；不选，等于把可用信息丢掉。
- **保留 `CATALOGUE_FAILED`，把原因塞进 message** — `store.settle()` 会把非裸码归一成 `RUN_FAILED`，反而更差；不选。
- **把 `has_children`/`children_plan` 的类型也放宽成任意值** — 会让下游 `has_children.toLowerCase()` 之类静默走偏；不选，只在明确等价时归一。

## Consequences

收益：两份真实响应都能解析出 8 个同名 section；真实 child 链路上 YAML 与等价标量两种输出都能完成 生成 → 发布 → 任务视图 → `page` 读取，磁盘正文与读取结果逐字相等；坏输出时的失败码变成可诊断的类别，且随后显式 repair 能跑到 `completed`。

代价与风险：

- YAML 是第二种结构解读。用 `maxAliasCount: 100`、重复键报错、256 KiB 上限、"仅当 JSON 完全不可用才尝试"来限制，但确实比只认 JSON 宽松。
- `dependent_file: "src/a.ts"` 这类写法现在能过。这是真实模型行为且信息无损；若将来要强制数组，应加严格模式而不是回退本次修复。
- `CATALOGUE_OUTPUT_*` 是新码，UI 暂无中文文案映射，只原样展示。比裸码可诊断，但不算友好。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 解析：真实两份响应、YAML 围栏、等价标量、截断仍失败、缺 `prompt` 仍失败 | `npx vitest run --project main electron/wikiService/referenceParsers.test.ts` | 9 项通过 |
| 渲染：10 个 purpose/分支与 golden 逐字相等 | `npx vitest run --project main electron/wikiService/referencePrompts.test.ts` | 3 项通过（修复前该文件 1 项红） |
| 失败分类 | `npx vitest run --project main electron/wikiService/fullGeneration.test.ts` | 8 项通过 |
| wiki 链路单测 | `npx vitest run --project main --maxWorkers=2 electron/wikiService electron/knowledgeProcess electron/agentData/knowledgeKernel` | 36 文件 / 283 项通过 |
| 应用层 Wiki 单测 | `npx vitest run --project main --maxWorkers=2 electron/app/nativeWikiController.test.ts … electron/agentData/nativeWikiProjection.test.ts` | 10 文件 / 66 项通过 |
| 真实 child 端到端 | `node --import tsx scripts/test-repo-wiki-flow.mjs` | 9 文件 / 50 项通过（新增 YAML 出力与"坏输出→repair"两条） |
| 一条命令复验 | `node --import tsx scripts/verify-repo-wiki-catalogue.mjs` | 解析 2/2；端到端 1 通过 |
| 类型检查 | `npx tsc -p tsconfig.repo-wiki.json --noEmit` | 通过 |

未验收：真实模型、真实供应商、桌面应用内实际点击、`CATALOGUE_OUTPUT_*` 的中文文案。渲染层 `RepoWikiWorkspace.knowledge.test.tsx` 目前 9 项红，原因是 `nativePrimary` 下内核概览本就不渲染（`App.tsx:240`），与本链路无关且早于本轮修改。
