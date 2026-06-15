# 阶段 B 实现计划 — 会话同屏 tab（主区多会话 keep-alive）

> **面向 AI 代理的工作者：** 用 `superpowers:executing-plans` 逐任务**内联**实现（本仓库**禁止子代理**）。每任务末尾 commit。
>
> **目标：** 把主聊天区从「单 ChatView」升级为「多会话 keep-alive tab 容器」，同屏并存多个会话——切换瞬间、各自后台流式不丢。**核心复用 A1 的 `agentStoreRegistry`**（已让多 store 常驻），B 本质是把这些常驻 store 在主区**可视化为 tab**；**不碰 dockStore、不改后端/pi**。
>
> 依据：`2026-06-14-multi-session-concurrency-design.md` §6。

**命令约定：** 单测 `cd tauri-agent && npx vitest run <file>`；类型 `npx tsc --noEmit`。

---

## 0. 范围

- **B 核心**：主区会话 tab（`sessionStore.openWorkspaces` 驱动，keep-alive 切换）。
- **配套**：dock（right/bottom 的 page/subagent/terminal）跟随 active 会话（沿用现状的"跟随 active workspace"，仅在 active 切换时 re-sync）。
- **不含**：真分屏并排（B 之后的 B2）；dock 完全 per-session 分片（同 cwd 多会话才需要，留给 D1/后续）。

## 1. 架构

```
ModuleContainer(chat) =
  <SidebarPanel/>                         // 不变
  <MainArea>                              // 原 MainChatColumn → MainSessionDock
    MainColumnHeader                      // 全局头部（不变）
    SessionTabStrip                       // 新：会话 tab 条（openWorkspaces 映射）
    SessionBodyStack                      // 新：keep-alive 挂载所有打开会话
      └ SessionBody(ws)                   // 新：AgentStoreProvider(ws)+首屏加载+ChatView
  <RightPanelColumn/> <TerminalColumn/>   // dock 跟随 active（不变）
```

- **"打开的会话"** = `sessionStore.openWorkspaces: string[]`（有序 tab 列表）；A1 的 `agentStoreRegistry` 已保证这些 store 后台常驻。
- **active** = `sessionStore.activeWorkspace`（已有）。
- **Workspace() 拆分**：原 `Workspace()` 的 per-session 逻辑（首屏 open/refresh/getMessages、subagent sync）下放到 `SessionBody`；全局逻辑（键盘快捷键、auto-title 监听、布局）留在 App 壳。

> **关键（嵌套两层 Provider）：** **保留**顶层 `<AgentStoreProvider workspace={activeWorkspace}>` 包整个布局——给壳外组件（dock 的 `SubAgentBody`/`extensionCards`、各 panel `Checkpoints/Memory/Review/Create/Knowledge`… 等 `useAgentStoreContext` 使用者）提供 **active 会话的 store**；`SessionBody` 内**再嵌一层** `<AgentStoreProvider workspace={ws}>` 给该 tab 的 ChatView 自己的 store。`agentStoreRegistry` 保证同 workspace 返回**同一个 store 实例**，故 active tab 内外层是同一个、无冲突；非 active tab 用各自常驻 store。切 active → 外层 workspace 变 → dock/panels 自动切到新 active store。
>
> ⚠️ **不要移除顶层 Provider**：dock/panels 在 SessionBody 子树之外，移除会导致它们脱离 Provider 抛错（共 35 处 `useAgentStoreContext`）。

---

## 任务 TB1：`sessionStore` 打开会话列表（openWorkspaces）

**文件：** `src/store/session.ts`、`src/store/session.test.ts`（若无则新建）

- [ ] **步骤 1：失败测试**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from './session';

beforeEach(() => {
  useSessionStore.setState({ openWorkspaces: [], activeWorkspace: '' });
});

describe('sessionStore openWorkspaces', () => {
  it('openWorkspaceTab 追加并去重、置为 active', () => {
    const s = useSessionStore.getState();
    s.openWorkspaceTab('/a');
    s.openWorkspaceTab('/b');
    s.openWorkspaceTab('/a'); // 去重
    expect(useSessionStore.getState().openWorkspaces).toEqual(['/a', '/b']);
    expect(useSessionStore.getState().activeWorkspace).toBe('/a');
  });

  it('closeWorkspaceTab 移除并把 active 落到左邻', () => {
    const s = useSessionStore.getState();
    s.openWorkspaceTab('/a');
    s.openWorkspaceTab('/b');
    s.openWorkspaceTab('/c');
    s.setActiveWorkspace('/b');
    s.closeWorkspaceTab('/b');
    expect(useSessionStore.getState().openWorkspaces).toEqual(['/a', '/c']);
    expect(useSessionStore.getState().activeWorkspace).toBe('/a');
  });
});
```

- [ ] **步骤 2：实现**（session.ts）

```typescript
  openWorkspaces: string[];           // 主区会话 tab（有序）
  openWorkspaceTab: (cwd: string) => void;
  closeWorkspaceTab: (cwd: string) => void;
```

```typescript
  openWorkspaces: [],
  openWorkspaceTab: (cwd) =>
    set((s) => ({
      openWorkspaces: s.openWorkspaces.includes(cwd) ? s.openWorkspaces : [...s.openWorkspaces, cwd],
      activeWorkspace: cwd,
    })),
  closeWorkspaceTab: (cwd) =>
    set((s) => {
      const idx = s.openWorkspaces.indexOf(cwd);
      const next = s.openWorkspaces.filter((w) => w !== cwd);
      const activeWorkspace =
        s.activeWorkspace === cwd ? (next[Math.max(0, idx - 1)] ?? next[0] ?? '') : s.activeWorkspace;
      return { openWorkspaces: next, activeWorkspace };
    }),
```

> `closeWorkspaceTab` 仅管 UI tab；store 的销毁交给调用方 `agentStoreRegistry.release(cwd)`（TB4）。

- [ ] **步骤 3：测试通过 + Commit** `git commit -m "feat(session): openWorkspaces tab list"`

---

## 任务 TB2：`SessionBody` —— per-session Provider + 首屏加载 + ChatView

把原 `Workspace()` 的 per-session 加载逻辑（`App.tsx` 首屏 effect）下放到一个可多实例的 `SessionBody`。

**文件：** 新建 `src/features/chat/SessionBody.tsx`

- [ ] **步骤 1：实现**

```tsx
import { memo } from 'react';
import { AgentStoreProvider } from '../../stores/AgentStoreContext';
import { SessionBodyInner } from './SessionBodyInner';

/** 一个打开的会话：独立 store（registry 常驻）+ 自己的首屏加载 + ChatView。 */
export const SessionBody = memo(function SessionBody({ workspace }: { workspace: string }) {
  return (
    <AgentStoreProvider workspace={workspace}>
      <SessionBodyInner />
    </AgentStoreProvider>
  );
});
```

`SessionBodyInner`（同文件或拆分）承接原 `Workspace()` 的 per-session effect（`App.tsx:197-263`）：`openWorkspace` → `refreshSessions` → `switchSession` → `getMessages`，以及 `workspaceReady`、`setWorkspaceSessionPath`、subagent sync。关键改动：

- 用 `const { workspace, store, setWorkspaceReady } = useAgentStoreContext()`（本 tab 的 store）。
- **subagent sync 仅 active 时做**：`const active = useSessionStore((s) => s.activeWorkspace === workspace)`；`useEffect(() => { if (active) useDockStore.getState().syncSubAgentTabs(messages); }, [active, messages])`（dock 跟随 active，避免后台 tab 抢 dock）。
- body 渲染 `<ChatView/>`（ChatView 不改，自然用本 Provider 的 store）。

- [ ] **步骤 2：类型检查**（先不接线，确保独立编译）。
- [ ] **步骤 3：Commit** `git commit -m "feat(chat): SessionBody (per-session provider + load + ChatView)"`

---

## 任务 TB3：主区 `MainSessionDock`（tab 条 + keep-alive body stack）

**文件：** 新建 `src/features/chat/MainSessionDock.tsx`、`MainSessionDock.test.tsx`；复用 `dockTabStyles`（tab 视觉）

- [ ] **步骤 1：实现**

```tsx
import { useMemo } from 'react';
import { Flexbox } from '@lobehub/ui';
import { useSessionStore } from '../../store/session';
import { agentStoreRegistry } from '../../stores/agentStoreRegistry';
import { MainColumnHeader } from '../layout/MainColumnHeader';
import { SessionBody } from './SessionBody';
// 复用 dockTabStyles 或新建轻量 tab 样式

export function MainSessionDock() {
  const openWorkspaces = useSessionStore((s) => s.openWorkspaces);
  const activeWorkspace = useSessionStore((s) => s.activeWorkspace);
  const setActive = useSessionStore((s) => s.setActiveWorkspace);
  const closeTab = useSessionStore((s) => s.closeWorkspaceTab);

  // tab 标题：从 sessionStore.workspaceSessionPaths + allSessions 解析（或会话 name）
  const titleOf = useMemo(() => /* cwd → 显示名 */ ..., [/* deps */]);

  return (
    <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
      <MainColumnHeader />
      {/* tab 条：openWorkspaces.map → tab；点击 setActive；× → closeTab + registry.release */}
      <SessionTabStrip
        items={openWorkspaces}
        activeId={activeWorkspace}
        titleOf={titleOf}
        onActivate={setActive}
        onClose={(ws) => { closeTab(ws); agentStoreRegistry.release(ws); }}
      />
      {/* keep-alive：所有打开会话常驻挂载，仅显隐切换 */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {openWorkspaces.map((ws) => (
          <div
            key={ws}
            style={{ position: 'absolute', inset: 0, display: ws === activeWorkspace ? 'flex' : 'none', flexDirection: 'column' }}
            data-testid={`session-body-${ws}`}
          >
            <SessionBody workspace={ws} />
          </div>
        ))}
      </div>
    </Flexbox>
  );
}
```

`SessionTabStrip` 可内联或抽小组件（参考 `dock/TabStrip` 但更轻；阶段 B 暂不接 DnD）。

- [ ] **步骤 2：组件测试**（mock registry + sessionStore；断言 tab 渲染、active 显隐、onClose 调 release）。
- [ ] **步骤 3：测试通过 + Commit** `git commit -m "feat(chat): MainSessionDock with keep-alive session tabs"`

---

## 任务 TB4：拆分 `Workspace()` → App 壳 + 接线 MainSessionDock

**文件：** `src/App.tsx`

- [ ] **步骤 1：把 per-session 逻辑移出 `Workspace()`**

- 原 `Workspace()` 的首屏加载 effect、`workspaceReady`、subagent sync、workspace 切换 reset → 已在 TB2 的 `SessionBodyInner` 承接。
- `Workspace()` 改名/收敛为 **App 壳**：保留全局 effect（键盘快捷键 `App.tsx:380-389`、auto-title 监听 `:391-408`）、布局（Sidebar + MainSessionDock + Right/Terminal）。
- **保留**顶层 `<AgentStoreProvider workspace={activeWorkspace}>`（`App.tsx:488`）给壳外组件（dock/panels）提供 active store；`SessionBody` 内再嵌各自 Provider（见架构段「嵌套两层 Provider」）。**不要移除顶层 Provider**——否则 dock(`SubAgentBody`/`extensionCards`) 与各 panel(`Checkpoints/Memory/Review/Create/Knowledge`…) 会脱离 Provider 抛错。加载只在 `SessionBody` 做（外层仅提供 context）；`FullscreenLoading` 改读 active 会话 ready（或简化为首 tab 前显示）。

- [ ] **步骤 2：`MainChatColumn` → `MainSessionDock`**

把布局里的 `<MainChatColumn />`（`App.tsx:435`）替换为 `<MainSessionDock />`。`MainChatColumn`、顶层 `AgentStoreProvider` 包裹删除。

- [ ] **步骤 3：初始打开**

App 启动解析到初始 workspace 后（`App.tsx:455-482`），调用 `openWorkspaceTab(ws)`（而非仅 `setActiveWorkspace`），让初始会话成为第一个 tab。

- [ ] **步骤 4：类型检查 + 受限 vitest + 冒烟**

`npx tsc --noEmit`；`npx vitest run src/features/chat src/stores`；dev 验证单会话仍正常。

- [ ] **步骤 5：Commit** `git commit -m "refactor(app): split Workspace into shell + per-session bodies"`

---

## 任务 TB5：Sidebar 打开会话 = 加 tab；dock 跟随 active；收尾

**文件：** `src/App.tsx`（handlers）、`src/features/sessions/*`（按需）

- [ ] **步骤 1：打开会话改为加 tab**

- `handleOpenSession(cwd, path)`：`openWorkspaceTab(cwd)`（加 tab + active）+ `setWorkspaceSessionPath(cwd, path)`；该会话的 store 由 `AgentStoreProvider`(SessionBody) 经 registry 常驻；首屏加载在 SessionBody 内。
- `handleNewConversation`/`handleNewSession`：创建后 `openWorkspaceTab(cwd)`。
- `switchProject`：`openWorkspaceTab(cwd)`（已打开则仅 active）。

- [ ] **步骤 2：dock 跟随 active（验证）**

subagent sync 已在 SessionBody「仅 active」做（TB2）；page/terminal 的 dock 仍是全局单例跟随 active workspace。验证切换会话时 dock（right/bottom）正确反映 active 会话（page 卡片来自 active 会话、subagent 来自 active 会话 messages）。

- [ ] **步骤 3：关闭 tab 释放**

tab × → `closeWorkspaceTab(cwd)` + `agentStoreRegistry.release(cwd)`（停订阅；后端进程可保活或按需 `pi.closeWorkspace`——阶段 B 先保活，交 LRU/退出清理）。

- [ ] **步骤 4：手动冒烟（dev）**

1. 打开会话 A、再打开会话 B → 主区出现 2 个 tab，B 激活。
2. A 发长任务 → 切到 B → A tab 仍在后台跑（角标）→ 切回 A，流式连续（keep-alive，无重载）。
3. 关闭 A tab → 移除、active 落到 B。
4. dock（终端/page/subagent）跟随 active 会话正确。

- [ ] **步骤 5：Commit** `git commit -m "feat(app): open sessions as main tabs, dock follows active"`

---

## 风险与对策

| 风险 | 对策 |
|---|---|
| Workspace 拆分波及面大（首屏/effects/Provider） | TB2 先独立实现 SessionBody 并编译通过，TB4 再接线；保留全局 effects 在壳 |
| 多个 AgentStoreProvider 同时首屏 open | 各 SessionBody 独立 open 自己的 workspace；后端进程按 workspace 复用（A1 已常驻），open 幂等 |
| dock 被后台会话抢占 | subagent sync 仅 active 会话做（TB2）；page/terminal 全局跟随 active |
| keep-alive 内存随 tab 增长 | 关闭 tab 即 `registry.release`；registry LRU（A1）兜底 |
| FullscreenLoading 语义变化 | 改为 active 会话 ready 或首 tab 前显示 |

## 测试策略

- 单测：`session.test.ts`（openWorkspaces）、`MainSessionDock.test.tsx`（tab 渲染/切换/关闭）。
- 受限：`vitest run src/features/chat src/stores`。
- 手动：TB5 步骤 4 同屏多会话冒烟。

## 与后续衔接

- **B2（真分屏）**：在 MainSessionDock 基础上支持并排/分割布局（多 active）。
- **D1（同 cwd 多会话）**：B 的 tab 以 workspace 为 id；待 D1 把 key 升级为 clientId 后，同一 cwd 可开多个 tab（同项目多会话同屏）。B 与 D1 正交、可叠加。

> **禁止子代理，内联执行。** 顺序 TB1→TB5，每任务 commit；TB4 是结构性改动，前后各跑一次 tsc + 受限 vitest。
