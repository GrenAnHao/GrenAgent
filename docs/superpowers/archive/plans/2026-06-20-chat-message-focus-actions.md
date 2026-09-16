# 对话焦点气泡功能卡片（消息操作栏）实现计划 — Phase 1

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给 `tauri-agent` 对话消息加上 hover/focus 浮现的「焦点气泡」操作栏——用户气泡 = 复制(可用)/编辑/重新生成/删除(占位)，助手 = 复制(可用)。

**架构：** 新增 `features/chat/messageActions/` 模块（声明式 slot → `ActionIcon` 条 + antd `Dropdown` 溢出菜单，镜像 lobehub `MessageActionBar` 但精简）；`ChatItemShell` 加 hover 显隐的 actions 槽；`UserMessage` / `TurnTimeline` 各自挂栏。复制用 `navigator.clipboard.writeText` + antd `App.useApp().message`。编辑/重生/删除本期 `disabled` 占位，Phase 2 接 pi fork。

**技术栈：** React 19、TypeScript、`@lobehub/ui`（ActionIcon/Flexbox）、antd v6（App/Dropdown）、antd-style（createStaticStyles）、lucide-react、vitest 4 + @testing-library/react。

**规格：** `docs/superpowers/specs/2026-06-20-chat-message-focus-actions-design.md`

**测试命令（均在 `tauri-agent/` 目录执行）：** `pnpm exec vitest run <文件路径>`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `tauri-agent/src/features/chat/messageActions/types.ts` | 类型：`MessageActionContext` / `MessageActionSlot` / `MessageActionItem` / `Notify` |
| `tauri-agent/src/features/chat/messageActions/slots.tsx` | 纯函数 `buildActionItem(slot, ctx, notify)`：copy 真实现，edit/regenerate/del disabled 占位 |
| `tauri-agent/src/features/chat/messageActions/MessageActionBar.tsx` | 组件：bar → ActionIcon 条；menu → Dropdown 溢出菜单 |
| `tauri-agent/src/features/chat/messageActions/slots.test.ts` | slot builder 单测 |
| `tauri-agent/src/features/chat/messageActions/MessageActionBar.test.tsx` | 组件单测 |
| `tauri-agent/src/features/chat/ChatItemShell.tsx`（改） | 新增 `actions?: ReactNode` 槽 |
| `tauri-agent/src/features/chat/chatStyles.ts`（改） | actions 行样式 + `.item:hover/.focus-within` 显隐 |
| `tauri-agent/src/features/chat/UserMessage.tsx`（改） | 挂用户 bar+menu（文本非空时） |
| `tauri-agent/src/features/chat/TurnTimeline.tsx`（改） | 助手末尾挂 copy（text 段非空时） |

---

## 任务 1：类型 + slot builder

**文件：**
- 创建：`tauri-agent/src/features/chat/messageActions/types.ts`
- 创建：`tauri-agent/src/features/chat/messageActions/slots.tsx`
- 测试：`tauri-agent/src/features/chat/messageActions/slots.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `tauri-agent/src/features/chat/messageActions/slots.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildActionItem } from './slots';
import type { MessageActionContext } from './types';

const ctx: MessageActionContext = { role: 'user', text: '你好世界' };

describe('buildActionItem', () => {
  it('copy 可用且点击写剪贴板并提示', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const success = vi.fn();

    const item = buildActionItem('copy', ctx, { success });
    expect(item.key).toBe('copy');
    expect(item.disabled).toBeFalsy();
    expect(item.onClick).toBeTypeOf('function');

    await item.onClick!();
    expect(writeText).toHaveBeenCalledWith('你好世界');
    expect(success).toHaveBeenCalledWith('已复制');
  });

  it('edit / regenerate / del 为 disabled 占位且无 onClick', () => {
    for (const slot of ['edit', 'regenerate', 'del'] as const) {
      const item = buildActionItem(slot, ctx, { success: vi.fn() });
      expect(item.disabled).toBe(true);
      expect(item.onClick).toBeUndefined();
      expect(item.label).toContain('即将支持');
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/features/chat/messageActions/slots.test.ts`
预期：FAIL，报错 `Failed to resolve import './slots'`（模块尚不存在）。

- [ ] **步骤 3：编写最少实现代码**

创建 `tauri-agent/src/features/chat/messageActions/types.ts`：

```ts
import type { LucideIcon } from 'lucide-react';

export type MessageRole = 'user' | 'assistant';

/** 动作运行时上下文。Phase 2 再加 entryId。 */
export interface MessageActionContext {
  role: MessageRole;
  text: string;
}

/** 轻量提示句柄（解耦 antd MessageInstance，便于测试）。 */
export interface Notify {
  success: (content: string) => void;
}

/** bar / menu 里的槽位 key。'divider' 仅用于菜单分隔。 */
export type MessageActionSlot = 'copy' | 'edit' | 'regenerate' | 'del' | 'divider';
export type MessageActionKey = Exclude<MessageActionSlot, 'divider'>;

export interface MessageActionItem {
  key: MessageActionKey;
  icon: LucideIcon;
  label: string;
  onClick?: () => void | Promise<void>;
  disabled?: boolean;
  danger?: boolean;
}
```

创建 `tauri-agent/src/features/chat/messageActions/slots.tsx`：

```tsx
import { Copy, PencilLine, RotateCcw, Trash2 } from 'lucide-react';
import type { MessageActionContext, MessageActionItem, MessageActionKey, Notify } from './types';

const SOON = '即将支持';

/**
 * 解析单个 slot → 动作项。copy 为真实现（写剪贴板 + 提示）；
 * edit/regenerate/del 为 disabled 占位（Phase 2 接 pi fork 后填 onClick）。
 * 纯函数（不含 hook），notify 由调用方传入，便于单测。
 */
export function buildActionItem(
  slot: MessageActionKey,
  ctx: MessageActionContext,
  notify: Notify,
): MessageActionItem {
  switch (slot) {
    case 'copy':
      return {
        key: 'copy',
        icon: Copy,
        label: '复制',
        onClick: async () => {
          await navigator.clipboard?.writeText(ctx.text);
          notify.success('已复制');
        },
      };
    case 'edit':
      return { key: 'edit', icon: PencilLine, label: `编辑（${SOON}）`, disabled: true };
    case 'regenerate':
      return { key: 'regenerate', icon: RotateCcw, label: `重新生成（${SOON}）`, disabled: true };
    case 'del':
      return { key: 'del', icon: Trash2, label: `删除（${SOON}）`, disabled: true, danger: true };
  }
}
```

> 备注：若 `lucide-react` 当前版本未导出 `LucideIcon` 类型，将 `types.ts` 的 `icon` 改为 `import type { ComponentType } from 'react'; icon: ComponentType<{ size?: number | string }>`。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run src/features/chat/messageActions/slots.test.ts`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/messageActions/types.ts tauri-agent/src/features/chat/messageActions/slots.tsx tauri-agent/src/features/chat/messageActions/slots.test.ts
git commit -m "feat(chat-actions): 消息操作 slot 类型与 builder（copy 实现 + 占位）"
```

---

## 任务 2：MessageActionBar 组件

**文件：**
- 创建：`tauri-agent/src/features/chat/messageActions/MessageActionBar.tsx`
- 测试：`tauri-agent/src/features/chat/messageActions/MessageActionBar.test.tsx`

- [ ] **步骤 1：编写失败的测试**

创建 `tauri-agent/src/features/chat/messageActions/MessageActionBar.test.tsx`：

```tsx
import { describe, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { render, screen } from '@testing-library/react';
import { MessageActionBar } from './MessageActionBar';

function renderBar() {
  return render(
    <App>
      <MessageActionBar
        ctx={{ role: 'user', text: 'hello' }}
        bar={['regenerate', 'edit', 'copy']}
        menu={['edit', 'copy', 'divider', 'regenerate', 'del']}
      />
    </App>,
  );
}

describe('MessageActionBar', () => {
  it('bar 渲染三个图标按钮 + 更多按钮', () => {
    renderBar();
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /编辑/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /重新生成/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '更多' })).toBeTruthy();
  });

  it('点击复制写剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderBar();
    screen.getByRole('button', { name: '复制' }).click();
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('编辑按钮 disabled', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /编辑/ })).toHaveProperty('disabled', true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/features/chat/messageActions/MessageActionBar.test.tsx`
预期：FAIL，报错 `Failed to resolve import './MessageActionBar'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `tauri-agent/src/features/chat/messageActions/MessageActionBar.tsx`：

```tsx
import { memo } from 'react';
import { createElement } from 'react';
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { App, Dropdown, type MenuProps } from 'antd';
import { MoreHorizontal } from 'lucide-react';
import { buildActionItem } from './slots';
import type { MessageActionContext, MessageActionSlot } from './types';

interface MessageActionBarProps {
  ctx: MessageActionContext;
  /** 常驻图标条的槽位（按显示顺序）。 */
  bar: MessageActionSlot[];
  /** `...` 溢出菜单的槽位；省略则不渲染更多按钮。 */
  menu?: MessageActionSlot[];
}

/** 通用消息操作栏：声明式 slot → ActionIcon 条 + Dropdown 溢出菜单。 */
export const MessageActionBar = memo<MessageActionBarProps>(({ ctx, bar, menu }) => {
  const { message } = App.useApp();
  const notify = { success: (c: string) => message.success(c) };

  const menuItems: MenuProps['items'] = menu?.map((slot, i) => {
    if (slot === 'divider') return { type: 'divider', key: `divider-${i}` };
    const it = buildActionItem(slot, ctx, notify);
    return {
      key: it.key,
      label: it.label,
      icon: createElement(it.icon, { size: 14 }),
      disabled: it.disabled,
      danger: it.danger,
      onClick: it.onClick,
    };
  });

  return (
    <Flexbox horizontal align="center" gap={2} role="menubar">
      {bar
        .filter((slot): slot is Exclude<MessageActionSlot, 'divider'> => slot !== 'divider')
        .map((slot) => {
          const it = buildActionItem(slot, ctx, notify);
          return (
            <ActionIcon
              key={it.key}
              icon={it.icon}
              size="small"
              title={it.label}
              disabled={it.disabled}
              onClick={it.onClick}
            />
          );
        })}
      {menuItems && menuItems.length > 0 && (
        <Dropdown menu={{ items: menuItems }} trigger={['click']}>
          <ActionIcon icon={MoreHorizontal} size="small" title="更多" />
        </Dropdown>
      )}
    </Flexbox>
  );
});

MessageActionBar.displayName = 'MessageActionBar';
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run src/features/chat/messageActions/MessageActionBar.test.tsx`
预期：PASS（3 passed）。

> 若 `ActionIcon` 不支持 `title` 生成可访问名（`getByRole name` 找不到按钮），改用 `aria-label={it.label}`；若不支持 `disabled`，用 `<span style={{ opacity: .4, pointerEvents: 'none' }}>` 包裹。运行测试确认后再继续。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/messageActions/MessageActionBar.tsx tauri-agent/src/features/chat/messageActions/MessageActionBar.test.tsx
git commit -m "feat(chat-actions): MessageActionBar 组件（图标条 + 溢出菜单）"
```

---

## 任务 3：ChatItemShell actions 槽 + hover 显隐样式

**文件：**
- 修改：`tauri-agent/src/features/chat/chatStyles.ts`
- 修改：`tauri-agent/src/features/chat/ChatItemShell.tsx`
- 测试：`tauri-agent/src/features/chat/ChatItemShell.test.tsx`（已存在，追加用例）

- [ ] **步骤 1：编写失败的测试**

在 `tauri-agent/src/features/chat/ChatItemShell.test.tsx` 追加：

```tsx
import { render } from '@testing-library/react';
import { ChatItemShell } from './ChatItemShell';

it('actions 渲染在 .chat-actions 容器内', () => {
  const { container } = render(
    <ChatItemShell placement="right" bubble actions={<button>复制</button>}>
      正文
    </ChatItemShell>,
  );
  const actions = container.querySelector('.chat-actions');
  expect(actions).not.toBeNull();
  expect(actions!.textContent).toContain('复制');
});

it('无 actions 时不渲染 .chat-actions', () => {
  const { container } = render(
    <ChatItemShell placement="left">正文</ChatItemShell>,
  );
  expect(container.querySelector('.chat-actions')).toBeNull();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/features/chat/ChatItemShell.test.tsx`
预期：FAIL（`.chat-actions` 为 null —— actions 槽尚未实现）。

- [ ] **步骤 3：编写最少实现代码**

修改 `tauri-agent/src/features/chat/chatStyles.ts`，在 `item` 的 css 末尾加显隐规则，并新增 `actions` / `actionsLeft` / `actionsRight`：

```ts
  item: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-block: 8px;
    max-width: 100%;
    content-visibility: auto;
    contain-intrinsic-size: auto 64px;

    &:hover .chat-actions,
    &:focus-within .chat-actions {
      opacity: 1;
    }
  `,
```

并在样式对象中追加（与 `bubble` 同级）：

```ts
  actions: css`
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 28px;
    opacity: 0;
    transition: opacity 0.2s ease;
  `,
  actionsRight: css`
    align-self: flex-end;
  `,
  actionsLeft: css`
    align-self: flex-start;
  `,
```

修改 `tauri-agent/src/features/chat/ChatItemShell.tsx`：

```tsx
import { memo, type ReactNode } from 'react';
import { cx } from 'antd-style';
import { chatStyles } from './chatStyles';

interface ChatItemShellProps {
  /** 'left' = 助手（全宽 ContentBlock 栈），'right' = 用户（右对齐气泡）。 */
  placement: 'left' | 'right';
  /** 用气泡包裹内容（用户消息）。助手消息不包气泡。 */
  bubble?: boolean;
  /** hover/focus 才浮现的操作栏（焦点气泡）。预留固定高度，避免显隐跳动。 */
  actions?: ReactNode;
  children: ReactNode;
}

/** 自研无头像消息外壳：对齐 lobehub 间距（gap 8 / paddingBlock 8 / 用户 paddingInlineStart 36）。 */
function ChatItemShellInner({ placement, bubble, actions, children }: ChatItemShellProps) {
  const isUser = placement === 'right';
  return (
    <div className={cx(chatStyles.item, isUser && chatStyles.itemUser)}>
      <div className={cx(chatStyles.body, !isUser && chatStyles.bodyAssistant)}>
        {bubble ? <div className={chatStyles.bubble}>{children}</div> : children}
        {actions ? (
          <div
            className={cx(
              'chat-actions',
              chatStyles.actions,
              isUser ? chatStyles.actionsRight : chatStyles.actionsLeft,
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const ChatItemShell = memo(ChatItemShellInner);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run src/features/chat/ChatItemShell.test.tsx`
预期：PASS（含新增 2 用例 + 原有用例）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/chatStyles.ts tauri-agent/src/features/chat/ChatItemShell.tsx tauri-agent/src/features/chat/ChatItemShell.test.tsx
git commit -m "feat(chat-actions): ChatItemShell 增加 hover 显隐的 actions 槽"
```

---

## 任务 4：UserMessage 接入用户操作栏

**文件：**
- 修改：`tauri-agent/src/features/chat/UserMessage.tsx`
- 测试：`tauri-agent/src/features/chat/UserMessage.test.tsx`（已存在，追加用例）

- [ ] **步骤 1：编写失败的测试**

在 `tauri-agent/src/features/chat/UserMessage.test.tsx` 追加（注意需用 antd `App` 包裹，因 MessageActionBar 用了 `App.useApp()`）：

```tsx
import { App } from 'antd';
import { render, screen } from '@testing-library/react';
import { UserMessage } from './UserMessage';

it('有文本时渲染复制按钮与更多菜单', () => {
  render(
    <App>
      <UserMessage text="继续搜索上周的" />
    </App>,
  );
  expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '更多' })).toBeTruthy();
});

it('纯图片无文本时不渲染操作栏', () => {
  const { container } = render(
    <App>
      <UserMessage text="" images={[{ mimeType: 'image/png', data: 'AAAA' }]} />
    </App>,
  );
  expect(container.querySelector('.chat-actions')).toBeNull();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/features/chat/UserMessage.test.tsx`
预期：FAIL（找不到「复制」按钮 —— 尚未挂栏）。

- [ ] **步骤 3：编写最少实现代码**

修改 `tauri-agent/src/features/chat/UserMessage.tsx`：在顶部加导入，并把 `ChatItemShell` 改为传入 `actions`（仅在 `bodyText` 非空时）。

导入区追加：

```tsx
import { MessageActionBar } from './messageActions/MessageActionBar';
import type { MessageActionContext } from './messageActions/types';
```

把 `return (` 之前组织出 ctx + actions，并把 `<ChatItemShell ...>` 那行替换为带 `actions` 的版本：

```tsx
  const actions = bodyText
    ? (() => {
        const ctx: MessageActionContext = { role: 'user', text: bodyText };
        return (
          <MessageActionBar
            ctx={ctx}
            bar={['regenerate', 'edit', 'copy']}
            menu={['edit', 'copy', 'divider', 'regenerate', 'del']}
          />
        );
      })()
    : undefined;

  return (
    <ChatItemShell placement="right" bubble={false} actions={actions}>
      <div className={styles.col}>
        {/* ...原有内容不变... */}
      </div>
    </ChatItemShell>
  );
```

> 仅改 `ChatItemShell` 开标签（加 `actions={actions}`）与新增上面 `const actions`；`styles.col` 内部结构保持不变。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run src/features/chat/UserMessage.test.tsx`
预期：PASS（含新增 2 用例 + 原有用例）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/UserMessage.tsx tauri-agent/src/features/chat/UserMessage.test.tsx
git commit -m "feat(chat-actions): 用户气泡接入焦点操作栏（复制可用，其余占位）"
```

---

## 任务 5：TurnTimeline 接入助手复制

**文件：**
- 修改：`tauri-agent/src/features/chat/TurnTimeline.tsx`
- 测试：`tauri-agent/src/features/chat/TurnTimeline.test.tsx`（新建）

- [ ] **步骤 1：编写失败的测试**

创建 `tauri-agent/src/features/chat/TurnTimeline.test.tsx`：

```tsx
import { describe, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { render, screen } from '@testing-library/react';
import { TurnTimeline } from './TurnTimeline';
import type { TimelineSegment } from './groupMessages';

const textTurn: TimelineSegment[] = [
  { kind: 'text', id: 't1', content: '答案正文', streaming: false },
];
const toolOnly: TimelineSegment[] = [
  { kind: 'tool', id: 'x1', toolCallId: 'c1', toolName: 'read', args: {}, result: {}, status: 'done' },
];

describe('TurnTimeline 助手复制', () => {
  it('有正文时渲染复制按钮并复制拼接文本', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <App>
        <TurnTimeline segments={textTurn} />
      </App>,
    );
    const btn = screen.getByRole('button', { name: '复制' });
    btn.click();
    expect(writeText).toHaveBeenCalledWith('答案正文');
  });

  it('仅工具无正文时不渲染复制', () => {
    const { container } = render(
      <App>
        <TurnTimeline segments={toolOnly} />
      </App>,
    );
    expect(container.querySelector('.chat-actions')).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/features/chat/TurnTimeline.test.tsx`
预期：FAIL（找不到「复制」按钮）。

- [ ] **步骤 3：编写最少实现代码**

修改 `tauri-agent/src/features/chat/TurnTimeline.tsx`：导入栏组件、计算 text、把 `<ChatItemShell placement="left">` 改为带 `actions`。

导入区追加：

```tsx
import { MessageActionBar } from './messageActions/MessageActionBar';
```

在 `TurnTimeline` 函数体内、`return` 之前：

```tsx
  const text = segments
    .map((s) => (s.kind === 'text' ? s.content : ''))
    .join('\n')
    .trim();
  const actions = text ? (
    <MessageActionBar ctx={{ role: 'assistant', text }} bar={['copy']} />
  ) : undefined;
```

并把 `return (` 内的外壳标签改为：

```tsx
    <ChatItemShell placement="left" actions={actions}>
      {rows.map((row) =>
        row.kind === 'context' ? (
          <Suspense key={row.id} fallback={null}>
            <ContextToolGroup tools={row.tools} />
          </Suspense>
        ) : (
          <MemoSegment key={row.id} segment={row.segment} />
        ),
      )}
    </ChatItemShell>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run src/features/chat/TurnTimeline.test.tsx`
预期：PASS（2 passed）。

- [ ] **步骤 5：回归 + 类型检查**

运行：`pnpm exec vitest run src/features/chat` 与 `pnpm exec tsc --noEmit`
预期：chat 目录全部 PASS；tsc 无新增报错。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/chat/TurnTimeline.tsx tauri-agent/src/features/chat/TurnTimeline.test.tsx
git commit -m "feat(chat-actions): 助手回合末尾接入复制操作"
```

---

## 自检

**1. 规格覆盖度（对照 spec 各节）：**
- 4 架构（messageActions 模块 / slot）→ 任务 1、2。
- 5.1 ChatItemShell actions 槽 + 预留高度 → 任务 3。
- 5.2 chatStyles hover/focus 显隐 → 任务 3。
- 5.3 UserMessage bar=['regenerate','edit','copy'] / menu=['edit','copy','divider','regenerate','del'] → 任务 4。
- 5.4 TurnTimeline 助手仅 copy（text 段拼接）→ 任务 5。
- 6 数据流复制（navigator.clipboard + message.success）→ 任务 1（builder）+ 2（接线）。
- 8 占位策略（edit/regenerate/del disabled）→ 任务 1（disabled 项）。
- 10 测试 → 各任务 TDD + 任务 5 回归。
- 全部覆盖，无遗漏。

**2. 占位符扫描：** 计划内无「待定/TODO/后续实现」；每个代码步骤均有完整代码块；「即将支持」是产品占位文案（用户可见），非计划缺陷。

**3. 类型一致性：** `MessageActionItem.onClick`（任务 1 定义）在任务 2 用作 `it.onClick`；`MessageActionSlot`/`MessageActionKey` 在任务 1、2 一致；`buildActionItem(slot, ctx, notify)` 三参签名在任务 1 定义、任务 2 调用一致；`Notify.success` 在任务 1 定义、任务 2 用 `message.success` 适配——一致。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-20-chat-message-focus-actions.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新子代理，任务间审查，快速迭代（superpowers:subagent-driven-development）。
2. **内联执行** — 当前会话用 superpowers:executing-plans 批量执行并设检查点。

选哪种方式？
