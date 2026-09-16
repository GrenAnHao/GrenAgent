# 会话切换 UX 修复实现计划（回弹 / 删除即时 / 缓存卡死 / 加载）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 修复 tauri-agent 桌面端删除会话/对话的回弹、非即时、列表与消息缓存卡在已删会话，以及未缓存会话切换的后端冗余对齐。

**架构：** 给"全量会话重拉"加单调代次（epoch）作废过期响应；删除以隐藏集为唯一真相（去掉裸 `setAllSessions`）+ 即时失效消息缓存；选中态确定化；命中缓存时按需跳过冗余后端对齐。纯前端（`tauri-agent/src`），零后端协议改动、零 Pi fork。

**技术栈：** TypeScript、React、zustand、vitest（`cd tauri-agent && npx vitest run <file>`、`npx tsc --noEmit`）。

设计来源：`docs/superpowers/specs/2026-06-26-session-switch-ux-design.md`。

---

## 文件结构

- 修改：`tauri-agent/src/lib/sessionCache.ts` —— 增 epoch 计数（`bumpSessionMutationEpoch`/`getSessionMutationEpoch`/`isFreshResponse`）。
- 测试：`tauri-agent/src/lib/sessionCache.test.ts`（新建）。
- 修改：`tauri-agent/src/lib/sessionMessageCache.ts` —— 增 `invalidateCachedSession(path)`。
- 测试：`tauri-agent/src/lib/sessionMessageCache.test.ts`（新建）。
- 修改：`tauri-agent/src/App.tsx` —— `refreshAllSessions` epoch 守卫；`refreshSessions` 选中态确定化；`handleDeleteSession` / `handleDeleteConversation` 删除唯一真相 + 缓存失效；F3 命中缓存跳冗余对齐（measure-first）。

---

## 任务 1：sessionCache 单调代次（epoch）

**文件：**
- 修改：`tauri-agent/src/lib/sessionCache.ts`
- 测试：`tauri-agent/src/lib/sessionCache.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// tauri-agent/src/lib/sessionCache.test.ts
import { describe, expect, it } from 'vitest';
import {
  bumpSessionMutationEpoch,
  getSessionMutationEpoch,
  isFreshResponse,
} from './sessionCache';

describe('session mutation epoch', () => {
  it('bump increments and reads back', () => {
    const before = getSessionMutationEpoch();
    const after = bumpSessionMutationEpoch();
    expect(after).toBe(before + 1);
    expect(getSessionMutationEpoch()).toBe(after);
  });

  it('isFreshResponse true when no mutation since start', () => {
    const started = getSessionMutationEpoch();
    expect(isFreshResponse(started)).toBe(true);
  });

  it('isFreshResponse false after a mutation', () => {
    const started = getSessionMutationEpoch();
    bumpSessionMutationEpoch();
    expect(isFreshResponse(started)).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/lib/sessionCache.test.ts`
预期：FAIL，导出不存在。

- [ ] **步骤 3：编写实现**

在 `tauri-agent/src/lib/sessionCache.ts` 末尾追加：

```ts
// 会话列表的单调代次：每次删除/新建/重命名等 mutation 自增；
// 重拉响应回来时若代次已变（期间发生过 mutation），该响应作废，避免把旧列表灌回（回弹治根）。
let mutationEpoch = 0;

export function bumpSessionMutationEpoch(): number {
  return ++mutationEpoch;
}

export function getSessionMutationEpoch(): number {
  return mutationEpoch;
}

/** 请求发起时记录 startedEpoch；响应回来调此判定是否仍可应用。 */
export function isFreshResponse(startedEpoch: number): boolean {
  return startedEpoch === mutationEpoch;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/lib/sessionCache.test.ts`
预期：PASS（3 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/lib/sessionCache.ts tauri-agent/src/lib/sessionCache.test.ts
git commit -m "feat(session-ux): monotonic mutation epoch to discard stale list refetches"
```

## 任务 2：消息缓存按 path 失效

**文件：**
- 修改：`tauri-agent/src/lib/sessionMessageCache.ts`
- 测试：`tauri-agent/src/lib/sessionMessageCache.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// tauri-agent/src/lib/sessionMessageCache.test.ts
import { describe, expect, it } from 'vitest';
import {
  getCachedSession,
  setCachedSession,
  invalidateCachedSession,
} from './sessionMessageCache';

describe('invalidateCachedSession', () => {
  it('evicts the entry for a path', () => {
    setCachedSession('/p/a.jsonl', [], '0');
    expect(getCachedSession('/p/a.jsonl')).toBeDefined();
    invalidateCachedSession('/p/a.jsonl');
    expect(getCachedSession('/p/a.jsonl')).toBeUndefined();
  });

  it('is a no-op for an unknown path', () => {
    expect(() => invalidateCachedSession('/p/missing.jsonl')).not.toThrow();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/lib/sessionMessageCache.test.ts`
预期：FAIL，`invalidateCachedSession` 不存在。

- [ ] **步骤 3：编写实现**

在 `tauri-agent/src/lib/sessionMessageCache.ts` 末尾追加：

```ts
/** 删除某会话后清掉其消息缓存，避免 showCachedSession 仍命中已删会话内容（缓存卡死）。 */
export function invalidateCachedSession(sessionPath: string): void {
  cache.delete(sessionPath);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/lib/sessionMessageCache.test.ts`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/lib/sessionMessageCache.ts tauri-agent/src/lib/sessionMessageCache.test.ts
git commit -m "feat(session-ux): invalidateCachedSession to evict deleted session messages"
```

## 任务 3：refreshAllSessions 加 epoch 守卫

**文件：**
- 修改：`tauri-agent/src/App.tsx:66-107`（`refreshAllSessions`）

- [ ] **步骤 1：扩充 sessionCache 的 import**

把 `App.tsx` 顶部对 `./lib/sessionCache` 的具名导入加上 epoch 三件：

```ts
import {
  getAllSessionsInflight,
  getCachedAllSessions,
  setAllSessionsInflight,
  setCachedAllSessions,
  invalidateAllSessionsCache,
  bumpSessionMutationEpoch,
  getSessionMutationEpoch,
  isFreshResponse,
} from './lib/sessionCache';
```

- [ ] **步骤 2：守卫所有"应用响应"的入口**

把 `refreshAllSessions`（:66-107）改为：发请求前记录 `startedEpoch`，每个 `syncAllSessions` 调用点先判 `isFreshResponse`：

```ts
async function refreshAllSessions(force = false): Promise<void> {
  const { syncAllSessions, setAllSessionsLoading, setError } = useSessionStore.getState();
  const startedEpoch = getSessionMutationEpoch();

  if (!force) {
    const cached = getCachedAllSessions();
    if (cached) {
      if (isFreshResponse(startedEpoch)) syncAllSessions(cached);
      return;
    }
    const inflight = getAllSessionsInflight();
    if (inflight) {
      setAllSessionsLoading(true);
      try {
        const s = await inflight;
        if (isFreshResponse(startedEpoch)) syncAllSessions(s);
      } finally {
        setAllSessionsLoading(false);
      }
      return;
    }
  }

  setAllSessionsLoading(true);
  const request = pi
    .listAllSessions()
    .then((sessions) => {
      // 期间发生过 mutation（删除/新建/重命名）→ 该响应已过期，丢弃：不写缓存、不应用，
      // 否则会把"删前/删中"扫到的旧列表灌回，表现为删后回弹/需重删。
      if (!isFreshResponse(startedEpoch)) return sessions;
      setCachedAllSessions(sessions);
      syncAllSessions(sessions);
      return sessions;
    })
    .catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    })
    .finally(() => {
      setAllSessionsLoading(false);
      setAllSessionsInflight(null);
    });

  setAllSessionsInflight(request);
  await request;
}
```

> 注意：`force=true` 的删除后重拉自身在调用前已 `bumpSessionMutationEpoch()`（任务 4/5），故其 `startedEpoch` 是最新的，不会被自己作废；只作废更早发出的在途请求。

- [ ] **步骤 3：typecheck**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：通过。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/App.tsx
git commit -m "fix(session-ux): epoch-guard refreshAllSessions so stale refetches can't resurrect deleted sessions"
```

## 任务 4：handleDeleteSession 改为隐藏集唯一真相 + 缓存失效

**文件：**
- 修改：`tauri-agent/src/App.tsx:472-534`（`handleDeleteSession`）
- 修改：`tauri-agent/src/App.tsx` import（加 `invalidateCachedSession`、`filterDeletedSessions`、`mergeAllSessions`）

- [ ] **步骤 1：补 import**

```ts
import { invalidateCachedSession } from './lib/sessionMessageCache';
import { filterDeletedSessions, mergeAllSessions } from './lib/mergeSessions';
```

- [ ] **步骤 2：重写 handleDeleteSession**

把整个 `handleDeleteSession`（:472-534）替换为（去掉裸 `setAllSessions`，加缓存失效 + epoch，`next` 从过滤后列表取）：

```ts
const handleDeleteSession = useCallback(async (cwd: string, path: string) => {
  const st = useSessionStore.getState();
  const wasActive = pathsEquivalent(st.activeSessionPath ?? '', path);
  // 乐观：隐藏集为唯一真相（渲染层 filterDeletedSessions 即时移除）；同时失效两级缓存 + bump epoch
  // 作废在途重拉。不再裸 setAllSessions(remaining)——那会与重拉互相覆盖造成回弹。
  st.hideDeletedSession(path);
  st.removeOptimisticSession(path);
  invalidateCachedSession(path);
  bumpSessionMutationEpoch();
  invalidateAllSessionsCache();
  if (wasActive) {
    store.reset();
    st.setActiveSession('');
  }
  try {
    await pi.deleteSession(cwd, path);
    bumpSessionMutationEpoch();
    invalidateAllSessionsCache();
    if (wasActive) {
      const visible = filterDeletedSessions(
        mergeAllSessions(st.allSessions, st.optimisticSessions),
        useSessionStore.getState().deletedSessionPaths,
      );
      const nextInProject = visible
        .filter((s) => s.cwd && pathsEquivalent(s.cwd, cwd))
        .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))[0];
      if (nextInProject) {
        try {
          await pi.switchSession(cwd, nextInProject.path);
          const { messages } = await pi.getMessages(cwd);
          store.loadMessages(messages, { force: true, sessionPath: nextInProject.path });
          st.setActiveSession(nextInProject.path);
          st.setWorkspaceSessionPath(cwd, nextInProject.path);
        } catch {
          /* 切换失败：保持空会话区 */
        }
      } else {
        try {
          const state = (await pi.getState(cwd)) as { sessionFile?: string };
          const newPath = state.sessionFile;
          if (newPath) {
            st.setActiveSession(newPath);
            st.setWorkspaceSessionPath(cwd, newPath);
            st.upsertOptimisticSession({
              id: `opt-${newPath}`,
              path: newPath,
              cwd,
              timestamp: new Date().toISOString(),
              name: null,
            });
          }
        } catch {
          /* getState 失败保持空会话区 */
        }
      }
    }
    void refreshAllSessions(true);
  } catch (e) {
    // 后端删除失败：撤销隐藏，列表项恢复，并提示错误。
    st.unhideDeletedSession(path);
    st.setError(e instanceof Error ? e.message : String(e));
  }
}, [store]);
```

> 关键差异：① 删去 `st.setAllSessions(remaining)`（避免与重拉抢）；② 加 `invalidateCachedSession(path)`（消"缓存卡在已删会话"）；③ 加两处 `bumpSessionMutationEpoch()`（删时 + 删后，作废过期重拉）；④ `next` 从 `filterDeletedSessions(...)` 取（不再选到已隐藏项）；⑤ 删去末尾原 `refreshSessions(cwd)`（其 auto-select 会与上面显式选中打架，见任务 6；活跃会话的下一步已在此显式处理）。
>
> 安全性已核实：store 的 per-workspace `sessions` 字段**无任何渲染处订阅**（侧栏全部由 `allSessions` 经 `useProjectGroups`/`useConversations` 派生；`grep "useSessionStore((s) => s.sessions)"` 无命中）。故删除路径去掉 `refreshSessions(cwd)` 不影响侧栏列表刷新。

- [ ] **步骤 3：typecheck**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：通过（确认 `filterDeletedSessions`/`mergeAllSessions`/`invalidateCachedSession` 已导入且无未用告警）。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/App.tsx
git commit -m "fix(session-ux): delete session via hide-set as single truth + cache eviction + epoch (no rubber-band)"
```

## 任务 5：handleDeleteConversation 同口径

**文件：**
- 修改：`tauri-agent/src/App.tsx:581-610`（`handleDeleteConversation`）

- [ ] **步骤 1：重写 handleDeleteConversation**

去掉裸 `setAllSessions`，`next` 从过滤后列表取，失效该 cwd 下所有 session 的消息缓存 + bump epoch：

```ts
const handleDeleteConversation = useCallback(
  (cwd: string) => {
    const st = useSessionStore.getState();
    // 失效该 cwd 下所有会话的消息缓存（删除前先收集 path）。
    const pathsUnderCwd = st.allSessions
      .filter((s) => s.cwd && pathsEquivalent(s.cwd, cwd))
      .map((s) => s.path);
    st.hideDeletedConversation(cwd);
    st.removeOptimisticByCwd(cwd);
    for (const p of pathsUnderCwd) invalidateCachedSession(p);
    bumpSessionMutationEpoch();
    invalidateAllSessionsCache();
    if (pathsEquivalent(st.activeWorkspace, cwd)) {
      const visible = filterDeletedSessions(
        mergeAllSessions(st.allSessions, st.optimisticSessions),
        useSessionStore.getState().deletedSessionPaths,
      );
      const next = visible
        .filter(
          (s) =>
            s.cwd &&
            !pathsEquivalent(s.cwd, cwd) &&
            !useSessionStore
              .getState()
              .deletedConversationCwds.some((d) => pathsEquivalent(d, s.cwd ?? '')),
        )
        .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))[0];
      st.setActiveSession(next?.path ?? '');
      if (next?.cwd) {
        st.setActiveWorkspace(next.cwd);
      } else {
        void handleNewConversation();
      }
    }
    void (async () => {
      try {
        await pi.deleteConversation(cwd);
        bumpSessionMutationEpoch();
        invalidateAllSessionsCache();
        await refreshAllSessions(true);
      } catch (e) {
        st.unhideDeletedConversation(cwd);
        st.setError(e instanceof Error ? e.message : String(e));
      }
    })();
  },
  [handleNewConversation],
);
```

> 关键差异：删去裸 `setAllSessions`；`next` 从已过滤列表取并额外排除 `deletedConversationCwds`（不再切到另一个"已隐藏未清理"的对话→消除切到已删 cwd 的闪/错）；失效该 cwd 全部会话消息缓存；删时 + 删后各 bump 一次 epoch。

- [ ] **步骤 2：typecheck + Commit**

运行：`cd tauri-agent && npx tsc --noEmit`

```bash
git add tauri-agent/src/App.tsx
git commit -m "fix(session-ux): delete conversation via hide-set + cache eviction + filtered next selection"
```

## 任务 6：refreshSessions 选中态确定化

**文件：**
- 修改：`tauri-agent/src/App.tsx:44-64`（`refreshSessions`）

- [ ] **步骤 1：给 refreshSessions 加"是否允许自动选中"开关**

auto-select 仅在调用方未显式管理选中时触发，避免删除/切换后的显式选中被它二次抢走：

```ts
async function refreshSessions(
  workspace: string,
  openResult?: OpenWorkspaceResult,
  options?: { autoSelect?: boolean },
): Promise<void> {
  const autoSelect = options?.autoSelect ?? true;
  const { setSessions, setActiveSession, setError } = useSessionStore.getState();
  try {
    const sessions = await pi.listSessions(workspace);
    setSessions(sessions);
    if (!autoSelect) return;
    const active = useSessionStore.getState().activeSessionPath;
    if (!active) {
      if (openResult?.sessionFile) {
        setActiveSession(openResult.sessionFile);
      } else if (sessions.length > 0) {
        setActiveSession(sessions[0].path);
      }
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}
```

> 切换工作区的 effect（:356）保持 `autoSelect: true`（首次打开需要兜底选中）；删除路径已不再调用 `refreshSessions`（任务 4 移除），故无需传 false。本步是把 auto-select 显式化、为后续调用点留出确定性开关，并补一条 `autoSelect:false` 的单测保护。

- [ ] **步骤 2：补单测（抽出 auto-select 判定）**

> `refreshSessions` 直接依赖 `pi`/store，难纯测。把"是否应自动选中 + 选哪个"抽成纯函数 `pickAutoSelected(active, openResult, sessions)` 放 `tauri-agent/src/lib/sessionSelect.ts`，在 `refreshSessions` 内调用，并对纯函数补测：

```ts
// tauri-agent/src/lib/sessionSelect.ts
import type { OpenWorkspaceResult, SessionInfo } from './pi';

/** 返回应设为 active 的 path；null 表示保持现状（已有显式 active 或无候选）。 */
export function pickAutoSelected(
  active: string | null,
  openResult: OpenWorkspaceResult | undefined,
  sessions: SessionInfo[],
): string | null {
  if (active) return null;
  if (openResult?.sessionFile) return openResult.sessionFile;
  return sessions.length > 0 ? sessions[0].path : null;
}
```

```ts
// tauri-agent/src/lib/sessionSelect.test.ts
import { describe, expect, it } from 'vitest';
import { pickAutoSelected } from './sessionSelect';

describe('pickAutoSelected', () => {
  it('keeps explicit active (returns null)', () => {
    expect(pickAutoSelected('/a.jsonl', undefined, [])).toBeNull();
  });
  it('prefers openResult.sessionFile when no active', () => {
    expect(pickAutoSelected(null, { sessionFile: '/o.jsonl' } as never, [])).toBe('/o.jsonl');
  });
  it('falls back to first session', () => {
    expect(pickAutoSelected(null, undefined, [{ path: '/s.jsonl' } as never])).toBe('/s.jsonl');
  });
  it('returns null when nothing to pick', () => {
    expect(pickAutoSelected(null, undefined, [])).toBeNull();
  });
});
```

`refreshSessions` 内改用：`const pick = autoSelect ? pickAutoSelected(active, openResult, sessions) : null; if (pick) setActiveSession(pick);`

- [ ] **步骤 3：运行测试 + typecheck**

运行：`cd tauri-agent && npx vitest run src/lib/sessionSelect.test.ts && npx tsc --noEmit`
预期：PASS（4 passed）+ typecheck 通过。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/lib/sessionSelect.ts tauri-agent/src/lib/sessionSelect.test.ts tauri-agent/src/App.tsx
git commit -m "refactor(session-ux): deterministic auto-select via pure pickAutoSelected"
```

## 任务 7（measure-first，可选）：命中缓存跳过冗余后端对齐

**文件：**
- 修改：`tauri-agent/src/App.tsx:328-383`（切换 effect）

- [ ] **步骤 1：先测量，确认值得做**

在本机复现"切换慢"，看 `createStartupPerf` 的 `perf.report()` 输出（控制台 `[PERF-startup]`），记录未缓存会话切换里 `openWorkspace` / `getMessages` 各占多少 ms。若主成本是冷 spawn → 优先确保 hover 预热覆盖（任务范围外）；若主成本是命中缓存后仍 `getMessages` 重读 → 做步骤 2。

- [ ] **步骤 2：命中缓存且后端已在该会话时跳过整轮对齐**

当 `App.tsx:331` 已 `showCachedSession(target)` 秒显，且 `workspaceSessionPaths[workspace] === target`（该 workspace 此前已切到该 session、后端活跃会话即它）时，跳过 effect 下方的 `openWorkspace`+`switchSession`+`getMessages`，仅 `void refreshAllSessions()`：

```ts
if (target && store.showCachedSession(target)) {
  setWorkspaceReady(true);
  const backendOnTarget = pathsEquivalent(
    useSessionStore.getState().workspaceSessionPaths[workspace] ?? '',
    target,
  );
  if (backendOnTarget) {
    useSessionStore.getState().setLoading(false);
    void refreshAllSessions();
    return () => {
      alive = false;
      clearTimeout(readyGuard);
    };
  }
}
```

> 保守条件：仅"模块缓存命中 + 后端活跃会话已是它"才跳过；否则照旧走完整对齐（fail-safe，宁可多对齐一次也不显示陈旧内容）。

- [ ] **步骤 3：typecheck + 手动冒烟 + Commit**

运行：`cd tauri-agent && npx tsc --noEmit`；手动：切到看过的会话应无骨架屏、无内容闪。

```bash
git add tauri-agent/src/App.tsx
git commit -m "perf(session-ux): skip redundant backend re-align when cache hit and backend already on target"
```

---

## 自检

**1. 规格覆盖度：**
- F1 epoch 作废 → 任务 1（原语）+ 任务 3（refreshAllSessions 守卫）✓
- F2 删除唯一真相 → 任务 4（session）+ 任务 5（conversation）去裸 `setAllSessions` ✓
- F4 选中态确定化 → 任务 6（`pickAutoSelected` + 删除路径不再 auto-select 抢）✓
- F5 缓存失效 → 任务 2（`invalidateCachedSession`）+ 任务 4/5 调用 ✓
- F3 加载提速（measure-first）→ 任务 7 ✓

**2. 占位符扫描：** 无"TODO/待定/类似任务 N"；每个代码步骤含完整代码。任务 6 的纯函数抽取给了完整实现与测试。任务 7 标注 measure-first 并给了完整跳过逻辑（非占位）。

**3. 类型一致：**
- epoch 三件签名一致：`bumpSessionMutationEpoch(): number` / `getSessionMutationEpoch(): number` / `isFreshResponse(startedEpoch: number): boolean`（任务 1 定义，任务 3/4/5 使用）。
- `invalidateCachedSession(sessionPath: string): void`（任务 2 定义，任务 4/5 使用）。
- `filterDeletedSessions(sessions, deletedPaths)` / `mergeAllSessions(all, optimistic)`（既有 `lib/mergeSessions.ts`，任务 4/5 import 使用，签名与现有一致）。
- `pickAutoSelected(active, openResult, sessions)`（任务 6 定义并在 `refreshSessions` 使用）。

**4. 依赖序：** 任务 1、2 为纯原语先行；任务 3 依赖 1；任务 4、5 依赖 1+2；任务 6 独立；任务 7 measure-first 最后。每个任务独立产出可测、可 commit 的变更。

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-26-session-switch-ux.md`。两种执行方式：

1. **子代理驱动（推荐）** —— 每任务一个子代理 + 任务间审查。**注意：本仓库 MCP messenger 规则要求"插件相关任务不并发子代理"；但本计划是普通前端实现、与 messenger 无关，可用子代理。** 若仍想稳妥，用方式 2。
2. **内联执行** —— 当前会话用 executing-plans 批量执行、设检查点。

选哪种？
