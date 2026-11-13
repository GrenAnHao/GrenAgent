# Agent Note: Repo Wiki catalogue 生成失败的三个根因与修复

Status: implemented
Archived: 2026-11-13

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

## 第二轮：真实用户复跑暴露的三个新故障

第一轮修复上线后用户复跑，失败点从 `catalogue-root` 后移到 `catalogue-child`，错误码 `CATALOGUE_CHILD_OUTPUT_INVALID`。取任务 `74b0342e-1b90-4f4b-89db-2cbc59e2efe9` 的 8 次 child 响应逐条验：2 次成功、1 次**单个对象而非数组**、1 次**JSON 内未转义引号**、4 次**模型返回空**（`out=1` token，`stopReason=done`）。

对应修了三处：

1. **单个 section 对象**。`sectionsFrom()` 现在把裸对象当作单元素目录（其自带 `items` 优先），`normalizeSections()` 不再要求顶层必须是数组。
2. **未转义的内层引号**。`repairUnescapedQuotes()` 只在“引号后面不是 `,` `}` `]` `:`”时补转义，且必须整体 `JSON.parse` 通过才算成功；它挂在 `taggedJson()` 的 `invalid` 分支、`repairJson()` 之后，所以截断与真正损坏仍然失败（有反例用例）。
3. **provider 错误从不重试**。`stopReason === 'error'` 原来直接 `return undefined`，把一次瞬时故障变成整段失败。现在区分瞬时（408/409/425/429/5xx、rate limit、timeout、ECONNRESET…）与永久（401/400），只对瞬时错误消耗下一次 attempt。永久错误仍只试一次，既有 Beta 夹具的“2 次调用”断言因此保持成立。
4. **空响应没有纠偏**。原来重试会收到“修复 JSON 语法”的指令，对空输出无效。现在按失败原因分流：空响应给“你的上一条回复为空，请完整返回 `<documentation_structure>`”，格式错误才走候选修复。

`WikiModelTurn` 新增可选 `errorMessage`（`nativeWikiModel.ts` 从 `AssistantMessage.errorMessage` 截断填入，仅用于重试判定，不落库）。

## 第三轮：修复代码曾只存在于 git stash，现已按文件恢复

第二轮的三处修复（`repairUnescapedQuotes`、`sectionsFrom`、`isRetriableProviderError` 与空回复指令、`WikiModelTurn.errorMessage`）当时**从未进入工作区或任何提交**：`git log --all -- electron/wikiService/referenceParsers.ts` 只有两个提交，都不含这些函数，而函数体与注释完整地留在 `stash@{0}`（`On master: tmp-verify-baseline`）。取证依据是拿该 stash 的解析器单独喂 4 条真实 child 响应：工作区版本 2/4，stash 版本 4/4。

恢复方式是按文件取 hunk（`git show 'stash@{0}:<path>'`），**不是** `git stash pop`——该 stash 同时包含 `agentDataProcess/**`、`agentData/wikiEngine/**`、`AgentDataCenter` 等已被退役流程删除的文件，pop 会让它们复活并大面积冲突。恢复的 6 个文件：

- `electron/wikiService/referenceParsers.ts`
- `electron/wikiService/referenceParsers.test.ts`
- `electron/wikiService/fullGeneration.ts`
- `electron/wikiService/fullGeneration.test.ts`
- `electron/wikiService/sessionRuntime.ts`
- `electron/app/nativeWikiModel.ts`

一处对 stash 版本的修正：`sectionsFrom()` 原本把单对象的 `children` 也铺平进同一层（`return [v, ...v.children]`），这会与 `node()` 自身的递归重复，同一个子树既成为兄弟又成为子节点。恢复后的版本只返回 `[v]`，由 `node()` 递归，新增用例断言「单对象 + 声明了 children」只产生一个根节点。

stash 本身保留未动，便于回溯。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 解析：4 份真实响应（root YAML / root 标量外形 / child 单对象 / child 未转义引号）、截断仍失败、缺 `prompt` 仍失败 | `npx vitest run --project main electron/wikiService/referenceParsers.test.ts` | 11 项通过 |
| 渲染：10 个 purpose/分支与 golden 逐字相等 | `npx vitest run --project main electron/wikiService/referencePrompts.test.ts` | 3 项通过（修复前该文件 1 项红） |
| 失败分类 + 重试策略 + 空响应指令 | `npx vitest run --project main electron/wikiService/fullGeneration.test.ts` | 13 项通过 |
| 真实 child 端到端 | `node --import tsx scripts/test-repo-wiki-flow.mjs` | 9 文件 / 50 项通过 |
| 一条命令复验 | `node --import tsx scripts/verify-repo-wiki-catalogue.mjs` | 4/4 份真实响应解析；端到端 50 项通过 |
| wiki 链路单测 | `npx vitest run --project main --maxWorkers=2 electron/wikiService electron/knowledgeProcess` | 21 文件中 19 通过；2 个 git 夹具文件因默认 5s 超时失败，`--testTimeout=60000` 后 11/11 通过（OneDrive 目录下 git 子进程慢，非逻辑问题）|
| 知识内核 | `npx vitest run --project main --maxWorkers=2 electron/agentData/knowledgeKernel` | 194 项中 193 通过；`incremental.test.ts` 同样为超时，放大后 9/9 |
| 类型检查 | `npx tsc -p tsconfig.repo-wiki.json --noEmit` / `-p tsconfig.json` | 均通过 |

未验收：真实模型、真实供应商、桌面应用内实际点击、`CATALOGUE_OUTPUT_*` 的中文文案。渲染层 `RepoWikiWorkspace.knowledge.test.tsx` 9 项红是 `nativePrimary` 下内核概览本就不渲染（`App.tsx:240`），与本链路无关且早于本轮修改。

## 第二轮仍然存在的风险

- 空响应（`out=1`）的根因在供应商侧，我只能在重试与指令上提高成功率，不能保证模型不再返回空。若某个 child 两次都空，该节点仍会失败并触发 `CATALOGUE_CHILD_OUTPUT_INVALID`。
- 未转义引号修复基于“引号后不是结构化字符”的启发式。若模型写出更离谱的损坏，仍会被判失败——这是有意的：宁可重试，也不发布一棵可能错的目录树。

