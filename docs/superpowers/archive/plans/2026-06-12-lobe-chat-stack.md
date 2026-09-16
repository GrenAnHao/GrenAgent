# Lobe Chat Stack 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `tauri-agent` 的聊天核心迁回 Lobe UI 的 `ChatList + ChatInputArea` 组件栈，修复输入框竖排和消息 UI 组合错乱。

**架构：** 保留现有 agent store 和 Pi 事件流，只在 chat feature 内增加一个轻量 adapter，把 Hermes 内部消息映射为 Lobe UI `ChatMessage`。消息流由 `ChatList` 渲染，工具执行继续使用现有 `ToolExecution`，输入区改用完整 `ChatInputArea`，不再手动拼低层 inner/send 组件。

**技术栈：** React 19、Vite、Vitest、`@lobehub/ui@5.15.13`、`antd-style`。

---

## 文件结构

- 创建：`tauri-agent/src/features/chat/messageAdapter.ts`
  - 职责：把 `stores/agentReducer` 的 `ChatMessage[]` 分离为 Lobe UI 可渲染的 user/assistant 消息和 Hermes tool 消息。
- 创建：`tauri-agent/src/features/chat/messageAdapter.test.ts`
  - 职责：锁定 adapter 行为，防止 tool 消息丢失或 user/assistant 顺序错乱。
- 修改：`tauri-agent/src/features/chat/MessageList.tsx`
  - 职责：用 `ChatList` 渲染 user/assistant 消息，用现有 `ToolExecution` 渲染 tool 消息。
- 修改：`tauri-agent/src/features/chat/ChatInput.tsx`
  - 职责：用完整 `ChatInputArea` 替代 `ChatInputAreaInner + ChatSendButton` 手动组合。
- 修改：`tauri-agent/src/features/chat/ChatView.tsx`
  - 职责：移除不必要的 absolute/flex 组合，让消息区和输入区按正常 column 布局占位。
- 可选修改：`tauri-agent/src/index.css`
  - 职责：仅删除或调整与新聊天布局直接冲突的全局 chat CSS。

## 任务 1：添加消息适配器

**文件：**
- 创建：`tauri-agent/src/features/chat/messageAdapter.ts`
- 创建：`tauri-agent/src/features/chat/messageAdapter.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `tauri-agent/src/features/chat/messageAdapter.test.ts` 写入：

```ts
import { describe, expect, it } from 'vitest';
import type { ChatMessage as HermesMessage } from '../../stores/agentReducer';
import { splitMessagesForLobeChat } from './messageAdapter';

describe('splitMessagesForLobeChat', () => {
  it('maps user and assistant messages to Lobe chat messages', () => {
    const messages: HermesMessage[] = [
      { kind: 'user', id: 'u1', text: 'hello' },
      { kind: 'assistant', id: 'a1', text: 'hi', thinking: '', streaming: false },
    ];

    const result = splitMessagesForLobeChat(messages);

    expect(result.chatMessages).toEqual([
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'hi' },
    ]);
    expect(result.toolMessages).toEqual([]);
  });

  it('keeps tool messages separate for custom rendering', () => {
    const tool: HermesMessage = {
      kind: 'tool',
      id: 't1',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'pwd' },
      result: 'ok',
      status: 'done',
    };

    const result = splitMessagesForLobeChat([
      { kind: 'user', id: 'u1', text: 'run pwd' },
      tool,
    ]);

    expect(result.chatMessages).toEqual([
      { id: 'u1', role: 'user', content: 'run pwd' },
    ]);
    expect(result.toolMessages).toEqual([tool]);
  });

  it('uses assistant thinking as content when text is empty', () => {
    const messages: HermesMessage[] = [
      { kind: 'assistant', id: 'a1', text: '', thinking: 'thinking...', streaming: true },
    ];

    const result = splitMessagesForLobeChat(messages);

    expect(result.chatMessages).toEqual([
      { id: 'a1', role: 'assistant', content: 'thinking...' },
    ]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
cd tauri-agent
pnpm test src/features/chat/messageAdapter.test.ts
```

预期：FAIL，报错找不到 `./messageAdapter` 或 `splitMessagesForLobeChat`。

- [ ] **步骤 3：实现最少 adapter**

创建 `tauri-agent/src/features/chat/messageAdapter.ts`：

```ts
import type { ChatMessage as LobeChatMessage } from '@lobehub/ui/chat';
import type { ChatMessage as HermesMessage } from '../../stores/agentReducer';

export type ToolMessage = Extract<HermesMessage, { kind: 'tool' }>;

export interface LobeChatSplit {
  chatMessages: LobeChatMessage[];
  toolMessages: ToolMessage[];
}

export function splitMessagesForLobeChat(messages: HermesMessage[]): LobeChatSplit {
  const chatMessages: LobeChatMessage[] = [];
  const toolMessages: ToolMessage[] = [];

  for (const message of messages) {
    if (message.kind === 'tool') {
      toolMessages.push(message);
      continue;
    }

    chatMessages.push({
      id: message.id,
      role: message.kind === 'user' ? 'user' : 'assistant',
      content: message.text || (message.kind === 'assistant' ? message.thinking : ''),
    });
  }

  return { chatMessages, toolMessages };
}
```

- [ ] **步骤 4：运行 adapter 测试验证通过**

运行：

```bash
cd tauri-agent
pnpm test src/features/chat/messageAdapter.test.ts
```

预期：PASS，3 个测试通过。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/messageAdapter.ts tauri-agent/src/features/chat/messageAdapter.test.ts
git commit -m "test: add lobe chat message adapter"
```

## 任务 2：用 ChatList 替换手写消息列表主体

**文件：**
- 修改：`tauri-agent/src/features/chat/MessageList.tsx`

- [ ] **步骤 1：替换 MessageList 实现**

将 `tauri-agent/src/features/chat/MessageList.tsx` 改为：

```tsx
import { Flexbox } from '@lobehub/ui';
import { ChatList } from '@lobehub/ui/chat';
import { useAgentStore } from '../../stores/AgentStoreContext';
import { ToolExecution } from '../tools/ToolExecution';
import { splitMessagesForLobeChat } from './messageAdapter';

export function MessageList() {
  const { useStore } = useAgentStore();
  const messages = useStore((s) => s.messages);
  const { chatMessages, toolMessages } = splitMessagesForLobeChat(messages);

  return (
    <Flexbox
      flex={1}
      gap={12}
      padding={16}
      style={{ minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
    >
      <ChatList data={chatMessages} variant="bubble" showTitle={false} />

      {toolMessages.map((msg) => (
        <ToolExecution
          key={msg.id}
          toolName={msg.toolName}
          args={msg.args}
          result={msg.result}
          status={msg.status}
        />
      ))}
    </Flexbox>
  );
}
```

说明：本地 `@lobehub/ui@5.15.13` 的根入口不导出 `ChatList`，必须从 `@lobehub/ui/chat` 导入。

- [ ] **步骤 2：运行类型检查**

运行：

```bash
cd tauri-agent
pnpm build
```

预期：TypeScript 通过。

- [ ] **步骤 3：运行相关测试**

运行：

```bash
cd tauri-agent
pnpm test src/features/chat/messageAdapter.test.ts src/stores/agentReducer.test.ts
```

预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/features/chat/MessageList.tsx
git commit -m "feat: render chat messages with lobe ChatList"
```

## 任务 3：用完整 ChatInputArea 替换手动输入框组合

**文件：**
- 修改：`tauri-agent/src/features/chat/ChatInput.tsx`

- [ ] **步骤 1：替换 ChatInput 实现**

将 `tauri-agent/src/features/chat/ChatInput.tsx` 改为：

```tsx
import { useState } from 'react';
import { ChatInputArea, ChatSendButton } from '@lobehub/ui/chat';
import { createStyles } from 'antd-style';
import { useAgentStore } from '../../stores/AgentStoreContext';

const useStyles = createStyles(({ token, css }) => ({
  container: css`
    flex: 0 0 auto;
    padding: 12px 16px 16px;
    border-top: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorBgLayout};
  `,
}));

interface ChatInputProps {
  onSend: (message: string) => Promise<void>;
  onAbort: () => Promise<void>;
}

export function ChatInput({ onSend, onAbort }: ChatInputProps) {
  const { useStore } = useAgentStore();
  const isStreaming = useStore((s) => s.isStreaming);
  const [value, setValue] = useState('');
  const { styles } = useStyles();

  const handleSend = () => {
    const text = value.trim();
    if (!text || isStreaming) return;
    setValue('');
    void onSend(text);
  };

  return (
    <div className={styles.container}>
      <ChatInputArea
        value={value}
        loading={isStreaming}
        placeholder="Type a message..."
        onInput={setValue}
        onSend={handleSend}
        heights={{ minHeight: 88, inputHeight: 88, maxHeight: 240 }}
        bottomAddons={
          <ChatSendButton
            loading={isStreaming}
            onSend={handleSend}
            onStop={() => void onAbort()}
          />
        }
      />
    </div>
  );
}
```

说明：本地 `@lobehub/ui@5.15.13` 类型定义中，`onStop` 属于 `ChatSendButtonProps`，不是 `ChatInputAreaProps`。因此停止按钮通过 `bottomAddons` 显式传入。

- [ ] **步骤 2：运行类型检查**

运行：

```bash
cd tauri-agent
pnpm build
```

预期：TypeScript 通过。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/chat/ChatInput.tsx
git commit -m "feat: use lobe ChatInputArea composer"
```

## 任务 4：恢复 ChatView 正常纵向布局

**文件：**
- 修改：`tauri-agent/src/features/chat/ChatView.tsx`

- [ ] **步骤 1：替换 ChatView 容器样式**

将 `tauri-agent/src/features/chat/ChatView.tsx` 的 return 部分改为：

```tsx
  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <MessageList />
      <ChatInput onSend={handleSend} onAbort={handleAbort} />
    </div>
  );
```

保留 `handleSend` 和 `handleAbort` 逻辑不变。

- [ ] **步骤 2：运行构建**

运行：

```bash
cd tauri-agent
pnpm build
```

预期：PASS。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/chat/ChatView.tsx
git commit -m "fix: use normal chat column layout"
```

## 任务 5：清理直接冲突的旧 chat CSS

**文件：**
- 修改：`tauri-agent/src/index.css`
- 可选修改：`tauri-agent/src/styles.css`

- [ ] **步骤 1：检查旧 CSS 是否仍被引用**

运行：

```bash
cd tauri-agent
rg -n "chat-view|chat-messages|chat-composer-wrap|styles.css" src
```

预期：`styles.css` 没有从 `main.tsx` 引入；旧 `.chat-*` 类没有被新组件使用。

- [ ] **步骤 2：仅删除直接冲突样式**

如果 `tauri-agent/src/styles.css` 未被引用，则不修改它。若 `tauri-agent/src/index.css` 中存在会影响新布局的全局规则，只保留基础 reset：

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
}

#root {
  width: 100%;
  height: 100vh;
}
```

- [ ] **步骤 3：运行构建**

运行：

```bash
cd tauri-agent
pnpm build
```

预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/index.css tauri-agent/src/styles.css
git commit -m "chore: remove obsolete chat layout styles"
```

如果 `styles.css` 没有修改，不要把它加入 commit。

## 任务 6：截图验收

**文件：**
- 生成：`tauri-agent/output/playwright/lobe-chat-1440.png`
- 生成：`tauri-agent/output/playwright/lobe-chat-mobile.png`

- [ ] **步骤 1：启动 Vite**

运行：

```bash
cd tauri-agent
pnpm dev
```

若端口已在运行，直接使用 `http://127.0.0.1:1420`。

- [ ] **步骤 2：桌面截图**

运行：

```bash
cd tauri-agent
New-Item -ItemType Directory -Force output\playwright | Out-Null
npx --yes playwright screenshot --viewport-size=1440,900 http://127.0.0.1:1420 output\playwright\lobe-chat-1440.png
```

预期：截图中输入框文字横向显示，消息区和输入区不重叠。

- [ ] **步骤 3：窄屏截图**

运行：

```bash
cd tauri-agent
npx --yes playwright screenshot --viewport-size=390,844 http://127.0.0.1:1420 output\playwright\lobe-chat-mobile.png
```

预期：即使固定侧栏仍占空间，聊天输入框本身不再竖排，不出现输入区内部重叠。

- [ ] **步骤 4：最终验证**

运行：

```bash
cd tauri-agent
pnpm test src/features/chat/messageAdapter.test.ts src/stores/agentReducer.test.ts
pnpm build
```

预期：测试和构建均通过。

- [ ] **步骤 5：Commit 验收产物**

截图通常不提交，除非项目已有截图基线策略。默认只提交代码：

```bash
git status --short
```

确认只有预期代码文件处于修改状态后，无需提交 `output/playwright`。
