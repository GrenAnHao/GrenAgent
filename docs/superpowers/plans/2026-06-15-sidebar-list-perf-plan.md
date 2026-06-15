# 侧栏对话/项目列表性能优化实现计划（lobehub 同款：memo + virtua 虚拟化）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 消除侧栏（`Sidebar`）对话/项目列表卡顿。对齐 lobehub 的列表优化范式：① memoized 行组件 + 稳定回调 + 行尾 Dropdown 懒挂载（地基）；② 把「对话 + 分区标题 + 项目头 + 会话 + 查看全部」**拍平成一维带类型的数组**，用 **`virtua` 的 `VList`** 做虚拟化（变高自动测量，天然适配分组/折叠/内联编辑）。

**架构：** 参考 lobehub `src/features/Conversation/ChatList/components/VirtualizedList.tsx`（virtua `VList`，把 header/footer/spacer 与消息拍平进一个 `data` 数组、渲染函数按类型分支、item 组件各自 memo）。本侧栏同样：新增 `useSidebarItems` 把全部内容拍平为 `SidebarItem[]`；`Sidebar` 用 `<VList data={items}>{(item)=>renderItem(item)}</VList>` 渲染；行用 memo 组件（`ConversationRow`/`GroupSessionRow`/`ProjectHeaderRow`）+ 稳定回调；`SessionItem` 行尾操作首次 hover 才挂载（去掉每行常驻 antd Dropdown）。虚拟化后每次只渲染视口内 ~20–40 行，DOM、Dropdown、re-render 全部被视口数量上界限制。

**技术栈：** React 19（`memo`/`useCallback`/`useMemo`/`useState`）+ `virtua`（`VList`，新增依赖，对齐 lobehub `virtua@^0.48`）+ antd（`Dropdown`）+ `@lobehub/ui`（`ActionIcon`/`Icon`）+ antd-style + vitest + @testing-library/react。

**lobehub 范式核对（已读源码）：**
- `virtua` 的 `VList`：`<VList data={dataWithSlots} ref style keepMounted bufferSize onScroll>{(id, index) => ReactElement}</VList>`，渲染函数按 id 类型分支（header/footer/spacer/普通）。变高由 virtua 自动测量。
- 官方 README 确认渲染 prop 形态：`<VList data={items} style={{height}}>{(d,i)=><El key={i}/>}</VList>`；并建议「用 memo 子组件 + 稳定 key + 调 `bufferSize`」优化大列表；**严禁用 index 作 key**（用 cwd/path 等稳定 id）。
- item 组件 memo，列表组件 memo（部分用 fast-deep-equal），配 zustand `useShallow` 选择器。
- 网格类列表（文件/技能/社区）用 `react-virtuoso`；变高/流式（聊天）用 `virtua` —— 我们侧栏是变高+分组，故选 `virtua`。

**前置事实（已核对现状）：**
- `Sidebar.tsx`：`Flexbox` 内 PanelHeader + `SidebarActions` + 一个 `styles.scroll`（`overflow-y:auto; flex:1; min-height:0`）滚动容器；容器内：loading/empty、`对话`区（`conversations.map` 全量 SessionItem）、`项目`区（`GroupList`→`ProjectGroup`→`sessions.slice(0,5).map`）。
- `GroupList`/`ProjectGroup` 仅被 `Sidebar` 使用；`ProjectGroup` 的「查看全部」`showAll` 是其内部 `useState`（本计划上提到 `Sidebar`）。
- `ConversationItem`（`useConversations`）：`{cwd, sessionPath, name, timestamp, isCurrent}`；`ProjectGroup`（`useProjectGroups`）：`{cwd, name, isCurrent, pinned, sessions: SessionInfo[], lastActivity}`。
- `SessionItem`/`ProjectItem`/`RowActions`：每行渲染 antd `Dropdown`；`SessionItem` memo（但被内联闭包打掉）；App 的 `handleX` 已 `useCallback` 稳定。
- `useSidebarPrefsStore`：`collapsed`(Record)、`pinnedSessions`(string[])、`toggleCollapsed`、`togglePinnedProject`、`togglePinnedSession`、`hideProject`、`setAlias`。
- 折叠默认值：组默认折叠 = `!isCurrent`（当前项目默认展开），即 `expanded = collapsed[cwd] === undefined ? isCurrent : !collapsed[cwd]`。

**共享契约（跨任务务必一致）：**
- `SidebarItem`（拍平项，定义在 `useSidebarItems.ts`）：见任务 5。
- `ConversationRow` props：`{ item: ConversationItem; active; running; editing; onOpen(cwd,path); onDelete(cwd); onSubmitRename(cwd,path,name); onRequestRename(path) }`。
- `GroupSessionRow` props：`{ cwd; session: SessionInfo; active; running; pinned; editing; onOpen(cwd,path); onDelete(cwd,path); onSubmitRename(cwd,path,name); onRequestRename(path); onPinToggle(path) }`。
- `ProjectHeaderRow` props：`{ group: ProjectGroup; expanded; onToggleExpand(cwd, defaultCollapsed); onNewInProject(cwd); onPinProject(cwd); onRevealProject(cwd); onRenameProject(group); onHideProject(cwd); onRemoveProject(cwd) }`。
- 常量 `DEFAULT_VISIBLE = 5` 移到 `useSidebarItems.ts`。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `tauri-agent/src/features/sessions/SessionItem.tsx`（改） | 行尾操作首次 hover 才挂载（懒挂 Dropdown） |
| `tauri-agent/src/features/sessions/SessionItem.test.tsx`（改） | 增「hover 才出现操作」测试 |
| `tauri-agent/src/features/sessions/ConversationRow.tsx`（新） | memo 行：对话项，稳定回调 |
| `tauri-agent/src/features/sessions/ConversationRow.test.tsx`（新） | 回调验证 |
| `tauri-agent/src/features/sessions/GroupSessionRow.tsx`（新） | memo 行：项目组会话项，稳定回调 |
| `tauri-agent/src/features/sessions/GroupSessionRow.test.tsx`（新） | 回调验证 |
| `tauri-agent/src/features/sessions/ProjectHeaderRow.tsx`（新） | memo 行：项目头（包 `ProjectItem`），稳定回调 |
| `tauri-agent/src/features/sessions/useSidebarItems.ts`（新） | `buildSidebarItems` 纯函数 + `useSidebarItems` hook：拍平为 `SidebarItem[]` |
| `tauri-agent/src/features/sessions/useSidebarItems.test.ts`（新） | 拍平顺序/类型/折叠/查看全部 单测 |
| `tauri-agent/src/features/sessions/Sidebar.tsx`（改） | 用 `VList` 渲染拍平数组；上提 `showAll` 状态；按类型 renderItem |
| `tauri-agent/src/features/sessions/ProjectGroup.tsx`（删） | 逻辑并入 `useSidebarItems` + `ProjectHeaderRow`/`GroupSessionRow` |
| `tauri-agent/package.json`（改） | 新增依赖 `virtua` |

---

## 任务 1：SessionItem 行尾操作懒挂载

**文件：** 改 `SessionItem.tsx`、`SessionItem.test.tsx`

- [ ] **步骤 1：写失败测试** — 在 `SessionItem.test.tsx` 的 `describe` 内追加：

```tsx
  it('mounts row actions only after first hover', () => {
    render(<SessionItem {...base} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    fireEvent.mouseEnter(screen.getByText('修复登录 bug').parentElement as HTMLElement);
    expect(screen.queryAllByRole('button').length).toBeGreaterThan(0);
  });
```

- [ ] **步骤 2：运行验证失败** — `cd tauri-agent && bunx vitest run src/features/sessions/SessionItem.test.tsx`，预期 FAIL。

- [ ] **步骤 3：加 hover state** — 在 `const [draft, setDraft] = useState(title);` 之后加：

```tsx
  const [hovered, setHovered] = useState(false);
```

- [ ] **步骤 4：改非编辑渲染分支** — 把：

```tsx
  const menuItems = buildSessionMenuItems({
    pinned,
    onPinToggle,
    onRename: onRequestRename,
    onDelete,
  });

  return (
    <div className={cx('pi-session-row', styles.row, active && styles.active)} onClick={onClick}>
      <span className={styles.title}>{title}</span>
      {running && (
        <span data-testid="session-running" className={styles.spin}>
          <Icon icon={waiting ? Hand : LoaderCircle} size="small" />
        </span>
      )}
      <span className={styles.acts}>
        <RowActions menuItems={menuItems} />
      </span>
    </div>
  );
```

替换为：

```tsx
  return (
    <div
      className={cx('pi-session-row', styles.row, active && styles.active)}
      onClick={onClick}
      onMouseEnter={() => {
        if (!hovered) setHovered(true);
      }}
    >
      <span className={styles.title}>{title}</span>
      {running && (
        <span data-testid="session-running" className={styles.spin}>
          <Icon icon={waiting ? Hand : LoaderCircle} size="small" />
        </span>
      )}
      <span className={styles.acts}>
        {hovered && (
          <RowActions
            menuItems={buildSessionMenuItems({
              pinned,
              onPinToggle,
              onRename: onRequestRename,
              onDelete,
            })}
          />
        )}
      </span>
    </div>
  );
```

- [ ] **步骤 5：运行验证通过** — 同步骤 2 命令，预期 PASS（含原有 3 个测试）。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/sessions/SessionItem.tsx tauri-agent/src/features/sessions/SessionItem.test.tsx
git commit -m "perf(sidebar): lazy-mount row actions on first hover (任务1/7)"
```

---

## 任务 2：ConversationRow（memo + 稳定回调）

**文件：** 新 `ConversationRow.tsx`、`ConversationRow.test.tsx`

- [ ] **步骤 1：写失败测试 `ConversationRow.test.tsx`**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationRow } from './ConversationRow';
import type { ConversationItem } from './useConversations';

const item: ConversationItem = {
  cwd: '/works/c1',
  sessionPath: '/works/c1/s.json',
  name: '会话甲',
  timestamp: '2026-06-15T00:00:00Z',
  isCurrent: false,
};

describe('ConversationRow', () => {
  it('renders name and fires onOpen with cwd + path', () => {
    const onOpen = vi.fn();
    render(
      <ConversationRow
        item={item}
        active={false}
        running={false}
        editing={false}
        onOpen={onOpen}
        onDelete={vi.fn()}
        onSubmitRename={vi.fn()}
        onRequestRename={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('会话甲'));
    expect(onOpen).toHaveBeenCalledWith('/works/c1', '/works/c1/s.json');
  });

  it('submits rename with cwd + path + name', () => {
    const onSubmitRename = vi.fn();
    render(
      <ConversationRow
        item={item}
        active={false}
        running={false}
        editing
        onOpen={vi.fn()}
        onDelete={vi.fn()}
        onSubmitRename={onSubmitRename}
        onRequestRename={vi.fn()}
      />,
    );
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '新名' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmitRename).toHaveBeenCalledWith('/works/c1', '/works/c1/s.json', '新名');
  });
});
```

- [ ] **步骤 2：运行验证失败** — `cd tauri-agent && bunx vitest run src/features/sessions/ConversationRow.test.tsx`，预期 FAIL（模块缺失）。

- [ ] **步骤 3：实现 `ConversationRow.tsx`**

```tsx
import { memo, useCallback } from 'react';
import { SessionItem } from './SessionItem';
import type { ConversationItem } from './useConversations';

interface ConversationRowProps {
  item: ConversationItem;
  active: boolean;
  running: boolean;
  editing: boolean;
  onOpen: (cwd: string, path: string) => void;
  onDelete: (cwd: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
  onRequestRename: (path: string) => void;
}

export const ConversationRow = memo(function ConversationRow({
  item,
  active,
  running,
  editing,
  onOpen,
  onDelete,
  onSubmitRename,
  onRequestRename,
}: ConversationRowProps) {
  const handleClick = useCallback(() => onOpen(item.cwd, item.sessionPath), [onOpen, item.cwd, item.sessionPath]);
  const handleDelete = useCallback(() => onDelete(item.cwd), [onDelete, item.cwd]);
  const handleRename = useCallback(
    (name: string) => onSubmitRename(item.cwd, item.sessionPath, name),
    [onSubmitRename, item.cwd, item.sessionPath],
  );
  const handleRequestRename = useCallback(() => onRequestRename(item.sessionPath), [onRequestRename, item.sessionPath]);
  const noop = useCallback(() => {}, []);

  return (
    <SessionItem
      title={item.name}
      active={active}
      running={running}
      pinned={false}
      editing={editing}
      onClick={handleClick}
      onPinToggle={noop}
      onRequestRename={handleRequestRename}
      onRename={handleRename}
      onDelete={handleDelete}
    />
  );
});
```

- [ ] **步骤 4：运行验证通过** — 同步骤 2 命令，预期 PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/sessions/ConversationRow.tsx tauri-agent/src/features/sessions/ConversationRow.test.tsx
git commit -m "perf(sidebar): memoized ConversationRow (任务2/7)"
```

---

## 任务 3：GroupSessionRow（memo + 稳定回调）

**文件：** 新 `GroupSessionRow.tsx`、`GroupSessionRow.test.tsx`

- [ ] **步骤 1：写失败测试 `GroupSessionRow.test.tsx`**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GroupSessionRow } from './GroupSessionRow';
import type { SessionInfo } from '../../lib/pi';

const session = { path: '/proj/p1/s.json', name: '组会话甲', cwd: '/proj/p1', timestamp: '' } as SessionInfo;

describe('GroupSessionRow', () => {
  it('fires onOpen with cwd + path', () => {
    const onOpen = vi.fn();
    render(
      <GroupSessionRow
        cwd="/proj/p1"
        session={session}
        active={false}
        running={false}
        pinned={false}
        editing={false}
        onOpen={onOpen}
        onDelete={vi.fn()}
        onSubmitRename={vi.fn()}
        onRequestRename={vi.fn()}
        onPinToggle={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('组会话甲'));
    expect(onOpen).toHaveBeenCalledWith('/proj/p1', '/proj/p1/s.json');
  });

  it('falls back to Untitled for empty name', () => {
    render(
      <GroupSessionRow
        cwd="/proj/p1"
        session={{ ...session, name: '' } as SessionInfo}
        active={false}
        running={false}
        pinned={false}
        editing={false}
        onOpen={vi.fn()}
        onDelete={vi.fn()}
        onSubmitRename={vi.fn()}
        onRequestRename={vi.fn()}
        onPinToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('Untitled')).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行验证失败** — `cd tauri-agent && bunx vitest run src/features/sessions/GroupSessionRow.test.tsx`，预期 FAIL。

- [ ] **步骤 3：实现 `GroupSessionRow.tsx`**

```tsx
import { memo, useCallback } from 'react';
import type { SessionInfo } from '../../lib/pi';
import { SessionItem } from './SessionItem';

interface GroupSessionRowProps {
  cwd: string;
  session: SessionInfo;
  active: boolean;
  running: boolean;
  pinned: boolean;
  editing: boolean;
  onOpen: (cwd: string, path: string) => void;
  onDelete: (cwd: string, path: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
  onRequestRename: (path: string) => void;
  onPinToggle: (path: string) => void;
}

export const GroupSessionRow = memo(function GroupSessionRow({
  cwd,
  session,
  active,
  running,
  pinned,
  editing,
  onOpen,
  onDelete,
  onSubmitRename,
  onRequestRename,
  onPinToggle,
}: GroupSessionRowProps) {
  const path = session.path;
  const handleClick = useCallback(() => onOpen(cwd, path), [onOpen, cwd, path]);
  const handleDelete = useCallback(() => onDelete(cwd, path), [onDelete, cwd, path]);
  const handleRename = useCallback((name: string) => onSubmitRename(cwd, path, name), [onSubmitRename, cwd, path]);
  const handleRequestRename = useCallback(() => onRequestRename(path), [onRequestRename, path]);
  const handlePinToggle = useCallback(() => onPinToggle(path), [onPinToggle, path]);

  return (
    <SessionItem
      title={session.name || 'Untitled'}
      active={active}
      running={running}
      pinned={pinned}
      editing={editing}
      onClick={handleClick}
      onPinToggle={handlePinToggle}
      onRequestRename={handleRequestRename}
      onRename={handleRename}
      onDelete={handleDelete}
    />
  );
});
```

- [ ] **步骤 4：运行验证通过** — 同步骤 2 命令，预期 PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/sessions/GroupSessionRow.tsx tauri-agent/src/features/sessions/GroupSessionRow.test.tsx
git commit -m "perf(sidebar): memoized GroupSessionRow (任务3/7)"
```

---

## 任务 4：ProjectHeaderRow（memo 包 ProjectItem + 稳定回调）

**文件：** 新 `ProjectHeaderRow.tsx`、`ProjectHeaderRow.test.tsx`

- [ ] **步骤 1：写失败测试 `ProjectHeaderRow.test.tsx`**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectHeaderRow } from './ProjectHeaderRow';
import type { ProjectGroup } from './useProjectGroups';

const group: ProjectGroup = {
  cwd: '/proj/p1',
  name: '项目甲',
  isCurrent: false,
  pinned: false,
  sessions: [],
  lastActivity: '',
};

describe('ProjectHeaderRow', () => {
  it('renders name and toggles expand with cwd + default-collapsed', () => {
    const onToggleExpand = vi.fn();
    render(
      <ProjectHeaderRow
        group={group}
        expanded={false}
        onToggleExpand={onToggleExpand}
        onNewInProject={vi.fn()}
        onPinProject={vi.fn()}
        onRevealProject={vi.fn()}
        onRenameProject={vi.fn()}
        onHideProject={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('项目甲'));
    // 默认折叠 = !isCurrent = true
    expect(onToggleExpand).toHaveBeenCalledWith('/proj/p1', true);
  });
});
```

- [ ] **步骤 2：运行验证失败** — `cd tauri-agent && bunx vitest run src/features/sessions/ProjectHeaderRow.test.tsx`，预期 FAIL。

- [ ] **步骤 3：实现 `ProjectHeaderRow.tsx`**

```tsx
import { memo, useCallback } from 'react';
import { ProjectItem } from './ProjectItem';
import type { ProjectGroup } from './useProjectGroups';

interface ProjectHeaderRowProps {
  group: ProjectGroup;
  expanded: boolean;
  onToggleExpand: (cwd: string, defaultCollapsed: boolean) => void;
  onNewInProject: (cwd: string) => void;
  onPinProject: (cwd: string) => void;
  onRevealProject: (cwd: string) => void;
  onRenameProject: (group: ProjectGroup) => void;
  onHideProject: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
}

export const ProjectHeaderRow = memo(function ProjectHeaderRow({
  group,
  expanded,
  onToggleExpand,
  onNewInProject,
  onPinProject,
  onRevealProject,
  onRenameProject,
  onHideProject,
  onRemoveProject,
}: ProjectHeaderRowProps) {
  const cwd = group.cwd;
  const handleToggle = useCallback(() => onToggleExpand(cwd, !group.isCurrent), [onToggleExpand, cwd, group.isCurrent]);
  const handleNew = useCallback(() => onNewInProject(cwd), [onNewInProject, cwd]);
  const handlePin = useCallback(() => onPinProject(cwd), [onPinProject, cwd]);
  const handleReveal = useCallback(() => onRevealProject(cwd), [onRevealProject, cwd]);
  const handleRename = useCallback(() => onRenameProject(group), [onRenameProject, group]);
  const handleHide = useCallback(() => onHideProject(cwd), [onHideProject, cwd]);
  const handleRemove = useCallback(() => onRemoveProject(cwd), [onRemoveProject, cwd]);

  return (
    <ProjectItem
      name={group.name}
      expanded={expanded}
      isCurrent={group.isCurrent}
      pinned={group.pinned}
      onToggle={handleToggle}
      onNew={handleNew}
      onPinToggle={handlePin}
      onReveal={handleReveal}
      onRename={handleRename}
      onHide={handleHide}
      onRemove={handleRemove}
    />
  );
});
```

- [ ] **步骤 4：运行验证通过** — 同步骤 2 命令，预期 PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/sessions/ProjectHeaderRow.tsx tauri-agent/src/features/sessions/ProjectHeaderRow.test.tsx
git commit -m "perf(sidebar): memoized ProjectHeaderRow (任务4/7)"
```

---

## 任务 5：useSidebarItems（拍平为类型化数组）

**文件：** 新 `useSidebarItems.ts`、`useSidebarItems.test.ts`

- [ ] **步骤 1：写失败测试 `useSidebarItems.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { buildSidebarItems } from './useSidebarItems';
import type { ConversationItem } from './useConversations';
import type { ProjectGroup } from './useProjectGroups';

const conv: ConversationItem = { cwd: '/w/c', sessionPath: '/w/c/s.json', name: '对话1', timestamp: '', isCurrent: false };
const mkSession = (p: string) => ({ path: p, name: p, cwd: '/p/g', timestamp: '' }) as ProjectGroup['sessions'][number];
const group: ProjectGroup = {
  cwd: '/p/g',
  name: '组1',
  isCurrent: true,
  pinned: false,
  sessions: [mkSession('s1'), mkSession('s2'), mkSession('s3'), mkSession('s4'), mkSession('s5'), mkSession('s6')],
  lastActivity: '',
};

describe('buildSidebarItems', () => {
  it('flattens conversations and groups with section headers', () => {
    const items = buildSidebarItems({
      conversations: [conv],
      pinnedGroups: [],
      normalGroups: [group],
      collapsed: {},
      pinnedSessions: [],
      showAllCwds: new Set(),
    });
    const types = items.map((i) => i.type);
    expect(types[0]).toBe('section'); // 对话
    expect(types).toContain('conversation');
    expect(types).toContain('project');
    // isCurrent=true 默认展开，6 条 > DEFAULT_VISIBLE(5) → 5 session + 1 more
    expect(items.filter((i) => i.type === 'session')).toHaveLength(5);
    expect(items.filter((i) => i.type === 'more')).toHaveLength(1);
  });

  it('hides sessions when collapsed', () => {
    const items = buildSidebarItems({
      conversations: [],
      pinnedGroups: [],
      normalGroups: [group],
      collapsed: { '/p/g': true },
      pinnedSessions: [],
      showAllCwds: new Set(),
    });
    expect(items.filter((i) => i.type === 'session')).toHaveLength(0);
    expect(items.filter((i) => i.type === 'more')).toHaveLength(0);
  });

  it('shows all sessions when showAll set', () => {
    const items = buildSidebarItems({
      conversations: [],
      pinnedGroups: [],
      normalGroups: [group],
      collapsed: {},
      pinnedSessions: [],
      showAllCwds: new Set(['/p/g']),
    });
    expect(items.filter((i) => i.type === 'session')).toHaveLength(6);
    expect(items.filter((i) => i.type === 'more')).toHaveLength(0);
  });

  it('adds pinned label before pinned groups', () => {
    const items = buildSidebarItems({
      conversations: [],
      pinnedGroups: [{ ...group, cwd: '/p/pin', pinned: true }],
      normalGroups: [],
      collapsed: { '/p/pin': true },
      pinnedSessions: [],
      showAllCwds: new Set(),
    });
    expect(items.some((i) => i.type === 'pinned-label')).toBe(true);
  });
});
```

- [ ] **步骤 2：运行验证失败** — `cd tauri-agent && bunx vitest run src/features/sessions/useSidebarItems.test.ts`，预期 FAIL（模块缺失）。

- [ ] **步骤 3：实现 `useSidebarItems.ts`**

```ts
import { useMemo } from 'react';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import type { ConversationItem } from './useConversations';
import { useConversations } from './useConversations';
import type { ProjectGroup } from './useProjectGroups';
import { useProjectGroups } from './useProjectGroups';
import type { SessionInfo } from '../../lib/pi';

export const DEFAULT_VISIBLE = 5;

export type SidebarItem =
  | { type: 'section'; key: string; label: string; action: 'new-conversation' | 'new-project' }
  | { type: 'conversation'; key: string; item: ConversationItem }
  | { type: 'pinned-label'; key: string }
  | { type: 'project'; key: string; group: ProjectGroup; expanded: boolean }
  | { type: 'session'; key: string; cwd: string; session: SessionInfo; pinned: boolean }
  | { type: 'more'; key: string; cwd: string; total: number };

interface BuildParams {
  conversations: ConversationItem[];
  pinnedGroups: ProjectGroup[];
  normalGroups: ProjectGroup[];
  collapsed: Record<string, boolean>;
  pinnedSessions: string[];
  showAllCwds: Set<string>;
}

export function buildSidebarItems(params: BuildParams): SidebarItem[] {
  const { conversations, pinnedGroups, normalGroups, collapsed, pinnedSessions, showAllCwds } = params;
  const pinnedSet = new Set(pinnedSessions);
  const items: SidebarItem[] = [];

  items.push({ type: 'section', key: 'sec-conv', label: '对话', action: 'new-conversation' });
  for (const c of conversations) {
    items.push({ type: 'conversation', key: `conv-${c.cwd}`, item: c });
  }

  items.push({ type: 'section', key: 'sec-proj', label: '项目', action: 'new-project' });

  const pushGroup = (g: ProjectGroup) => {
    const expanded = collapsed[g.cwd] === undefined ? g.isCurrent : !collapsed[g.cwd];
    items.push({ type: 'project', key: `proj-${g.cwd}`, group: g, expanded });
    if (!expanded) return;
    const showAll = showAllCwds.has(g.cwd);
    const visible = showAll ? g.sessions : g.sessions.slice(0, DEFAULT_VISIBLE);
    for (const s of visible) {
      items.push({ type: 'session', key: `sess-${s.path}`, cwd: g.cwd, session: s, pinned: pinnedSet.has(s.path) });
    }
    const hidden = g.sessions.length - visible.length;
    if (hidden > 0) items.push({ type: 'more', key: `more-${g.cwd}`, cwd: g.cwd, total: g.sessions.length });
  };

  if (pinnedGroups.length > 0) items.push({ type: 'pinned-label', key: 'pinned-label' });
  for (const g of pinnedGroups) pushGroup(g);
  for (const g of normalGroups) pushGroup(g);

  return items;
}

export function useSidebarItems(showAllCwds: Set<string>): SidebarItem[] {
  const conversations = useConversations();
  const groups = useProjectGroups();
  const collapsed = useSidebarPrefsStore((s) => s.collapsed);
  const pinnedSessions = useSidebarPrefsStore((s) => s.pinnedSessions);

  return useMemo(() => {
    const pinnedGroups: ProjectGroup[] = [];
    const normalGroups: ProjectGroup[] = [];
    for (const g of groups) (g.pinned ? pinnedGroups : normalGroups).push(g);
    return buildSidebarItems({
      conversations,
      pinnedGroups,
      normalGroups,
      collapsed,
      pinnedSessions,
      showAllCwds,
    });
  }, [conversations, groups, collapsed, pinnedSessions, showAllCwds]);
}
```

（`useSessionStore` import 仅为类型/将来扩展保留——若未用到可删；实际本 hook 通过 `useConversations`/`useProjectGroups` 间接读 store。**实现时若 lint 报未使用，删掉该 import。**）

- [ ] **步骤 4：运行验证通过** — 同步骤 2 命令，预期 PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/sessions/useSidebarItems.ts tauri-agent/src/features/sessions/useSidebarItems.test.ts
git commit -m "perf(sidebar): flatten conversations + groups into typed item array (任务5/7)"
```

---

## 任务 6：Sidebar 用 virtua VList 渲染拍平数组

**文件：** 改 `Sidebar.tsx`、`package.json`；删 `ProjectGroup.tsx`

- [ ] **步骤 1：安装 virtua** — 运行 `cd tauri-agent && pnpm add virtua`（与 lobehub 一致的虚拟列表库；写入 `package.json` dependencies）。

- [ ] **步骤 2：重写 `Sidebar.tsx`** — 整体替换为下述内容（移除 `GroupList`/`ProjectGroup`/直接 `SessionItem` 用法，改用 `VList` + 拍平项 + memo 行组件）：

```tsx
import { useCallback, useState, memo } from 'react';
import { ActionIcon, Empty, Flexbox, Text } from '@lobehub/ui';
import { Dropdown } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { FolderPlus, MessageSquarePlus, PanelLeftClose } from 'lucide-react';
import { openPath } from '@tauri-apps/plugin-opener';
import { VList } from 'virtua';
import { PanelHeader } from '../../components/PanelHeader';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import { useConversations } from './useConversations';
import { SidebarActions } from './SidebarActions';
import { ConversationRow } from './ConversationRow';
import { GroupSessionRow } from './GroupSessionRow';
import { ProjectHeaderRow } from './ProjectHeaderRow';
import { useSidebarItems, type SidebarItem } from './useSidebarItems';

const styles = createStaticStyles(({ css }) => ({
  sec: css`
    padding: 12px 14px 4px;
    color: ${cssVar.colorTextTertiary};
    font-size: 10px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  `,
  secRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 8px 4px 14px;
  `,
  secLabel: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 10px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  `,
  more: css`
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 0 6px;
    padding: 2px 10px 4px 28px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    cursor: pointer;

    &:hover {
      color: ${cssVar.colorText};
    }
  `,
  listWrap: css`
    flex: 1;
    min-height: 0;
  `,
}));

export interface SidebarProps {
  runningSessionPaths: Set<string>;
  onNewConversation: () => void;
  onOpenProject: () => void;
  onNewSession: (cwd: string) => void;
  onOpenSession: (cwd: string, path: string) => void;
  onDeleteSession: (cwd: string, path: string) => void;
  onDeleteConversation: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
  onToggleSidebar: () => void;
}

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  const conversations = useConversations();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const isLoading = useSessionStore((s) => s.isLoading);
  const allSessionsLoading = useSessionStore((s) => s.allSessionsLoading);

  const toggleCollapsed = useSidebarPrefsStore((s) => s.toggleCollapsed);
  const togglePinnedProject = useSidebarPrefsStore((s) => s.togglePinnedProject);
  const togglePinnedSession = useSidebarPrefsStore((s) => s.togglePinnedSession);
  const hideProject = useSidebarPrefsStore((s) => s.hideProject);
  const setAlias = useSidebarPrefsStore((s) => s.setAlias);

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [showAllCwds, setShowAllCwds] = useState<Set<string>>(new Set());

  const items = useSidebarItems(showAllCwds);

  const handleSubmitRename = useCallback(
    (cwd: string, path: string, name: string) => {
      setRenamingPath(null);
      props.onSubmitRename(cwd, path, name);
    },
    [props.onSubmitRename],
  );
  const handleRequestRename = useCallback((path: string) => setRenamingPath(path), []);
  const handleRevealProject = useCallback((cwd: string) => void openPath(cwd), []);
  const handleRenameProject = useCallback(
    (group: { cwd: string; name: string }) => {
      const next = window.prompt('项目别名（留空恢复默认）', group.name);
      if (next !== null) setAlias(group.cwd, next);
    },
    [setAlias],
  );
  const handleShowAll = useCallback((cwd: string) => {
    setShowAllCwds((prev) => {
      const next = new Set(prev);
      next.add(cwd);
      return next;
    });
  }, []);

  const newProjectMenu = {
    items: [
      { key: 'blank', label: '新建空白项目' },
      { key: 'existing', label: '使用现有文件夹' },
    ],
    onClick: () => props.onOpenProject(),
  };

  const renderItem = useCallback(
    (item: SidebarItem) => {
      switch (item.type) {
        case 'section':
          return (
            <div className={styles.secRow}>
              <span className={styles.secLabel}>{item.label}</span>
              {item.action === 'new-conversation' ? (
                <ActionIcon
                  icon={MessageSquarePlus}
                  size="small"
                  title="新建对话 (Ctrl+Alt+N)"
                  onClick={props.onNewConversation}
                />
              ) : (
                <Dropdown menu={newProjectMenu} trigger={['click']}>
                  <span>
                    <ActionIcon icon={FolderPlus} size="small" title="新建项目" />
                  </span>
                </Dropdown>
              )}
            </div>
          );
        case 'conversation':
          return (
            <ConversationRow
              item={item.item}
              active={activeSessionPath === item.item.sessionPath}
              running={props.runningSessionPaths.has(item.item.sessionPath)}
              editing={renamingPath === item.item.sessionPath}
              onOpen={props.onOpenSession}
              onDelete={props.onDeleteConversation}
              onSubmitRename={handleSubmitRename}
              onRequestRename={handleRequestRename}
            />
          );
        case 'pinned-label':
          return <div className={styles.sec}>置顶</div>;
        case 'project':
          return (
            <ProjectHeaderRow
              group={item.group}
              expanded={item.expanded}
              onToggleExpand={toggleCollapsed}
              onNewInProject={props.onNewSession}
              onPinProject={togglePinnedProject}
              onRevealProject={handleRevealProject}
              onRenameProject={handleRenameProject}
              onHideProject={hideProject}
              onRemoveProject={props.onRemoveProject}
            />
          );
        case 'session':
          return (
            <GroupSessionRow
              cwd={item.cwd}
              session={item.session}
              active={activeSessionPath === item.session.path}
              running={props.runningSessionPaths.has(item.session.path)}
              pinned={item.pinned}
              editing={renamingPath === item.session.path}
              onOpen={props.onOpenSession}
              onDelete={props.onDeleteSession}
              onSubmitRename={handleSubmitRename}
              onRequestRename={handleRequestRename}
              onPinToggle={togglePinnedSession}
            />
          );
        case 'more':
          return (
            <div className={styles.more} onClick={() => handleShowAll(item.cwd)}>
              查看全部 {item.total} 条
            </div>
          );
        default:
          return null;
      }
    },
    [
      activeSessionPath,
      renamingPath,
      props.runningSessionPaths,
      props.onNewConversation,
      props.onOpenSession,
      props.onDeleteConversation,
      props.onNewSession,
      props.onRemoveProject,
      props.onDeleteSession,
      handleSubmitRename,
      handleRequestRename,
      toggleCollapsed,
      togglePinnedProject,
      togglePinnedSession,
      hideProject,
      handleRevealProject,
      handleRenameProject,
      handleShowAll,
    ],
  );

  const showLoading = (isLoading || allSessionsLoading) && conversations.length === 0 && items.length <= 2;
  const showEmpty = !isLoading && !allSessionsLoading && conversations.length === 0 && items.length <= 2;

  return (
    <Flexbox height="100%" style={{ minHeight: 0, background: 'var(--gren-sidebar-bg, transparent)' }}>
      <PanelHeader
        title="Pi Agent"
        actions={<ActionIcon icon={PanelLeftClose} size="small" title="收起" onClick={props.onToggleSidebar} />}
      />
      <SidebarActions />
      <div className={styles.listWrap}>
        {showLoading ? (
          <Flexbox align="center" justify="center" style={{ padding: 24 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              加载会话…
            </Text>
          </Flexbox>
        ) : showEmpty ? (
          <Empty description="暂无对话或项目" />
        ) : (
          <VList data={items} style={{ height: '100%' }}>
            {(item: SidebarItem) => <div key={item.key}>{renderItem(item)}</div>}
          </VList>
        )}
      </div>
    </Flexbox>
  );
});
```

（要点：`VList` 成为滚动容器，外层 `listWrap` 提供 `flex:1; min-height:0` 高度；渲染函数用 `item.key`（cwd/path 派生）作 key，**不用 index**；行用 memo 组件，virtua 渲染 prop + memo 子组件 = lobehub 同款；`renderItem` 用 `useCallback` 收敛依赖。`showLoading/showEmpty` 用 `items.length <= 2`（仅两个 section 头）判空。）

- [ ] **步骤 3：删除 `ProjectGroup.tsx`** — 该文件逻辑已并入 `useSidebarItems` + `ProjectHeaderRow` + `GroupSessionRow`，且仅被旧 `Sidebar` 使用。

```bash
git rm tauri-agent/src/features/sessions/ProjectGroup.tsx
```

- [ ] **步骤 4：类型检查 + 测试** — `cd tauri-agent && bunx tsc --noEmit && bunx vitest run src/features/sessions/`，预期 tsc 0 错、测试全绿（若有引用 `ProjectGroup` 的残留 import 报错，按提示删除）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/package.json tauri-agent/pnpm-lock.yaml tauri-agent/src/features/sessions/Sidebar.tsx
git commit -m "perf(sidebar): virtualize sidebar list with virtua VList (任务6/7)"
```

---

## 任务 7：全量验证 + 冒烟

- [ ] **步骤 1：类型检查** — `cd tauri-agent && bunx tsc --noEmit`，预期 0 错。
- [ ] **步骤 2：侧栏测试** — `cd tauri-agent && bunx vitest run src/features/sessions/`，预期全绿。
- [ ] **步骤 3：手动冒烟（建议）** — 重启 app：
  1. 侧栏滚动顺滑；切换激活会话、hover 出操作、重命名、删除、置顶、折叠/展开项目、「查看全部」、新建对话/项目 —— 行为与改造前一致。
  2. 大量对话/项目时只渲染视口内行（用 DevTools 看 DOM 节点数远小于总条数）。
  3. React DevTools Profiler 录「切换激活会话」：仅原激活行 + 新激活行重渲染。
- [ ] **步骤 4：Commit（如冒烟有微调）**

```bash
git add -A
git commit -m "test(sidebar): e2e smoke fixes (任务7/7)"
```

---

## 自检（规格覆盖度对照）

| 需求 / 痛点 | 对应任务 | lobehub 对应 |
|----------------|----------|--------------|
| 每行常驻 antd Dropdown → 懒挂载 | 任务 1 | memoized/惰性 item |
| memo 失效（对话区内联闭包） | 任务 2 | memo item + 稳定 props |
| memo 失效（项目组会话内联闭包） | 任务 3 | 同上 |
| memo 失效（项目头内联闭包） | 任务 4 | 同上 |
| 混合内容拍平为一维类型数组 | 任务 5 | `dataWithSlots`（header/footer/spacer + 消息） |
| 虚拟滚动（只渲染视口） | 任务 6 | `virtua` `VList` + 渲染 prop + 稳定 key |
| 加载/空态 | 任务 6 | 条件渲染替代 VList |

**类型一致性：** `SidebarItem` 联合类型在 `useSidebarItems.ts` 定义并被 `Sidebar.renderItem` 全分支消费；`ConversationItem`/`ProjectGroup`/`SessionInfo` 来源唯一；三个 Row 组件的回调签名与 `Sidebar` 传参一致；`onSubmitRename` 全链路 `(cwd,path,name)`；`toggleCollapsed(cwd, defaultCollapsed)` 与 `ProjectHeaderRow.onToggleExpand` 一致。`key` 全部用 `item.key`（cwd/path 派生），不用 index（符合 virtua 要求）。

**占位符扫描：** 无 TODO/待定；每步含完整代码与命令。仅 `useSidebarItems.ts` 顶部 `useSessionStore` import 标注「若 lint 未使用则删」——实现时按 lint 结果处理（非占位）。

**依赖顺序：** 任务 1（懒挂，独立）→ 任务 2/3/4（三个 memo 行，互相独立，均依赖 SessionItem/ProjectItem 既有契约）→ 任务 5（拍平 hook，依赖 ConversationItem/ProjectGroup 类型）→ 任务 6（Sidebar VList 收口，依赖 2/3/4/5 + virtua 依赖）→ 任务 7（验证）。

**虚拟化注意（实现时遵守）：** ① `VList` 需要有界高度（外层 `listWrap` 给 `flex:1;min-height:0`，VList `height:100%`）；② key 用稳定 id；③ 行内若有变高（重命名 Input）由 virtua 自动测量，无需手动设高；④ 如需 overscan 调优可加 `bufferSize`（默认即可，先不加）。

---

## 执行交接

两种执行方式：

1. **子代理驱动（推荐）**：每任务一个子代理 + 任务间审查。必需子技能 superpowers:subagent-driven-development。
2. **内联执行**：当前会话用 superpowers:executing-plans 批量执行 + 检查点。
