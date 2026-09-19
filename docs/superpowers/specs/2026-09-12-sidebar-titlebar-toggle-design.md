# 会话列表折叠迁到标题栏

- 日期：2026-09-12
- 状态：规格已审查，可按计划实现
- 主题：折叠按钮钉在标题栏最左，不再位移；侧栏空顶栏去掉；π 落到空会话标题左侧。

## 1. 目标

会话列表的开合按钮现在在侧栏 44px 空顶栏右侧。点下去之后侧栏消失，展开钮出现在主列顶栏左侧，鼠标对不上。空顶栏本身也浪费纵向空间。

改完之后：

1. 标题栏最左边是折叠图标，不再显示 π。旁边仍是 GrenAgent 字样。开合都点这一颗，窗口坐标不变。
2. 侧栏不再有空顶栏。列表从搜索框开始。
3. 主列顶栏不再出现「侧栏没了才冒出来」的展开钮。
4. π 出现在空会话标题左侧，和「我们该做什么？」组成一行。

成功标准：点标题栏折叠图标收起列表后，同一位置再点就能开回来，不必挪鼠标。空会话标题与 π 的笔画高度、间距按下节锁定值，不靠临场加减像素。

## 2. 布局与交互

### 2.1 标题栏

`Titlebar` 左边从「π + GrenAgent」改为「折叠图标 + GrenAgent」。

- 展开（`selectSidebarVisible === true`）：`PanelLeftClose`，`title` / `aria-label` 为「收起会话列表」，`aria-expanded="true"`。
- 收起：`PanelLeftOpen`，文案为「展开会话列表」，`aria-expanded="false"`。
- 点击调用现有 `toggleSidebar`。不改 `layoutStore` 的自动收起、挤右面板、宽度钳制。
- 按钮 28×28，与标题栏窗口控件同级；图标尺寸跟现有 `ActionIcon` small 一致。这颗钮的 28px 是点击热区，不是空状态 π 的字高。
- 标题栏整条仍是拖拽区。折叠按钮单独 ` -webkit-app-region: no-drag `（及 Tauri 等价），避免点一下变成拖窗口。GrenAgent 字样保持可拖，和现在点品牌的手感一致。
- `data-testid="sidebar-toggle"`。

不在「对话」模块时：同一格仍占位，避免切模块时标题栏左缘抖动；按钮 `disabled`，不调用 `toggleSidebar`。会话列表在其它模块里是 `display: none`，点了也看不到变化。切回对话后按钮恢复可点，开合状态保持离开前的值。

### 2.2 侧栏与主列

`Sidebar` 删除只有收起钮的 `PanelHeader`，以及 `onToggleSidebar` prop。`SidebarActions`（搜索框）成为侧栏第一个子节点。

`MainColumnHeader` 删除 `SidebarToggleButton`。工作区标签、规划徽章、终端 / 右面板开关不动。

`App` 不再往 `Sidebar` 传折叠回调。

### 2.3 空状态品牌标

`EmptyChatPrompt` 标题改为横向 lockup：左侧 π，右侧原标题。对话空状态与项目空状态共用这一布局。

锁定值（相对标题 28px / `font-weight: 500`）：

| 项 | 值 | 依据 |
| --- | --- | --- |
| π 笔画高度 | 23px | 用户判定「太小 ≈ 16」「齐字号 28 太大」后，在区间 [16, 28] 做黄金分割：`16 + 12 × 0.618 = 23` |
| π 与标题间距 | 9px | 短段：`23 × 0.382 ≈ 9` |
| π 颜色 | 与标题相同（`colorText` / `--gren-fg`） | 不当成另一块蓝色装饰 |
| 对齐 | `align-items: center` | 笔画顶底视觉居中于标题行 |
| viewBox | `40 56 160 134` | 按 `PiBrandLogo` 路径真实轮廓裁切，去掉原 240×220 上下留白 |

有消息后 `EmptyChatPrompt` 整块不渲染，π 一起消失，不进消息列表。

`FullscreenLoading` 的 π 不改，仍用默认 viewBox 与品牌色。

不新开折叠快捷键。现有 Ctrl+Alt+N 新建对话保留。

## 3. 组件与数据流

```text
useModuleStore.activeModule
useLayoutStore → selectSidebarVisible / toggleSidebar
        ↓
Titlebar 折叠钮（常驻；仅 chat 可点）
        ↓
SidebarShell.expand ← selectSidebarVisible   （已有，不改）
        ↓
Sidebar（无顶栏）→ SearchBox → 列表

EmptyChatPrompt ← 仅空会话
  PiBrandLogo tight 23px + 9px + 标题
```

`GrenAgentBrand` 目前只被 `Titlebar` 使用。本规格把它改成只渲染字样（去掉内部 π），由 `Titlebar` 在左侧另放折叠钮。不要再给 `GrenAgentBrand` 加 leading 插槽，避免品牌组件和布局开关缠在一起。

`PiBrandLogo` 增加可选 `tight?: boolean`。`tight` 时 viewBox 为 `40 56 160 134`。默认 false，启动页动画路径不受影响。`EmptyChatPrompt` 使用 `<PiBrandLogo size={23} tight />`。

electron-agent 与 tauri-agent 改同一组文件，行为一致：

- `src/components/Titlebar.tsx`
- `src/components/GrenAgentBrand.tsx`
- `src/components/PiBrandLogo.tsx`
- `src/features/sessions/Sidebar.tsx`
- `src/features/layout/MainColumnHeader.tsx`
- `src/features/chat/EmptyChatPrompt.tsx`
- `src/App.tsx`（去掉 `onToggleSidebar` 传递）

不改 `layoutStore`、`ModuleRail`、`ResizeHandle`、`FullscreenLoading`。

## 4. 边界

- 窗口变窄触发自动收起：图标仍在标题栏，切到展开态。再点走现有「手动展开」逻辑。
- 设置 / 扩展 / 用量 / Agent 数据 / 开发者工作台：按钮可见、禁用。
- 拖窗口：点折叠钮只开合；点字样或标题栏空白仍拖。
- 两种空状态标题都带 π。
- 不引入第二条折叠入口，避免再出现双位置。

## 5. 测试

electron-agent 与 tauri-agent 各跑对应测试。

标题栏（新）：

- 对话模块且侧栏可见：`sidebar-toggle` 为收起图标，可点，点后 `sidebarOpen` 为 false。
- 侧栏不可见：同一 `testid` 仍在，图标为展开，再点后打开。
- `activeModule !== 'chat'`：按钮存在且 disabled。
- 按钮节点带 `no-drag`（或平台等价属性）。

空状态（新，`EmptyChatPrompt` 单测）：

- 对话标题与项目标题左侧都渲染 π。
- 根节点能断言 lockup 间距 9px、logo `size` 23、`tight`。
- 不在本组件里测「有消息不出现」——那是 `ChatView` 已有空状态分支；若现有 mock 挡住了，不为此改 ChatView 集成测。

回归：

- `Sidebar` 不再渲染「收起」`ActionIcon`，也不再要 `onToggleSidebar`。
- `MainColumnHeader` 不再渲染 `SidebarToggleButton`。
- `layoutStore` 现有自动收起 / 挤右面板用例不改。
- `FullscreenLoading` / `PiBrandLogo` 默认 viewBox 回归（已有测试保持）。

不做像素级视觉回归，不为启动页 π 加新测试。

## 6. 非目标

- 不改模块栏、右面板、终端折叠。
- 不改会话行、搜索、新建对话 / 项目。
- 不把侧栏改成抽屉、窄列或左缝浮钉。
- 不把折叠钮放进模块栏或主列。
- 不改窗口最小化 / 最大化 / 关闭。
- 不改品牌启动动画。

## 7. 规格自检

- 无「待定 / TODO」占位。π 高度、间距、viewBox、禁用规则、文件清单均已写死。
- 标题栏 28px 热区与空状态 23px 笔画高度分开，避免实现时混用。
- 范围可收进一份实现计划：同一交互在 electron / tauri 镜像落地。
- 「其它模块禁用」优先于「静默改隐藏侧栏状态」，避免用户在设置页点了却看不见反馈。
