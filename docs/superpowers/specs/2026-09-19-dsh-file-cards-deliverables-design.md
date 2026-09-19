# DSH 读写编卡片与回合产物

- 日期：2026-09-19
- 范围：主对话里 read / write / edit 的展开体与流式；回合尾「已编辑 / 产物」；`present` 工具；右坞审查 tab 接入本轮工具 diff
- 状态：设计已按节批准，待实现计划
- 对照：DSH `ui-tool` 的 FileMutationRow / ReadRow / DiffBlock、`ui-deliverables` 的 ChangedFiles / PresentedFileCard、`tool-present`；不接 Host `workspace/changes`，不做左右分栏审查

## 1. 目标 / 非目标

**目标**

1. 读写编展开体不再出现文件名（标题行已有）。写入/编辑用 unified diff；读取等结果后给带行号的正文。
2. 写入/编辑在模型还在吐参数时就展开并长行；读取运行中只有标题。
3. 一轮助手说完后，在该轮回复底下出「已编辑」（本轮成功 write/edit）和产物卡（本轮成功 `present`）。
4. 点已编辑或文件行，打开右坞已有审查 tab，看这一轮同一份 diff。产物「打开」走默认应用，下拉在资源管理器中显示。

**非目标**

- 不接 git 快照，不实现 DSH Host 的 `workspace/changes`。
- bash / 其它工具改过的文件不进已编辑。
- 审查不做左右分栏、不做换行开关、不做按历史轮次切换器。
- 不做侧边栏文件预览（产物不打开预览面板）。
- 不改 CLI 展示。
- 子代理对话：卡片无文件名和流式跟着走（共用 `ToolExecution`）。`TurnTail` 只由主对话 `ChatView` 打开，子代理时间线不挂尾栏；审查只读主对话 AgentStore。

**成功标准**

- 展开 write/edit/read，正文里搜不到第二份文件名。
- 写入 running 且 `args.content` 从 `"a"` 变成 `"a\nb"` 时，绿行从 1 行变成 2 行，不必等 `tool_execution_end`。
- 读取 running 时展开体没有正文；结束后出现行号正文。
- 本轮成功 write 再 edit 同一文件：已编辑一行，`+/-` 为两次之和；没有 `present` 则没有产物卡。
- `present` 越界或文件不存在则整次失败，不进产物。
- 点已编辑打开右坞审查，选中对应文件，diff 与卡片一致。通路空开审查时看到占位文案，不猜上一轮。

## 2. 已确认的设计决定

| 维度 | 决定 |
| --- | --- |
| 展开体文件名 | 去掉。不要 pathLabel，也不要 diff/代码块第一行的路径 |
| 写入/编辑呈现 | unified diff（`+` / `-` / 上下文），标题右侧和块底都带 `+N -M` |
| 读取呈现 | 结束后带行号正文；运行中只有标题 |
| 流式 | 写入/编辑用当前参数画 intended diff；读取等结果 |
| 定格 | 有 `details.diff` 用结果；否则保持参数 diff（写入常见） |
| 标题动词 | `read`/`read_file` → 读取；`write`/`write_file` → 写入；`edit`/`search_replace`/`str_replace` → 编辑 |
| 已编辑来源 | 本轮成功 write/edit，按路径去重、首次顺序；`+/-` 各次加总 |
| 产物来源 | 只来自本轮成功 `present` |
| 打开 | 已编辑 → 右坞审查；产物打开 / 点卡片 → `openPath`；下拉 → `revealItemInDir` |
| 审查 | 填现成 `review` tab；一侧复用一张；数据与卡片同一派生 |
| 数据通道 | 从 `groupMessages` 的 turn segments 纯派生，不新开事件 |
| git | 不做 |

## 3. 架构

```text
模型吐 write/edit 参数
        │
        ▼
agentReducer 已有 running 工具卡（args 增长）
        │
        ▼
ToolExecution 默认展开
        │
        ▼
fileDiffModel(args, result, status)
        │
        ├─ running / 无 details.diff → intended（write: old=null, new=content；edit: old/new string）
        └─ done 且 details.diff 可用 → applied

一轮无 running、无 streaming
        │
        ▼
turnDeliverables(segments)
        ├─ changes[] ← 成功 write/edit
        └─ presented[] ← 成功 present 的 details.files

点已编辑
        │
        ▼
openTurnReview({ turnId, fileIndex, workspace })
        │
        ▼
右坞 review tab（复用或新建）
ReviewPayload.turnId / fileIndex
        │
        ▼
TurnReviewBody 再跑同一套 turnDeliverables + fileDiffModel
```

不新增 IPC，不新增 Host 快照。`openPath` / `revealItemInDir` 沿用现有 runtime。

## 4. 读写编卡片

### 4.1 派生

新建 `electron-agent/src/features/tools/fileDiffModel.ts`（纯函数）：

- `isFileMutation(name)`：`write` / `write_file` / `edit` / `search_replace` / `str_replace`
- `isFileRead(name)`：`read` / `read_file`
- `intendedDiff(name, args)`：
  - write：`path` 非空且 `content` 为 string（可空串）→ `{ path, oldText: null, newText: content }`
  - edit：`path` 非空，且 `oldText`/`old_string` 与 `newText`/`new_string` 为 string，或 `edits[]` 里至少一对 → 拼成一段 old/new（多对用 `\n...\n` 连接，与现 `getEditTexts` 一致）
  - 参数不完整（流式半截、缺字段）→ 有多少用多少：write 缺 content 则 `newText=""`；edit 缺一侧则当空串。不把半截 JSON 当错误。
- `appliedDiff(result)`：沿用现 `getDiff`；能解析再返回，否则 `null`
- `fileDiffModel(...)`：
  - 失败（`status==='error'`）→ `null`（卡片走错误文本，不画 diff）
  - running 或 `appliedDiff==null` → intended
  - 否则 applied
- `diffTotals(diff)`：按行统计。去掉文本末尾单独空行后再数。`+` 行进 added，`-` 行进 deleted，上下文不计。write 的 intended（old=null）每一行都是 `+`。

读取不走 diff。正文 = `extractText(result)`。

### 4.2 呈现

- 去掉 `ToolDetail` 读/写下的 `pathLabel`，去掉 `EditPreview` 的 `pathLabel`。
- 写入/编辑展开体用新建 `FileDiffBlock`：顶栏只留「复制」，不要文件名，不要「修改上下文 / 全部修改」。中间限高，超出后中间折叠、两端可见（对齐 DSH DiffBlock 的 fold）。底栏：`+N -M · 1 个文件`。`EditPreview.tsx` 删除，原测试迁到 `FileDiffBlock` / `ToolExecution`。
- 读取展开体：顶栏只留「复制」，左侧行号，右侧正文。运行中且还没有 `extractText(result)`：不渲染这块。
- `ConvRow` 标题：`name` 用上表中文动词；`args` 仍是 `fileNameFromPath`。`meta` 在有 totals 时写 `+N -M`（绿/红，与现卡片统计色一致）。
- 复制：写入/编辑拷贝可见 unified 文本（带 `+`/`-` 前缀，不含路径行）；读取拷贝正文（不含行号）。剪贴板失败则按钮仍显示「复制」。
- 展开态：保持 `useState(status === 'running')`。运行中挂上则默认展开；完成后保持用户是否收起。

`EditPreview.test.tsx` / `ToolExecution.test.tsx` 里「文件名出现两次」的断言改成只在标题出现一次。

## 5. `present` 工具

新建扩展 `extensions/present/`，并挂进 `extensions/index.ts`。

**参数**

```ts
{
  files: Array<{
    path: string           // 必填，非空
    description?: string   // 给用户看的一句说明
  }>
}
```

单次 1–8 个文件。超过、为 0、任一条失败 → 整次失败，不写 details.files。

**执行**

1. 每条 `path` 相对 `ctx.cwd` 解析；必须落在工作区内（用现有 workspace containment，与 write 越界同一套）。
2. 必须存在且是普通文件（不是目录、不是断掉的链接目标）。
3. 成功返回：

```ts
{
  content: [{ type: 'text', text: files.map(f => `Presented ${f.path}`).join('\n') }],
  details: { files: Array<{ path: string; description?: string }> }
}
```

`path` 保持模型传入的写法（不去改成绝对路径），好和已编辑的 display 对齐。

**提示词（description + promptGuidelines）**

用户要收下的产出，写完后、最终回复前必须 `present`。只在回复里写路径不算交付。文件必须已经存在。

**时间线**

`ToolExecution` 把 `present` 收成一行，不展开 body：

- running：交付文件 · 正在交付
- done：交付文件 · 第一个文件名（多个则 `· N 个文件`）
- error：交付失败 · 首行错误

产物卡只出现在回合尾，不在这一行下面。

**模式**

`present` 不写盘，Ask / Plan 不拦截。

## 6. 回合尾

新建 `electron-agent/src/features/chat/turnDeliverables.ts`：

```ts
type ChangeFile = { path: string; display: string; added: number; deleted: number }
type PresentedFile = { path: string; display: string; description?: string }

function turnSettled(segments): boolean
  // 无 tool.status==='running'，无 thinking/text.streaming

function changesForTurn(segments): ChangeFile[]
  // 成功 write/edit；路径 = 参数 path / file_path
  // 同 path 首次保留顺序；added/deleted 累加 fileDiffModel 的 totals
  // 失败、无 path、无有效 diff 的跳过

function presentedForTurn(segments): PresentedFile[]
  // 成功 present 的 details.files
  // 同 path 后一次覆盖 description，顺序按首次出现
```

`turnId` = 该条 `DisplayMessage`（`kind:'turn'`）的 `id`，也就是 `groupMessages` 里本轮第一条 assistant 的 id。

主对话的 `TurnTimeline` 增加可选 `showDeliverables`（仅 `ChatView` 传 `true`）。为 true 且 `turnSettled` 且 changes/presented 非空时，在 `rows` 之后、`ChatItemShell` 之内渲染 `TurnTail`。子代理时间线不传该开关。

**已编辑**

- 标题：「已编辑 {n} 个文件」，右侧合计 `+N -M`。
- 文件行：`display`（basename）+ 该文件 `+/-`。
- 超过 3 个默认只显示前 3，底下「全部 n 个文件 / 收起」。
- 点标题 → `openTurnReview({ turnId, fileIndex: 0 })`。
- 点第 i 行 → `fileIndex: i`（展开前后都用原始下标，不要用折叠后的下标）。

**产物**

- 卡片：类型图标、basename、description（没有则退回扩展名大写或「文件」）。
- 「打开」=`openPath(resolved)`；下拉「在文件资源管理器中显示」=`revealItemInDir`（macOS 文案用「在 Finder 中显示」）。
- 点卡片空白与「打开」相同。
- 打开/定位失败：描述换成错误句，可再点。
- 超过 4 张默认显示前 4，底下展开。
- 解析路径：工作区 `cwd` + 模型 path。解析失败则打开按钮不可用，描述写「没有可用的主机路径」。

回合还在跑时不渲染尾栏。刷新/重开会话后，从历史消息再派生一次，不另存一份。

## 7. 审查 tab

`ReviewPayload` 扩成：

```ts
{ workspace?: string; turnId?: string; fileIndex?: number }
```

新建 `openTurnReview({ turnId, fileIndex, workspace })`：

- 区域固定右坞，并展开右坞。
- 已有 `kind==='review'` 的右坞 tab：激活，并 `updateTab` 写入 turnId/fileIndex/workspace。
- 没有：新建，标题「审查」。
- **不**走 `canOpenLauncherKind`。普通对话从已编辑进来也要能开。

通路 / `Ctrl+Shift+G` 仍走现 `openLauncherTab('review')`：不写 turnId。`TurnReviewBody` 在 `payload.turnId` 为空时显示：「从对话里的已编辑进来，查看本轮改动。」不自动选上一轮。

`TabBodyRenderer` 把 `review` 从 `ReviewPlaceholderBody` 换成 `TurnReviewBody`。占位组件和「审查尚未接入」测试删掉或改成新空态测试。

**面板**

- 工具条：「本轮改动 · n 个文件」+「打开文件」（当前选中文件 `openPath`）。
- 文件列表：与已编辑同一 `changesForTurn`。选中项高亮。`fileIndex` 越界则落到 0。
- 下方 unified diff：该 path 在本轮每一次成功 mutation 各出一块 hunk，时间顺序与卡片一致（先 write 全绿，再 edit 红绿），不要压成「第一次 old + 最后一次 new」。块内不写文件名。
- 该轮找不到、无改动、拼不出 diff：各写一句（「找不到这一轮」「这一轮没有文件改动」「改动内容已不可用」）。
- 不做分栏、不做换行开关。列表和 diff 各自滚动。

审查读当前主对话 `AgentStore` 的 messages → `groupMessages` → 按 `turnId` 找 turn。工作区切换后若 turnId 对不上，走「找不到这一轮」。

## 8. 错误处理

| 情况 | 行为 |
| --- | --- |
| write/edit `status==='error'` 或无 path | 工具行错误；不进已编辑 |
| 流式参数半截 | 按已有字段画；不报错 |
| present 任一条非法 | 整次失败，无 details.files |
| 复制失败 | 按钮保持「复制」 |
| openPath / reveal 失败 | 产物描述改错误句，可再点 |
| 审查无 turnId | 空开占位文案 |
| 审查 turnId 找不到或无 changes | 对应一句，不空白 |

## 9. 测试

纯函数优先，组件测行为不测像素。

- `fileDiffModel`：write intended 全绿；edit 红绿；`details.diff` 覆盖 intended；error → null；末尾空行不进 totals。
- `ToolExecution`：标题「写入」+ 文件名一次；展开体没有文件名；running 时 content 变长、绿行变多；read running 无 `code-surface`/正文。
- `turnDeliverables`：write+edit 同文件一行且 +/- 加总；read/error 不进；无 present 则 presented 为空；未 settled 则 TurnTail 不渲染。
- `present` 扩展：工作区内普通文件通过；越界、不存在、目录、0 个、9 个失败。
- `openTurnReview`：无 tab 则建；有则复用并写入 payload；普通对话也能开。
- `TurnReviewBody`：有 target 列出文件并显示 diff；空开是占位句；点第二行切换 diff。

不写 Electron 窗口 e2e。

## 10. 文件清单

| 路径 | 动作 |
| --- | --- |
| `electron-agent/src/features/tools/fileDiffModel.ts` | 新建 |
| `electron-agent/src/features/tools/fileDiffModel.test.ts` | 新建 |
| `electron-agent/src/features/tools/FileDiffBlock.tsx` | 新建 |
| `electron-agent/src/features/tools/ToolExecution.tsx` | 改：无 pathLabel、中文动词、present 行、走 FileDiffBlock |
| `electron-agent/src/features/tools/ToolExecution.test.tsx` | 改 |
| `electron-agent/src/features/tools/EditPreview.tsx` | 删除 |
| `electron-agent/src/features/chat/turnDeliverables.ts` | 新建 |
| `electron-agent/src/features/chat/turnDeliverables.test.ts` | 新建 |
| `electron-agent/src/features/chat/TurnTail.tsx` | 新建 |
| `electron-agent/src/features/chat/TurnTimeline.tsx` | 改：挂 TurnTail |
| `extensions/present/index.ts` | 新建 |
| `extensions/present/present.ts` | 新建（校验） |
| `extensions/present/present.test.ts` | 新建 |
| `extensions/index.ts` | 挂 present |
| `electron-agent/src/stores/dockStore.ts` | `ReviewPayload` 加 turnId / fileIndex |
| `electron-agent/src/features/dock/openLauncherTab.ts` | 加 `openTurnReview` |
| `electron-agent/src/features/dock/TurnReviewBody.tsx` | 新建，替换占位 |
| `electron-agent/src/features/dock/TabBodyRenderer.tsx` | 换 body |
| `electron-agent/src/features/dock/ReviewPlaceholderBody.tsx` | 删除 |

现有 `openPath` / `revealItemInDir` / `fileNameFromPath` / `getEditTexts` / `getDiff` 复用，不平行再写一套路径工具。
