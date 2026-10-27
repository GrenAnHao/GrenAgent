# Agent Note: 文件管理器文件树的右键菜单

Status: implemented

## Problem

文件管理器的文件树只能左键打开文件。想把某个文件交给 agent，要回到输入框里 `@` 搜一遍；想在系统资源管理器里找到它、或者拿它的路径，只能先打开文件再去路径栏。用户要求给文件树加右键菜单：添加到对话、在文件资源管理器中显示、复制路径、复制相对路径。

## Decision

- 菜单项和分组（`fileExplorer/useFileTreeMenu.ts`）：「添加到对话」｜「在文件资源管理器中显示」（按平台叫法，`lib/revealLabel.ts`，和交付卡共用：Windows 资源管理器 / macOS「在 Finder 中显示」/ 其余「打开所在文件夹」）｜「复制路径」「复制相对路径」，组之间用分隔线。文件和目录是同一份菜单。右键不打开文件、不改选中，被右键的那一行描一圈主色边框（`data-menu-open`），菜单关掉后去掉。
- 复制路径给文件树里的原样绝对路径；复制相对路径相对文件树的根，规则和底部路径栏相同（`displayPath(root, path, 'relative')`）。复制成功弹「已复制：<路径>」，剪贴板不可用弹错误。
- 在资源管理器中显示走已有的 `revealItemInDir`（主进程 `shell.showItemInFolder`），失败弹原因。
- 添加到对话：`composerBridge` 新增一条接缝 `registerComposerInsertFile` / `addFileToComposer`。`ChatInput` 注册的实现往编辑器发 `INSERT_CHAT_TAG_COMMAND`，插入一个和 `@` 提及一样的文件 / 目录标签（发出去是 `@路径`），然后保存草稿、把焦点给输入框。输入框没聚焦过时 Lexical 把标签放在末尾，聚焦过就插在光标处。输入框没挂上（没有对话视图）时返回 false，菜单弹「当前没有可以添加的对话输入框」。
- 标签里的路径按**输入框所在会话**的工作区写（`composerFileTagValue`）：文件管理器标签的工作区和会话相同（`pathsEquivalent`）就用文件树给的相对路径；否则文件在会话工作区下就相对它；都不是就写绝对路径。右栏标签属于某个会话、只在它被查看时显示，所以收到文件的总是当前看着的这个会话的输入框。
- 菜单只有一份：`FileTree` 在滚动容器上接 `contextmenu`，按 `closest('[data-tree-row]')` 找到行（行上新增 `data-path` / `data-name` / `data-dir` / `data-truncated`），在 `document.body` 里放一个 1px、`position: fixed` 的锚点，antd `Dropdown` 受控打开在锚点上。「条目太多」提示行和行以外的空白处不弹。点菜单项、Esc、点别处都会收起。

## Alternatives considered

- **每一行包一个 `Dropdown trigger={['contextMenu']}`（标签栏、侧栏会话就是这么做的）**。最强理由：和仓库里已有写法一致，不用自己管位置和开合。不用：文件树是虚拟化的，菜单开着时滚动会把那一行卸掉，菜单跟着消失或者挂在已经不存在的节点上；每个可见行多一层 Trigger 也没必要。标签栏不虚拟化，所以那边继续用每项一个。
- **「添加到对话」直接往输入框写纯文本 `@路径`（复用现有 `setComposerValue` / `loadIntoComposer`）**。最强理由：不用新接缝。不用：那两条会整份重写或在末尾另起一段，把已经写好的胶囊和标签变成纯文本；插标签节点和用户自己 `@` 选文件得到的结果一样，删也是一键删。
- **标签里永远写绝对路径**。最强理由：不用判断工作区，任何会话都读得到。不用：同一个项目里相对路径短、和 `@` 提及的写法一致，agent 的工具也按会话目录解析相对路径；只在跨目录时退回绝对路径。

## Consequences

- 收益：从文件树一步把文件交给 agent、定位到系统资源管理器、拿到两种路径。
- 代价 / 已知限制：
  - 只对单个文件或目录；文件树没有多选，不能一次添加多个。
  - 空白处、文件树根本身没有菜单（根不是一行）。
  - 菜单不跟随键盘（Shift+F10 / 菜单键不会弹）。
  - 复制成功用全局提示，长路径会让提示变宽。
- 契约变化：`composerBridge` 多 `ComposerFileRef`、`registerComposerInsertFile`、`addFileToComposer`、`composerFileTagValue`；`FileTree` 多可选 prop `contextMenu` 和 `TreeMenuTarget` 类型，行上多四个 data 属性；`TurnTail` 的平台叫法挪到 `lib/revealLabel.ts`，行为不变。主进程、IPC 没改。新增依赖：无。
- 相关：路径栏和相对路径规则见 [文件管理器：普通对话也有、Markdown 链接、显示路径](./2026-10-23-file-explorer-casual-links-and-paths.md)；文件标签见 [文件管理器：改名并支持多文件标签](./2026-10-23-file-manager-tabs.md)。

## Verification

- `cd electron-agent && npx vitest run src/features/fileExplorer src/features/dock src/features/chat src/stores src/features/find src/lib`：219 个文件 1745 条通过（`.agents/evidence/2026-10-23-file-tree-context-menu/vitest.log`）。新增：`composerBridge.test.ts`（同工作区用相对路径、会话在子目录时相对会话、不在下面给绝对路径、输入框没挂上返回 false）；`ChatInput.test.tsx`（插入文件 / 目录标签、值按会话工作区写、卸载后返回 false）；`FileTreeBody.links.test.tsx`「文件树右键菜单」（四项两条分隔线、行标出且不打开文件、复制路径 / 相对路径、显示交给 `revealItemInDir`、添加到对话交给输入框、输入框不在时提示）。
- `npm run ui:check -- file-explorer`：230 条通过、0 失败（`.agents/evidence/2026-10-23-file-tree-context-menu/ui-check-file-explorer.log`，截图 `shots/`）。真实右键事件下：菜单四项顺序和 Windows 叫法、两条分隔线、出现在鼠标右下方且整个在窗口内、被右键的行标出、右键不读盘不切标签、Esc / 点菜单项 / 点别处都收起并去掉标记、复制相对路径（剪贴板读回 `src/util.json`）与复制路径的提示、目录「在文件资源管理器中显示」发出 `reveal:/repo/docs`、「添加到对话」把 `{ absolute, relative: 'docs/links.md', workspace: '/repo', name, isDirectory: false }` 交给输入框、浅色主题下菜单是浅底。日志里唯一的 `MISS` 是原有的一条忽略结果的等待。
- 没覆盖：场景里没有真实输入框，标签真正插进 Lexical 编辑器只由 `ChatInput.test.tsx`（编辑器是桩，只断言发出的命令）覆盖，没有在真实应用里点过；真实 `shell.showItemInFolder` 打开资源管理器没实机验证。
