# 输入区顶帽 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把排队、任务、目标收成一条顶帽，底边压住输入卡片；排队收起时显示条数和第一条原文，展开后用手柄改本地顺序。

**架构：** 不新做行列表。`composer-dock` 改成顶帽外壳，子节点顺序改为排队、任务、目标。三层去掉 `dockCard` 自己的边框。排队的收起文案和拖拽落点是纯函数；手柄用指针事件调用 `moveComposerItem`，不引入拖拽库。

**技术栈：** React、Vitest、Testing Library、antd-style、`electron-agent` 里现有的 `composerQueue`。

**规格：** `docs/superpowers/specs/2026-09-25-composer-top-cap-design.md`

---

## 文件

- 修改：`electron-agent/src/features/chat/input/composerQueue.ts` — 增加 `moveComposerItem`
- 修改：`electron-agent/src/features/chat/input/composerQueue.test.ts`
- 创建：`electron-agent/src/features/chat/input/queueSummary.ts` — 收起标题
- 创建：`electron-agent/src/features/chat/input/queueSummary.test.ts`
- 创建：`electron-agent/src/features/chat/input/queueDrop.ts` — 指针落点算插入位置
- 创建：`electron-agent/src/features/chat/input/queueDrop.test.ts`
- 修改：`electron-agent/src/features/chat/input/SteerQueue.tsx` — 收起、展开、手柄
- 修改：`electron-agent/src/features/chat/input/SteerQueue.test.tsx`
- 修改：`electron-agent/src/features/chat/input/dockCard.ts` — 卡片根标记 `data-dock-card`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.tsx` — 顶帽样式和顺序
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx` — 顺序断言
- 不改：`TodoDock.tsx` 的收起逻辑、`GoalPill.tsx` 的完成态、`ChatView.tsx` 的发送、`preview.tsx`

画廊里的 `TodoDock` 会一起失去卡片边框。规格不要求画廊，所以不改 `preview.tsx`。

---

### 任务 1：移动排队项

**文件：**
- 修改：`electron-agent/src/features/chat/input/composerQueue.ts`
- 测试：`electron-agent/src/features/chat/input/composerQueue.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `composerQueue.test.ts` 的 import 里加上 `moveComposerItem`，并追加：

```ts
it('moveComposerItem 把条目插到另一条前面', () => {
  const a = createComposerItem('a');
  const b = createComposerItem('b');
  const c = createComposerItem('c');
  expect(moveComposerItem([a, b, c], b.id, a.id).map((item) => item.id)).toEqual([b.id, a.id, c.id]);
});

it('moveComposerItem 的 beforeId 为 null 时放到队尾', () => {
  const a = createComposerItem('a');
  const b = createComposerItem('b');
  expect(moveComposerItem([a, b], a.id, null).map((item) => item.id)).toEqual([b.id, a.id]);
});

it('moveComposerItem 找不到被拖条目时原样返回', () => {
  const a = createComposerItem('a');
  const queue = [a];
  expect(moveComposerItem(queue, 'missing', null)).toBe(queue);
});

it('moveComposerItem 目标就是自己时原样返回', () => {
  const a = createComposerItem('a');
  const b = createComposerItem('b');
  const queue = [a, b];
  expect(moveComposerItem(queue, a.id, b.id)).toBe(queue);
});
```

最后一条的预期：`[a, b]` 里把 `a` 插到 `b` 前面，结果仍是 `[a, b]`，函数返回原数组。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/composerQueue.test.ts`

预期：FAIL，`moveComposerItem` 未导出。

- [ ] **步骤 3：编写最少实现代码**

在 `composerQueue.ts` 末尾添加：

```ts
export function moveComposerItem(
  queue: ComposerQueuedItem[],
  id: string,
  beforeId: string | null,
): ComposerQueuedItem[] {
  const from = queue.findIndex((item) => item.id === id);
  if (from < 0) return queue;
  const next = queue.filter((item) => item.id !== id);
  const to = beforeId == null ? next.length : next.findIndex((item) => item.id === beforeId);
  if (to < 0) return queue;
  const moved = queue[from];
  if (!moved) return queue;
  next.splice(to, 0, moved);
  const same = next.every((item, index) => item === queue[index]);
  return same ? queue : next;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/composerQueue.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/input/composerQueue.ts electron-agent/src/features/chat/input/composerQueue.test.ts
git commit -m "feat: move a composer queue item before another"
```

---

### 任务 2：排队收起标题

**文件：**
- 创建：`electron-agent/src/features/chat/input/queueSummary.ts`
- 测试：`electron-agent/src/features/chat/input/queueSummary.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { queueSummaryLabel } from './queueSummary';

describe('queueSummaryLabel', () => {
  it('带上条数和第一条原文', () => {
    expect(queueSummaryLabel([{ text: '  先改测试  ' }, { text: '第二条' }])).toBe('排队 · 2 · 先改测试');
  });

  it('第一条没有文字时只显示条数', () => {
    expect(queueSummaryLabel([{ text: '   ' }])).toBe('排队 · 1');
  });

  it('空队列返回空字符串', () => {
    expect(queueSummaryLabel([])).toBe('');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/queueSummary.test.ts`

预期：FAIL，找不到 `./queueSummary`。

- [ ] **步骤 3：编写最少实现代码**

```ts
export function queueSummaryLabel(items: readonly { text: string }[]): string {
  if (items.length === 0) return '';
  const text = items[0]?.text.trim() ?? '';
  return text ? `排队 · ${items.length} · ${text}` : `排队 · ${items.length}`;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/queueSummary.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/input/queueSummary.ts electron-agent/src/features/chat/input/queueSummary.test.ts
git commit -m "feat: format the collapsed composer queue label"
```

---

### 任务 3：拖拽落点

**文件：**
- 创建：`electron-agent/src/features/chat/input/queueDrop.ts`
- 测试：`electron-agent/src/features/chat/input/queueDrop.test.ts`

`beforeId` 为 `null` 表示放到队尾，和 `moveComposerItem` 一致。

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { queueDropBeforeId } from './queueDrop';

const rows = [
  { id: 'a', top: 0, bottom: 20 },
  { id: 'b', top: 20, bottom: 40 },
];

describe('queueDropBeforeId', () => {
  it('指针在某行上半段时插到该行前面', () => {
    expect(queueDropBeforeId(rows, 'a', 25)).toBe('b');
  });

  it('指针低于所有其他行时返回 null', () => {
    expect(queueDropBeforeId(rows, 'b', 30)).toBeNull();
  });

  it('忽略正在拖的那一行', () => {
    expect(queueDropBeforeId(rows, 'b', 5)).toBe('a');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/queueDrop.test.ts`

预期：FAIL，找不到 `./queueDrop`。

- [ ] **步骤 3：编写最少实现代码**

```ts
export function queueDropBeforeId(
  rows: readonly { id: string; top: number; bottom: number }[],
  draggingId: string,
  clientY: number,
): string | null {
  const others = rows.filter((row) => row.id !== draggingId);
  const hit = others.find((row) => clientY < (row.top + row.bottom) / 2);
  return hit?.id ?? null;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/queueDrop.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/input/queueDrop.ts electron-agent/src/features/chat/input/queueDrop.test.ts
git commit -m "feat: resolve the composer queue drop target"
```

---

### 任务 4：顶帽外壳和顺序

**文件：**
- 修改：`electron-agent/src/features/chat/input/dockCard.ts`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.tsx`
- 测试：`electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx`

现有测试 `keeps the goal pill in the dock` 和 `keeps the steer queue in the dock` 继续成立。本任务只加顺序，不改 `GoalPill` 的完成态，也不改 `TodoDock` 的收起逻辑。

- [ ] **步骤 1：编写失败的测试**

在 `MessageEditor.test.tsx` 追加：

```tsx
it('stacks queue, tasks, then goal inside the dock', async () => {
  useGoalStore.getState().setSnapshot('session-a', snapshot);
  agentState.composerQueue = [{ id: 'cq-1', text: '先改测试' }];
  render(<MessageEditor leftActions={[]} rightActions={[]} />);

  const dock = await screen.findByTestId('composer-dock');
  const queue = await screen.findByTestId('steer-queue');
  const goal = await screen.findByTestId('goal-pill');
  expect(queue.compareDocumentPosition(goal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(dock.contains(queue)).toBe(true);
  expect(dock.contains(goal)).toBe(true);
  expect(dock.compareDocumentPosition(screen.getByTestId('composer-surface')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
```

这个测试在改顺序之前会失败：现在的 DOM 是目标在排队前面。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/MessageEditor.test.tsx`

预期：FAIL，新测试里目标出现在排队前面。

- [ ] **步骤 3：编写最少实现代码**

`dockCard.ts` 的 `card` 样式保持不变。三个使用处的根节点加上 `data-dock-card=""`：

- `GoalPill.tsx` 里 `className={dockCard.card}` 的那层 `div`
- `TodoDock.tsx` 里 `data-testid="todo-dock"` 的那层 `div`
- `SteerQueue.tsx` 里每个 `data-testid={\`composer-queue-item-${item.id}\`}` 的那层 `div`

`MessageEditor.tsx` 把 dock 子节点改成：

```tsx
<div data-testid="composer-dock" className={styles.dock}>
  <SteerQueue />
  <TodoDockFromStore />
  <GoalPill onOpenDetails={(snapshot: GoalSnapshot) => setGoalDrawerSessionId(snapshot.sessionId)} />
</div>
```

把 `styles.dock` 换成：

```ts
dock: css`
  display: flex;
  flex-direction: column;
  margin-bottom: -1px;

  border: 1px solid ${cssVar.colorBorderSecondary};
  border-bottom: none;
  border-radius: ${cssVar.borderRadiusLG} ${cssVar.borderRadiusLG} 0 0;

  background: ${cssVar.colorBgElevated};

  &:empty {
    display: none;
    margin: 0;
    border: none;
  }

  [data-dock-card] {
    border: none;
    border-radius: 0;
    background: transparent;
  }

  [data-dock-card] + [data-dock-card] {
    border-top: 1px solid ${cssVar.colorBorderSecondary};
  }
`,
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/MessageEditor.test.tsx src/features/chat/input/GoalPill.test.tsx src/features/chat/input/TodoDock.test.tsx src/features/chat/input/SteerQueue.test.tsx`

预期：PASS。`SteerQueue` 现有测试仍能看到「跟进」和正文，因为收起行为在下一任务才加。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/input/dockCard.ts electron-agent/src/features/chat/input/GoalPill.tsx electron-agent/src/features/chat/input/TodoDock.tsx electron-agent/src/features/chat/input/SteerQueue.tsx electron-agent/src/features/chat/input/editor/MessageEditor.tsx electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx
git commit -m "feat: stack the composer dock as one cap"
```

`dockCard.ts` 如果这一步没有改到文件内容，不要把它加进 commit。

---

### 任务 5：排队收起和展开

**文件：**
- 修改：`electron-agent/src/features/chat/input/SteerQueue.tsx`
- 测试：`electron-agent/src/features/chat/input/SteerQueue.test.tsx`

- [ ] **步骤 1：改写会失败的现有断言，并补上新测试**

`渲染跟进条和三个操作` 改成：默认只看见标题，看不见正文和三个按钮。追加：

```tsx
it('收起时显示条数和第一条原文', () => {
  agentState.composerQueue = [
    { id: 'cq-1', text: '先改测试' },
    { id: 'cq-2', text: '第二条' },
  ];
  render(<SteerQueue />);
  const header = screen.getByRole('button', { name: /排队/ });
  expect(header.textContent).toBe('排队 · 2 · 先改测试');
  expect(header).toHaveAttribute('title', '先改测试');
  expect(screen.queryByText('第二条')).toBeNull();
});

it('第一条没有文字时标题只有条数', () => {
  agentState.composerQueue = [{ id: 'cq-1', text: '   ' }];
  render(<SteerQueue />);
  expect(screen.getByRole('button', { name: '排队 · 1' }).textContent).toBe('排队 · 1');
});

it('点标题才展开每条跟进', () => {
  render(<SteerQueue />);
  expect(screen.queryByRole('button', { name: '发送引导' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /排队/ }));
  expect(screen.getByText('先别再测了')).toBeTruthy();
  expect(screen.getByRole('button', { name: '发送引导' })).toBeTruthy();
});
```

`点发送引导` 和 `点删除这条` 两则现有测试，在点击操作前先 `fireEvent.click(screen.getByRole('button', { name: /排队/ }))`。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/SteerQueue.test.tsx`

预期：FAIL，现在一渲染就露出正文，没有「排队 ·」标题按钮。

- [ ] **步骤 3：编写最少实现代码**

`SteerQueue` 增加 `const [expanded, setExpanded] = useState(false)`。根节点：

```tsx
<div className={styles.wrap} data-testid="steer-queue" data-cap-layer="">
  <button
    type="button"
    className={styles.header}
    title={queue[0]?.text.trim() || undefined}
    aria-expanded={expanded}
    onClick={() => setExpanded((value) => !value)}
  >
    {queueSummaryLabel(queue)}
  </button>
  {expanded
    ? queue.map((item) => (
        <div className={styles.card} data-dock-card="" data-testid={`composer-queue-item-${item.id}`} key={item.id}>
          {/* 现有 head / 正文 / 编辑框原样放这里 */}
        </div>
      ))
    : null}
</div>
```

删掉每条上的 `dockCard.card`。标题 `styles.header`：横向、13px、单行省略、按钮重置边框和背景，铺满一行，左右 padding 与现在卡片的 `6px 12px` 一致。

展开后标题仍调用 `queueSummaryLabel(queue)`，不要换成别的文案。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/SteerQueue.test.tsx src/features/chat/input/editor/MessageEditor.test.tsx`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/input/SteerQueue.tsx electron-agent/src/features/chat/input/SteerQueue.test.tsx
git commit -m "feat: collapse the composer queue until it is opened"
```

---

### 任务 6：手柄排序

**文件：**
- 修改：`electron-agent/src/features/chat/input/SteerQueue.tsx`
- 测试：`electron-agent/src/features/chat/input/SteerQueue.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
it('拖动手柄交换两条顺序', () => {
  agentState.composerQueue = [
    { id: 'cq-1', text: '先改测试' },
    { id: 'cq-2', text: '第二条' },
  ];
  render(<SteerQueue />);
  fireEvent.click(screen.getByRole('button', { name: /排队/ }));
  const rows = screen.getAllByTestId(/composer-queue-item-/);
  rows[0]!.getBoundingClientRect = () => ({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: 0, toJSON() { return {}; } });
  rows[1]!.getBoundingClientRect = () => ({ top: 20, bottom: 40, left: 0, right: 100, width: 100, height: 20, x: 0, y: 20, toJSON() { return {}; } });
  const handle = screen.getAllByTestId('queue-drag-handle')[0]!;
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 10 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 35 });
  fireEvent.pointerUp(handle, { pointerId: 1, clientY: 35 });
  expect(agentState.composerQueue.map((item) => item.id)).toEqual(['cq-2', 'cq-1']);
});

it('点引导不改变顺序', () => {
  agentState.composerQueue = [
    { id: 'cq-1', text: '先改测试' },
    { id: 'cq-2', text: '第二条' },
  ];
  render(<SteerQueue />);
  fireEvent.click(screen.getByRole('button', { name: /排队/ }));
  fireEvent.click(screen.getAllByRole('button', { name: '发送引导' })[0]!);
  expect(agentState.composerQueue.map((item) => item.id)).toEqual(['cq-1', 'cq-2']);
  expect(steerQueued).toHaveBeenCalledWith('cq-1');
});

it('编辑中的条目被拖走后仍在编辑', () => {
  agentState.composerQueue = [
    { id: 'cq-1', text: '先改测试' },
    { id: 'cq-2', text: '第二条' },
  ];
  render(<SteerQueue />);
  fireEvent.click(screen.getByRole('button', { name: /排队/ }));
  fireEvent.click(screen.getAllByRole('button', { name: '编辑消息' })[0]!);
  const rows = screen.getAllByTestId(/composer-queue-item-/);
  rows[0]!.getBoundingClientRect = () => ({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: 0, toJSON() { return {}; } });
  rows[1]!.getBoundingClientRect = () => ({ top: 20, bottom: 40, left: 0, right: 100, width: 100, height: 20, x: 0, y: 20, toJSON() { return {}; } });
  const handle = screen.getAllByTestId('queue-drag-handle')[0]!;
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 10 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 35 });
  fireEvent.pointerUp(handle, { pointerId: 1, clientY: 35 });
  expect(screen.getByLabelText('编辑跟进')).toBeTruthy();
  expect(agentState.composerQueue.map((item) => item.id)).toEqual(['cq-2', 'cq-1']);
});
```

```tsx
it('拖拽过程中条目被删掉后不写回顺序', () => {
  agentState.composerQueue = [
    { id: 'cq-1', text: '先改测试' },
    { id: 'cq-2', text: '第二条' },
  ];
  const { rerender } = render(<SteerQueue />);
  fireEvent.click(screen.getByRole('button', { name: /排队/ }));
  const handle = screen.getAllByTestId('queue-drag-handle')[0]!;
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 10 });
  agentState.composerQueue = [{ id: 'cq-2', text: '第二条' }];
  rerender(<SteerQueue />);
  fireEvent.pointerUp(handle, { pointerId: 1, clientY: 35 });
  expect(agentState.composerQueue.map((item) => item.id)).toEqual(['cq-2']);
});
```

`SteerQueue.test.tsx` 的 `useStore` mock 要补上 `getState: () => agentState`，否则抬起时读不到当前队列。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/SteerQueue.test.tsx`

预期：FAIL，找不到 `queue-drag-handle`。

- [ ] **步骤 3：编写最少实现代码**

把现在的 `GripVertical` 图标换成按钮：

```tsx
<button
  type="button"
  data-testid="queue-drag-handle"
  aria-label="拖拽排序"
  className={styles.grip}
  onPointerDown={(event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const pointerId = event.pointerId;
    const draggingId = item.id;
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      window.removeEventListener('pointerup', onUp);
      const current = useStore.getState().composerQueue ?? [];
      if (!current.some((entry) => entry.id === draggingId)) return;
      const rects = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="composer-queue-item-"]')).map((node) => {
        const box = node.getBoundingClientRect();
        return { id: node.dataset.queueId ?? '', top: box.top, bottom: box.bottom };
      });
      const beforeId = queueDropBeforeId(rects, draggingId, up.clientY);
      useStore.setState((s) => ({
        composerQueue: moveComposerItem(s.composerQueue ?? [], draggingId, beforeId),
      }));
    };
    window.addEventListener('pointerup', onUp);
  }}
>
  <Icon icon={GripVertical} size={14} />
</button>
```

每一行根节点加上 `data-queue-id={item.id}`。`styles.grip` 改成无边框按钮，颜色仍用 `colorTextQuaternary`。引导、编辑、删除不要放在这个按钮里。

抬起时如果 `draggingId` 不在当前队列，函数直接 return，不调用 `moveComposerItem`。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/SteerQueue.test.tsx src/features/chat/input/composerQueue.test.ts src/features/chat/input/queueDrop.test.ts src/features/chat/input/editor/MessageEditor.test.tsx`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/input/SteerQueue.tsx electron-agent/src/features/chat/input/SteerQueue.test.tsx
git commit -m "feat: reorder composer follow-ups from the drag handle"
```

---

## 规格覆盖

| 规格 | 任务 |
| --- | --- |
| 顺序：排队、任务、目标 | 任务 4 |
| 1px 负边距，去掉每层自己的边框 | 任务 4 |
| 空层不占行，全空不出现顶帽 | 任务 4（子组件返回 null，dock 的 `:empty`） |
| 收起标题 `排队 · n · 第一条` | 任务 2、任务 5 |
| 展开后每条一行，标题不变 | 任务 5 |
| 只有手柄能拖，按钮不改顺序 | 任务 6 |
| `moveComposerItem` 与丢失条目不写回 | 任务 1、任务 6 |
| 编辑跟着 id | 任务 6 |
| 任务收起和目标完成态不动 | 任务 4 明确不改这两处逻辑 |
| 不改工作区、附件、正文、底栏 | 没有对应任务 |
