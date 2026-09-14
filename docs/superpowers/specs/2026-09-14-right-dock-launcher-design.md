# 右坞快捷通路（对齐 Codex 空栏）

- 日期：2026-09-14
- 范围：GrenAgent 桌面端右坞 / 底坞空态、快捷入口、关尽收栏、顶栏底坞按钮；新增 `file` / `review` 两种 tab
- 状态：已对齐（头脑风暴 2026-09-14）
- 不取代：子代理 tab、网页阅读 tab、浏览器/终端 body 的既有实现；视觉伴侣面板（`VisualPanel` 仍按现状替换整块右坞）

## 1. 背景与问题

右坞空着时只有一句「暂无内容…」，没有入口。Codex 在空右栏放一列工具通路（审查 / 终端 / 浏览器 / 文件），点哪一项就在这一侧打开。GrenAgent 已有坞 tab、互拖、浏览器和底栏终端，缺的是空态通路和「这一侧 tab 清完就收栏」。

另外：`dockStore.moveTabRegion` 把终端钉死在底坞，和「两侧坞都能放终端」冲突，本期要拆掉这道钉。

## 2. 目标 / 非目标

**目标**

- 某一侧坞 `tabs.length === 0` 且该侧展开时，整栏是快捷通路，没有空 tab 条，也没有「暂无内容」提示。
- 项目会话通路：审查、终端、浏览器、文件。普通对话通路：浏览器、终端。
- 点通路在**当前这一侧**开 tab；快捷键一律在右坞开（关着就先开右坞）。
- 这一侧最后一张 tab 关掉，或被拖到对面：这一侧整栏收起，不回到通路。
- 顶栏原终端图标改成底坞展开/收起（不再表示「新开终端」）。
- 文件：工作区文件树 tab。审查：占位 tab，本期不做 diff。

**非目标**

- 不做 Codex Review / Git diff 审查内容（审查只占位）。
- 不做坞内文件编辑器；文件树只展开目录、列出文件。
- 不改子代理 / 网页阅读 / 项目上下文 tab 的打开条件。
- 不改 `VisualPanel` 占用右坞的现有替换逻辑。
- 不新做底坞专用另一套入口文案：底坞空态用**同一套** `DockLauncher`。
- 不改 `resetWorkspaceTabs`「曾经有终端则底栏留一张 idle」的换工作区行为。

## 3. 已确认的设计决定

| 维度 | 决定 |
| --- | --- |
| 空态结构 | 方案 A：没 tab 时整栏即通路；有 tab 才出现 TabStrip |
| 终端开在哪 | 点哪一侧通路就在哪一侧开；快捷键走右坞 |
| 两坞内容 | 浏览器、终端、文件、审查、子代理、page 都可以在两侧；互拖保留 |
| 审查 | 本期入口 + 占位，无 diff |
| 文件 | 当前工作区文件树 |
| 关尽 | 该侧整栏收起，不回到通路 |
| 顶栏原终端图标 | 只切底坞 expand（`terminalOpen`） |
| 浏览器 / 终端 | 每次点开新 tab |
| 文件 / 审查 | 这一侧已有则激活，不重复开 |

## 4. 会话类型

与侧栏同一口径（`useProjectGroups` / `isUnder(cwd, worksDir)`）：

- **普通对话**：当前会话 `cwd` 落在 works 目录下（侧栏「对话」分组）。
- **项目会话**：其余有 `cwd` 的会话。

`cwd` 尚未就绪时按普通对话处理（只给浏览器、终端），避免空工作区点开文件树。

## 5. 界面状态

### 5.1 空栏通路

没有 tab 条。每行：lucide 图标、名称、右侧快捷键。审查打开后的 body 才写占位说明，通路行上不写「占位」。

项目会话四行，从上到下：

1. 审查
2. 终端
3. 浏览器
4. 文件

普通对话两行：浏览器、终端。

不可用：没有工作区时「文件」行禁用（不可点、快捷键无效）。普通对话不渲染审查、文件。

### 5.2 有 tab

现有 `TabStrip` + `TabBodyStack`。通路隐藏。顶栏右坞折叠按钮仍在 strip 的 actions 里（现有 `onCollapse`）。底坞 strip 的 `+` 仍可新建终端。

### 5.3 顶栏

- 面板按钮：右坞关着时出现，点开右坞（0 tab → 通路）。现有 `MainHeaderActions` 行为保留。
- 原 `SquareTerminal`：改成底坞展开/收起，`title` 为「底栏」，`active` 仍绑 `terminalOpen`。图标用 lucide 的底栏/面板类图标（例如 `PanelBottom`），不用终端图标，避免和通路「终端」抢语义。

## 6. 打开 / 关闭

### 6.1 打开

| 动作 | 结果 |
| --- | --- |
| 顶栏开右坞 / 底坞 | 对应 `rightPanelOpen` / `terminalOpen` = true；0 tab 显示通路 |
| 通路点某一行 | 在 **launcher 所在 region** `addTab` |
| `Ctrl+T` / `Ctrl+\`` / `Ctrl+P` / `Ctrl+Shift+G` | 在 **right** `addTab`（或激活已有文件/审查）；右坞关着则先 `setRightPanelOpen(true)` |
| 普通对话下的 `Ctrl+P` / `Ctrl+Shift+G` | 忽略 |
| 现有 `openPage` / `openSubAgent` / … | 不变，仍开右坞 |

`addTab` 已有「往哪侧加就展开哪侧」，继续用。

### 6.2 关掉

在 `closeTab` 之后：若该 tab 原先所在 region 已无 tab，则该侧收起（right → `setRightPanelOpen(false)`，bottom → `setTerminalOpen(false)`）。

在 `moveTabRegion` 成功之后：

1. 目标侧展开（已有）。
2. 若源侧已无 tab，源侧收起。

不允许把最后一张 tab 挪走后源侧停在空通路——关尽即收栏。

### 6.3 必须删除的钉死逻辑

`dockStore.moveTabRegion` 里「终端拒绝移入右坞」删掉。终端可以进右坞，也可以留在底坞。

## 7. 架构

```
MainHeaderActions
  面板按钮 → toggleRightPanel
  底栏按钮 → toggleTerminal

DockPanel(region)
  tabsInRegion.length === 0 → DockLauncher(region)
  else → TabStrip + TabBodyStack

DockLauncher
  items = project ? [review, terminal, browser, file]
                  : [browser, terminal]
  onSelect(kind) → openLauncherTab(region, kind)

openLauncherTab
  browser | terminal → 永远 new id
  file | review → 同 region + 同 kind 则 setActive，否则 addTab
```

**新文件**

- `electron-agent/src/features/dock/DockLauncher.tsx`（及测试）：空态通路
- `electron-agent/src/features/dock/launcherItems.ts`（及测试）：项目/普通对话条目、禁用规则
- `electron-agent/src/features/dock/FileTreeBody.tsx`（及测试）：`file` tab
- `electron-agent/src/features/dock/ReviewPlaceholderBody.tsx`（及测试）：`review` tab

**改现有**

- `dockStore.ts`：`DockTabKind` 增加 `'file' | 'review'`；拆掉终端钉底坞；`closeTab` / `moveTabRegion` 关尽收栏
- `TabBodyRenderer.tsx`：挂 `file` / `review`（注释里的阶段 2/3 占位改成这两个 kind；本期 `review` 不是 diff）
- `DockPanel.tsx`：空态换 `DockLauncher`；去掉 Globe 仅开浏览器的空提示依赖（Globe 可保留为「再开一个浏览器」，仅在**已有 tab** 的 strip actions 里）
- `MainColumnHeader.tsx`：终端图标改为底坞按钮
- `useKeyboardShortcuts.ts` 或坞级 hook：四条快捷键
- `layoutStore`：不必新字段；继续用 `rightPanelOpen` / `terminalOpen`

## 8. tab 载荷

- `file`：`{ workspace: string }`，id 建议 `file:${region}:${workspace}`，保证两侧可各有一棵树。
- `review`：无需载荷或 `{ workspace: string }`，id 建议 `review:${region}`。
- 浏览器 / 终端：沿用现有 payload；id 继续时间戳，保证每次新开。

文件树数据走现有工作区文件 API（`get_file_tree` / `lib/files.ts`），失败时 body 内错误 + 重试，不关坞。

## 9. 错误

- 文件入口在无工作区时禁用。
- 文件树请求失败：tab 内错误文案和重试，坞保持打开。
- 审查占位无失败态。
- 浏览器、终端错误沿用 `BrowserBody` / `TerminalBody`。

## 10. 测试

全部 vitest，不要求 Electron 真窗。

1. `launcherItems`：项目 4 项、普通对话 2 项；无 cwd 时文件禁用。
2. 点通路：`addTab` 的 region 等于 launcher 的 region；浏览器/终端 id 不复用；文件/审查第二次点只 `setActive`。
3. `closeTab` 关最后一张 → 对应 `rightPanelOpen` 或 `terminalOpen` 为 false。
4. `moveTabRegion` 移走最后一张 → 源侧收起、目标侧打开；终端可以移入右坞。
5. 顶栏底坞按钮只切换 `terminalOpen`。
6. `FileTreeBody`：成功列出节点；失败显示错误，不调用收栏。
7. 快捷键：项目会话 `Ctrl+T` 开浏览器右 tab；普通对话 `Ctrl+P` 不建文件 tab。

## 11. 非范围的明确行为

- 换工作区仍走 `resetWorkspaceTabs`：若换前有终端，底栏会留下一张 idle 终端（现有行为），因此换工作区后底坞可能仍开着，不是通路。这是有意不改。
- 通路视觉对齐 Codex 的「一行入口 + 右侧快捷键」，用现有暗色 token 和 lucide，不引入 emoji。
