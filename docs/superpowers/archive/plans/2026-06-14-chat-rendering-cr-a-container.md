# CR-A：对话列表容器骨架 + 性能 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 `tauri-agent` 主对话的 `MessageList` 重写为 `ChatListView`，用 `@lobehub/ui/chat/ChatList` 完全包装容器层，落地虚拟滚动 + memo + 流式节流的性能优化。

**架构：** 数据流 `agentStore.messages → useThrottledValue(100ms during streaming) → groupMessages → messageAdapter → <ChatList renderMessages={...}>`。ChatList 接管虚拟滚动 / BackBottom / loading；assistant 角色的自定义 render 把 tool 列表内联在气泡尾部；notice 走 system 角色。保留 `groupMessages` 已落地的分组逻辑；删除自研 ResizeObserver / 自研 BackBottom / scroll handler。

**技术栈：** React 19 + `@lobehub/ui@5.15.13`（`@lobehub/ui/chat` 暴露 `ChatList`） + antd-style + zustand + vitest + @testing-library/react + jsdom。

**对应规格：** `docs/superpowers/specs/2026-06-14-chat-rendering-cr-a-container-design.md`

---

## 文件清单（锁定）

**新增**：
- `tauri-agent/src/features/chat/messageAdapter.ts` — `DisplayMessage[] → LobeChatMessage[]` 的纯函数 adapter
- `tauri-agent/src/features/chat/messageAdapter.test.ts` — 4 种映射 + 孤儿 tool 单测
- `tauri-agent/src/features/chat/ChatListView.tsx` — 替代 `MessageList`，包装 ChatList
- `tauri-agent/src/features/chat/ChatListView.test.tsx` — mock ChatList 验证 renderMessages 调度
- `tauri-agent/src/hooks/useThrottledValue.ts` — 通用 throttle hook，trailing edge + enabled 开关 + 立即同步
- `tauri-agent/src/hooks/useThrottledValue.test.ts` — 节流行为单测

**修改**：
- `tauri-agent/src/features/chat/ChatView.tsx` — 把 `MessageList` 引用换为 `ChatListView`
- `tauri-agent/src/features/chat/AssistantMessage.tsx` — 新增 `tools?` prop + `belowMessage` 渲染 + `React.memo`
- `tauri-agent/src/features/chat/AssistantMessage.test.tsx` — 增加 `tools` prop 测试
- `tauri-agent/src/features/chat/UserMessage.tsx` — `React.memo`
- `tauri-agent/src/features/chat/NoticePill.tsx` — `React.memo`

**退役**：
- `tauri-agent/src/features/chat/MessageList.tsx` — 被 `ChatListView` 完全替代

**保留（不动）**：
- `tauri-agent/src/features/chat/groupMessages.ts` — 被 adapter 调用
- `tauri-agent/src/features/chat/ChatMessageItems.tsx` — 子代理对话仍走旧路径
- `tauri-agent/src/features/chat/Thinking.tsx`、`PreparingIndicator.tsx`、`LazyMarkdown.tsx` — CR-B 接手
- `tauri-agent/src/features/tools/ToolExecution.tsx` — 仅由 `AssistantMessage` 内联调用

---

## 任务 1：messageAdapter（纯函数 + 单测）

**文件：**
- 创建：`tauri-agent/src/features/chat/messageAdapter.ts`
- 测试：`tauri-agent/src/features/chat/messageAdapter.test.ts`

- [ ] **步骤 1.1：编写失败的测试**

`tauri-agent/src/features/chat/messageAdapter.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { toLobeMessages } from './messageAdapter';
import type { DisplayMessage } from './groupMessages';

describe('toLobeMessages', () => {
  it('user → role:user', () => {
    const input: DisplayMessage[] = [{ kind: 'user', id: 'u1', text: 'hi' }];
    const out = toLobeMessages(input);
    expect(out).toEqual([{ id: 'u1', role: 'user', content: 'hi' }]);
  });

  it('assistantGroup → role:assistant + extra.kind=assistantGroup + tools 数组', () => {
    const input: DisplayMessage[] = [
      {
        kind: 'assistantGroup',
        id: 'a1',
        text: 'ok',
        thinking: 'reasoning',
        streaming: false,
        thinkingDuration: 1500,
        tools: [
          { id: 't1', toolCallId: 'tc1', toolName: 'grep', args: { q: 'x' }, result: { hits: 3 }, status: 'done' },
        ],
      },
    ];
    const out = toLobeMessages(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'a1',
      role: 'assistant',
      content: 'ok',
      extra: {
        kind: 'assistantGroup',
        thinking: 'reasoning',
        streaming: false,
        thinkingDuration: 1500,
        tools: [
          { id: 't1', toolCallId: 'tc1', toolName: 'grep', args: { q: 'x' }, result: { hits: 3 }, status: 'done' },
        ],
      },
    });
  });

  it('notice → role:system + extra.kind=notice', () => {
    const input: DisplayMessage[] = [
      { kind: 'notice', id: 'n1', customType: 'knowledge-rag', content: '已注入 3 条' },
    ];
    const out = toLobeMessages(input);
    expect(out[0]).toMatchObject({
      id: 'n1',
      role: 'system',
      content: '已注入 3 条',
      extra: { kind: 'notice', customType: 'knowledge-rag', content: '已注入 3 条' },
    });
  });

  it('孤儿 tool（无前置 assistantGroup）→ role:system + extra.kind=orphanTool', () => {
    const input: DisplayMessage[] = [
      {
        kind: 'tool',
        id: 't9',
        toolCallId: 'tc9',
        toolName: 'orphan',
        args: {},
        result: null,
        status: 'running',
      },
    ];
    const out = toLobeMessages(input);
    expect(out[0]).toMatchObject({
      id: 't9',
      role: 'system',
      content: '',
      extra: { kind: 'orphanTool', toolCallId: 'tc9', toolName: 'orphan', status: 'running' },
    });
  });

  it('混合顺序保留', () => {
    const input: DisplayMessage[] = [
      { kind: 'user', id: 'u1', text: 'hi' },
      { kind: 'notice', id: 'n1', customType: 'x', content: 'y' },
      { kind: 'assistantGroup', id: 'a1', text: 'ok', thinking: '', streaming: false, tools: [] },
    ];
    const out = toLobeMessages(input);
    expect(out.map((m) => m.id)).toEqual(['u1', 'n1', 'a1']);
    expect(out.map((m) => m.role)).toEqual(['user', 'system', 'assistant']);
  });
});
```

- [ ] **步骤 1.2：运行测试验证失败**

运行：`cd tauri-agent && npm run test -- messageAdapter`
预期：FAIL，报错 "Cannot find module './messageAdapter'" 或类似导入错误。

- [ ] **步骤 1.3：写最少实现**

`tauri-agent/src/features/chat/messageAdapter.ts`：

```ts
import type { ChatMessage as LobeChatMessage } from '@lobehub/ui/chat';
import type { DisplayMessage } from './groupMessages';

export interface AssistantGroupExtra {
  kind: 'assistantGroup';
  thinking: string;
  streaming: boolean;
  thinkingDuration?: number;
  tools: Array<{
    id: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    result: unknown;
    status: 'running' | 'done' | 'error';
  }>;
}

export interface NoticeExtra {
  kind: 'notice';
  customType: string;
  content: string;
}

export interface OrphanToolExtra {
  kind: 'orphanTool';
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

export type ChatExtra = AssistantGroupExtra | NoticeExtra | OrphanToolExtra;

export function toLobeMessages(messages: DisplayMessage[]): LobeChatMessage[] {
  return messages.map((msg): LobeChatMessage => {
    switch (msg.kind) {
      case 'user':
        return { id: msg.id, role: 'user', content: msg.text } as LobeChatMessage;
      case 'assistantGroup':
        return {
          id: msg.id,
          role: 'assistant',
          content: msg.text,
          extra: {
            kind: 'assistantGroup',
            thinking: msg.thinking,
            streaming: msg.streaming,
            thinkingDuration: msg.thinkingDuration,
            tools: msg.tools,
          } satisfies AssistantGroupExtra,
        } as LobeChatMessage;
      case 'notice':
        return {
          id: msg.id,
          role: 'system',
          content: msg.content,
          extra: { kind: 'notice', customType: msg.customType, content: msg.content } satisfies NoticeExtra,
        } as LobeChatMessage;
      case 'tool':
        return {
          id: msg.id,
          role: 'system',
          content: '',
          extra: {
            kind: 'orphanTool',
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            args: msg.args,
            result: msg.result,
            status: msg.status,
          } satisfies OrphanToolExtra,
        } as LobeChatMessage;
    }
  });
}
```

注：因 `@lobehub/ui/chat` 的 `ChatMessage` 类型可能不允许任意 `extra` 字段，第一遍用 `as LobeChatMessage` 强转通过。若 ts 报错，则在文件顶部加：`// eslint-disable-next-line @typescript-eslint/consistent-type-assertions`。

- [ ] **步骤 1.4：运行测试验证通过**

运行：`cd tauri-agent && npm run test -- messageAdapter`
预期：PASS，5 个用例全过。

- [ ] **步骤 1.5：Commit**

```bash
cd "D:/OneDrive/Project Files/Pi"
git add tauri-agent/src/features/chat/messageAdapter.ts tauri-agent/src/features/chat/messageAdapter.test.ts
git commit -m "feat(chat): messageAdapter DisplayMessage->LobeChatMessage (CR-A1)"
```

---

## 任务 2：useThrottledValue（hook + 单测）

**文件：**
- 创建：`tauri-agent/src/hooks/useThrottledValue.ts`
- 测试：`tauri-agent/src/hooks/useThrottledValue.test.ts`

- [ ] **步骤 2.1：编写失败的测试**

`tauri-agent/src/hooks/useThrottledValue.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useThrottledValue } from './useThrottledValue';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useThrottledValue', () => {
  it('enabled=false：直接返回最新值（节流关闭）', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useThrottledValue(v, 100, { enabled: false }),
      { initialProps: { v: 'a' } },
    );
    expect(result.current).toBe('a');
    rerender({ v: 'b' });
    expect(result.current).toBe('b');
  });

  it('enabled=true：100ms 内多次更新只在 trailing edge 生效', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useThrottledValue(v, 100, { enabled: true }),
      { initialProps: { v: 'a' } },
    );
    expect(result.current).toBe('a');

    rerender({ v: 'b' });
    rerender({ v: 'c' });
    rerender({ v: 'd' });
    // 还未到 trailing edge
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe('d');
  });

  it('enabled 从 true 切到 false：立即同步最新值', () => {
    const { result, rerender } = renderHook(
      ({ v, enabled }) => useThrottledValue(v, 100, { enabled }),
      { initialProps: { v: 'a', enabled: true } },
    );

    rerender({ v: 'b', enabled: true });
    rerender({ v: 'c', enabled: true });
    expect(result.current).toBe('a');

    rerender({ v: 'c', enabled: false });
    expect(result.current).toBe('c');
  });

  it('默认 enabled=true', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useThrottledValue(v, 100),
      { initialProps: { v: 'a' } },
    );
    rerender({ v: 'b' });
    expect(result.current).toBe('a');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe('b');
  });
});
```

- [ ] **步骤 2.2：运行测试验证失败**

运行：`cd tauri-agent && npm run test -- useThrottledValue`
预期：FAIL，"Cannot find module './useThrottledValue'"。

- [ ] **步骤 2.3：写最少实现**

`tauri-agent/src/hooks/useThrottledValue.ts`：

```ts
import { useEffect, useRef, useState } from 'react';

interface Options {
  enabled?: boolean;
}

export function useThrottledValue<T>(value: T, ms: number, options?: Options): T {
  const enabled = options?.enabled ?? true;
  const [throttled, setThrottled] = useState<T>(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEnabledRef = useRef<boolean>(enabled);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setThrottled(value);
      lastEnabledRef.current = false;
      return;
    }

    // enabled 刚从 false 切回 true：把当前值同步为基线
    if (!lastEnabledRef.current) {
      setThrottled(value);
      lastEnabledRef.current = true;
      return;
    }
    lastEnabledRef.current = true;

    if (timerRef.current) return;

    timerRef.current = setTimeout(() => {
      setThrottled(value);
      timerRef.current = null;
    }, ms);

    return () => {
      // 不在此处清理 timer：清理会破坏 trailing-edge 语义；只有 enabled 变化或卸载时才清
    };
  }, [value, ms, enabled]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return throttled;
}
```

- [ ] **步骤 2.4：运行测试验证通过**

运行：`cd tauri-agent && npm run test -- useThrottledValue`
预期：PASS，4 个用例全过。

> 若 trailing-edge 测试 fail（vi.advanceTimersByTime 推进后 result 未更新），原因通常是 timer 在 effect cleanup 被误清。调整：把 `useRef` 改成只在 `enabled` 变化或卸载时清，保留 trailing setTimeout 完成机会（上面的实现已遵循）。

- [ ] **步骤 2.5：Commit**

```bash
cd "D:/OneDrive/Project Files/Pi"
git add tauri-agent/src/hooks/useThrottledValue.ts tauri-agent/src/hooks/useThrottledValue.test.ts
git commit -m "feat(hooks): useThrottledValue trailing-edge + enabled switch (CR-A2)"
```

---

## 任务 3：AssistantMessage 接受 tools + memo

**文件：**
- 修改：`tauri-agent/src/features/chat/AssistantMessage.tsx`
- 修改：`tauri-agent/src/features/chat/AssistantMessage.test.tsx`

- [ ] **步骤 3.1：补充失败测试**

在 `AssistantMessage.test.tsx` 的 `describe('AssistantMessage thinking 渲染', ...)` 之后追加新 describe：

```tsx
describe('AssistantMessage tools 内联渲染', { timeout: 30_000 }, () => {
  it('提供 tools 时渲染 ToolExecution 列表', async () => {
    renderWithTheme(
      <AssistantMessage
        text="完成"
        thinking=""
        streaming={false}
        tools={[
          {
            id: 't1',
            toolCallId: 'tc1',
            toolName: 'grep_search',
            args: { q: 'foo' },
            result: { hits: 3 },
            status: 'done',
          },
        ]}
      />,
    );
    // ToolExecution 是 lazy 组件，等待 Suspense 解析
    await screen.findByText(/grep_search/i, {}, { timeout: 5000 });
  });

  it('tools 为空数组时不渲染 ToolExecution', () => {
    renderWithTheme(<AssistantMessage text="hi" thinking="" streaming={false} tools={[]} />);
    expect(screen.queryByText(/grep_search/i)).toBeNull();
  });

  it('tools 未提供时不渲染 ToolExecution', () => {
    renderWithTheme(<AssistantMessage text="hi" thinking="" streaming={false} />);
    expect(screen.queryByText(/grep_search/i)).toBeNull();
  });
});
```

- [ ] **步骤 3.2：运行测试验证失败**

运行：`cd tauri-agent && npm run test -- AssistantMessage`
预期：FAIL，新增的 3 个 tools 用例报「Type 'tools' is not assignable」或运行时找不到 ToolExecution。

- [ ] **步骤 3.3：改实现**

替换 `tauri-agent/src/features/chat/AssistantMessage.tsx` 为：

```tsx
import { lazy, memo, Suspense } from 'react';
import { ChatItem } from '@lobehub/ui/chat';
import { Thinking } from './Thinking';

const ToolExecution = lazy(() =>
  import('../tools/ToolExecution').then((m) => ({ default: m.ToolExecution })),
);

export interface AssistantTool {
  id: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

interface AssistantMessageProps {
  text: string;
  thinking: string;
  streaming: boolean;
  thinkingDuration?: number;
  tools?: AssistantTool[];
}

function AssistantMessageInner({
  text,
  thinking,
  streaming,
  thinkingDuration,
  tools,
}: AssistantMessageProps) {
  const reasoning = streaming && !text;
  const hasTools = !!tools && tools.length > 0;

  const messageNode = (
    <>
      {text || (reasoning && !thinking ? '...' : '')}
      {hasTools && (
        <Suspense fallback={null}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBlockStart: 8 }}>
            {tools!.map((t) => (
              <ToolExecution
                key={t.id}
                toolName={t.toolName}
                toolCallId={t.toolCallId}
                args={t.args}
                result={t.result}
                status={t.status}
              />
            ))}
          </div>
        </Suspense>
      )}
    </>
  );

  return (
    <ChatItem
      placement="left"
      variant="docs"
      showAvatar={false}
      fontSize={14}
      loading={streaming && !text && !thinking && !hasTools}
      message={messageNode}
      aboveMessage={
        thinking ? (
          <Thinking content={thinking} thinking={reasoning} duration={thinkingDuration} />
        ) : undefined
      }
    />
  );
}

export const AssistantMessage = memo(AssistantMessageInner);
```

> 设计选择：把 tools 放进 `message` slot 末尾（用 ReactNode 拼接），避免依赖 ChatItem 可能不存在的 `belowMessage` prop（lobe-ui@5.15.13 类型若已支持，可以后续切回 `belowMessage` 做更精细的视觉分隔）。
> 注意：原文件有 `avatar={{ avatar: '🤖', title: 'Assistant' }}` — 本期按用户偏好移除。

- [ ] **步骤 3.4：运行测试验证通过**

运行：`cd tauri-agent && npm run test -- AssistantMessage`
预期：PASS，所有 thinking + tools 用例（3 + 3）全过。

- [ ] **步骤 3.5：Commit**

```bash
cd "D:/OneDrive/Project Files/Pi"
git add tauri-agent/src/features/chat/AssistantMessage.tsx tauri-agent/src/features/chat/AssistantMessage.test.tsx
git commit -m "feat(chat): AssistantMessage accepts tools inline + memo (CR-A3)"
```

---

## 任务 4：UserMessage + NoticePill memo

**文件：**
- 修改：`tauri-agent/src/features/chat/UserMessage.tsx`
- 修改：`tauri-agent/src/features/chat/NoticePill.tsx`

- [ ] **步骤 4.1：改 UserMessage 为 memo**

把 `tauri-agent/src/features/chat/UserMessage.tsx` 改成：

```tsx
import { memo } from 'react';
import { ChatItem } from '@lobehub/ui/chat';

interface UserMessageProps {
  text: string;
}

function UserMessageInner({ text }: UserMessageProps) {
  return (
    <ChatItem
      placement="right"
      showAvatar={false}
      variant="bubble"
      fontSize={14}
      message={text}
    />
  );
}

export const UserMessage = memo(UserMessageInner);
```

> 注：原文件有 `avatar={{ avatar: '🧑', title: 'You' }}` — 按用户偏好移除。

- [ ] **步骤 4.2：改 NoticePill 为 memo**

把 `tauri-agent/src/features/chat/NoticePill.tsx` 末尾的 `export function NoticePill(...)` 改名为 `function NoticePillInner(...)`，并在文件末尾追加：

```tsx
import { memo } from 'react';

export const NoticePill = memo(NoticePillInner);
```

（合并到现有 import 即可，不必新增 import 行）

完整改后：

```tsx
import { Collapse, Flexbox, Icon } from '@lobehub/ui';
import { Sparkles } from 'lucide-react';
import { memo, useState } from 'react';
import { LazyMarkdown } from './LazyMarkdown';

const TITLES: Record<string, string> = {
  'knowledge-rag': '已注入知识库上下文',
  'long-term-memory': '已注入长期记忆',
};

interface NoticePillProps {
  customType: string;
  content: string;
}

function NoticePillInner({ customType, content }: NoticePillProps) {
  const [expanded, setExpanded] = useState(false);
  const title = TITLES[customType] ?? '已注入上下文';

  return (
    <div data-testid="notice-pill" style={{ paddingInlineStart: 4, maxWidth: '100%' }}>
      <Collapse
        variant="borderless"
        gap={4}
        activeKey={expanded ? ['notice'] : []}
        onChange={(keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          setExpanded(arr.includes('notice'));
        }}
        items={[
          {
            key: 'notice',
            label: (
              <Flexbox horizontal align="center" gap={6} style={{ fontSize: 12, color: 'var(--gren-fg-muted, #9aa1ac)' }}>
                <Icon icon={Sparkles} size={13} />
                <span>{title}</span>
              </Flexbox>
            ),
            children: expanded ? <LazyMarkdown>{content}</LazyMarkdown> : null,
          },
        ]}
      />
    </div>
  );
}

export const NoticePill = memo(NoticePillInner);
```

- [ ] **步骤 4.3：运行已有相关测试**

运行：`cd tauri-agent && npm run test -- UserMessage NoticePill`
预期：PASS，已有用例不破坏。

（若 `UserMessage.test.tsx` 或 `NoticePill.test.tsx` 不存在，只跑 `NoticePill.test.tsx` 即可，已知文件存在）

- [ ] **步骤 4.4：跑全量 chat 测试确保无破坏**

运行：`cd tauri-agent && npm run test -- "src/features/chat"`
预期：所有 chat 目录测试 PASS。

- [ ] **步骤 4.5：Commit**

```bash
cd "D:/OneDrive/Project Files/Pi"
git add tauri-agent/src/features/chat/UserMessage.tsx tauri-agent/src/features/chat/NoticePill.tsx
git commit -m "perf(chat): React.memo UserMessage + NoticePill (CR-A4)"
```

---

## 任务 5：ChatListView（新组件 + 集成测试）

**文件：**
- 创建：`tauri-agent/src/features/chat/ChatListView.tsx`
- 创建：`tauri-agent/src/features/chat/ChatListView.test.tsx`

- [ ] **步骤 5.1：编写失败的集成测试**

`tauri-agent/src/features/chat/ChatListView.test.tsx`：

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import type { ChatMessage } from '../../stores/agentReducer';

// vi.mock 会被 vitest hoist 到所有 import 之前
const chatListSpy = vi.fn();
vi.mock('@lobehub/ui/chat', async () => {
  const actual = await vi.importActual<typeof import('@lobehub/ui/chat')>('@lobehub/ui/chat');
  return {
    ...actual,
    ChatList: (props: any) => {
      chatListSpy(props);
      return <div data-testid="mock-chat-list" />;
    },
  };
});

import { ChatListView } from './ChatListView';
import { AgentStoreProvider } from '../../stores/AgentStoreContext';

afterEach(() => {
  cleanup();
  chatListSpy.mockClear();
});

function makeMessages(): ChatMessage[] {
  return [
    { kind: 'user', id: 'u1', text: 'hi' } as ChatMessage,
    {
      kind: 'assistant',
      id: 'a1',
      text: 'ok',
      thinking: '',
      streaming: false,
    } as ChatMessage,
    {
      kind: 'tool',
      id: 't1',
      toolCallId: 'tc1',
      toolName: 'grep',
      args: {},
      result: {},
      status: 'done',
    } as ChatMessage,
    { kind: 'notice', id: 'n1', customType: 'knowledge-rag', content: '已注入 3 条' } as ChatMessage,
  ];
}

describe('ChatListView', () => {
  it('把 store messages 经 group + adapter 后传给 ChatList', () => {
    render(
      <ThemeProvider themeMode="dark">
        <AgentStoreProvider workspace="/test" initialMessages={makeMessages()}>
          <ChatListView />
        </AgentStoreProvider>
      </ThemeProvider>,
    );

    expect(chatListSpy).toHaveBeenCalled();
    const last = chatListSpy.mock.calls.at(-1)![0];
    // group 后：user / assistantGroup(含 tool) / notice = 3 条
    expect(last.data.map((m: any) => m.id)).toEqual(['u1', 'a1', 'n1']);
    expect(last.data.map((m: any) => m.role)).toEqual(['user', 'assistant', 'system']);
    expect(last.data[1].extra.tools).toHaveLength(1);
  });

  it('renderMessages 提供 user / assistant / system 三个分派', () => {
    render(
      <ThemeProvider themeMode="dark">
        <AgentStoreProvider workspace="/test" initialMessages={makeMessages()}>
          <ChatListView />
        </AgentStoreProvider>
      </ThemeProvider>,
    );
    const last = chatListSpy.mock.calls.at(-1)![0];
    expect(typeof last.renderMessages.user).toBe('function');
    expect(typeof last.renderMessages.assistant).toBe('function');
    expect(typeof last.renderMessages.system).toBe('function');
  });
});
```

> 注：若 `AgentStoreProvider` 的实际 props 不支持 `initialMessages`，改为：
> ```tsx
> // 用 minimal mock 替代真实 store
> vi.mock('../../stores/AgentStoreContext', () => {
>   const state = { messages: [...], isStreaming: false };
>   return {
>     useAgentStore: () => ({
>       useStore: (sel: any) => sel(state),
>     }),
>     AgentStoreProvider: ({ children }: any) => <>{children}</>,
>   };
> });
> ```
> 实施时先查 `tauri-agent/src/stores/AgentStoreContext.tsx`（已在 untracked 修改清单），选合适的 mock 方式。

- [ ] **步骤 5.2：运行测试验证失败**

运行：`cd tauri-agent && npm run test -- ChatListView`
预期：FAIL，"Cannot find module './ChatListView'"。

- [ ] **步骤 5.3：写最少实现**

`tauri-agent/src/features/chat/ChatListView.tsx`：

```tsx
import { ChatList } from '@lobehub/ui/chat';
import { useMemo } from 'react';
import { useAgentStore } from '../../stores/AgentStoreContext';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages } from './groupMessages';
import { toLobeMessages, type AssistantGroupExtra, type NoticeExtra, type OrphanToolExtra } from './messageAdapter';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { NoticePill } from './NoticePill';

interface ChatListViewProps {
  bottomOffset?: number;
}

export function ChatListView({ bottomOffset = 88 }: ChatListViewProps) {
  const { useStore } = useAgentStore();
  const messages = useStore((s) => s.messages);
  const isStreaming = useStore((s) => s.isStreaming);

  const throttledMessages = useThrottledValue(messages, 100, { enabled: isStreaming });
  const lobeMessages = useMemo(
    () => toLobeMessages(groupMessages(throttledMessages)),
    [throttledMessages],
  );

  return (
    <ChatList
      data={lobeMessages as any}
      variant="bubble"
      loading={isStreaming}
      style={{ position: 'absolute', inset: 0, paddingBottom: bottomOffset }}
      renderMessages={{
        user: (_default: unknown, item: any) => (
          <UserMessage key={item.id} text={item.content} />
        ),
        assistant: (_default: unknown, item: any) => {
          const extra = item.extra as AssistantGroupExtra;
          return (
            <AssistantMessage
              key={item.id}
              text={item.content}
              thinking={extra.thinking}
              streaming={extra.streaming}
              thinkingDuration={extra.thinkingDuration}
              tools={extra.tools.length > 0 ? extra.tools : undefined}
            />
          );
        },
        system: (_default: unknown, item: any) => {
          const extra = item.extra as NoticeExtra | OrphanToolExtra;
          if (extra?.kind === 'notice') {
            return <NoticePill key={item.id} customType={extra.customType} content={extra.content} />;
          }
          return null;
        },
      } as any}
    />
  );
}
```

> `as any` 用于在不破坏 ChatList 类型导出（其 `renderMessages` 的 signature 可能严格）的前提下传入自定义 extra。若类型严格通过，移除 `as any` 并显式提供 ChatList 期望的 prop 形状。

- [ ] **步骤 5.4：运行测试验证通过**

运行：`cd tauri-agent && npm run test -- ChatListView`
预期：PASS，两个用例都过。

- [ ] **步骤 5.5：Commit**

```bash
cd "D:/OneDrive/Project Files/Pi"
git add tauri-agent/src/features/chat/ChatListView.tsx tauri-agent/src/features/chat/ChatListView.test.tsx
git commit -m "feat(chat): ChatListView wraps ChatList with adapter + throttle (CR-A5)"
```

---

## 任务 6：切换 ChatView + 退役 MessageList

**文件：**
- 修改：`tauri-agent/src/features/chat/ChatView.tsx`
- 删除：`tauri-agent/src/features/chat/MessageList.tsx`

- [ ] **步骤 6.1：把 ChatView 改为引用 ChatListView**

修改 `tauri-agent/src/features/chat/ChatView.tsx` 第 2 行：

把 `import { MessageList } from './MessageList';` 改为 `import { ChatListView } from './ChatListView';`

并把 `<MessageList bottomOffset={inputHeight + 24} />` 改为 `<ChatListView bottomOffset={inputHeight + 24} />`。

完整新 `ChatView.tsx`：

```tsx
import { useState } from 'react';
import { ChatListView } from './ChatListView';
import { ChatInput } from './ChatInput';
import type { PromptImage } from './input/ChatInputContext';
import { pi } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';

export function ChatView() {
  const { workspace, store } = useAgentStoreContext();
  const [inputHeight, setInputHeight] = useState(120);

  const handleSend = async (message: string, images?: PromptImage[]) => {
    const text = message.trim();
    if (!text && !images?.length) return;
    if (text) store.pushUserMessage(text);
    await pi.prompt(workspace, text, undefined, images);
  };

  const handleAbort = async () => {
    await pi.abort(workspace);
  };

  return (
    <div style={{ height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <ChatListView bottomOffset={inputHeight + 24} />
      <ChatInput onSend={handleSend} onAbort={handleAbort} onHeightChange={setInputHeight} />
    </div>
  );
}
```

- [ ] **步骤 6.2：搜索其他引用，确认无残留**

运行：`cd tauri-agent && rg -n "from './MessageList'|from '../MessageList'|from \"./MessageList\"" src/`
预期：除了 `MessageList.tsx` 自身（即将删除）外，**没有其它输出**。

若有遗漏引用（例如 storybook、子代理对话），切换为 `ChatListView` 或在该位置注释保留（明确说明子代理走旧路径，则不动）。

- [ ] **步骤 6.3：删除 MessageList.tsx**

运行：
```bash
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
rm src/features/chat/MessageList.tsx
```

（PowerShell：`Remove-Item "src/features/chat/MessageList.tsx"`）

- [ ] **步骤 6.4：跑全量测试 + build**

运行：
```bash
cd tauri-agent
npm run test -- "src/features/chat"
npm run build
```
预期：测试 PASS，build 成功（tsc 无类型错误，vite build 完成）。

> 若 build fail 说 `messageAdapter.ts` 的 `as LobeChatMessage` 不通过严格检查，按文件顶 eslint disable + ts-expect-error 修复对应行；若类型严格阻塞，把 adapter 返回值类型由 `LobeChatMessage[]` 放宽为 `Array<LobeChatMessage & { extra?: ChatExtra }>`。

- [ ] **步骤 6.5：Commit**

```bash
cd "D:/OneDrive/Project Files/Pi"
git add tauri-agent/src/features/chat/ChatView.tsx
git rm tauri-agent/src/features/chat/MessageList.tsx
git commit -m "refactor(chat): ChatView switches to ChatListView; retire MessageList (CR-A6)"
```

---

## 任务 7：视觉冒烟（截图验证）

**文件：** 无新增代码，仅手动验证 + 写报告。

- [ ] **步骤 7.1：启动 dev**

运行：`cd tauri-agent && npm run dev`

预期：vite 启动成功，控制台无错误，开发服务器地址被打印（一般 `http://localhost:5173` 或类似）。

- [ ] **步骤 7.2：手动 / 浏览器自动化截图验证**

在 1440×900 桌面尺寸下：

1. 启动一个会话，发 3-5 条 user/assistant 交替消息（至少一条触发工具调用）
2. 截图：`docs/superpowers/specs/2026-06-14-chat-rendering-cr-a-screenshot-1440.png`
3. 确认：
   - 消息列表正常滚动
   - assistant 气泡尾部嵌套 ToolExecution 卡片（CR-A3 内联效果）
   - NoticePill 提示条正常折叠/展开
   - BackBottom 按钮在向上滚动后出现（lobe-ui ChatList 内置）
   - 流式响应中不卡顿（节流生效）

在 390×844 移动尺寸下：

1. 同样发几条消息
2. 截图：`docs/superpowers/specs/2026-06-14-chat-rendering-cr-a-screenshot-390.png`
3. 确认：composer 不竖排、消息流不重叠

可用 playwright 自动化（如果项目里已有 e2e setup）；否则手动截图。

- [ ] **步骤 7.3：长对话性能验证（虚拟滚动）**

伪造 1000 条历史消息（通过 store hack 或 mock），观察：

- 列表滚动 60fps 无卡顿
- DOM 内只渲染视口附近 ~20 条 message item（DevTools Elements 验证）

如果使用 React DevTools Profiler，单次流式 token 触发的渲染时长 < 16ms。

- [ ] **步骤 7.4：如有视觉/性能 regression，回到对应任务修复 + 重新冒烟**

可能要做的微调：

- `ChatList` 的 padding / gap 与原 `MessageList` 不一致 → 在 `ChatListView` 的 style 加调整
- BackBottom 内置位置覆盖被 ChatInput 浮层挡住 → 给 ChatList 加 `paddingBottom` 已在 5.3 处理，必要时调大缓冲
- 工具列表过长导致 assistant 气泡过宽 → 在 AssistantMessage 内的 tool 容器加 `max-width: 100%`

- [ ] **步骤 7.5：Commit 截图与可能的微调**

```bash
cd "D:/OneDrive/Project Files/Pi"
git add docs/superpowers/specs/2026-06-14-chat-rendering-cr-a-screenshot-*.png
# 如有 ChatListView/AssistantMessage 微调
git add tauri-agent/src/features/chat/
git commit -m "test(chat): visual smoke screenshots for CR-A (1440 + 390); minor polish"
```

---

## 完成判定

- [ ] 全部 7 个任务的 commit 已落入分支
- [ ] `npm run test -- src/features/chat` PASS
- [ ] `npm run test -- src/hooks/useThrottledValue` PASS
- [ ] `npm run build` PASS
- [ ] 视觉冒烟两份截图存在且符合预期
- [ ] `MessageList.tsx` 已不存在，所有引用已迁移
- [ ] 现有 `AssistantMessage thinking 渲染` / `NoticePill` 等测试不破坏

CR-A 完成后，可启动 CR-B（内容渲染增强）的 brainstorming。
