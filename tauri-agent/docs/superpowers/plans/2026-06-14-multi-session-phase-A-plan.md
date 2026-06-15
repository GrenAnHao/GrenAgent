# 阶段 A 实现计划 — 前端多 store 常驻 + 并发治理

> **面向 AI 代理的工作者：** 用 `superpowers:executing-plans` 逐任务**内联**实现（本仓库**禁止子代理**）。步骤用 `- [ ]` 跟踪，每个任务末尾 commit 一次。
>
> **目标：** 把"同一时刻只有一个 active AgentStore"升级为"多 store 常驻注册表"，让切走的会话在后台继续消费 pi 事件、保留流式过程；并引入两级并发队列（同会话串行 + 全局并发上限 = 方案 E）防止同开 N 会话打爆机器/LLM 配额。**纯前端、后端零改动、不改 pi。**
>
> 设计依据见 `docs/superpowers/plans/2026-06-14-multi-session-concurrency-design.md`（§5 阶段 A、§11 借鉴）。

**命令约定：**
- 单测：`cd tauri-agent && npx vitest run <file>`
- 类型检查：`cd tauri-agent && npx tsc --noEmit`
- 全量测试：`cd tauri-agent && npx vitest run`

**背景事实（已核查）：**
- `createAgentStore(workspace)` 已是工厂：内部 `onPiEvent` 订阅 + rAF 批量 flush + `destroy()`（`src/stores/agent.ts`）。
- `AgentStoreProvider` 现以 `useMemo` 建单 store、卸载即 `destroy`（`src/stores/AgentStoreContext.tsx:23,30`）——这是"单 store"根源。
- 后端进程切换不 close、常驻（`App.tsx:265` switchProject 只 open 不 close；`lib.rs:34` 仅窗口关闭 close_all）——**后台并发现状已成立**。
- 事件按 workspace 广播 `{ workspace, event }`（`src/lib/pi.ts:213`），store 订阅时 `env.workspace !== workspace` 即丢弃（`agent.ts:94`）。
- Sidebar 运行角标现为单值 `runningSessionPath = isStreaming ? activeSessionPath : null`（`App.tsx:410`），`SessionItem running={runningSessionPath === c.sessionPath}`（`Sidebar.tsx:222`）。

**阶段划分：**
- **A1 核心多 store 常驻**：T1 后台 flush、T2 registry、T3 接线、T4 Sidebar 多会话角标。完成即解锁"多对话后台并行 + 切回不丢流式"。
- **A2 并发治理（方案 E）**：T5 两级 Lane、T6 prompt 接入 Lane。

---

## 文件结构

**新建（`tauri-agent/src`）**
- `stores/agentStoreRegistry.ts` — 常驻 store 注册表 + 运行态 zustand（`useAgentRegistryStore`）+ LRU 上限
- `stores/agentStoreRegistry.test.ts` — registry 单测
- `lib/commandLanes.ts` — 两级队列（session 串行 + global 并发）纯逻辑（A2）
- `lib/commandLanes.test.ts` — lane 单测（A2）

**修改**
- `stores/agent.ts` — `scheduleFlush` 后台 `setTimeout` fallback + `setActive`；`AgentStoreApi` 暴露 `setActive` 与 `useStore.subscribe`
- `stores/agent.test.ts` — 后台 flush 用例
- `stores/AgentStoreContext.tsx` — 从 registry 取 store、切换 `setActive`、不再随切换 destroy
- `store/session.ts` — 新增 `workspaceSessionPaths` 映射（workspace→当前 sessionPath）
- `App.tsx` — registry 卸载 destroyAll；维护 `workspaceSessionPaths`；`runningSessionPaths` 改由 registry 派生
- `features/sessions/Sidebar.tsx`、`features/sessions/SessionItem.tsx`、`features/sessions/ProjectGroup.tsx` — 角标 prop 由单值改 `Set<string>`
- `features/chat/ChatView.tsx` — prompt 经 Lane（A2）

---

## 任务 T1：`agent.ts` 后台 flush fallback + `setActive`

后台（非 active）store 仍在收事件，但 `requestAnimationFrame` 在隐藏/非聚焦时被浏览器节流甚至暂停，导致后台会话流式不更新。改为：active 用 rAF，inactive 用 `setTimeout` 兜底。

**文件：** 改 `src/stores/agent.ts`、`src/stores/agent.test.ts`

- [ ] **步骤 1：在测试里加失败用例**

在 `agent.test.ts` 的 `describe` 内末尾新增（复用现有 `emit`/rAF stub）：

```typescript
  it('非 active store 用 setTimeout 兜底 flush（rAF 不触发也能更新）', () => {
    vi.useFakeTimers();
    store = createAgentStore('.');
    store.setActive(false);

    emit({ type: 'agent_start' });
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } });

    // 非 active：不走 rAF，flush 前不可见
    flushRAF();
    expect(store.useStore.getState().messages).toHaveLength(0);

    // setTimeout 到点后应用
    vi.advanceTimersByTime(80);
    expect(store.useStore.getState().isStreaming).toBe(true);
  });
```

- [ ] **步骤 2：运行验证失败**

`cd tauri-agent && npx vitest run src/stores/agent.test.ts` → 预期 FAIL（`setActive is not a function`）。

- [ ] **步骤 3：实现**

在 `agent.ts` 顶部常量区加：

```typescript
/** 非 active store 的 flush 间隔（rAF 在后台被节流，用 setTimeout 兜底）。 */
const BACKGROUND_FLUSH_MS = 60;
```

把现有 `rafId` 声明扩展，并改写 `scheduleFlush` / `clearQueue`（`agent.ts:44,76-92`）：

```typescript
  let queue: AgentEvent[] = [];
  let rafId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let active = true; // 默认 active；registry.setActive 控制

  const flush = () => {
    rafId = null;
    timeoutId = null;
    if (!queue.length) return;
    // ...（其余 flush 体不变）
  };

  const scheduleFlush = () => {
    if (rafId != null || timeoutId != null) return;
    if (active && typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(flush);
    } else {
      timeoutId = setTimeout(flush, BACKGROUND_FLUSH_MS);
    }
  };

  const clearQueue = () => {
    queue = [];
    if (rafId != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (timeoutId != null) clearTimeout(timeoutId);
    rafId = null;
    timeoutId = null;
  };
```

> 注意：`flush` 体内原有逻辑（events 应用、persistThinkingDurations）保持不变，仅在开头补 `timeoutId = null;`。

在 `AgentStoreApi`（`agent.ts:16-28`）接口补：

```typescript
  setActive: (active: boolean) => void;
```

并扩展 `useStore` 类型，暴露 zustand 自带的 `subscribe`（registry 需要）：

```typescript
  useStore: {
    (): AgentState;
    <T>(selector: (s: AgentState) => T): T;
    getState: () => AgentState;
    setState: (partial: Partial<AgentState> | ((s: AgentState) => Partial<AgentState>)) => void;
    subscribe: (listener: (s: AgentState, prev: AgentState) => void) => () => void;
  };
```

在 return 对象里新增：

```typescript
    setActive: (next) => {
      active = next;
    },
```

- [ ] **步骤 4：验证通过**

`cd tauri-agent && npx vitest run src/stores/agent.test.ts` → 预期 PASS（含原有用例）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/stores/agent.ts tauri-agent/src/stores/agent.test.ts
git commit -m "feat(agent): background setTimeout flush fallback + setActive"
```

---

## 任务 T2：`agentStoreRegistry.ts` 常驻注册表 + 运行态 + LRU

常驻持有所有 workspace 的 store（切走不 destroy），并维护一个 zustand 运行态（哪些 workspace 在 streaming）供 Sidebar 角标读；LRU 上限防无限增长（= 方案 E 的前端镜像）。

**文件：** 创建 `src/stores/agentStoreRegistry.ts`、`src/stores/agentStoreRegistry.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `agentStoreRegistry.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

const eventHandlers: Array<(e: { workspace: string; event: unknown }) => void> = [];
vi.mock('../lib/pi', () => ({
  onPiEvent: (h: (e: { workspace: string; event: unknown }) => void) => {
    eventHandlers.push(h);
    return Promise.resolve(() => {});
  },
  onPiExit: () => Promise.resolve(() => {}),
}));

import { createAgentStoreRegistry } from './agentStoreRegistry';

beforeEach(() => {
  eventHandlers.length = 0;
});

describe('agentStoreRegistry', () => {
  it('getOrCreate 复用同 key 的 store', () => {
    const reg = createAgentStoreRegistry();
    const a1 = reg.getOrCreate('/ws/a');
    const a2 = reg.getOrCreate('/ws/a');
    expect(a1).toBe(a2);
    expect(reg.keys()).toEqual(['/ws/a']);
    reg.destroyAll();
  });

  it('release 销毁并移除', () => {
    const reg = createAgentStoreRegistry();
    reg.getOrCreate('/ws/a');
    reg.release('/ws/a');
    expect(reg.keys()).toEqual([]);
    reg.destroyAll();
  });

  it('LRU 超限淘汰最久未 active（且不淘汰当前 active）', () => {
    const reg = createAgentStoreRegistry(2);
    reg.getOrCreate('/ws/a');
    reg.getOrCreate('/ws/b');
    reg.setActive('/ws/b');
    reg.getOrCreate('/ws/c'); // 超限 → 淘汰最久未 active 的 /ws/a
    expect(reg.keys().sort()).toEqual(['/ws/b', '/ws/c']);
    reg.destroyAll();
  });

  it('setActive 把 active 标志下发给各 store', () => {
    const reg = createAgentStoreRegistry();
    const a = reg.getOrCreate('/ws/a');
    const spy = vi.spyOn(a, 'setActive');
    reg.setActive('/ws/a');
    expect(spy).toHaveBeenCalledWith(true);
    reg.destroyAll();
  });
});
```

- [ ] **步骤 2：运行验证失败**

`cd tauri-agent && npx vitest run src/stores/agentStoreRegistry.test.ts` → FAIL（模块不存在）。

- [ ] **步骤 3：实现 `agentStoreRegistry.ts`**

```typescript
import { create } from 'zustand';
import { createAgentStore, type AgentStoreApi } from './agent';

/** 默认常驻上限：超过则 LRU 淘汰最久未 active 的非 active store。 */
const DEFAULT_MAX = 8;

interface Entry {
  store: AgentStoreApi;
  lastActive: number;
  unsub: () => void;
}

/** 运行态：哪些 workspace 当前在 streaming（供 Sidebar 角标读）。 */
interface RegistryStatus {
  runningWorkspaces: string[];
}
export const useAgentRegistryStore = create<RegistryStatus>(() => ({ runningWorkspaces: [] }));

export interface AgentStoreRegistry {
  getOrCreate: (workspace: string) => AgentStoreApi;
  get: (workspace: string) => AgentStoreApi | undefined;
  release: (workspace: string) => void;
  setActive: (workspace: string | null) => void;
  keys: () => string[];
  destroyAll: () => void;
}

export function createAgentStoreRegistry(max = DEFAULT_MAX): AgentStoreRegistry {
  const map = new Map<string, Entry>();
  let activeKey: string | null = null;

  const recomputeRunning = () => {
    const running: string[] = [];
    for (const [ws, e] of map) {
      if (e.store.useStore.getState().isStreaming) running.push(ws);
    }
    const prev = useAgentRegistryStore.getState().runningWorkspaces;
    // 仅在集合变化时 setState，避免无谓渲染
    if (prev.length !== running.length || running.some((w) => !prev.includes(w))) {
      useAgentRegistryStore.setState({ runningWorkspaces: running });
    }
  };

  const evictIfNeeded = () => {
    while (map.size > max) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [ws, e] of map) {
        if (ws === activeKey) continue;
        if (e.store.useStore.getState().isStreaming) continue; // 不淘汰运行中的
        if (e.lastActive < oldest) {
          oldest = e.lastActive;
          victim = ws;
        }
      }
      if (!victim) break; // 全在运行/全 active：暂不淘汰
      release(victim);
    }
  };

  const release = (workspace: string) => {
    const e = map.get(workspace);
    if (!e) return;
    e.unsub();
    e.store.destroy();
    map.delete(workspace);
    if (activeKey === workspace) activeKey = null;
    recomputeRunning();
  };

  const getOrCreate = (workspace: string) => {
    const existing = map.get(workspace);
    if (existing) {
      existing.lastActive = Date.now();
      return existing.store;
    }
    const store = createAgentStore(workspace);
    store.setActive(workspace === activeKey);
    const unsub = store.useStore.subscribe(() => recomputeRunning());
    map.set(workspace, { store, lastActive: Date.now(), unsub });
    evictIfNeeded();
    return store;
  };

  const setActive = (workspace: string | null) => {
    activeKey = workspace;
    for (const [ws, e] of map) {
      e.store.setActive(ws === workspace);
      if (ws === workspace) e.lastActive = Date.now();
    }
  };

  return {
    getOrCreate,
    get: (workspace) => map.get(workspace)?.store,
    release,
    setActive,
    keys: () => [...map.keys()],
    destroyAll: () => {
      for (const e of map.values()) {
        e.unsub();
        e.store.destroy();
      }
      map.clear();
      activeKey = null;
      useAgentRegistryStore.setState({ runningWorkspaces: [] });
    },
  };
}

/** 全局单例（与 dockStore / sessionStore 风格一致）。 */
export const agentStoreRegistry = createAgentStoreRegistry();
```

- [ ] **步骤 4：验证通过**

`cd tauri-agent && npx vitest run src/stores/agentStoreRegistry.test.ts` → PASS（4 用例）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/stores/agentStoreRegistry.ts tauri-agent/src/stores/agentStoreRegistry.test.ts
git commit -m "feat(agent): add常驻 AgentStoreRegistry with running status + LRU"
```

---

## 任务 T3：接线 `AgentStoreContext` + `App`（registry 取 store，切换不 destroy）

**文件：** 改 `src/stores/AgentStoreContext.tsx`、`src/App.tsx`

- [ ] **步骤 1：改 `AgentStoreContext.tsx`**

把 `AgentStoreProvider`（`:22-40`）改为从 registry 取、切换 `setActive`、**不再卸载 destroy**：

```tsx
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentStoreApi } from './agent';
import { agentStoreRegistry } from './agentStoreRegistry';

// ... AgentStoreContextValue 不变 ...

export function AgentStoreProvider({ workspace, children }: AgentStoreProviderProps) {
  const store = useMemo(() => agentStoreRegistry.getOrCreate(workspace), [workspace]);
  const [workspaceReady, setWorkspaceReady] = useState(false);

  useEffect(() => {
    setWorkspaceReady(false);
  }, [workspace]);

  // 切换 active：当前显示的 workspace 用 rAF 实时刷新，其余转后台 setTimeout 兜底。
  useEffect(() => {
    agentStoreRegistry.setActive(workspace);
  }, [workspace]);

  // 注意：不再在卸载时 store.destroy()（store 由 registry 常驻/LRU/显式 release 管理）。

  const value = useMemo(
    () => ({ workspace, store, workspaceReady, setWorkspaceReady }),
    [workspace, store, workspaceReady],
  );

  return <AgentStoreContext.Provider value={value}>{children}</AgentStoreContext.Provider>;
}
```

- [ ] **步骤 2：改 `App.tsx`**

把 `App()` 的 cleanup（`:479-481`）从"只 close active"改为 registry 全清（后端 `close_all` 已在窗口关闭兜底，`lib.rs:34`）：

```tsx
import { agentStoreRegistry } from './stores/agentStoreRegistry';
// ...
  useEffect(() => {
    void (async () => { /* ...原启动逻辑不变... */ })();
    return () => {
      agentStoreRegistry.destroyAll();
    };
  }, []);
```

> 切换会话/项目的 handlers（`switchProject`/`handleOpenSession`/`handleNewConversation`）无需改动：它们已 `openWorkspace`（后端保活）+ `setActiveWorkspace`（驱动 Provider 的 workspace → registry.getOrCreate 自动常驻新 store、setActive）。

- [ ] **步骤 3：类型检查 + 全量测试**

`cd tauri-agent && npx tsc --noEmit` 与 `npx vitest run` → 预期无回归。

- [ ] **步骤 4：手动冒烟（dev）**

`cd tauri-agent && npx tauri dev`：在会话 A 发起长任务 → 切到会话 B → 切回 A，**A 的流式过程连续可见（不再只看最终态）**；B 也能独立交互。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/stores/AgentStoreContext.tsx tauri-agent/src/App.tsx
git commit -m "feat(agent): keep stores alive via registry, switch toggles active"
```

---

## 任务 T4：Sidebar 多会话运行角标

把单值 `runningSessionPath` 升级为"所有后台运行会话的 path 集合"，数据源 = registry 运行态 + `workspace→sessionPath` 映射。

**文件：** 改 `store/session.ts`、`App.tsx`、`features/sessions/Sidebar.tsx`、`SessionItem.tsx`、`ProjectGroup.tsx`

- [ ] **步骤 1：`store/session.ts` 新增映射**

在 `SessionStore` 接口与实现加：

```typescript
  workspaceSessionPaths: Record<string, string>; // workspace(cwd) → 该 ws 当前活跃 sessionPath
  setWorkspaceSessionPath: (workspace: string, path: string) => void;
```

```typescript
  workspaceSessionPaths: {},
  setWorkspaceSessionPath: (workspace, path) =>
    set((s) => ({ workspaceSessionPaths: { ...s.workspaceSessionPaths, [workspace]: path } })),
```

- [ ] **步骤 2：维护映射**

在 `App.tsx` 设置 `activeSessionPath` 的位置（`handleOpenSession:290`、`Workspace` 首屏 `refreshSessions` 后、`switchSession` 后）同步调用 `setWorkspaceSessionPath(cwd, path)`。最小改法：在 `handleOpenSession` 与 `Workspace` 的 `getMessages` 前各补一行：

```tsx
useSessionStore.getState().setWorkspaceSessionPath(cwd /* 或 workspace */, path);
```

- [ ] **步骤 3：`App.tsx` 派生 `runningSessionPaths`**

把 `Workspace` 内 `const runningSessionPath = isStreaming ? activeSessionPath : null;`（`:410`）替换为从 registry 运行态派生：

```tsx
import { useAgentRegistryStore } from './stores/agentStoreRegistry';
// 在 Workspace() 内：
const runningWorkspaces = useAgentRegistryStore((s) => s.runningWorkspaces);
const workspaceSessionPaths = useSessionStore((s) => s.workspaceSessionPaths);
const runningSessionPaths = useMemo(() => {
  const set = new Set<string>();
  for (const ws of runningWorkspaces) {
    const p = workspaceSessionPaths[ws];
    if (p) set.add(p);
  }
  return set;
}, [runningWorkspaces, workspaceSessionPaths]);
```

把 `<SidebarPanel runningSessionPath={runningSessionPath} .../>` 改为 `runningSessionPaths={runningSessionPaths}`（需 `useMemo` 已在 `react` 导入）。

- [ ] **步骤 4：prop 类型沿链改 `Set<string>`**

- `App.tsx` `SidebarPanel` props：`runningSessionPath: string | null` → `runningSessionPaths: Set<string>`。
- `Sidebar.tsx` `SidebarProps`/`GroupListProps`：同改；`SessionItem` 判定 `running={props.runningSessionPaths.has(c.sessionPath)}`（`:222`）。
- `ProjectGroup.tsx`：透传 `runningSessionPaths`，内部 `SessionItem running={runningSessionPaths.has(session.path)}`。

> 这是机械改名（单值 → Set.has），逐文件替换即可。

- [ ] **步骤 5：测试 + 冒烟**

`cd tauri-agent && npx tsc --noEmit` + `npx vitest run`。dev 验证：后台运行的会话在 Sidebar 显示运行角标（不止当前会话）。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/store/session.ts tauri-agent/src/App.tsx tauri-agent/src/features/sessions/Sidebar.tsx tauri-agent/src/features/sessions/SessionItem.tsx tauri-agent/src/features/sessions/ProjectGroup.tsx
git commit -m "feat(sidebar): show running indicator for all background sessions"
```

> **A1 完成。** 此时已实现"多对话后台并行 + 切回不丢流式 + 后台运行角标"。A2 为并发治理增强，可按需继续。

---

## 任务 T5：`commandLanes.ts` 两级队列（方案 E）

借鉴 OpenClaw `lanes.ts`：session lane（同 key 串行，保历史有序）+ global lane（全局并发上限，防打爆）。纯逻辑、易测。

**文件：** 创建 `src/lib/commandLanes.ts`、`src/lib/commandLanes.test.ts`

- [ ] **步骤 1：失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { createCommandLanes } from './commandLanes';

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('commandLanes', () => {
  it('同 sessionKey 串行执行', async () => {
    const lanes = createCommandLanes({ globalConcurrency: 10 });
    const order: string[] = [];
    const d1 = defer();
    const p1 = lanes.run('s', async () => { order.push('a-start'); await d1.promise; order.push('a-end'); });
    const p2 = lanes.run('s', async () => { order.push('b-start'); });
    await Promise.resolve();
    expect(order).toEqual(['a-start']); // b 未开始（串行）
    d1.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('global 并发上限限制不同 session 同时执行数', async () => {
    const lanes = createCommandLanes({ globalConcurrency: 1 });
    const order: string[] = [];
    const d1 = defer();
    const p1 = lanes.run('s1', async () => { order.push('1'); await d1.promise; });
    const p2 = lanes.run('s2', async () => { order.push('2'); });
    await Promise.resolve();
    expect(order).toEqual(['1']); // global=1 → s2 等待
    d1.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['1', '2']);
  });
});
```

- [ ] **步骤 2：验证失败** → `npx vitest run src/lib/commandLanes.test.ts`。

- [ ] **步骤 3：实现 `commandLanes.ts`**

```typescript
export interface CommandLanes {
  /** 在 sessionKey 串行 + 全局并发上限约束下执行 fn，返回其结果。 */
  run: <T>(sessionKey: string, fn: () => Promise<T>) => Promise<T>;
}

export function createCommandLanes(opts: { globalConcurrency: number }): CommandLanes {
  const sessionTail = new Map<string, Promise<unknown>>(); // 每会话串行链尾
  let globalActive = 0;
  const globalWaiters: Array<() => void> = [];

  const acquireGlobal = (): Promise<void> => {
    if (globalActive < opts.globalConcurrency) {
      globalActive++;
      return Promise.resolve();
    }
    return new Promise((resolve) => globalWaiters.push(resolve)).then(() => {
      globalActive++;
    });
  };
  const releaseGlobal = () => {
    globalActive--;
    const next = globalWaiters.shift();
    if (next) next();
  };

  const run = <T>(sessionKey: string, fn: () => Promise<T>): Promise<T> => {
    const prev = sessionTail.get(sessionKey) ?? Promise.resolve();
    const task = prev
      .catch(() => {}) // 前一个失败不阻断后续
      .then(async () => {
        await acquireGlobal();
        try {
          return await fn();
        } finally {
          releaseGlobal();
        }
      });
    // 链尾推进（忽略结果/异常，仅用于串行）
    sessionTail.set(sessionKey, task.catch(() => {}));
    return task;
  };

  return { run };
}

/** 全局单例：阶段 A 默认全局并发上限（可后续做成可配置）。 */
export const commandLanes = createCommandLanes({ globalConcurrency: 3 });
```

- [ ] **步骤 4：验证通过** → PASS（2 用例）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/lib/commandLanes.ts tauri-agent/src/lib/commandLanes.test.ts
git commit -m "feat(lanes): two-level session/global command lanes"
```

---

## 任务 T6：prompt 接入 Lane（并发占用按 streaming 释放）

**关键语义**：pi 的 `prompt` RPC 多半"接受即响应"，streaming 走事件流。因此 Lane 占用应从"发 prompt"持续到"该会话 `agent_end` / `isStreaming` 转 false"，而非到 `pi.prompt` 的 promise resolve。

**文件：** 改 `features/chat/ChatView.tsx`

- [ ] **步骤 1：实现**

把 `ChatView.handleSend`（`ChatView.tsx:10-16`）的 `await pi.prompt(...)` 包进 Lane，占用直到本会话 streaming 结束：

```tsx
import { commandLanes } from '../../lib/commandLanes';
// ...
  const handleSend = async (message: string, images?: PromptImage[]) => {
    const text = message.trim();
    if (!text && !images?.length) return;
    if (text) store.pushUserMessage(text);
    await commandLanes.run(workspace, async () => {
      await pi.prompt(workspace, text, undefined, images);
      // 等待本会话 streaming 结束再释放并发槽（pi prompt 立即返回，流式走事件）
      await waitForStreamingEnd(store);
    });
  };
```

新增小工具（可放 `ChatView.tsx` 内或 `lib/`）：

```tsx
function waitForStreamingEnd(store: AgentStoreApi): Promise<void> {
  if (!store.useStore.getState().isStreaming) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = store.useStore.subscribe((s) => {
      if (!s.isStreaming) {
        unsub();
        resolve();
      }
    });
  });
}
```

> `store.useStore.subscribe` 已在 T1 暴露。`AgentStoreApi` 从 `useAgentStoreContext()` 取（`ChatView.tsx:8`）。

- [ ] **步骤 2：类型检查 + 全量测试 + 冒烟**

`npx tsc --noEmit` + `npx vitest run`。dev 验证：把 `globalConcurrency` 临时设 1，同开 3 个会话发 prompt → 仅 1 个在跑、其余排队，前一个 `agent_end` 后下一个自动开始。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/chat/ChatView.tsx
git commit -m "feat(chat): route prompt through command lanes (release on streaming end)"
```

> **A2 完成。** 全局并发上限即方案 E 的核心；后续可把 `globalConcurrency` 接入 settings。

---

## 自检

**1. 任务依赖顺序**：T1(setActive/subscribe) → T2(registry 依赖二者) → T3(接线依赖 registry) → T4(角标依赖 registry 运行态) → T5(lanes 独立) → T6(依赖 T1 的 subscribe + T5)。无逆序依赖。

**2. 类型一致性**：
- `AgentStoreApi.setActive` / `useStore.subscribe`（T1 定义）被 registry(T2)/ChatView(T6) 使用。
- `agentStoreRegistry` / `useAgentRegistryStore`（T2）被 AgentStoreContext(T3)/App(T4) 使用。
- `workspaceSessionPaths` / `setWorkspaceSessionPath`（T4）单一来源 `store/session.ts`。
- `runningSessionPaths: Set<string>`（T4）沿 App→Sidebar→ProjectGroup→SessionItem 一致。
- `commandLanes`（T5）被 ChatView(T6) 使用。

**3. 与现有 mock 风格对齐**：registry.test / agent.test 均用 `vi.mock('../lib/pi')` 捕获 `onPiEvent` handler + 手动 `emit`，与现有 `agent.test.ts` 完全一致。

**4. 范围边界（阶段 A 不做）**：
- 不解决"同一 cwd 多会话并发"（留给 D1，需 manager key 改造 + 文件锁）。
- dock（终端/page/subagent）仍跟随 active workspace（A6-甲；per-workspace 化留给阶段 B）。
- 后端、pi、协议零改动。

**5. 风险点**：
- LRU 淘汰运行中会话：已规避（`evictIfNeeded` 跳过 isStreaming 与 activeKey）。
- 后台 rAF 节流：T1 setTimeout 兜底解决。
- Lane 占用泄漏：`run` 用 try/finally 释放 global slot；streaming 永不结束的极端情况由现有 abort/exit（`onPiExit` 置 isStreaming=false，`agent.ts:100`）兜底解除 `waitForStreamingEnd`。

---

## 执行交接

- **必需子技能：** `superpowers:executing-plans`（本仓库禁止子代理，内联执行）。
- 顺序 T1→T6，每任务末尾 commit；A1（T1-T4）完成即可单独验收上线，A2（T5-T6）为并发治理增强。
- 动手前建议先做设计文档 §三 的 **0.5d spike**（验证 pi `SessionManager` 文件锁），虽与阶段 A 无直接依赖，但决定后续 D1 是否需自加锁。
