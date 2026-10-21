# Agent Note: 侧栏最顶层分区（置顶 / 对话 / 项目）整区折叠

Status: implemented

## Problem

侧栏只有项目分组能折叠。对话多、项目多的时候，想只看项目或者只看置顶，只能一路往下滚；「置顶」「对话」「项目」三个区头只是标题，点了没反应。

## Decision

- 三个区头都能点标题收起 / 展开整区。收起的区只留区头，区头右边的新建入口（新建对话、新建项目）还在。
- 状态存在 `sidebarPrefsStore` 的 `collapsedSections`（`Partial<Record<'pinned' | 'conversations' | 'projects', boolean>>`），和项目分组的 `collapsed` 一起经 persist 写进 localStorage 的 `pi-sidebar`，重启后保留。默认全部展开；旧数据里没有这个字段，读出来就是全部展开，不用迁移。
- `buildSidebarItems` 把三个区头统一成 `type: 'section'` 条目（`id` / `label` / `collapsed` / 可选 `action`），去掉原来单独的 `pinned-label` 类型。收起的区不产出任何内容条目：
  - 置顶区收起时，置顶的会话也不回到原项目里（它照旧被项目列表排除），置顶的对话也不回「对话」区。
  - 「对话」「项目」收起不影响置顶区里的对话和项目。
- 区头组件 `SidebarSectionHeader`：可点区域是 `role="button"`、`tabIndex=0`、`aria-expanded`，Enter / Space 切换（Space 阻止默认滚动）。可点区域铺满标题到新建按钮之间，新建按钮是它的兄弟节点，点按钮不会折叠。标题仍在距侧栏左沿 14px 处，和原来一致。
- 箭头放在标题后面：展开时只在悬停或键盘聚焦（`:focus-visible`）时出现；收起时一直显示，朝右。用 `:focus-visible` 而不是 `:focus-within`，鼠标点过之后焦点留在区头上，箭头不该一直挂着。
- 两条自动展开：
  - 点区头里的新建入口先展开本区（新建对话立刻展开；新建项目在选了下拉菜单项时展开，只打开下拉不展开）。Ctrl+Alt+N 等别的入口不动用户的折叠。
  - 置顶一项（会话、对话、项目）时，置顶区若是收起的就展开，在 store 的三个 `togglePinned*` 里做。取消置顶不动分区。
- 正在看的会话所在的区被收起时，侧栏里看不到它（主区仍显示这个会话），和项目分组收起时一样。

## Alternatives considered

- **只在本次运行里记（Sidebar 里的 useState），不落盘**。最强理由：不改 localStorage 格式，也不会出现「上次收起、这次忘了」找不到东西的情况。不用：项目分组的折叠已经落盘在同一个 store 里，两种折叠一个记一个不记反而奇怪；会收起整区的人多半是长期不想看它。
- **收起的区仍显示正在看的那一行**。最强理由：用户永远看得到自己在哪。不用：区头写着收起、下面却有一行，语义不一致；项目分组收起时也不这样做；主区本来就显示当前会话。
- **区头的新建入口不展开、完全尊重折叠**。最强理由：只有一条规则，和 Ctrl+Alt+N 一致。不用：用户是在这个区里点的新建，新建出来的那一行看不见会以为没建成；VS Code 视图标题栏的动作也是先展开视图。
- **箭头放在标题前面、一直显示**。最强理由：一眼看出能折叠。不用：标题会被挤到右边，和项目行的缩进对不齐；三个常驻箭头加上项目行自己的箭头太密。收起时箭头常驻，已经能看出这一区被收起。
- **保留 `pinned-label` 类型，只给「对话」「项目」加折叠**。最强理由：改动更小。不用：用户要的就是三个区都能折叠；两种区头两套渲染，统一成一个 `section` 类型后置顶区自然获得同样的行为。

## Consequences

- 收益：长列表里可以只看关心的区；状态跨重启保留；键盘可操作，读屏能读出展开状态。
- 收起的区里有运行中或需要处理的会话时，区头和折叠的项目分组头一样显示汇总角标和计数，见 [会话注意状态](./2026-10-19-session-attention-badges-and-notifications.md)。
- 代价：localStorage `pi-sidebar` 多一个字段。降级到旧版本时该字段被忽略，三个区都展开，不报错。
- `SidebarItem` 不再有 `pinned-label`；以后按类型判断置顶区头的代码要改成 `type === 'section' && id === 'pinned'`。

## Verification

- `cd electron-agent && npx vitest run src/stores/sidebarPrefsStore.test.ts src/features/sessions/useSidebarItems.test.ts`：2 个文件 17 条通过（`.agents/evidence/2026-10-19-sidebar-section-collapse/unit.log`）。新增：三个区都收起只剩三个区头且新建入口还在；只收置顶时置顶会话不回原项目、置顶对话不回「对话」区；只收「对话」时置顶区里的对话不受影响；分区默认展开、各自切换；`expandSection` 只打开收起的区；置顶时自动展开置顶区、取消置顶不动；旧的 persist 数据没有 `collapsedSections` 也能读出全部展开。整个 `src/features/sessions` 加 store 一共 11 个文件 56 条通过。
- `node ui-harness/check.mjs sidebar-sections`（新场景，真实 Sidebar + 真实 sidebarPrefsStore）：59 条全部通过（`ui-check-sidebar-sections.log`，截图在 `shots/`）。覆盖区头顺序与默认展开、不悬停没有箭头、悬停只有那一个区头出箭头、点标题收起后行消失且箭头朝右常驻、下一个区头紧接上来、点标题右边空白处也能切换、写进 localStorage、新建对话在展开时不折叠且收起时先展开、点击后焦点在区头上 Enter 展开 Space 收起、键盘聚焦时箭头显示、新建项目打开下拉不展开选了菜单项才展开、收起置顶后置顶会话哪里都不出现、右键置顶一项后置顶区自动展开、区头标题距左沿 14px、新建按钮和标题垂直居中、可点区域高 28px 且铺到新建按钮左边、浅色主题。首轮有 1 条失败：`t.click` 点完 80ms 就移开鼠标，箭头的 0.15s 淡出没放完（量到 opacity 0.075），probe 里补等 300ms 后通过，不是组件问题。
- 同样渲染真实 Sidebar 的 `session-archive` 复跑：47 条全部通过（`ui-check-session-archive.log`）。其余场景不渲染 Sidebar，没跑。
- 临时 tsconfig 只查改动的 6 个文件：没有类型错误（顺手修了 `useSidebarItems.test.ts` 里一处原有的 filter 缺类型收窄）。
- 没有在真实 Electron 主窗口里点过（仓库没有 verify-* skill）；App 里 Ctrl+Alt+N 不展开「对话」区这一条没有自动化覆盖，它不经过区头，代码上没有改动。
