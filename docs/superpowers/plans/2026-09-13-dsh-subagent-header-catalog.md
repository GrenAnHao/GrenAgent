# DSH 子代理规格 3：页头目录 + 子会话覆层 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 父会话 JSONL 写下直接子级目录；Electron 页头可打开谱系；点开主列覆层。one-shot 只读，continuable 可打字（投递走规格 2 inbox）。

**架构：** `pi.appendEntry("subagent_catalog")` 为权威。折叠只用 `SessionManager.open(path).buildContextEntries()` 的 leaf 路径，再切 `subagent_catalog_base`。目录变更走 `catalog-events.ts` sink，不靠 `session.subscribe`。覆层不替换 `WorkspaceHandle`。

**技术栈：** TypeScript ESM、vitest、React Testing Library、现有 `subagentUtils` 绑定。

**上游规格：** `docs/superpowers/specs/2026-09-13-dsh-subagent-header-catalog-design.md`

**依赖：** 规格 2 计划 `docs/superpowers/plans/2026-09-13-dsh-subagent-continuable-notice.md` 必须先落地（Activation / `subagent_prompt` 冷恢复 / parent host）。目录写入可在规格 2 的 spawn 接受点接上。

**不要执行：** 删 `SubAgentMenuButton`、切 WorkspaceHandle、Tauri 页头、把子会话挂进左侧列表、规格 4 的种子拷贝。

---

## 动工前必读

- 工作区很脏：`git add` 只加本任务文件。Windows 用 PowerShell here-string 提交。
- 扩展侧写目录：`pi.appendEntry("subagent_catalog", fact)`。子会话 meta 仍是 `sessionManager.appendCustomEntry`。
- 折叠：**`buildContextEntries()`**，禁止 `getEntries()`。leaf 外分支上的目录行必须测到消失。
- compaction 后旧目录行从页头消失：接受，不要做豁免。
- 目录事件不进会话订阅。用 `catalog-events.ts`，照抄 `embedded-events.ts`。
- IPC 的 `sessionPath` 必须落在**当场** `foldCatalog(parentPath)` 的白名单里，不信渲染层。
- `activity`：`running | idle | ready | settled | unavailable`。one-shot 文件还在是 `settled`，不是 `unavailable`。
- 规格 4 落地前采样 `inheritedEventCount` 缺省 0。本计划采样函数先预留 `slice(inherited)`，用 0 即可。
- 测试：

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run multi-agent/catalog.test.ts
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/subagents
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `extensions/multi-agent/catalog.ts` | `establishCatalogChild`、`foldCatalog`、`readCatalogBase` |
| `extensions/multi-agent/catalog.test.ts` | 顺序、base 切刀、leaf 路径、corrupt、settled |
| `extensions/multi-agent/catalog-events.ts` | sink，与 `embedded-events.ts` 同构 |
| `extensions/multi-agent/catalog-events.test.ts` | 注册 / 发射 / 一处抛错不影响别人 |
| `electron-agent/src/features/subagents/SubagentHeaderCatalog.tsx` | 页头开关 + 下拉 |
| `electron-agent/src/features/subagents/SubagentHeaderCatalog.test.tsx` | 空不渲染、有行、角标 |
| `electron-agent/src/features/subagents/ChildSessionOverlay.tsx` | 覆层 + composer |
| `electron-agent/src/features/subagents/ChildSessionOverlay.test.tsx` | one-shot 无输入；continuable 有 |
| `electron-agent/src/features/panels/useChildSessionBinding.ts` | 从 `SubAgentConversation.tsx` 抽出的 hook |

修改：

| 文件 | 职责 |
| --- | --- |
| `extensions/multi-agent/index.ts` | one-shot 返回前 / continuable 首次接受后 `establishCatalogChild` |
| `electron-agent/electron/agent/workspaceHandle.ts` | 注册 catalog sink |
| `electron-agent/electron/app/subagentService.ts` | `catalog` / `catalogRowSample` / `prompt` / `interrupt` |
| `electron-agent/electron/ipc/register.ts` | 四个 command |
| `electron-agent/src/lib/pi.ts` | invoke |
| `electron-agent/src/features/layout/MainColumnHeader.tsx` | 插入目录按钮 |
| `electron-agent/src/App.tsx` | `MainChatColumn` 挂覆层（容器已 `position: relative`） |
| `electron-agent/src/features/panels/SubAgentConversation.tsx` | 改用抽出的 hook |
| `electron-agent/src/stores/agent.ts` | 忽略 `subagent_catalog_changed`（不当聊天） |

---

### 任务 1：`catalog.ts` 折叠与写入

**文件：** 新建 `extensions/multi-agent/catalog.ts`、`catalog.test.ts`

- [ ] **步骤 1：写失败的测试（规格 §8 全覆盖）**

用内存假 `entries` 数组喂 `foldCatalogFromEntries(entries)`，避免单测依赖真实 JSONL I/O。另用临时文件测 `foldCatalog(path)` 走 `SessionManager` 的那条（若 CI 里 SessionManager 可写）。

```ts
import { describe, expect, it } from "vitest";
import { foldCatalogFromEntries, establishCatalogChild } from "./catalog.js";

const fact = (over: Record<string, unknown> = {}) => ({
  type: "custom",
  customType: "subagent_catalog",
  data: {
    version: 0,
    childId: "sa-1",
    sessionPath: "/c/sa-1.jsonl",
    childCreatedAt: 100,
    mode: "one-shot",
    label: "first",
    ...over,
  },
});

describe("foldCatalogFromEntries", () => {
  it("keeps write order not childCreatedAt", () => {
    const view = foldCatalogFromEntries([
      fact({ childId: "sa-b", childCreatedAt: 200, label: "b" }),
      fact({ childId: "sa-a", childCreatedAt: 50, label: "a" }),
    ]);
    expect(view.entries.map((e) => e.id)).toEqual(["sa-b", "sa-a"]);
  });

  it("drops facts before subagent_catalog_base", () => {
    const view = foldCatalogFromEntries([
      fact({ childId: "sa-old" }),
      { type: "custom", customType: "subagent_catalog_base", data: { version: 0, reason: "user-fork" } },
      fact({ childId: "sa-new", label: "n" }),
    ]);
    expect(view.entries.map((e) => e.id)).toEqual(["sa-new"]);
  });

  it("marks corrupt fact and keeps siblings", () => {
    const view = foldCatalogFromEntries([
      fact({ childId: "sa-ok" }),
      { type: "custom", customType: "subagent_catalog", data: { version: 1, childId: "sa-bad" } },
    ]);
    expect(view.entries[0].id).toBe("sa-ok");
    expect(view.diagnostics?.[0]).toMatchObject({ id: "sa-bad", reason: "corrupt" });
  });
});
```

leaf 路径测试：构造两份 entries，`foldCatalogFromEntries` 只接收「当前 leaf」那份。再写一条集成测试：若能 `SessionManager.create` + `branch` 出另一条目录事实，`foldCatalog(path)` 看不到它。实现时 `foldCatalog` **必须**调用 `buildContextEntries`；单测可用 `vi.spyOn` 断言（有真实 SM 时）。

`establishCatalogChild` 测试：传入 mock `appendEntry`，断言只调一次、payload 含 `version: 0`。失败启动的路径在 index 测试里断言「不调用」。

- [ ] **步骤 3：实现**

```ts
export interface SubagentCatalogFact {
  version: 0;
  childId: string;
  sessionPath: string;
  childCreatedAt: number;
  mode: "one-shot" | "continuable";
  label: string;
}

export interface SubagentCatalogEntry {
  id: string;
  sessionPath: string;
  createdAt: number;
  mode: "one-shot" | "continuable";
  label: string;
}

export interface CatalogDiagnostic {
  id: string;
  reason: "corrupt";
}

export interface SubagentCatalogView {
  entries: SubagentCatalogEntry[];
  diagnostics: CatalogDiagnostic[];
}

export function establishCatalogChild(
  appendEntry: (customType: string, data: SubagentCatalogFact) => void,
  fact: Omit<SubagentCatalogFact, "version">,
): void {
  appendEntry("subagent_catalog", { version: 0, ...fact });
}

export function foldCatalogFromEntries(entries: Array<Record<string, unknown>>): SubagentCatalogView {
  let start = 0;
  entries.forEach((e, i) => {
    if (e.customType === "subagent_catalog_base") start = i + 1;
  });
  const slice = entries.slice(start);
  const view: SubagentCatalogView = { entries: [], diagnostics: [] };
  for (const e of slice) {
    if (e.customType !== "subagent_catalog") continue;
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (d.version !== 0 || typeof d.childId !== "string" || typeof d.sessionPath !== "string" || (d.mode !== "one-shot" && d.mode !== "continuable")) {
      view.diagnostics.push({ id: typeof d.childId === "string" ? d.childId : "unknown", reason: "corrupt" });
      continue;
    }
    view.entries.push({
      id: d.childId,
      sessionPath: d.sessionPath,
      createdAt: typeof d.childCreatedAt === "number" ? d.childCreatedAt : 0,
      mode: d.mode,
      label: typeof d.label === "string" && d.label.trim() ? d.label : "(untitled)",
    });
  }
  return view;
}
```

`foldCatalog(sessionPath)`：`SessionManager.open` → `buildContextEntries()` → 映射成上面的 entries → `foldCatalogFromEntries`。打开失败返回空 view。

- [ ] **步骤 5：Commit** `feat(multi-agent): 父会话 subagent_catalog 折叠`

---

### 任务 2：catalog-events + 创建时写入

**文件：**
- 新建 `extensions/multi-agent/catalog-events.ts`、`.test.ts`
- 修改 `extensions/multi-agent/index.ts`、`index.test.ts`

- [ ] **步骤 1：** events 测试照抄 `embedded-events.test.ts`。index 测试：embedded run 成功后 `appendEntry` 被叫一次；spawn continuable 在 install 成功后叫一次；创建抛错不叫。

- [ ] **步骤 3：**

`emitCatalogChanged({ sessionPath })`。index 在规格 2 留下的注释处：

```ts
try {
  establishCatalogChild((t, d) => pi.appendEntry(t, d), { ... });
  emitCatalogChanged({ sessionPath: parentPath });
} catch {
  // continuable: disposeActivation rollback, throw
  // one-shot: 不写目录，工具结果仍按规格 1
}
```

continuable 写入失败必须拆除 Activation（规格 §3.1）。one-shot 失败只缺目录行。

用户 rewind 写 `subagent_catalog_base`：听 `session_before_fork`，若即将拷贝的 leaf 上下文里已有 `subagent_catalog`，在新会话 `session_start`（同一 fork 结果）写一条 base。实现：`session_before_fork` 记下 `pendingForkBase = parentSessionPath`；下一次 `session_start` 若 `getSessionFile()` 不同且旧文件折出来非空，则 `pi.appendEntry("subagent_catalog_base", { version: 0, reason: "user-fork" })`。没有目录事实不写。

- [ ] **步骤 5：Commit** `feat(multi-agent): 成功创建后写入父目录事实`

---

### 任务 3：采样 activity / tokens / duration

**文件：**
- 新建 `extensions/multi-agent/catalog-sample.ts`、`.test.ts`

- [ ] **步骤 1：测试**

```ts
it("one-shot file present is settled not unavailable", () => {
  const row = sampleRow({ mode: "one-shot", sessionPath: existing, activation: undefined });
  expect(row.activity).toBe("settled");
});

it("continuable without activation is ready", () => {
  expect(sampleRow({ mode: "continuable", tornDown: false, activation: undefined }).activity).toBe("ready");
});

it("resident streaming is running", () => {
  expect(sampleRow({ activation: { isStreaming: true } }).activity).toBe("running");
});

it("omits tokens when no usage", () => {
  expect(sampleRow({ messages: [] }).tokens).toBeUndefined();
});

it("slices inheritedEventCount for tokens", () => {
  // 前 2 条带 usage，inherited=2，后 1 条 usage 5 → tokens === 5
});
```

`tokens` = 四段之和，只扫 `messages.slice(inheritedEventCount)`。无 usage 字段则 undefined。`durationMs`：slice 后第一条 user timestamp 到最后一条 assistant/tool timestamp；running 时终点 `Date.now()`。

- [ ] **步骤 5：Commit** `feat(multi-agent): 目录行现场采样`

---

### 任务 4：Electron IPC

**文件：**
- 修改 `electron-agent/electron/app/subagentService.ts`
- 修改 `electron-agent/electron/ipc/register.ts`
- 修改 `electron-agent/src/lib/pi.ts`
- 测试：`electron-agent/electron/app/subagentService.test.ts`（没有就建）

方法：

```ts
catalog(parentSessionPath: string): SubagentCatalogView
catalogRowSample(sessionPath: string): CatalogRowView
promptChild(workspace: string, parentSessionPath: string, sessionPath: string, message: string, delivery: "followUp" | "steer"): void
interruptChild(workspace: string, parentSessionPath: string, sessionPath: string): void
```

`prompt` / `interrupt`：先 `foldCatalog(parent)`，白名单 = entries + 已展开后代（本版后代用对 `hasChildren` 再 fold 一层的 id 集合；未展开则只有直接孩子）。不在名单 → throw `sessionPath is not in the parent catalog`。one-shot 的 prompt → throw。通过后调规格 2 的 `deliverToChild` / `interruptChild`（按 sessionPath 找 Activation，没有则冷恢复）。

`sessionMessages` 已有，照抄 open。

- [ ] **步骤 5：Commit** `feat(electron): 子代理目录与覆层 IPC`

---

### 任务 5：抽出 `useChildSessionBinding`

**文件：**
- 新建 `electron-agent/src/features/panels/useChildSessionBinding.ts`
- 修改 `SubAgentConversation.tsx` 改为 import hook
- 现有 `subagentUtils.test.ts` / conversation 测试必须仍绿

不要改绑定语义。只搬函数。

- [ ] **步骤 5：Commit** `refactor(electron): 抽出子会话绑定 hook`

---

### 任务 6：页头目录 UI

**文件：**
- 新建 `SubagentHeaderCatalog.tsx` + test
- 修改 `MainColumnHeader.tsx`
- 修改 `workspaceHandle.ts` 注册 catalog sink → `pi://event` `{ type: "subagent_catalog_changed", sessionPath }`
- 修改 `agent.ts`：`type === "subagent_catalog_changed"` 直接 return（已忽略 `source==="subagent"`；这条 source 是 interactive）

- [ ] **步骤 1：测试**

- `entries.length===0`：没有 `data-testid="subagent-header-catalog"`
- 有行：按钮在；点开看到 label / mode
- 有 `running`：title 含运行数
- 点行调用 `onOpen(entry)`（本任务用 mock，不挂覆层）

下拉：360px 宽，`role="tree"`，Esc 关闭。放在 `WorkspaceTabs` 与 `PlanModeBadge` 之间。

- [ ] **步骤 5：Commit** `feat(electron): 主列页头子代理目录`

---

### 任务 7：主列覆层

**文件：**
- 新建 `ChildSessionOverlay.tsx` + test
- 修改 `App.tsx` 的 `MainChatColumn`：父 `ChatView` 不卸载；覆层绝对定位铺内容区
- 新建小 store 或 props lift：`overlayChild: { sessionPath, label, mode, activity, tornDown } | null`

- [ ] **步骤 1：测试**

- one-shot：有 `subagent-child-overlay`，无 composer，文案 `此子代理只读`
- continuable + ready：有 textarea / 发送；点击后 `pi.subagentPrompt` 收到 `delivery: "followUp"`
- continuable + running：按钮「引导」，`delivery: "steer"`
- tornDown：`无法继续`，无输入
- 返回：调用 `onClose`；测「父 ChatView 在覆层打开时仍 mount」（`data-testid` 父列表还在）

顶条：`← 返回`、label、mode、只读/可续聊。running 时停止键调 `subagentInterrupt`。

从子目录点孙：替换 overlay 状态，返回仍清 overlay 回父（不堆栈）。

- [ ] **步骤 5：Commit** `feat(electron): 子会话主列覆层`

---

## 规格覆盖

| 规格 | 任务 |
| --- | --- |
| §3.1 写入时机 | 2 |
| §3.2 leaf + base | 1 |
| §3.3 user-fork base | 2 |
| §3.4 采样 / settled | 3 |
| §4.1 页头 | 6 |
| §4.2 / §4.3 覆层 | 5、7 |
| §4.4 Bot 菜单不动 | 不做删除 |
| §5 IPC / sink | 4、6 |
| 规格 4 种子 base | 不做（夹具可测 fold） |

---

## 完成定义

- 成功 embedded 创建后页头不刷新也出现一行
- rewind 出的新文件若写了 `subagent_catalog_base`，页头为空或只有新孩子
- 覆层打开时 `WorkspaceHandle` 会话路径仍是父
- continuable 覆层打字进子 JSONL，父主 store 不出现该 user 气泡
