# Agent Note: 可读文件默认在右侧「文件」标签里打开

Status: implemented

## Problem

对话里「已交付文件」卡片（`TurnTail.tsx` 的 `PresentedFileCard`）和审查标签的「打开文件」按钮都调用 `openPath`，即 `shell.openPath` 交给系统默认程序。用户只想快速看一眼 md / json / 日志 / 源码，却被切到外部编辑器。右侧「文件」标签（`FileExplorer`）本来就能预览这些内容，只是外部没有入口把路径交给它：`FilePayload` 只有 `{ workspace }`，打开哪个文件是 `useOpenFile` 的组件内状态，只有点文件树才会改。

## Decision

### 1. 判定规则：沿用现有规则，不新增

「可读」以现有 `FileExplorer` 的实际判定为准，不引入扩展名白名单。

| 判定点 | 现有规则 | 出处 |
| --- | --- | --- |
| 渲染分类 | 按扩展名：`md/markdown/mdx` → markdown 预览；`png/jpg/jpeg/gif/svg/webp/bmp/ico` → 图片；其余一律按 text 走 | `fileExplorer/fileKinds.ts` `fileKindOf` |
| 是否二进制 | 读开头 8000 字节，含 NUL 即二进制（和 git 同一条） | `fileService.ts` `readForView` / `BINARY_SNIFF_BYTES` |
| 大文件 | `> 5 MB` 只读前 5 MB 并标 `truncated`；`> 2 MB` 编辑器关掉折叠、括号匹配等重扩展 | `MAX_VIEW_BYTES` / `LARGE_TEXT_BYTES` |
| 范围 | 必须在工作区内，符号链接逃逸也拒绝 | `safeWorkspacePath` |

据此，入口调 `openWorkspaceFile(path, workspace)`（`features/dock/openWorkspaceFile.ts`）：

- 图片扩展名：跳过探测，直接进右侧标签，用查看器现有的内联预览（用户确认图片也在右侧看）。
- 其余先调一次 `read_file_view`：返回 `binary`，或 `truncated`（超过 5 MB），就调原来的 `openPath` 走系统程序，不开标签（用户确认超过 5 MB 不算可读）。
- 其余（通过探测的文本）在右侧标签里打开。
- 探测本身读失败（不存在、权限不足、越界）不回退系统打开，仍交给右侧标签，由查看器现有的错误态显示「打不开这个文件：…」加「重试」。
- 路径解析与工作区之外的文件：见 [会话切换工作目录后找不到文件](../bug-fix/2026-10-16-session-cwd-file-paths.md)。入口用 `resolveSessionFile` 得到绝对路径和可读根目录；项目根之外的文件以该目录为根另开「文件」标签，含 `..` 的路径或没有工作区时才置灰。
- 探测只复用 `read_file_view` 的返回，没有新增判定标准；代价是大文件最多多读一遍 5 MB。

文件树里手动点开的二进制或大文件不受影响，仍是现有的「不支持预览」与截断横幅。

### 2. 统一入口：请求通道

- `openLauncherTab` 返回激活或新建的标签 id。`openWorkspaceFile` 用它在 `right` 区找当前会话里已有的该工作区「文件」标签并激活，没有才建（`findExisting` 按 region + workspace 去重，只看当前会话可见的标签，见 [右侧边栏跟会话走](../bug-fix/2026-10-16-right-dock-session-binding.md)），面板没展开则展开。
- 要打开的路径通过 `stores/fileOpenRequests.ts` 的一次性请求交给该标签：`byTab[tabId] = { path, nonce }`，只放内存。不写进 `FilePayload`：payload 会持久化，且 `snapshotClosedTab` / `findLiveForRestore` 会带着它，重启或恢复关闭的标签时会莫名重开文件。
- `FileExplorer` 订阅自己 `watchId`（即标签 id）的请求。根目录列出来之后接手：先 `consume`（nonce 对不上说明期间来了新请求，留着），把路径用 `toTreePath` 改写成树里的形式（以列目录返回的根和分隔符为准，选中项比较与点树一致），调与点文件树相同的 `useOpenFile.open`，再把祖先目录列出并展开（`ancestorDirs`）。标签刚建出来时请求先留在 store 里，组件挂载并拿到根后才消费。

### 3. 入口清单

| # | 入口 | 现状 | 处理 |
| --- | --- | --- | --- |
| 1 | 已交付文件卡「打开」按钮、卡片整块点击（`TurnTail.tsx`） | `openPath` → 系统程序 | 改调 `openWorkspaceFile`；成功后状态文字按去向写「已在右侧文件标签中打开」或「已在默认程序中打开」 |
| 2 | 同一张卡下拉「用默认应用打开」 | `openPath` | 保留为系统打开（`run('system')`），是显式覆盖入口，不拦截 |
| 3 | 同一张卡下拉「在文件资源管理器中显示」 | `revealItemInDir` | 不变 |
| 4 | 审查标签工具栏「打开文件」（`TurnReviewBody.tsx`） | `openPath` | 改调 `openWorkspaceFile`，失败弹 `message.error` |
| 5 | 已编辑 N 个文件的各行（`TurnTail` → `openTurnReview`） | 打开审查标签看 diff | 不变，已在右侧，且是 diff 视图 |
| 6 | 文件树点击 | 已在右侧 | 基线，不变 |
| 7 | 启动器 / 加号菜单的「文件」 | 开标签，不带文件 | 不变 |
| 8 | 文件查看器里「用系统打开」（二进制、截断横幅、工具栏，走 `open_workspace_file`） | 系统打开 | 不变，是显式系统打开 |
| 9 | Agent 数据代码索引「使用系统打开文件」（`CodeSourceDetail.tsx`） | 系统打开 | 不变：面板自带带行号的源码预览，按钮文案就是显式系统打开；它的 workspace 是索引项目，不一定是当前会话工作区 |
| 10 | 目录 / URL 类 `openPath`（`CodeRetrievalPanel`、`WikiLibrary*`、`RuntimeTab`、`extensionCards` 的 `fetch_url`、`PageContentViewer`） | 打开目录或网页 | 不是文件，不变 |
| 11 | 图片 / 音频卡的「在文件夹中显示」（`extensionCards.tsx`） | reveal | 不变 |
| 12 | `agentData_diagnostics_open`、`open_skills_dir` | 主进程直接 `shell.openPath` | 不变：诊断文件在工作区外，技能目录是目录 |

没有入口、本次不补的（用户确认只改已有入口）：

- 搜索结果：`GrepCard` / `CodeSearchCard` / `GlobCard` 的文件行没有点击打开动作。
- 报错、日志里的文件路径：代码里没有解析并可点击的逻辑；对话里的 `@path` 标签（`messageTags.tsx`）只渲染成标签；终端也未发现链接处理。
- 聊天 Markdown 里的普通链接是否经 Electron 默认导航处理，没有核对到主窗口的导航配置，本次不动。

无法统一的例外：无。工作区外的文件原本无法读取（`safeWorkspacePath` 越界即拒），现在由入口选出能读到它的根目录再打开，主进程的越界检查不变。

### 4. 打开后的表现

- 面板未展开则展开；已展开不动宽度。面板宽度、文件树宽度（`localStorage` 的树宽）、文件树收起状态都不被改写。
- 内容区按现有逻辑：md 默认预览、代码默认只读、可滚动；Ctrl+E 才进编辑；文件树可收起 / 展开，面板可收起。
- 同一文件重复打开：标签层聚焦已有标签；文件层靠 `useOpenFile.open` 里「同路径且非 error 直接返回」，不重载、不产生第二个视图。
- 打开另一个文件：`useOpenFile` 是单文件模型，会替换当前文件，先走 `resolveUnsaved`（保存 / 放弃 / 取消）。选「取消」则保持原文件，未保存内容不丢。入口不弹额外提示，也拿不到取消结果，所以卡片状态文字只表示「已交给右侧标签」。
- 文件树当前选中项跟着新文件走，祖先目录自动展开并加载。

### 5. 用户覆盖

仓库里没有「按文件或按类型记住打开方式」的设置，也没有存储。显式选择就是当次动作：点「用默认应用打开」或「用系统打开」就是系统打开，默认行为不拦截、不改回。「记住选择」不做（用户确认），否则等于新增一套设置和存储。

### 6. 约束与降级

- 全程只读：`readForView` 只读盘；默认模式是预览 / 只读，不会因打开而写盘。写盘只发生在用户编辑后点保存（`write_file` 原子 tmp + rename）。唯一新增的磁盘相关动作是目录监听（`watch_workspace_dirs`），它不改文件。
- 编码：读取按 UTF-8 解码，保留 BOM；保存时保持原 CRLF / LF。已知局限：非 UTF-8 文件（如 GBK）会显示乱码，只读模式下不会写坏；这是现有行为，本次不改。
- 失败都落在内联状态，不弹阻断窗口，且可重试：
  - 文件不存在：`File does not exist`，右侧显示「打不开这个文件：…」加「重试」。
  - 越界：`Path escapes workspace`。
  - 权限不足等 fs 错误：同一错误态，带系统错误信息。
  - 二进制与超过 5 MB：入口探测后直接系统打开，不进右侧。
  - 系统打开失败：卡片显示「打开失败，点击重试」；审查标签弹 `message.error`。

## Alternatives considered

- 按扩展名白名单决定走右侧还是系统。最强理由：二进制能不读盘就直接交给系统，没有探测那一遍多读。不用：扩展名清单是新判定标准，与「以既有规则为准」冲突，且 `fileKindOf` 本身就把未知扩展名当 text，权威判定在读内容的 NUL 嗅探。
- 每个可读文件开一个独立标签。最强理由：和「同一文件重复打开聚焦已有视图」字面最一致，也能同时留多个文件。不用：`FileExplorer` 是单文件模型，脏检查、目录监听、`registerUnsaved`、`setDockCloseGuard` 都按标签挂一份，改成多文件是重构；现在的标签级去重加文件级去重已满足「不重复」。
- 把要打开的路径放进 `FilePayload`。最强理由：实现最短，复用 `updateTab`。不用：payload 持久化，重启和「恢复关闭的标签」会带出一个没人请求的文件。
- 不探测，直接进右侧，让查看器提示二进制不支持。最强理由：不多读一遍。不用：压缩包、视频这类文件会白切一次面板再让用户点「用系统打开」，用户已选择先探测。

## Consequences

- 收益：看文件不再离开应用；二进制与超大文件体验不变；已有的「未保存修改」保护对外部入口同样生效。
- 代价：非图片的入口多一次 `read_file_view`，大文件最多多读 5 MB；`openLauncherTab` 返回值从 void 变为标签 id（兼容现有调用）。
- 请求只存内存：应用重启后不会重开，也不进恢复关闭标签的快照。
- 卡片状态文字无法反映用户在「未保存」弹窗里选了取消，只表示已交给右侧标签。
- 非 UTF-8 文本显示乱码，用户可能误以为内容损坏（现有行为）。
- 大小写：`toTreePath` 保留请求里的文件名大小写，在大小写敏感比较下，若请求大小写与磁盘不一致，选中项高亮可能对不上（Windows 下读盘不受影响）。

## 验证

verify: n/a 真实启动应用走用户路径：仓库当前没有 `verify-*` skill；改用下面的测试与 UI harness。

- `cd electron-agent && npx vitest run src/features/dock src/features/chat src/features/tools src/features/panels src/features/fileExplorer src/stores`：通过（含 `openWorkspaceFile.test.ts`、`FileTreeBody.test.tsx` 新增 3 例、`TurnTail.test.tsx`、`TurnReviewBody.test.tsx`、`treeModel.test.ts`）。
- `cd electron-agent && npm run ui:check -- file-explorer`：通过（73 passed, 0 failed），新增「外部请求打开」段：未展开目录里的 md 被打开并展开、选中；文件树宽度、文件标签宽度、树收起状态不变；同一文件重复请求不重读盘、不重复视图；不存在的文件显示错误与重试；出错后再请求其他文件恢复。只跑了该场景，其余 17 个没跑。
