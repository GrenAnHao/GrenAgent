# 子项目 CR-A：对话列表容器骨架 + 性能（lobehub 渲染复刻）— 设计

- 日期：2026-06-14
- 状态：设计待审（brainstorming 产出）
- 父任务：tauri-agent 对话列表「复刻 lobehub 渲染 + 优化」（拆分为 CR-A→CR-B→CR-C，本文档为 **CR-A**）
- 后续：CR-B = 内容渲染增强（markdown 全套 / LaTeX / Mermaid / 代码 diff）；CR-C = 交互与高级（actions / 编辑 / 分支 / Token / 快捷键）
- 决策来源：brainstorming（2026-06-14，用户逐项确认）

## 1. 目标

把 `tauri-agent/src/features/chat/MessageList` 从「半 lobe-chat 化」（已用 `ChatItem`、未用 `ChatList`，自己 ResizeObserver + 自研 BackBottom）升级为 **以 `@lobehub/ui/chat/ChatList` 为容器的完全包装方案**，并在此基础上落地容器层性能优化：虚拟滚动（virtua）、消息项 memo、流式节流。

核心价值：

- 滚动、贴底、动效统一交给 lobe-ui，未来 lobe-ui 升级自动获益
- 长对话（1000+ 条）虚拟滚动后无卡顿
- 流式输出期间不会因每个 token 触发整列重算
- 代码量下降（删除自研 BackBottom / ResizeObserver / scroll handler）

## 2. 关键决策（brainstorming 已确认）

| 决策点 | 选择 |
|--------|------|
| 复刻范围（总） | **C：完整复刻 lobe-chat 全套能力**；不要头像（沿用现有 `showAvatar={false}`） |
| 优化覆盖（总） | 性能 / 体验 / 内容渲染 / 工具卡片视觉 / 交互加强 **全要**，但拆 CR-A→CR-B→CR-C |
| 拆分策略 | **按技术层**：CR-A 容器骨架 + 性能 → CR-B 内容渲染 → CR-C 交互 |
| tool / NoticePill 位置 | **方案 B：内联进 assistant 气泡**（保留现有 `groupMessages`），NoticePill 作为独立 system 消息进 ChatList |
| ChatList 包装程度 | **方案 A：完全包装**（虚拟滚动 / BackBottom / loading 全交给 ChatList，自研代码删除） |

## 3. 背景与现状

`tauri-agent/src/features/chat/` 当前结构：

- `ChatView.tsx`：owner，持有 `handleSend` / `handleAbort` / `inputHeight`，渲染 `MessageList` + `ChatInput`
- `MessageList.tsx`（**本期重写为 `ChatListView.tsx`**）：
  - 直接 `messages.map`，按 `kind` 分派渲染 `UserMessage` / `AssistantMessage` / `ToolExecution` / `NoticePill`
  - 自己实现：`ResizeObserver` 监听内容尺寸、`atBottom` 状态、`handleScroll` 计算阈值、自研 `BackBottom` 按钮（`ActionIcon`）
  - 用绝对定位 + `bottomOffset` 留白给浮动输入框
- `groupMessages.ts`：把 `ChatMessage[]` 折叠为 `DisplayMessage[]`（assistant + 后续 tool 合并为 `assistantGroup`）— **已落地，本期保留并使用**
- `ChatMessageItems.tsx`：复用渲染单元（主对话与子代理对话共享）— 保留并在子代理对话沿用旧路径
- `UserMessage.tsx` / `AssistantMessage.tsx`：已用 `@lobehub/ui/chat` 的 `ChatItem`（`placement="right"/bubble`、`placement="left"/docs`、`showAvatar={false}`）
- `NoticePill.tsx`：基于 `Collapse` 自实现，自动注入提示条
- `Thinking.tsx` / `PreparingIndicator.tsx`：已对齐 lobehub 视觉

关键技术事实（已核实）：

- `@lobehub/ui@5.15.13` 暴露 `ChatList`（`@lobehub/ui/chat`），支持 `data: ChatMessage[]` / `renderMessages: { user, assistant, system, ... }` / `variant: 'docs' | 'bubble'`
- ChatList 内置 virtua 虚拟滚动 + BackBottom + loading
- ChatList 的 `ChatMessage.role` 是 LLM 角色（`user` / `assistant` / `system` / ...），不直接模型 tool；需用「自定义 role + extra」或「assistant 角色 + 自定义 extra」承载

## 4. 架构

### 4.1 分层

```
ChatView (owner)
├─ ChatListView                          // 新组件，替代 MessageList
│   ① useStore(messages) → groupMessages() → DisplayMessage[]   [useMemo]
│   ② toLobeMessages(DisplayMessage[]) → ChatMessage[]          [新 adapter]
│   ③ <ChatList data={...} renderMessages={...} variant="bubble" />
│       ├─ user        → <UserMessage />            (复用，memo)
│       ├─ assistant   → <AssistantMessage tools={...} />  (复用，含 tools 内联，memo)
│       └─ system      → <NoticePill customType={...} content={...} />  (复用，memo)
└─ ChatInput                             // 本期不动
```

### 4.2 `messageAdapter.ts`（新增）

```ts
import type { ChatMessage as LobeChatMessage } from '@lobehub/ui/chat';
import type { DisplayMessage } from './groupMessages';

interface AssistantExtra {
  kind: 'assistantGroup';
  thinking: string;
  streaming: boolean;
  thinkingDuration?: number;
  tools: Array<{ id; toolCallId; toolName; args; result; status }>;
}

interface NoticeExtra {
  kind: 'notice';
  customType: string;
  content: string;
}

interface ToolFallbackExtra {
  kind: 'orphanTool';
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

export function toLobeMessages(messages: DisplayMessage[]): LobeChatMessage[] {
  return messages.map((msg) => {
    switch (msg.kind) {
      case 'user':
        return { id: msg.id, role: 'user', content: msg.text };
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
          } satisfies AssistantExtra,
        };
      case 'notice':
        return {
          id: msg.id,
          role: 'system',
          content: msg.content,
          extra: { kind: 'notice', customType: msg.customType, content: msg.content } satisfies NoticeExtra,
        };
      case 'tool':
        // 孤儿 tool（groupMessages 未配对，理论上罕见）→ fallback system 消息
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
          } satisfies ToolFallbackExtra,
        };
    }
  });
}
```

> **设计要点**：role 选择策略 — `assistantGroup` 用 `role: 'assistant'`（最贴近语义），`notice` 用 `role: 'system'`（lobe-ui ChatList 支持的角色）。所有差异化数据走 `extra`，render 时按 `extra.kind` 分派。这保证未来若用上 ChatList 的内置 actions（CR-C）能正确作用到「整条消息」而非工具单元。

### 4.3 `ChatListView.tsx`（新增，替代 MessageList）

```tsx
import { ChatList } from '@lobehub/ui/chat';
import { useMemo } from 'react';
import { useAgentStore } from '../../stores/AgentStoreContext';
import { groupMessages } from './groupMessages';
import { toLobeMessages } from './messageAdapter';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { NoticePill } from './NoticePill';

export function ChatListView({ bottomOffset = 88 }: { bottomOffset?: number }) {
  const { useStore } = useAgentStore();
  const messages = useStore((s) => s.messages);
  const isStreaming = useStore((s) => s.isStreaming);

  // 节流详见 4.7。
  const throttledMessages = useThrottledValue(messages, 100, { enabled: isStreaming });
  const lobeMessages = useMemo(
    () => toLobeMessages(groupMessages(throttledMessages)),
    [throttledMessages],
  );

  return (
    <ChatList
      data={lobeMessages}
      variant="bubble"
      loading={isStreaming}
      style={{ position: 'absolute', inset: 0, paddingBottom: bottomOffset }}
      renderMessages={{
        user: (_default, item) => <UserMessage key={item.id} text={item.content} />,
        assistant: (_default, item) => {
          const extra = item.extra as AssistantExtra;
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
        system: (_default, item) => {
          const extra = item.extra as NoticeExtra | ToolFallbackExtra;
          if (extra.kind === 'notice') {
            return <NoticePill key={item.id} customType={extra.customType} content={extra.content} />;
          }
          // orphanTool fallback
          return null; // CR-A 阶段静默吞掉，CR-B 决定是否做兜底卡片
        },
      }}
    />
  );
}
```

> **设计要点**：
>
> - `ChatList` 的 `loading` 接管 `PreparingIndicator` 等价语义（本期保留 `PreparingIndicator` 仅用于 backwards-compat 视觉，CR-B 决定是否退役）
> - 删除 `BackBottom` 自研 — ChatList 内置
> - 删除 `ResizeObserver` / scroll handler / `atBottom` — ChatList 内置
> - 沿用 `bottomOffset` 保留输入框留白契约，避免动到 `ChatView`
> - `AssistantMessage` 需要新增 `tools?` prop 来承载内联 tool 列表（见 4.4）

### 4.4 `AssistantMessage.tsx`（小改：接受 tools，内联渲染）

新增 `tools?: ToolDisplay[]` prop。当存在 tools 时，在 `ChatItem` 的 `belowMessage`（或 `message` 末尾追加）渲染 `ToolExecution` 列表。

```tsx
import { ChatItem } from '@lobehub/ui/chat';
import { lazy, Suspense, memo } from 'react';
import { Thinking } from './Thinking';

const ToolExecution = lazy(() =>
  import('../tools/ToolExecution').then((m) => ({ default: m.ToolExecution })),
);

interface AssistantMessageProps {
  text: string;
  thinking: string;
  streaming: boolean;
  thinkingDuration?: number;
  tools?: ToolDisplay[];
}

function AssistantMessageInner({ text, thinking, streaming, thinkingDuration, tools }: AssistantMessageProps) {
  const reasoning = streaming && !text;
  return (
    <ChatItem
      placement="left"
      variant="docs"
      showAvatar={false}
      fontSize={14}
      loading={streaming && !text && !thinking}
      message={text || (reasoning && !thinking ? '...' : '')}
      aboveMessage={thinking ? <Thinking content={thinking} thinking={reasoning} duration={thinkingDuration} /> : undefined}
      belowMessage={tools?.length ? (
        <Suspense fallback={null}>
          {tools.map((t) => (
            <ToolExecution
              key={t.id}
              toolName={t.toolName}
              toolCallId={t.toolCallId}
              args={t.args}
              result={t.result}
              status={t.status}
            />
          ))}
        </Suspense>
      ) : undefined}
    />
  );
}

export const AssistantMessage = memo(AssistantMessageInner);
```

> 注：`avatar` prop 移除（用户明确不要头像）；`belowMessage` 是否为 ChatItem 标准 prop 需在实现时核对 lobe-ui@5.15.13 类型；若不存在，退回把 tools 渲染在 `message` slot 末尾（拼成 ReactNode）。

### 4.5 `UserMessage.tsx` / `NoticePill.tsx`（仅加 memo）

```tsx
export const UserMessage = memo(UserMessageInner);
export const NoticePill = memo(NoticePillInner);
```

### 4.6 `MessageList.tsx`（退役）

被 `ChatListView` 完全替代。`ChatView.tsx` 改为引用 `ChatListView`。`ChatMessageItems.tsx` **保留**（子代理对话渲染仍走旧路径，CR 范围只动主对话）。

### 4.7 流式节流

在 `ChatListView` 内对 store messages 加 100ms throttle，避免每个 token 触发整列重算 — 不改动 store 契约。

新增 `tauri-agent/src/hooks/useThrottledValue.ts`：

```ts
export function useThrottledValue<T>(value: T, ms: number, options?: { enabled?: boolean }): T;
```

契约：

- `enabled` 默认 `true`；为 `false` 时节流关闭，直接返回最新 `value`
- `enabled` 从 `true` → `false` 切换时，**立即同步** 最新 `value`（避免流式结束后丢最后一帧）
- 节流采用 trailing edge（每 `ms` 内最后一次更新生效）
- 内部用 `setTimeout` + `useRef` 管理；卸载时清 timer

在 `ChatListView` 内使用：

```ts
const isStreaming = useStore((s) => s.isStreaming);
const throttledMessages = useThrottledValue(messages, 100, { enabled: isStreaming });
const lobeMessages = useMemo(() => toLobeMessages(groupMessages(throttledMessages)), [throttledMessages]);
```

## 5. 数据流

```
agentStore.messages (ChatMessage[])
  → useThrottledValue(100ms during streaming)
  → groupMessages() [useMemo]
  → DisplayMessage[]
  → toLobeMessages() [纯函数]
  → LobeChatMessage[]
  → <ChatList renderMessages={user|assistant|system}/>
  → 现有 UserMessage / AssistantMessage(含 tools 内联) / NoticePill 复用
  → ChatList 内置：virtua 虚拟滚动 + 自动滚到底 + BackBottom + loading
```

## 6. 错误处理

- **孤儿 tool**（无前置 assistant 的 tool 消息）：adapter 兜底成 `role: 'system' + extra.kind='orphanTool'`，本期渲染为 `null`（不显示），CR-B 阶段决定是否做兜底卡片
- **ChatList 自带 `renderErrorMessages`**：本期不启用，留 CR-C 做错误重试 UI
- **lobe-ui 升级破坏 props**：在 `ChatListView` 内部用类型断言隔离；测试覆盖 renderMessages 签名

## 7. 测试策略

### 7.1 单元测试
- `messageAdapter.test.ts`（新增）
  - `user` → `{ role:'user', content:text }`
  - `assistantGroup` → `{ role:'assistant', extra.kind='assistantGroup', extra.tools=[...] }`
  - `notice` → `{ role:'system', extra.kind='notice' }`
  - `tool`（孤儿）→ `{ role:'system', extra.kind='orphanTool' }`
- `groupMessages.test.ts`（已存在）：保留
- `useThrottledValue.test.ts`（如新增）：节流行为 + 流式停止后立即同步

### 7.2 集成测试
- `ChatListView.test.tsx`（新增）
  - mock `ChatList`（vi.mock `@lobehub/ui/chat`），断言传入的 `data` / `renderMessages` 调度正确
  - 验证 store messages 变化 → ChatList data 更新
  - 验证 streaming 时 throttle 生效（fake timers）
- `AssistantMessage.test.tsx`（已存在）：增加 `tools` prop 测试

### 7.3 视觉冒烟
- `vite dev` 跑 1440×900 / 390×844 截图：消息流正常、BackBottom 出现、贴底滚动、长对话流畅
- 与 CR-B/CR-C 共用一份测试夹具（mock 100 条 / 1000 条消息）

## 8. 实现顺序（writing-plans 阶段细化）

每步 TDD（红 → 绿 → 重构）+ commit：

- **CR-A1** `messageAdapter.ts` + 单测（不动其他文件）
- **CR-A2** `useThrottledValue` hook + 单测（新增，契约见 4.7）
- **CR-A3** `AssistantMessage` 接受 `tools` prop + memo + 测试更新
- **CR-A4** `UserMessage` / `NoticePill` 加 memo
- **CR-A5** `ChatListView.tsx` 新增 + 集成测试
- **CR-A6** `ChatView.tsx` 切换到 `ChatListView`；删除 `MessageList.tsx`
- **CR-A7** 视觉冒烟（截图 1440×900 / 390×844）

## 9. 文件清单

**新增**：
- `tauri-agent/src/features/chat/ChatListView.tsx` + `ChatListView.test.tsx`
- `tauri-agent/src/features/chat/messageAdapter.ts` + `messageAdapter.test.ts`
- `tauri-agent/src/hooks/useThrottledValue.ts` + `useThrottledValue.test.ts`

**修改**：
- `tauri-agent/src/features/chat/ChatView.tsx`（引用 `ChatListView` 替代 `MessageList`）
- `tauri-agent/src/features/chat/AssistantMessage.tsx`（新增 `tools` prop + `belowMessage` 渲染 + memo）
- `tauri-agent/src/features/chat/UserMessage.tsx`（memo）
- `tauri-agent/src/features/chat/NoticePill.tsx`（memo）
- `tauri-agent/src/features/chat/AssistantMessage.test.tsx`（覆盖 `tools` prop）

**退役**：
- `tauri-agent/src/features/chat/MessageList.tsx`（被 `ChatListView` 完全替代）

**保留**：
- `tauri-agent/src/features/chat/groupMessages.ts`（核心，被 adapter 调用）
- `tauri-agent/src/features/chat/ChatMessageItems.tsx`（子代理对话仍走旧路径）
- `tauri-agent/src/features/chat/Thinking.tsx`、`PreparingIndicator.tsx`、`LazyMarkdown.tsx`（CR-B 接手增强）

## 10. 非目标（YAGNI）

- 不动 `ChatInput`（CR 全期保留输入区改造为后续考量）
- 不增强 markdown（LaTeX/Mermaid/diff 留给 CR-B）
- 不加交互（actions / 编辑 / 分支 / Token / 快捷键 / 引用回复留给 CR-C）
- 不改 `agentReducer` / store schema
- 不引入 `@lobehub/ui/mobile`（无移动端目标）
- 不动 `ToolExecution` 卡片视觉与逻辑（CR-B 顺手再调）
- 不做 ChatList 内置 actions（`onActionsClick` / `actions` slot）— CR-C
- 不做子代理对话的 ChatList 化（`ChatMessageItems` 仍按旧路径）— 后续单独评估

## 11. 风险与缓解

- **lobe-ui ChatList API 与我们映射不完全契合**（例如 `extra` 不通过 renderMessages 直传）：在 `messageAdapter.test.ts` 加 lobe-ui 类型快照测试；CR-A5 集成测试用 mock ChatList 验证签名
- **ChatList 内置 BackBottom 行为与现状用户习惯不同**：CR-A7 视觉冒烟阶段评估，若手感差则在 CR-C 阶段加自定义；CR-A 阶段以「lobe-ui 默认」为基准线
- **`belowMessage` prop 不存在于 ChatItem@5.15.13**：fallback 把 tools 拼进 `message` ReactNode 末尾
- **流式节流引起最后一帧丢失**：useThrottledValue 在 `isStreaming` 变 false 时立即同步最新值
- **虚拟滚动与动态高度 markdown**：lobe-ui 用 virtua 已处理，但需在视觉冒烟时关注流式中高度变化是否抖动
