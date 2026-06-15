# 通用可停靠 Tab 容器（Dock）实现计划 — 阶段 1 地基

> **面向 AI 代理的工作者：** 用 `superpowers:executing-plans` 逐任务**内联**实现本计划（本仓库**禁止子代理**）。步骤用复选框 `- [ ]` 跟踪进度。每个任务结尾 commit 一次。

**目标：** 把右侧面板与底部终端统一成 Codex/VS Code 风格的通用 Tab 容器：共享 tab 条、＋、关闭、同坞重排与跨坞互拖；阶段 1 接入终端 / 网页(fetch_url) / 子代理(spawn_agent) 三种内容，并为后续 file/diff/sidechat 预留扩展位。

**架构（方案 C）：** 新建 `dockStore` 统一管理 tab 列表与各坞激活态；**终端钉在 Bottom Dock、不可跨坞**；page / subagent 可在 Right ↔ Bottom 间自由移动；单一 App 级 `DndContext` 包裹两坞 tab 条实现互拖。外壳布局（`RightPanelShell` / `TerminalShell`）保持不变。

**技术栈：** React 19 + TypeScript + zustand(persist) + `@dnd-kit/*` + `@lobehub/ui` + antd-style。规格见 `docs/superpowers/specs/2026-06-14-dock-tab-container-design.md`。

**命令约定：**
- 前端测试（单文件）：`cd tauri-agent && npx vitest run <file>`
- 前端类型检查：`cd tauri-agent && npx tsc --noEmit`
- 全量前端测试：`cd tauri-agent && npx vitest run`

---

## 文件结构

**新建（`tauri-agent/src`）**
- `stores/dockStore.ts` — 统一 tab 状态机（替代 `rightPanelStore.ts`）
- `stores/dockStore.test.ts` — store 单元测试
- `features/dock/dockTabStyles.ts` — 共享 tab 样式 + `resolveTone` / `toneColor`（从 Right/Terminal 合并）
- `features/dock/SortableDockTab.tsx` — 单个可排序 tab
- `features/dock/TabStrip.tsx` — 共享 tab 条（SortableContext + 区域 droppable + ＋/折叠操作区）
- `features/dock/TabStrip.test.tsx` — tab 条组件测试
- `features/dock/TabBodyRenderer.tsx` — 按 kind 分发 body（含 `DockBodyProps`、kind 注册表）
- `features/dock/TabBodyStack.tsx` — keep-alive 渲染所有 body
- `features/dock/PageBody.tsx` — page kind body（复用 `PageContentViewer`）
- `features/dock/SubAgentBody.tsx` — subagent kind body（复用 `SubAgentConversation`，从 messages 取实时态）
- `features/dock/TerminalBody.tsx` — 单终端 xterm 生命周期（从 `TerminalPanel` 拆出）
- `features/dock/TerminalBody.test.tsx` — 终端 body 生命周期测试（mock xterm + terminal lib）
- `features/dock/DockPanel.tsx` — region 入口：TabStrip + TabBodyStack（**替换**旧占位实现）
- `features/dock/DockPanel.test.tsx` — region 入口组件测试（迁移自 `RightPanel.test.tsx`）
- `features/dock/dockDnd.ts` — DnD 纯逻辑：`restrictToWindowBelowTitlebar` modifier + `planDrop` 决策
- `features/dock/dockDnd.test.ts` — `planDrop` 单元测试
- `features/dock/DockDndProvider.tsx` — App 级 DndContext + DragOverlay

**修改**
- `stores/layoutStore.ts` — 新增 `setTerminalOpen`（dockStore 展开底坞需要）
- `stores/layoutStore.test.ts` — 覆盖 `setTerminalOpen`
- `features/tools/extensionCards.tsx:19,153` — `useRightPanelStore` → `useDockStore`
- `features/panels/PageContentViewer.tsx:8` — `PageView` 改从 `dockStore` 导入
- `App.tsx` — 右栏/底坞改用 `DockPanel`；包 `DockDndProvider`；新增 subagent 同步与工作区切换重置 effect

**删除**
- `stores/rightPanelStore.ts`
- `features/panels/RightPanel.tsx`
- `features/panels/RightPanel.test.tsx`
- `features/panels/index.ts`（仅导出 RightPanel，弃用）
- `features/terminal/TerminalPanel.tsx`

> `features/panels/PageContentViewer.tsx`、`SubAgentConversation.tsx`、`subagentUtils.ts` **保留**，被 dock body 复用。

---

## 任务 T1：layoutStore 新增 `setTerminalOpen`

`dockStore` 在底坞新增/移入 tab 时要展开终端外壳。`layoutStore` 现有 `setRightPanelOpen` 但终端只有 `toggleTerminal`，需补一个对称的 setter。

**文件：**
- 修改：`tauri-agent/src/stores/layoutStore.ts:21-30`（接口）、`:62-70`（实现）
- 测试：`tauri-agent/src/stores/layoutStore.test.ts`

- [ ] **步骤 1：在测试里加失败用例**

在 `layoutStore.test.ts` 的 `describe('layoutStore', ...)` 内、`should toggle terminal` 用例之后新增：

```typescript
  it('should set terminal open explicitly (idempotent)', () => {
    useLayoutStore.getState().setTerminalOpen(true);
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    useLayoutStore.getState().setTerminalOpen(true);
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    useLayoutStore.getState().setTerminalOpen(false);
    expect(useLayoutStore.getState().terminalOpen).toBe(false);
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/stores/layoutStore.test.ts`
预期：FAIL，报 `setTerminalOpen is not a function`。

- [ ] **步骤 3：实现 `setTerminalOpen`**

在 `layoutStore.ts` 接口 `LayoutState` 中，`toggleTerminal` 行下方新增声明：

```typescript
  setTerminalOpen: (open: boolean) => void;
```

在实现对象里，`toggleTerminal` 实现下方新增：

```typescript
      setTerminalOpen: (open) => set({ terminalOpen: open }),
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/stores/layoutStore.test.ts`
预期：PASS（含原有用例）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/stores/layoutStore.ts tauri-agent/src/stores/layoutStore.test.ts
git commit -m "feat(dock): add layoutStore.setTerminalOpen"
```

---

## 任务 T2：`dockStore` 统一状态机 + 单元测试

统一 tab 列表、各坞激活态、增删改、跨坞移动、page 打开、subagent 同步、工作区重置；persist 到 `hermes-dock`（终端 runtime `shellId` 不持久化）。

**文件：**
- 创建：`tauri-agent/src/stores/dockStore.ts`
- 测试：`tauri-agent/src/stores/dockStore.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `tauri-agent/src/stores/dockStore.test.ts`：

```typescript
import { beforeEach, describe, expect, it } from 'vitest';
import { useDockStore, defaultTerminalTitle, type DockTab } from './dockStore';
import { useLayoutStore } from './layoutStore';
import type { ChatMessage } from './agentReducer';

function reset() {
  localStorage.clear();
  useDockStore.setState({ tabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
}

const spawn = (id: string, toolCallId: string, task: string): ChatMessage => ({
  kind: 'tool',
  id,
  toolCallId,
  toolName: 'spawn_agent',
  args: { task },
  result: {},
  status: 'running',
});

describe('dockStore', () => {
  beforeEach(reset);

  it('openPage adds a right page tab, activates it, opens the right panel, and dedupes by url', () => {
    useDockStore.getState().openPage({ url: 'https://a', content: 'first' });
    let tabs = useDockStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe('page:https://a');
    expect(tabs[0].region).toBe('right');
    expect(useDockStore.getState().activeByRegion.right).toBe('page:https://a');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);

    // same url updates payload instead of adding a tab
    useDockStore.getState().openPage({ url: 'https://a', content: 'second' });
    tabs = useDockStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect((tabs[0].payload as { content: string }).content).toBe('second');
  });

  it('closeTab activates the left neighbor of the closed active tab', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://1', content: '' });
    s.openPage({ url: 'https://2', content: '' });
    s.openPage({ url: 'https://3', content: '' });
    s.setActive('right', 'page:https://2');
    s.closeTab('page:https://2');
    expect(useDockStore.getState().activeByRegion.right).toBe('page:https://1');
  });

  it('moveTabRegion moves a page to bottom and rejects moving a terminal to right', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://p', content: '' });
    s.moveTabRegion('page:https://p', 'bottom');
    let tab = useDockStore.getState().tabs.find((t) => t.id === 'page:https://p')!;
    expect(tab.region).toBe('bottom');
    expect(useDockStore.getState().activeByRegion.bottom).toBe('page:https://p');
    expect(useLayoutStore.getState().terminalOpen).toBe(true);

    s.addTab({ id: 'term-1', kind: 'terminal', region: 'bottom', title: 'T', closable: true, payload: { status: 'idle' } });
    s.moveTabRegion('term-1', 'right');
    tab = useDockStore.getState().tabs.find((t) => t.id === 'term-1')!;
    expect(tab.region).toBe('bottom'); // rejected
  });

  it('reorderTabs reorders within a region by index', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://1', content: '' });
    s.openPage({ url: 'https://2', content: '' });
    s.reorderTabs('right', 0, 1);
    const order = useDockStore.getState().tabs
      .filter((t) => t.region === 'right')
      .sort((a, b) => a.order - b.order)
      .map((t) => t.id);
    expect(order).toEqual(['page:https://2', 'page:https://1']);
  });

  it('syncSubAgentTabs adds tabs for spawn_agent messages and removes vanished ones', () => {
    const s = useDockStore.getState();
    s.syncSubAgentTabs([spawn('t1', 'c1', 'first'), { kind: 'tool', id: 'b', toolCallId: 'cb', toolName: 'bash', args: {}, result: {}, status: 'done' }, spawn('t2', 'c2', 'second')]);
    let subs = useDockStore.getState().tabs.filter((t) => t.kind === 'subagent');
    expect(subs.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(subs[0].closable).toBe(false);
    expect(subs[0].title).toBe('#1 first');
    expect(subs[1].title).toBe('#2 second');

    s.syncSubAgentTabs([spawn('t1', 'c1', 'first')]);
    subs = useDockStore.getState().tabs.filter((t) => t.kind === 'subagent');
    expect(subs.map((t) => t.id)).toEqual(['t1']);
  });

  it('resetWorkspaceTabs drops terminals (keeping one fresh idle) and keeps page tabs', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://keep', content: '' });
    s.addTab({ id: 'term-1', kind: 'terminal', region: 'bottom', title: defaultTerminalTitle(), closable: true, payload: { status: 'running', shellId: 'sh1' } });
    s.resetWorkspaceTabs();
    const tabs = useDockStore.getState().tabs;
    expect(tabs.some((t) => t.id === 'page:https://keep')).toBe(true);
    const terms = tabs.filter((t) => t.kind === 'terminal');
    expect(terms).toHaveLength(1);
    expect((terms[0].payload as { status: string }).status).toBe('idle');
    expect(terms[0].id).not.toBe('term-1');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/stores/dockStore.test.ts`
预期：FAIL，报无法解析 `./dockStore`（文件尚不存在）。

- [ ] **步骤 3：实现 `dockStore.ts`**

创建 `tauri-agent/src/stores/dockStore.ts`：

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useLayoutStore } from './layoutStore';
import type { ChatMessage } from './agentReducer';
import { taskLabel } from '../features/panels/subagentUtils';

export type DockRegion = 'right' | 'bottom';
export type DockTabKind = 'terminal' | 'page' | 'subagent';
// 后续阶段：| 'file' | 'diff' | 'sidechat'

export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';

export interface TerminalPayload {
  /** 运行时 shell 会话 id，不持久化。 */
  shellId?: string;
  status: TerminalStatus;
}

export interface PagePayload {
  url: string;
  content: string;
  title?: string;
  chars?: number;
  crawler?: string;
}

/** 兼容现有调用方（extensionCards / PageContentViewer）的别名。 */
export type PageView = PagePayload;

export interface SubAgentPayload {
  messageId: string;
  toolCallId: string;
}

export type DockTabPayload = TerminalPayload | PagePayload | SubAgentPayload;

export interface DockTab {
  id: string;
  kind: DockTabKind;
  region: DockRegion;
  title: string;
  closable: boolean;
  /** 同 region 内排序。 */
  order: number;
  payload: DockTabPayload;
}

interface DockState {
  tabs: DockTab[];
  activeByRegion: Record<DockRegion, string | null>;

  addTab: (input: Omit<DockTab, 'order'> & { order?: number }) => void;
  closeTab: (id: string) => void;
  setActive: (region: DockRegion, id: string) => void;
  setTerminalStatus: (id: string, status: TerminalStatus, shellId?: string) => void;
  reorderTabs: (region: DockRegion, fromIndex: number, toIndex: number) => void;
  moveTabRegion: (id: string, targetRegion: DockRegion, insertIndex?: number) => void;
  openPage: (page: PageView) => void;
  syncSubAgentTabs: (messages: ChatMessage[]) => void;
  resetWorkspaceTabs: () => void;
}

type ToolMessage = Extract<ChatMessage, { kind: 'tool' }>;

/** 终端默认标题（Windows → PowerShell）。 */
export function defaultTerminalTitle(): string {
  if (typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent)) return 'PowerShell';
  return 'Terminal';
}

function nextOrder(tabs: DockTab[], region: DockRegion): number {
  return tabs.filter((t) => t.region === region).reduce((max, t) => Math.max(max, t.order), -1) + 1;
}

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** 用一批已更新的 tab 覆盖原列表中的同 id 项。 */
function patchTabs(tabs: DockTab[], updated: DockTab[]): DockTab[] {
  const byId = new Map(updated.map((t) => [t.id, t]));
  return tabs.map((t) => byId.get(t.id) ?? t);
}

export const useDockStore = create<DockState>()(
  persist(
    (set) => ({
      tabs: [],
      activeByRegion: { right: null, bottom: null },

      addTab: (input) => {
        set((s) => {
          const order = input.order ?? nextOrder(s.tabs, input.region);
          const tab: DockTab = { ...input, order };
          return {
            tabs: [...s.tabs, tab],
            activeByRegion: { ...s.activeByRegion, [input.region]: tab.id },
          };
        });
        if (input.region === 'right') useLayoutStore.getState().setRightPanelOpen(true);
        else useLayoutStore.getState().setTerminalOpen(true);
      },

      closeTab: (id) =>
        set((s) => {
          const target = s.tabs.find((t) => t.id === id);
          if (!target) return s;
          const region = target.region;
          const regionTabs = s.tabs.filter((t) => t.region === region).sort((a, b) => a.order - b.order);
          const index = regionTabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          const activeByRegion = { ...s.activeByRegion };
          if (activeByRegion[region] === id) {
            const remaining = regionTabs.filter((t) => t.id !== id);
            const fallback = remaining[Math.max(0, index - 1)] ?? remaining[0] ?? null;
            activeByRegion[region] = fallback ? fallback.id : null;
          }
          return { tabs, activeByRegion };
        }),

      setActive: (region, id) =>
        set((s) => ({ activeByRegion: { ...s.activeByRegion, [region]: id } })),

      setTerminalStatus: (id, status, shellId) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id && t.kind === 'terminal'
              ? { ...t, payload: { ...(t.payload as TerminalPayload), status, ...(shellId !== undefined ? { shellId } : {}) } }
              : t,
          ),
        })),

      reorderTabs: (region, fromIndex, toIndex) =>
        set((s) => {
          const inRegion = s.tabs.filter((t) => t.region === region).sort((a, b) => a.order - b.order);
          if (fromIndex < 0 || toIndex < 0 || fromIndex >= inRegion.length || toIndex >= inRegion.length) return s;
          const moved = moveItem(inRegion, fromIndex, toIndex).map((t, i) => ({ ...t, order: i }));
          return { tabs: patchTabs(s.tabs, moved) };
        }),

      moveTabRegion: (id, targetRegion, insertIndex) => {
        let moved = false;
        set((s) => {
          const tab = s.tabs.find((t) => t.id === id);
          if (!tab) return s;
          // 终端钉在底坞：拒绝移入右坞。
          if (tab.kind === 'terminal' && targetRegion === 'right') return s;
          if (tab.region === targetRegion) return s;

          const targetTabs = s.tabs.filter((t) => t.region === targetRegion).sort((a, b) => a.order - b.order);
          const at = insertIndex == null ? targetTabs.length : Math.max(0, Math.min(insertIndex, targetTabs.length));
          const movedTab: DockTab = { ...tab, region: targetRegion };
          const nextTarget = [...targetTabs.slice(0, at), movedTab, ...targetTabs.slice(at)].map((t, i) => ({ ...t, order: i }));
          moved = true;
          return {
            tabs: patchTabs(s.tabs, nextTarget),
            activeByRegion: { ...s.activeByRegion, [targetRegion]: id },
          };
        });
        if (!moved) return;
        if (targetRegion === 'right') useLayoutStore.getState().setRightPanelOpen(true);
        else useLayoutStore.getState().setTerminalOpen(true);
      },

      openPage: (page) => {
        const id = `page:${page.url}`;
        const title = page.title || page.url;
        set((s) => {
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? s.tabs.map((t) => (t.id === id ? { ...t, title, payload: { ...page } } : t))
            : [
                ...s.tabs,
                {
                  id,
                  kind: 'page' as const,
                  region: 'right' as const,
                  title,
                  closable: true,
                  order: nextOrder(s.tabs, 'right'),
                  payload: { ...page },
                },
              ];
          return { tabs, activeByRegion: { ...s.activeByRegion, right: id } };
        });
        useLayoutStore.getState().setRightPanelOpen(true);
      },

      syncSubAgentTabs: (messages) =>
        set((s) => {
          const spawn = messages.filter((m): m is ToolMessage => m.kind === 'tool' && m.toolName === 'spawn_agent');
          const wantIds = new Set(spawn.map((m) => m.id));
          const others = s.tabs.filter((t) => t.kind !== 'subagent');
          const keptById = new Map(
            s.tabs.filter((t) => t.kind === 'subagent' && wantIds.has(t.id)).map((t) => [t.id, t] as const),
          );
          let appendOrder = nextOrder(others, 'right') + keptById.size;

          const subTabs: DockTab[] = spawn.map((m, i) => {
            const title = `#${i + 1} ${taskLabel(m.args)}`;
            const existing = keptById.get(m.id);
            if (existing) return { ...existing, title };
            return {
              id: m.id,
              kind: 'subagent',
              region: 'right',
              title,
              closable: false,
              order: appendOrder++,
              payload: { messageId: m.id, toolCallId: m.toolCallId },
            };
          });

          const tabs = [...others, ...subTabs];
          const activeByRegion = { ...s.activeByRegion };
          (['right', 'bottom'] as DockRegion[]).forEach((region) => {
            const activeId = activeByRegion[region];
            if (activeId && !tabs.some((t) => t.id === activeId && t.region === region)) {
              activeByRegion[region] = tabs.filter((t) => t.region === region).at(-1)?.id ?? null;
            }
          });
          return { tabs, activeByRegion };
        }),

      resetWorkspaceTabs: () =>
        set((s) => {
          const hadTerminal = s.tabs.some((t) => t.kind === 'terminal');
          const kept = s.tabs.filter((t) => t.kind !== 'terminal');
          const fresh: DockTab | null = hadTerminal
            ? {
                id: `terminal-${Date.now()}`,
                kind: 'terminal',
                region: 'bottom',
                title: defaultTerminalTitle(),
                closable: true,
                order: 0,
                payload: { status: 'idle' },
              }
            : null;
          const tabs = fresh ? [...kept, fresh] : kept;
          return {
            tabs,
            activeByRegion: { ...s.activeByRegion, bottom: fresh ? fresh.id : null },
          };
        }),
    }),
    {
      name: 'hermes-dock',
      // 终端 runtime shellId 不持久化，重置为 idle；subagent tab 由 messages 同步重建，不持久化。
      partialize: (s) => ({
        tabs: s.tabs
          .filter((t) => t.kind !== 'subagent')
          .map((t) => (t.kind === 'terminal' ? { ...t, payload: { status: 'idle' as const } } : t)),
        activeByRegion: s.activeByRegion,
      }),
    },
  ),
);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/stores/dockStore.test.ts`
预期：PASS（6 个用例全绿）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/stores/dockStore.ts tauri-agent/src/stores/dockStore.test.ts
git commit -m "feat(dock): add unified dockStore with tabs/regions/persist"
```

---

## 任务 T3：共享样式 + `TabStrip` + `SortableDockTab`

把 `RightPanel.tsx` 与 `TerminalPanel.tsx` 里几乎一致的 tab 样式合并到 `dockTabStyles.ts`，并新建展示型 tab 条。

**文件：**
- 创建：`tauri-agent/src/features/dock/dockTabStyles.ts`
- 创建：`tauri-agent/src/features/dock/SortableDockTab.tsx`
- 创建：`tauri-agent/src/features/dock/TabStrip.tsx`
- 测试：`tauri-agent/src/features/dock/TabStrip.test.tsx`

- [ ] **步骤 1：实现 `dockTabStyles.ts`**

创建 `tauri-agent/src/features/dock/dockTabStyles.ts`：

```typescript
import { createStaticStyles, cssVar, useTheme } from 'antd-style';
import { HEADER_HEIGHT } from '../../components/PanelHeader';
import type { DockTab, TerminalPayload } from '../../stores/dockStore';

export type DotTone = 'neutral' | 'success' | 'warning' | 'error';
type AppTheme = ReturnType<typeof useTheme>;

export const dockTabStyles = createStaticStyles(({ css }) => ({
  container: css`
    height: 100%;
    min-height: 0;
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: ${HEADER_HEIGHT}px;
    padding: 0 8px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgElevated};
  `,
  tabs: css`
    display: flex;
    flex: 1;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  `,
  actions: css`
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
  `,
  tab: css`
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 180px;
    height: 28px;
    padding: 0 4px 0 12px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    cursor: grab;
    user-select: none;
    touch-action: none;
    outline: none;

    &:active {
      cursor: grabbing;
    }

    &:focus,
    &:focus-visible {
      outline: none;
    }

    &:hover {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }
  `,
  tabActive: css`
    border-color: ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFill};
    color: ${cssVar.colorText};
  `,
  tabTitle: css`
    overflow: hidden;
    flex: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  tabClose: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillSecondary};
      color: ${cssVar.colorText};
    }
  `,
  tabCloseSpacer: css`
    width: 4px;
    flex: none;
  `,
  statusDot: css`
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: ${cssVar.colorTextQuaternary};
  `,
  toneSuccess: css`
    background: ${cssVar.colorSuccess};
  `,
  toneWarning: css`
    background: ${cssVar.colorWarning};
  `,
  toneError: css`
    background: ${cssVar.colorError};
  `,
  body: css`
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: ${cssVar.colorBgContainer};
  `,
  bodyItem: css`
    position: absolute;
    inset: 0;
    flex-direction: column;
    overflow: hidden;
  `,
  terminalHost: css`
    height: 100%;
    padding: 8px;

    .xterm {
      height: 100%;
    }
  `,
  empty: css`
    display: flex;
    align-items: center;
    flex: 1;
    padding: 12px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

/** tab → 状态点色调。终端 running=绿、subagent running=黄（语义不同，分 kind 处理）。 */
export function resolveTone(tab: DockTab, subAgentStatus?: 'running' | 'done' | 'error'): DotTone {
  if (tab.kind === 'terminal') {
    const s = (tab.payload as TerminalPayload).status;
    if (s === 'running') return 'success';
    if (s === 'starting') return 'warning';
    if (s === 'error' || s === 'exited') return 'error';
    return 'neutral';
  }
  if (tab.kind === 'subagent') {
    if (subAgentStatus === 'done') return 'success';
    if (subAgentStatus === 'running') return 'warning';
    if (subAgentStatus === 'error') return 'error';
    return 'neutral';
  }
  return 'neutral';
}

/** DragOverlay portal 到 body 后脱离主题容器，需用解析后的实色。 */
export function toneColor(theme: AppTheme, tone: DotTone): string {
  switch (tone) {
    case 'success':
      return theme.colorSuccess;
    case 'warning':
      return theme.colorWarning;
    case 'error':
      return theme.colorError;
    default:
      return theme.colorTextQuaternary;
  }
}
```

- [ ] **步骤 2：实现 `SortableDockTab.tsx`**

创建 `tauri-agent/src/features/dock/SortableDockTab.tsx`：

```tsx
import { Icon } from '@lobehub/ui';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cx } from 'antd-style';
import { Globe, X } from 'lucide-react';
import { dockTabStyles, type DotTone } from './dockTabStyles';
import type { DockTab } from '../../stores/dockStore';

interface SortableDockTabProps {
  tab: DockTab;
  active: boolean;
  tone: DotTone;
  onActivate: () => void;
  onClose: () => void;
}

function toneClass(tone: DotTone): string {
  return cx(
    dockTabStyles.statusDot,
    tone === 'success' && dockTabStyles.toneSuccess,
    tone === 'warning' && dockTabStyles.toneWarning,
    tone === 'error' && dockTabStyles.toneError,
  );
}

export function SortableDockTab({ tab, active, tone, onActivate, onClose }: SortableDockTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });

  return (
    <div
      ref={setNodeRef}
      role="tab"
      aria-selected={active}
      data-testid={`dock-tab-${tab.id}`}
      className={cx(dockTabStyles.tab, active && dockTabStyles.tabActive)}
      style={{ opacity: isDragging ? 0.4 : undefined, transform: CSS.Transform.toString(transform), transition }}
      onClick={onActivate}
      {...attributes}
      {...listeners}
    >
      {tab.kind === 'page' ? (
        <Icon icon={Globe} size={12} style={{ flex: 'none' }} />
      ) : (
        <span className={toneClass(tone)} />
      )}
      <span className={dockTabStyles.tabTitle}>{tab.title}</span>
      {tab.closable ? (
        <button
          type="button"
          className={dockTabStyles.tabClose}
          title="关闭"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X size={12} />
        </button>
      ) : (
        <span className={dockTabStyles.tabCloseSpacer} />
      )}
    </div>
  );
}
```

- [ ] **步骤 3：实现 `TabStrip.tsx`**

创建 `tauri-agent/src/features/dock/TabStrip.tsx`：

```tsx
import type { ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { dockTabStyles, type DotTone } from './dockTabStyles';
import { SortableDockTab } from './SortableDockTab';
import type { DockRegion, DockTab } from '../../stores/dockStore';

interface TabStripProps {
  region: DockRegion;
  /** 已按 region 过滤并按 order 排序的 tab。 */
  tabs: DockTab[];
  activeId: string | null;
  toneOf: (tab: DockTab) => DotTone;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** 右对齐的操作区（＋ 菜单 / 折叠按钮）。 */
  actions?: ReactNode;
}

export function TabStrip({ region, tabs, activeId, toneOf, onActivate, onClose, actions }: TabStripProps) {
  // 区域级 droppable：拖到 tab 之间空白处也能落入本坞（跨坞互拖需要）。
  const { setNodeRef } = useDroppable({ id: `dock:${region}` });

  return (
    <div className={dockTabStyles.header}>
      <div ref={setNodeRef} className={dockTabStyles.tabs} role="tablist" data-testid={`dock-strip-${region}`}>
        <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          {tabs.map((tab) => (
            <SortableDockTab
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              tone={toneOf(tab)}
              onActivate={() => onActivate(tab.id)}
              onClose={() => onClose(tab.id)}
            />
          ))}
        </SortableContext>
      </div>
      {actions != null ? <div className={dockTabStyles.actions}>{actions}</div> : null}
    </div>
  );
}
```

- [ ] **步骤 4：编写组件测试**

创建 `tauri-agent/src/features/dock/TabStrip.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabStrip } from './TabStrip';
import { resolveTone } from './dockTabStyles';
import type { DockTab } from '../../stores/dockStore';

afterEach(cleanup);

const pageTab: DockTab = { id: 'page:u', kind: 'page', region: 'right', title: 'Example', closable: true, order: 0, payload: { url: 'u', content: '' } };
const subTab: DockTab = { id: 's1', kind: 'subagent', region: 'right', title: '#1 task', closable: false, order: 1, payload: { messageId: 's1', toolCallId: 'c1' } };

function renderStrip(props: Partial<React.ComponentProps<typeof TabStrip>> = {}) {
  return render(
    <DndContext>
      <TabStrip
        region="right"
        tabs={[pageTab, subTab]}
        activeId="page:u"
        toneOf={(t) => resolveTone(t)}
        onActivate={props.onActivate ?? (() => {})}
        onClose={props.onClose ?? (() => {})}
        {...props}
      />
    </DndContext>,
  );
}

describe('TabStrip', () => {
  it('renders one tab per item and marks the active one', () => {
    renderStrip();
    expect(screen.getByTestId('dock-tab-page:u').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('dock-tab-s1').getAttribute('aria-selected')).toBe('false');
  });

  it('fires onActivate when a tab is clicked', () => {
    const onActivate = vi.fn();
    renderStrip({ onActivate });
    fireEvent.click(screen.getByTestId('dock-tab-s1'));
    expect(onActivate).toHaveBeenCalledWith('s1');
  });

  it('shows a close button only on closable tabs and fires onClose', () => {
    const onClose = vi.fn();
    renderStrip({ onClose });
    const closeBtn = screen.getByTestId('dock-tab-page:u').querySelector('button');
    expect(closeBtn).not.toBeNull();
    expect(screen.getByTestId('dock-tab-s1').querySelector('button')).toBeNull();
    fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalledWith('page:u');
  });
});
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/dock/TabStrip.test.tsx`
预期：PASS（3 个用例）。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/dock/dockTabStyles.ts tauri-agent/src/features/dock/SortableDockTab.tsx tauri-agent/src/features/dock/TabStrip.tsx tauri-agent/src/features/dock/TabStrip.test.tsx
git commit -m "feat(dock): add shared tab styles, SortableDockTab and TabStrip"
```

---

## 任务 T4：`DockPanel` + `TabBodyStack` + `TabBodyRenderer` + page/subagent body

region 入口：读 `dockStore` 与 messages，渲染 tab 条 + keep-alive body 区。此任务**不含**终端 body（T5），但 `TabBodyRenderer` 先把 `terminal` 指向一个临时占位，T5 再替换为真正的 `TerminalBody`。

**文件：**
- 创建：`tauri-agent/src/features/dock/TabBodyRenderer.tsx`
- 创建：`tauri-agent/src/features/dock/TabBodyStack.tsx`
- 创建：`tauri-agent/src/features/dock/PageBody.tsx`
- 创建：`tauri-agent/src/features/dock/SubAgentBody.tsx`
- 创建：`tauri-agent/src/features/dock/DockPanel.tsx`（**覆盖**旧占位文件）
- 测试：`tauri-agent/src/features/dock/DockPanel.test.tsx`

- [ ] **步骤 1：实现 `PageBody.tsx`**

创建 `tauri-agent/src/features/dock/PageBody.tsx`：

```tsx
import { PageContentViewer } from '../panels/PageContentViewer';
import { useDockStore, type PagePayload } from '../../stores/dockStore';
import type { DockBodyProps } from './TabBodyRenderer';

export function PageBody({ tab }: DockBodyProps) {
  const closeTab = useDockStore((s) => s.closeTab);
  return <PageContentViewer page={tab.payload as PagePayload} onClose={() => closeTab(tab.id)} />;
}
```

- [ ] **步骤 2：实现 `SubAgentBody.tsx`**

创建 `tauri-agent/src/features/dock/SubAgentBody.tsx`：

```tsx
import { useAgentStore } from '../../stores/AgentStoreContext';
import type { ChatMessage } from '../../stores/agentReducer';
import { SubAgentConversation } from '../panels/SubAgentConversation';
import { taskLabel } from '../panels/subagentUtils';
import type { SubAgentPayload } from '../../stores/dockStore';
import type { DockBodyProps } from './TabBodyRenderer';

type ToolMessage = Extract<ChatMessage, { kind: 'tool' }>;

export function SubAgentBody({ tab }: DockBodyProps) {
  const payload = tab.payload as SubAgentPayload;
  const store = useAgentStore();
  const sa = store.useStore(
    (s) => s.messages.find((m) => m.kind === 'tool' && m.id === payload.messageId) as ToolMessage | undefined,
  );
  if (!sa) return null;
  return (
    <SubAgentConversation
      key={tab.id}
      data-testid={`subagent-${payload.toolCallId}`}
      task={taskLabel(sa.args)}
      result={sa.result}
      status={sa.status}
    />
  );
}
```

- [ ] **步骤 3：实现 `TabBodyRenderer.tsx`（终端用临时占位）**

创建 `tauri-agent/src/features/dock/TabBodyRenderer.tsx`：

```tsx
import type { ComponentType } from 'react';
import type { DockTab, DockTabKind } from '../../stores/dockStore';
import { PageBody } from './PageBody';
import { SubAgentBody } from './SubAgentBody';

export interface DockBodyProps {
  tab: DockTab;
  active: boolean;
}

// T5 会把 terminal 替换为真正的 TerminalBody。
function TerminalBodyPlaceholder() {
  return null;
}

const BODY_RENDERERS: Record<DockTabKind, ComponentType<DockBodyProps>> = {
  terminal: TerminalBodyPlaceholder,
  page: PageBody,
  subagent: SubAgentBody,
  // file: FileBody,        // 阶段 2
  // diff: DiffBody,        // 阶段 3
  // sidechat: SideChatBody // 阶段 4
};

export function TabBodyRenderer({ tab, active }: DockBodyProps) {
  const Body = BODY_RENDERERS[tab.kind];
  return <Body tab={tab} active={active} />;
}
```

- [ ] **步骤 4：实现 `TabBodyStack.tsx`**

创建 `tauri-agent/src/features/dock/TabBodyStack.tsx`：

```tsx
import { dockTabStyles } from './dockTabStyles';
import { TabBodyRenderer } from './TabBodyRenderer';
import type { DockTab } from '../../stores/dockStore';

interface TabBodyStackProps {
  tabs: DockTab[];
  activeId: string | null;
  emptyHint: string;
}

/** keep-alive：所有 body 常驻挂载，仅切换显隐（终端 xterm 实例昂贵，不可卸载）。 */
export function TabBodyStack({ tabs, activeId, emptyHint }: TabBodyStackProps) {
  return (
    <div className={dockTabStyles.body}>
      {tabs.length === 0 ? <div className={dockTabStyles.empty}>{emptyHint}</div> : null}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={dockTabStyles.bodyItem}
          style={{ display: tab.id === activeId ? 'flex' : 'none' }}
          data-testid={`dock-body-${tab.id}`}
        >
          <TabBodyRenderer tab={tab} active={tab.id === activeId} />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **步骤 5：实现 `DockPanel.tsx`（覆盖旧占位）**

覆盖 `tauri-agent/src/features/dock/DockPanel.tsx` 全部内容：

```tsx
import { useCallback, useEffect, useMemo } from 'react';
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { Dropdown } from 'antd';
import { PanelRightClose, Plus } from 'lucide-react';
import { useAgentStore } from '../../stores/AgentStoreContext';
import {
  defaultTerminalTitle,
  useDockStore,
  type DockRegion,
  type DockTab,
} from '../../stores/dockStore';
import { resolveTone } from './dockTabStyles';
import { TabStrip } from './TabStrip';
import { TabBodyStack } from './TabBodyStack';

interface DockPanelProps {
  region: DockRegion;
  /** 收起本坞外壳（右坞传入）。 */
  onCollapse?: () => void;
}

export function DockPanel({ region, onCollapse }: DockPanelProps) {
  const store = useAgentStore();
  const messages = store.useStore((s) => s.messages);
  const allTabs = useDockStore((s) => s.tabs);
  const activeByRegion = useDockStore((s) => s.activeByRegion);
  const setActive = useDockStore((s) => s.setActive);
  const closeTab = useDockStore((s) => s.closeTab);
  const addTab = useDockStore((s) => s.addTab);
  const syncSubAgentTabs = useDockStore((s) => s.syncSubAgentTabs);

  // 仅右坞实例负责把 subagent tab 与 messages 对齐（subagent 默认落右坞，sync 作用于全部 region）。
  useEffect(() => {
    if (region === 'right') syncSubAgentTabs(messages);
  }, [region, messages, syncSubAgentTabs]);

  const subAgentStatus = useMemo(() => {
    const map: Record<string, 'running' | 'done' | 'error'> = {};
    for (const m of messages) {
      if (m.kind === 'tool' && m.toolName === 'spawn_agent') map[m.id] = m.status;
    }
    return map;
  }, [messages]);

  const tabs = useMemo(
    () => allTabs.filter((t) => t.region === region).sort((a, b) => a.order - b.order),
    [allTabs, region],
  );
  const activeId = activeByRegion[region] ?? tabs.at(-1)?.id ?? null;

  const toneOf = useCallback(
    (tab: DockTab) => resolveTone(tab, tab.kind === 'subagent' ? subAgentStatus[tab.id] : undefined),
    [subAgentStatus],
  );

  const addTerminal = useCallback(() => {
    addTab({
      id: `terminal-${Date.now()}`,
      kind: 'terminal',
      region: 'bottom',
      title: defaultTerminalTitle(),
      closable: true,
      payload: { status: 'idle' },
    });
  }, [addTab]);

  const actions = (
    <>
      {region === 'bottom' ? (
        <ActionIcon icon={Plus} size="small" title="新建终端" onClick={addTerminal} />
      ) : (
        <Dropdown
          trigger={['click']}
          menu={{ items: [{ key: 'hint', disabled: true, label: '从 fetch_url 卡片或 spawn_agent 打开' }] }}
        >
          <ActionIcon icon={Plus} size="small" title="新建" />
        </Dropdown>
      )}
      {onCollapse ? (
        <ActionIcon icon={PanelRightClose} size="small" title="Collapse panel" onClick={onCollapse} />
      ) : null}
    </>
  );

  const emptyHint =
    region === 'bottom'
      ? '没有打开的终端。点击右上角 + 新建。'
      : '暂无内容。点击工具卡片（如 fetch_url 结果）或用 spawn_agent 委派任务，会在这里以独立 tab 打开。';

  return (
    <Flexbox className="dock-panel" style={{ height: '100%', minHeight: 0 }}>
      <TabStrip
        region={region}
        tabs={tabs}
        activeId={activeId}
        toneOf={toneOf}
        onActivate={(id) => setActive(region, id)}
        onClose={closeTab}
        actions={actions}
      />
      <TabBodyStack tabs={tabs} activeId={activeId} emptyHint={emptyHint} />
    </Flexbox>
  );
}
```

- [ ] **步骤 6：编写组件测试（迁移自 RightPanel.test.tsx）**

创建 `tauri-agent/src/features/dock/DockPanel.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { messagesRef } = vi.hoisted(() => ({ messagesRef: { current: [] as unknown[] } }));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStore: () => ({
    useStore: (sel: (s: { messages: unknown[] }) => unknown) => sel({ messages: messagesRef.current }),
  }),
}));
vi.mock('../panels/SubAgentConversation', () => ({
  SubAgentConversation: ({
    task,
    status,
    'data-testid': testId,
  }: {
    task: string;
    result: unknown;
    status: string;
    'data-testid'?: string;
  }) => (
    <div data-testid={testId}>
      <span>{task}</span>
      <span>{status}</span>
    </div>
  ),
}));

import { DockPanel } from './DockPanel';
import { useDockStore } from '../../stores/dockStore';

afterEach(() => {
  cleanup();
  messagesRef.current = [];
  localStorage.clear();
  useDockStore.setState({ tabs: [], activeByRegion: { right: null, bottom: null } });
});

function renderRight() {
  return render(
    <DndContext>
      <DockPanel region="right" />
    </DndContext>,
  );
}

describe('DockPanel (right region)', () => {
  it('shows the empty hint when there is no content', () => {
    renderRight();
    expect(screen.getByText(/暂无内容/)).toBeTruthy();
  });

  it('renders one tab per spawn_agent (ignoring other tools) and shows the active conversation', () => {
    messagesRef.current = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'spawn_agent', args: { task: 'research X' }, result: {}, status: 'running' },
      { kind: 'tool', id: 't2', toolCallId: 'c2', toolName: 'bash', args: {}, result: {}, status: 'done' },
    ];
    renderRight();
    expect(screen.getByTestId('dock-tab-t1')).toBeTruthy();
    expect(screen.queryByTestId('dock-tab-t2')).toBeNull();
    expect(screen.getByTestId('subagent-c1').textContent).toContain('research X');
  });

  it('switches the active conversation when another tab is clicked', () => {
    messagesRef.current = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'spawn_agent', args: { task: 'first task' }, result: {}, status: 'done' },
      { kind: 'tool', id: 't2', toolCallId: 'c2', toolName: 'spawn_agent', args: { task: 'second task' }, result: {}, status: 'running' },
    ];
    renderRight();
    // 默认激活最新（t2）。
    expect(screen.getByTestId('dock-body-t2').style.display).toBe('flex');
    fireEvent.click(screen.getByTestId('dock-tab-t1'));
    expect(screen.getByTestId('dock-body-t1').style.display).toBe('flex');
    expect(screen.getByTestId('dock-body-t2').style.display).toBe('none');
  });
});
```

- [ ] **步骤 7：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/dock/DockPanel.test.tsx`
预期：PASS（3 个用例）。

- [ ] **步骤 8：Commit**

```bash
git add tauri-agent/src/features/dock/PageBody.tsx tauri-agent/src/features/dock/SubAgentBody.tsx tauri-agent/src/features/dock/TabBodyRenderer.tsx tauri-agent/src/features/dock/TabBodyStack.tsx tauri-agent/src/features/dock/DockPanel.tsx tauri-agent/src/features/dock/DockPanel.test.tsx
git commit -m "feat(dock): add DockPanel, body stack/renderer and page/subagent bodies"
```

---

## 任务 T5：`TerminalBody` 拆分迁移

把 `TerminalPanel` 的单个 xterm 生命周期拆成每 tab 一个 `TerminalBody`：自建 xterm/FitAddon、懒启动 shell、绑定输入输出、向 `dockStore` 回写状态、激活时 refit/focus、卸载时停 shell。

**文件：**
- 创建：`tauri-agent/src/features/dock/TerminalBody.tsx`
- 修改：`tauri-agent/src/features/dock/TabBodyRenderer.tsx`（占位 → 真 body）
- 测试：`tauri-agent/src/features/dock/TerminalBody.test.tsx`

- [ ] **步骤 1：实现 `TerminalBody.tsx`**

创建 `tauri-agent/src/features/dock/TerminalBody.tsx`：

```tsx
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTheme } from 'antd-style';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { terminal } from '../../lib/terminal';
import { useDockStore, type TerminalPayload } from '../../stores/dockStore';
import { dockTabStyles } from './dockTabStyles';
import type { DockBodyProps } from './TabBodyRenderer';

export function TerminalBody({ tab, active }: DockBodyProps) {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const theme = useTheme();
  const setTerminalStatus = useDockStore((s) => s.setTerminalStatus);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const disposeRef = useRef<{ dispose: () => void } | null>(null);
  const shellIdRef = useRef<string | undefined>((tab.payload as TerminalPayload).shellId);
  const pendingRef = useRef<string[]>([]);

  const xtermTheme = useMemo(
    () => ({
      background: theme.colorBgContainer,
      cursor: theme.colorPrimary,
      foreground: theme.colorText,
      selectionBackground: theme.colorFillSecondary,
    }),
    [theme.colorBgContainer, theme.colorFillSecondary, theme.colorPrimary, theme.colorText],
  );

  const write = useCallback((data: string) => {
    const normalized = data.replace(/\r?\n/g, '\r\n');
    if (termRef.current) termRef.current.write(normalized);
    else pendingRef.current.push(normalized);
  }, []);

  // 创建 xterm（仅一次），卸载时销毁。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || termRef.current) return;
    const term = new XTerm({
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      cursorStyle: 'block',
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      theme: xtermTheme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    const d = term.onData((data) => {
      const sid = shellIdRef.current;
      if (!sid) return;
      void terminal.shellWrite(sid, data).catch((err) => write(`\r\n[write error] ${String(err)}\r\n`));
    });
    termRef.current = term;
    fitRef.current = fit;
    disposeRef.current = d;
    if (pendingRef.current.length) {
      pendingRef.current.forEach((c) => term.write(c));
      pendingRef.current = [];
    }
    return () => {
      d.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      disposeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 懒启动 shell：workspace 就绪且当前 tab 仍是 idle。
  useEffect(() => {
    if (!workspaceReady) return;
    if ((tab.payload as TerminalPayload).status !== 'idle') return;
    let cancelled = false;
    setTerminalStatus(tab.id, 'starting');
    void terminal
      .shellStart(workspace)
      .then(({ session_id }) => {
        if (cancelled) {
          void terminal.shellStop(session_id);
          return;
        }
        shellIdRef.current = session_id;
        setTerminalStatus(tab.id, 'running', session_id);
      })
      .catch((err) => {
        write(`\r\n[shell error] ${String(err)}\r\n`);
        setTerminalStatus(tab.id, 'error');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceReady, workspace, tab.id]);

  // 监听本 shell 的输出/退出。
  useEffect(() => {
    let un: (() => void) | undefined;
    void terminal
      .onShellOutput((event) => {
        if (!event.session_id || event.session_id !== shellIdRef.current) return;
        if (event.type === 'output' && event.data) write(event.data);
        if (event.type === 'exit') {
          write(`\r\n[shell exited ${event.exit_code ?? 0}]\r\n`);
          shellIdRef.current = undefined;
          setTerminalStatus(tab.id, 'exited');
        }
      })
      .then((fn) => {
        un = fn;
      });
    return () => un?.();
  }, [tab.id, setTerminalStatus, write]);

  // 卸载（tab 关闭）时停止 shell。
  useEffect(() => {
    return () => {
      const sid = shellIdRef.current;
      if (sid) void terminal.shellStop(sid);
    };
  }, []);

  // 主题变化时刷新。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme;
    term.refresh(0, term.rows - 1);
  }, [xtermTheme]);

  // 激活时 refit + focus。
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
  }, [active]);

  // 容器尺寸变化时 refit（仅激活态）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      if (active) fitRef.current?.fit();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [active]);

  return <div ref={hostRef} className={dockTabStyles.terminalHost} />;
}
```

- [ ] **步骤 2：把 `TabBodyRenderer` 的终端占位替换为真 body**

修改 `tauri-agent/src/features/dock/TabBodyRenderer.tsx`：

删除占位组件并改用真实 `TerminalBody`。把：

```tsx
import { PageBody } from './PageBody';
import { SubAgentBody } from './SubAgentBody';
```

改为：

```tsx
import { PageBody } from './PageBody';
import { SubAgentBody } from './SubAgentBody';
import { TerminalBody } from './TerminalBody';
```

删除：

```tsx
// T5 会把 terminal 替换为真正的 TerminalBody。
function TerminalBodyPlaceholder() {
  return null;
}
```

并把注册表中的 `terminal: TerminalBodyPlaceholder,` 改为：

```tsx
  terminal: TerminalBody,
```

- [ ] **步骤 3：编写 `TerminalBody` 生命周期测试（mock xterm + terminal lib）**

创建 `tauri-agent/src/features/dock/TerminalBody.test.tsx`：

```tsx
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('xterm/css/xterm.css', () => ({}));
vi.mock('xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    rows = 0;
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    focus() {}
    refresh() {}
    dispose() {}
  },
}));
vi.mock('xterm-addon-fit', () => ({ FitAddon: class { fit() {} } }));

const shellStart = vi.fn(async () => ({ session_id: 'sh-1' }));
const shellStop = vi.fn(async () => {});
const onShellOutput = vi.fn(async () => () => {});
vi.mock('../../lib/terminal', () => ({
  terminal: {
    shellStart: (...a: unknown[]) => shellStart(...a),
    shellStop: (...a: unknown[]) => shellStop(...a),
    shellWrite: vi.fn(async () => {}),
    onShellOutput: (...a: unknown[]) => onShellOutput(...a),
  },
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws', workspaceReady: true }),
}));

import { TerminalBody } from './TerminalBody';
import { useDockStore, type DockTab } from '../../stores/dockStore';

const termTab: DockTab = { id: 'term-1', kind: 'terminal', region: 'bottom', title: 'PowerShell', closable: true, order: 0, payload: { status: 'idle' } };

afterEach(() => {
  cleanup();
  localStorage.clear();
  useDockStore.setState({ tabs: [termTab], activeByRegion: { right: null, bottom: 'term-1' } });
  shellStart.mockClear();
});

describe('TerminalBody', () => {
  it('starts a shell on mount and reports running status into dockStore', async () => {
    useDockStore.setState({ tabs: [termTab], activeByRegion: { right: null, bottom: 'term-1' } });
    render(<TerminalBody tab={termTab} active />);
    await waitFor(() => expect(shellStart).toHaveBeenCalledWith('/ws'));
    await waitFor(() => {
      const t = useDockStore.getState().tabs.find((x) => x.id === 'term-1')!;
      expect((t.payload as { status: string }).status).toBe('running');
      expect((t.payload as { shellId?: string }).shellId).toBe('sh-1');
    });
  });
});
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/dock/TerminalBody.test.tsx`
预期：PASS（1 个用例）。

- [ ] **步骤 5：类型检查**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误（此时 `TerminalPanel.tsx` 仍在但未被本任务改动，旧 `RightPanel`/`rightPanelStore` 也仍在）。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/dock/TerminalBody.tsx tauri-agent/src/features/dock/TabBodyRenderer.tsx tauri-agent/src/features/dock/TerminalBody.test.tsx
git commit -m "feat(dock): extract per-tab TerminalBody xterm lifecycle"
```

---

## 任务 T6：接线 App + 迁移调用方 + 删除旧实现

把右栏/底坞切到 `DockPanel`，迁移 `extensionCards`/`PageContentViewer` 的 import，新增 App 级 subagent 同步与工作区切换重置 effect，删除 `RightPanel`/`TerminalPanel`/`rightPanelStore`/旧 index。此阶段暂无 DnD（T7 补），但终端/网页/子代理功能完整可用。

> dnd-kit 的 `useSortable`/`useDroppable`/`SortableContext` 在没有外层 `DndContext` 时使用默认空上下文，不会抛错，仅不可拖拽——因此本任务后 App 正常渲染。

**文件：**
- 修改：`tauri-agent/src/features/tools/extensionCards.tsx:19,153`
- 修改：`tauri-agent/src/features/panels/PageContentViewer.tsx:8`
- 修改：`tauri-agent/src/App.tsx`
- 删除：`tauri-agent/src/features/panels/RightPanel.tsx`、`RightPanel.test.tsx`、`features/panels/index.ts`、`stores/rightPanelStore.ts`、`features/terminal/TerminalPanel.tsx`

- [ ] **步骤 1：迁移 `extensionCards.tsx` 到 `useDockStore`**

把 `tauri-agent/src/features/tools/extensionCards.tsx:19`：

```tsx
import { useRightPanelStore } from '../../stores/rightPanelStore';
```

改为：

```tsx
import { useDockStore } from '../../stores/dockStore';
```

把 `:153`：

```tsx
  const openPage = useRightPanelStore((s) => s.openPage);
```

改为：

```tsx
  const openPage = useDockStore((s) => s.openPage);
```

- [ ] **步骤 2：迁移 `PageContentViewer.tsx` 的 `PageView` import**

把 `tauri-agent/src/features/panels/PageContentViewer.tsx:8`：

```tsx
import type { PageView } from '../../stores/rightPanelStore';
```

改为：

```tsx
import type { PageView } from '../../stores/dockStore';
```

- [ ] **步骤 3：改 `App.tsx` 的 import 与列组件**

把 `App.tsx:8-9`：

```tsx
import { RightPanel } from './features/panels';
import { TerminalPanel } from './features/terminal/TerminalPanel';
```

改为：

```tsx
import { DockPanel } from './features/dock/DockPanel';
import { DockDndProvider } from './features/dock/DockDndProvider';
import { useDockStore } from './stores/dockStore';
```

> `DockDndProvider` 在 T7 创建。为避免 T6 单独编译失败，**本步骤先建一个直通占位** `DockDndProvider`（T7 覆盖为真实现）。在 `tauri-agent/src/features/dock/DockDndProvider.tsx` 写入：
>
> ```tsx
> import type { ReactNode } from 'react';
> export function DockDndProvider({ children }: { children: ReactNode }) {
>   return <>{children}</>;
> }
> ```

把 `App.tsx:157-173` 的 `RightPanelColumn` 与 `TerminalColumn` 改为：

```tsx
const RightPanelColumn = memo(function RightPanelColumn() {
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);

  return (
    <RightPanelShell>
      <DockPanel region="right" onCollapse={toggleRightPanel} />
    </RightPanelShell>
  );
});

const TerminalColumn = memo(function TerminalColumn() {
  return (
    <TerminalShell>
      <DockPanel region="bottom" />
    </TerminalShell>
  );
});
```

- [ ] **步骤 4：在 `Workspace` 内新增 subagent 同步与工作区切换重置 effect**

在 `App.tsx` 的 `Workspace()` 中，`const isStreaming = store.useStore((s) => s.isStreaming);` 行之后新增订阅与两个 effect（`useRef` 已在文件顶部从 `react` 导入，需补 `useRef`）：

先把顶部 `import { useCallback, useEffect, memo } from 'react';` 改为：

```tsx
import { useCallback, useEffect, useRef, memo } from 'react';
```

再在 `Workspace` 内（紧接 `const activeSessionPath = ...` 之后）加入：

```tsx
  const messages = store.useStore((s) => s.messages);
  const prevWorkspaceRef = useRef(workspace);

  // 主对话的 spawn_agent 变化时，统一在此处把 subagent tab 与 messages 对齐（单点，避免多坞重复 sync）。
  useEffect(() => {
    useDockStore.getState().syncSubAgentTabs(messages);
  }, [messages]);

  // 切换工作区：dispose 旧终端（TerminalBody 卸载会停 shell）、终端重置为 1 个 idle，page 结构保留。
  useEffect(() => {
    if (prevWorkspaceRef.current !== workspace) {
      prevWorkspaceRef.current = workspace;
      useDockStore.getState().resetWorkspaceTabs();
    }
  }, [workspace]);
```

> 说明：`DockPanel(region="right")` 内也有 `syncSubAgentTabs` effect；两者都调用同一幂等 action，结果一致。如担心重复，可在 T6 后将 `DockPanel` 内的 sync effect删除、只保留 App 单点——但保留无害（幂等）。本计划保留 DockPanel 内 sync 以便组件测试自洽，App 单点用于覆盖底坞实例不渲染右坞时的场景。

- [ ] **步骤 5：用 `DockDndProvider` 包裹两坞（占位直通，不改布局）**

把 `App.tsx` 中（`394-419` 附近）chat 列内层：

```tsx
        <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
          <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
            <MainChatColumn />
            <RightPanelColumn />
          </Flexbox>
          <TerminalColumn />
        </Flexbox>
```

改为：

```tsx
        <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
          <DockDndProvider>
            <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
              <MainChatColumn />
              <RightPanelColumn />
            </Flexbox>
            <TerminalColumn />
          </DockDndProvider>
        </Flexbox>
```

> 注意：此片段位于 `MainColumnHeader`/`ModuleContainer` 之内，保持外层 `<Flexbox flex={1} ...>` 不动，仅在其内部包一层直通 Provider，布局不变。

- [ ] **步骤 6：删除旧实现**

```bash
git rm tauri-agent/src/features/panels/RightPanel.tsx tauri-agent/src/features/panels/RightPanel.test.tsx tauri-agent/src/features/panels/index.ts tauri-agent/src/stores/rightPanelStore.ts tauri-agent/src/features/terminal/TerminalPanel.tsx
```

- [ ] **步骤 7：类型检查 + 全量测试验证无回归**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误（确认没有遗留 import 指向已删文件；`features/panels/` 仅剩 `PageContentViewer.tsx` / `SubAgentConversation.tsx` / `subagentUtils.ts`，均被 dock body 复用）。

运行：`cd tauri-agent && npx vitest run`
预期：全绿（`RightPanel.test.tsx` 已删，`DockPanel.test.tsx` 等替代）。

- [ ] **步骤 8：手动冒烟（dev）**

运行：`cd tauri-agent && npx tauri dev`（或既有 dev 流程）。验证：
1. fetch_url 工具卡片点击 → 右坞出现 page tab，可切换/关闭。
2. spawn_agent → 右坞出现 subagent tab（无关闭按钮）。
3. 底坞 ＋ 新建终端、切换、关闭正常；输入输出正常。
4. 切换工作区 → 终端重置为 1 个 idle 并重新 spawn；page 结构保留。
5. 折叠/展开右坞与底坞，激活 tab 保留。

- [ ] **步骤 9：Commit**

```bash
git add -A tauri-agent/src
git commit -m "refactor(dock): wire DockPanel into App, migrate callers, drop RightPanel/TerminalPanel/rightPanelStore"
```

---

## 任务 T7：`DockDndProvider` + 跨坞互拖

用单一 App 级 `DndContext` 包裹两坞，实现同坞重排与 page/subagent 跨坞互拖；终端拖向右坞被拒（视觉弹回）。把拖拽决策抽成纯函数 `planDrop` 便于单测。

**文件：**
- 创建：`tauri-agent/src/features/dock/dockDnd.ts`
- 测试：`tauri-agent/src/features/dock/dockDnd.test.ts`
- 覆盖：`tauri-agent/src/features/dock/DockDndProvider.tsx`（替换 T6 的直通占位）

- [ ] **步骤 1：编写 `planDrop` 失败测试**

创建 `tauri-agent/src/features/dock/dockDnd.test.ts`：

```typescript
import { describe, expect, it } from 'vitest';
import { planDrop } from './dockDnd';
import type { DockTab } from '../../stores/dockStore';

const t = (id: string, kind: DockTab['kind'], region: DockTab['region'], order: number): DockTab => ({
  id,
  kind,
  region,
  order,
  title: id,
  closable: kind !== 'subagent',
  payload: kind === 'terminal' ? { status: 'idle' } : kind === 'page' ? { url: id, content: '' } : { messageId: id, toolCallId: id },
});

const tabs: DockTab[] = [
  t('p1', 'page', 'right', 0),
  t('p2', 'page', 'right', 1),
  t('term1', 'terminal', 'bottom', 0),
];

describe('planDrop', () => {
  it('reorders within the same region when dropped on a sibling tab', () => {
    expect(planDrop(tabs, 'p1', 'p2')).toEqual({ type: 'reorder', region: 'right', from: 0, to: 1 });
  });

  it('moves a page across regions when dropped on the bottom strip', () => {
    expect(planDrop(tabs, 'p1', 'dock:bottom')).toEqual({ type: 'move', id: 'p1', region: 'bottom', insertIndex: 1 });
  });

  it('moves a page across regions when dropped on a tab in the other region', () => {
    expect(planDrop(tabs, 'p2', 'term1')).toEqual({ type: 'move', id: 'p2', region: 'bottom', insertIndex: 0 });
  });

  it('rejects dragging a terminal to the right region', () => {
    expect(planDrop(tabs, 'term1', 'dock:right')).toBeNull();
    expect(planDrop(tabs, 'term1', 'p1')).toBeNull();
  });

  it('returns null for no-op (same index, missing target)', () => {
    expect(planDrop(tabs, 'p1', 'p1')).toBeNull();
    expect(planDrop(tabs, 'nope', 'p1')).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/dock/dockDnd.test.ts`
预期：FAIL，无法解析 `./dockDnd`。

- [ ] **步骤 3：实现 `dockDnd.ts`**

创建 `tauri-agent/src/features/dock/dockDnd.ts`：

```typescript
import type { Modifier } from '@dnd-kit/core';
import { TITLE_BAR_HEIGHT } from '../../components/Titlebar';
import type { DockRegion, DockTab } from '../../stores/dockStore';

/** 限制拖拽浮层留在窗口内，且顶部不越过 titlebar。 */
export const restrictToWindowBelowTitlebar: Modifier = ({ transform, draggingNodeRect, windowRect }) => {
  if (!draggingNodeRect || !windowRect) return transform;
  const value = { ...transform };
  if (draggingNodeRect.top + value.y < TITLE_BAR_HEIGHT) {
    value.y = TITLE_BAR_HEIGHT - draggingNodeRect.top;
  } else if (draggingNodeRect.bottom + value.y > windowRect.height) {
    value.y = windowRect.height - draggingNodeRect.bottom;
  }
  if (draggingNodeRect.left + value.x < 0) {
    value.x = -draggingNodeRect.left;
  } else if (draggingNodeRect.right + value.x > windowRect.width) {
    value.x = windowRect.width - draggingNodeRect.right;
  }
  return value;
};

export type DropPlan =
  | { type: 'reorder'; region: DockRegion; from: number; to: number }
  | { type: 'move'; id: string; region: DockRegion; insertIndex: number };

function regionOf(overId: string, tabs: DockTab[]): DockRegion | null {
  if (overId === 'dock:right') return 'right';
  if (overId === 'dock:bottom') return 'bottom';
  return tabs.find((t) => t.id === overId)?.region ?? null;
}

/**
 * 纯决策：给定拖起 tab 与落点（兄弟 tab id 或 `dock:<region>`），返回应执行的操作。
 * 返回 null 表示忽略（无效落点 / 同位 / 终端拖出底坞）。
 */
export function planDrop(tabs: DockTab[], activeId: string, overId: string): DropPlan | null {
  const activeTab = tabs.find((t) => t.id === activeId);
  if (!activeTab) return null;

  const targetRegion = regionOf(overId, tabs) ?? activeTab.region;
  // 终端钉底坞：不可移入其它坞。
  if (activeTab.kind === 'terminal' && targetRegion !== 'bottom') return null;

  const overTab = tabs.find((t) => t.id === overId) ?? null;

  if (targetRegion === activeTab.region) {
    const inRegion = tabs.filter((t) => t.region === targetRegion).sort((a, b) => a.order - b.order);
    const from = inRegion.findIndex((t) => t.id === activeId);
    const to = overTab ? inRegion.findIndex((t) => t.id === overTab.id) : inRegion.length - 1;
    if (from < 0 || to < 0 || from === to) return null;
    return { type: 'reorder', region: targetRegion, from, to };
  }

  const inTarget = tabs.filter((t) => t.region === targetRegion).sort((a, b) => a.order - b.order);
  const insertIndex = overTab ? inTarget.findIndex((t) => t.id === overTab.id) : inTarget.length;
  return { type: 'move', id: activeId, region: targetRegion, insertIndex: insertIndex < 0 ? inTarget.length : insertIndex };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/dock/dockDnd.test.ts`
预期：PASS（5 个用例）。

- [ ] **步骤 5：实现真正的 `DockDndProvider.tsx`（覆盖 T6 占位）**

覆盖 `tauri-agent/src/features/dock/DockDndProvider.tsx` 全部内容：

```tsx
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Icon } from '@lobehub/ui';
import { cx, useTheme } from 'antd-style';
import { Globe, X } from 'lucide-react';
import { useDockStore, type DockTab } from '../../stores/dockStore';
import { dockTabStyles, resolveTone, toneColor } from './dockTabStyles';
import { planDrop, restrictToWindowBelowTitlebar } from './dockDnd';

type AppTheme = ReturnType<typeof useTheme>;

/** 浮层 portal 到 body 后脱离主题容器，色值需用解析后的实色内联。 */
function DockTabOverlay({ tab, theme }: { tab: DockTab; theme: AppTheme }) {
  return (
    <div
      className={cx(dockTabStyles.tab, dockTabStyles.tabActive)}
      style={{
        background: theme.colorBgElevated,
        borderColor: 'transparent',
        boxShadow: theme.boxShadowSecondary,
        color: theme.colorText,
        cursor: 'grabbing',
        opacity: 1,
      }}
    >
      {tab.kind === 'page' ? (
        <Icon icon={Globe} size={12} style={{ flex: 'none' }} />
      ) : (
        <span className={dockTabStyles.statusDot} style={{ background: toneColor(theme, resolveTone(tab)) }} />
      )}
      <span className={dockTabStyles.tabTitle}>{tab.title}</span>
      {tab.closable ? (
        <span className={dockTabStyles.tabClose} style={{ color: theme.colorTextTertiary }}>
          <X size={12} />
        </span>
      ) : (
        <span className={dockTabStyles.tabCloseSpacer} />
      )}
    </div>
  );
}

export function DockDndProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const tabs = useDockStore((s) => s.tabs);
  const reorderTabs = useDockStore((s) => s.reorderTabs);
  const moveTabRegion = useDockStore((s) => s.moveTabRegion);
  const setActive = useDockStore((s) => s.setActive);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const draggingTab = draggingId ? tabs.find((t) => t.id === draggingId) ?? null : null;

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setDraggingId(null);
    if (!over) return;
    const plan = planDrop(tabs, String(active.id), String(over.id));
    if (!plan) return;
    if (plan.type === 'reorder') {
      reorderTabs(plan.region, plan.from, plan.to);
      setActive(plan.region, String(active.id));
    } else {
      moveTabRegion(plan.id, plan.region, plan.insertIndex);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToWindowBelowTitlebar]}
      onDragStart={(e) => setDraggingId(String(e.active.id))}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDraggingId(null)}
    >
      {children}
      {typeof document !== 'undefined'
        ? createPortal(
            <DragOverlay adjustScale={false} dropAnimation={null} zIndex={9999}>
              {draggingTab ? <DockTabOverlay tab={draggingTab} theme={theme} /> : null}
            </DragOverlay>,
            document.body,
          )
        : null}
    </DndContext>
  );
}
```

- [ ] **步骤 6：类型检查 + 全量测试**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误。

运行：`cd tauri-agent && npx vitest run`
预期：全绿。

- [ ] **步骤 7：手动验证拖拽（dev）**

运行：`cd tauri-agent && npx tauri dev`。验证：
1. 同坞重排：底坞两个终端 tab 互拖换序。
2. page tab 从右坞拖到底坞 → 内容随之出现在底坞，自动展开底坞。
3. subagent tab 在右坞 ↔ 底坞间互拖。
4. 终端 tab 拖向右坞 → 被拒（视觉弹回，仍在底坞）。
5. 拖拽浮层颜色/阴影正常（不透明、状态点配色正确）。

- [ ] **步骤 8：Commit**

```bash
git add tauri-agent/src/features/dock/dockDnd.ts tauri-agent/src/features/dock/dockDnd.test.ts tauri-agent/src/features/dock/DockDndProvider.tsx
git commit -m "feat(dock): cross-dock drag via single DndContext and planDrop"
```

---

## 自检结果

**1. 规格覆盖度（逐节核对）**

| 规格章节 | 对应任务 | 状态 |
|----------|----------|------|
| §3.1 DockRegion / §3.2 Kind / §3.3 DockTab/payloads | T2 类型定义 | ✅ |
| §3.4 Kind 规则矩阵（terminal 不可跨坞/不可关? terminal 可关、subagent 不可关） | T2 `addTab`/`moveTabRegion` + syncSubAgentTabs `closable:false` | ✅ |
| §4.1 State + actions | T2 全部 action（含补充的 `setTerminalStatus`/`resetWorkspaceTabs`） | ✅ |
| §4.2 openPage 去重/closeTab 回退/moveTabRegion 拒绝 terminal/syncSubAgentTabs 增删/persist | T2 + 单测 | ✅ |
| §4.3 与 layoutStore 协作（4 个展开规则） | T1 `setTerminalOpen` + T2 `addTab`/`openPage`/`moveTabRegion` 调 layout | ✅ |
| §5.1 组件树 | T3/T4/T7 | ✅ |
| §5.2 文件规划 | 文件结构表逐一对应 | ✅ |
| §5.3 TabStrip UI（44px header/28px tab/图标/关闭/spacer/＋/折叠/空态） | T3 样式 + T4 actions/emptyHint | ✅ |
| §5.4 ＋菜单（bottom 新建终端 / right 占位提示） | T4 `actions` | ✅ |
| §5.5 TabBody keep-alive（Terminal/Page/SubAgent） | T4 TabBodyStack + T5 TerminalBody | ✅ |
| §6 拖拽（DndContext 范围/droppable 目标/规则矩阵） | T7 DockDndProvider + planDrop + TabStrip droppable | ✅ |
| §7 数据流 + 调用方迁移（extensionCards / subagent 打开） | T6 | ✅ |
| §8 错误处理与边界（关闭最后终端/workspace 切换/persist 恢复/同 URL/subagent 删除/dnd 取消） | T2 + T5 卸载停 shell + T6 reset effect + T7 onDragCancel | ✅ |
| §9 实现顺序 | T1→T7 与规格 6 步一致（T1 为 layout 前置） | ✅ |
| §10 测试计划（单测/组件测试/手动清单） | T2/T3/T4/T5/T7 测试 + T6/T7 手动清单 | ✅ |
| §11 后续阶段接口（kind 注册表 + 注释预留） | T4 `BODY_RENDERERS` 注释 + T2 kind 注释 | ✅ |

**2. 占位符扫描：** 全计划无 “TODO/待定/补充细节/添加适当错误处理” 等空话；每个代码步骤均含完整可粘贴代码。`TabBodyRenderer` 的 `TerminalBodyPlaceholder` 是 T4→T5 的**有意临时实现**（T5 步骤 2 明确替换），非占位空话。

**3. 类型一致性核对：**
- `DockTab` / `TerminalPayload` / `PagePayload` / `SubAgentPayload` 在 T2 定义，后续 T3–T7 全部引用同名同形。
- action 名一致：`addTab` / `closeTab` / `setActive` / `setTerminalStatus` / `reorderTabs` / `moveTabRegion` / `openPage` / `syncSubAgentTabs` / `resetWorkspaceTabs`（T2 定义，T4/T5/T6/T7 调用名一一对应）。
- `DockBodyProps`（T4 定义，含 `tab`/`active`）被 PageBody/SubAgentBody/TerminalBody 统一实现。
- `resolveTone` / `toneColor` / `DotTone`（T3 定义）被 SortableDockTab/DockPanel/DockDndProvider 引用。
- `defaultTerminalTitle`（T2 导出）被 DockPanel(T4) 与 resetWorkspaceTabs(T2) 共用，单一来源。
- `planDrop` / `restrictToWindowBelowTitlebar`（T7 定义）被 DockDndProvider 引用。
- `terminal.shellStart/shellWrite/shellStop/onShellOutput` 与 `lib/terminal.ts` 现有签名一致（`shellStart(workspace)` → `{ session_id }`）。

> 一处刻意偏离规格并已记录：**§4.2 persist** 规格写“保存 tabs”，本计划在 `partialize` 中**剔除 subagent tab**（它们完全由 messages 派生、由 `syncSubAgentTabs` 重建），避免跨会话脏数据；terminal 仅持久化结构并重置为 idle。page tab 按规格保留结构。

---

## 执行交接

计划已完成并保存到 `tauri-agent/docs/superpowers/plans/2026-06-14-dock-tab-container-plan.md`。

本仓库**禁止子代理**，因此采用**内联执行**：
- **必需子技能：** `superpowers:executing-plans`
- 从 T1 顺序执行到 T7，每个任务末尾 commit；在 T5/T6/T7 的类型检查与手动冒烟处设审查检查点。
