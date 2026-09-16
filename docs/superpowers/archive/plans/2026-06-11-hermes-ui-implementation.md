# Hermes UI 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 重构 tauri-agent UI 层，建立 Hermes 架构（分层清晰、功能内聚、渐进增强）

**架构：** RPC 通信层 → Zustand Store → Feature 模块 → LobeUI 组件，全面基于 LobeUI 实现聊天界面

**技术栈：** React 19.2 + TypeScript + Zustand + LobeUI + Tauri 2.x

---

## 文件结构规划

### 新建文件

**核心层：**
- `hermes/src/lib/pi-rpc.ts` - RPC 客户端，管理 Pi Agent 进程通信
- `hermes/src/lib/types.ts` - Pi Agent 类型定义

**状态层：**
- `hermes/src/store/session.ts` - 会话状态（Zustand）
- `hermes/src/store/messages.ts` - 消息流状态
- `hermes/src/store/ui.ts` - UI 状态
- `hermes/src/store/index.ts` - Store 统一导出

**功能层：**
- `hermes/src/features/chat/ChatView.tsx` - 聊天容器
- `hermes/src/features/chat/MessageList.tsx` - 消息列表（LobeUI ChatList）
- `hermes/src/features/chat/ChatInput.tsx` - 输入框（LobeUI ChatInputArea）
- `hermes/src/features/chat/UserMessage.tsx` - 用户消息组件
- `hermes/src/features/chat/AssistantMessage.tsx` - 助手消息组件
- `hermes/src/features/sessions/SessionList.tsx` - 会话列表
- `hermes/src/features/sessions/SessionItem.tsx` - 会话项

**钩子层：**
- `hermes/src/hooks/useRpcClient.ts` - RPC 客户端钩子

**入口：**
- `hermes/src/App.tsx` - 应用入口
- `hermes/src/main.tsx` - React 挂载
- `hermes/package.json` - 依赖配置
- `hermes/vite.config.ts` - Vite 配置
- `hermes/tsconfig.json` - TypeScript 配置

### 保留参考
- `tauri-agent/src/App.backup.tsx` - 原有逻辑参考
- `tauri-agent/src/lib/pi.ts` - 现有 Pi 通信逻辑参考

---

## Phase 1: 基础设施（MVP）

### 任务 1：项目初始化

**文件：**
- 创建：`hermes/package.json`
- 创建：`hermes/tsconfig.json`
- 创建：`hermes/vite.config.ts`

- [ ] **步骤 1：创建 hermes 目录**

```bash
mkdir -p hermes/src
cd hermes
```

- [ ] **步骤 2：初始化 package.json**

```json
{
  "name": "hermes",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "@lobehub/ui": "^5.15.13",
    "antd": "^6.4.3",
    "antd-style": "^4.1.0",
    "zustand": "^5.0.14",
    "lucide-react": "^1.17.0",
    "motion": "^12.40.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "~5.6.2",
    "vite": "^6.0.3"
  }
}
```

- [ ] **步骤 3：创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

- [ ] **步骤 4：创建 vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['@lobehub/ui'],
  },
});
```

- [ ] **步骤 5：安装依赖**

```bash
npm install
```

预期：无错误，生成 node_modules 和 package-lock.json

- [ ] **步骤 6：Commit**

```bash
git add hermes/
git commit -m "feat: initialize hermes project structure"
```

---

### 任务 2：类型定义

**文件：**
- 创建：`hermes/src/lib/types.ts`

- [ ] **步骤 1：定义 RPC 类型**

```typescript
export type ThinkingLevel = 'low' | 'medium' | 'high';

export interface ContentPart {
  type: 'text' | 'image';
  text?: string;
  imageUrl?: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
}

export type RpcCommand =
  | { id?: string; type: 'prompt'; message: string; images?: ImageContent[] }
  | { id?: string; type: 'abort' }
  | { id?: string; type: 'get_messages' }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'switch_session'; sessionPath: string }
  | { id?: string; type: 'new_session'; parentSession?: string }
  | { id?: string; type: 'set_model'; provider: string; modelId: string };

export interface RpcResponse<T = any> {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface AssistantMessageEvent {
  type: 'text_delta' | 'thinking_delta' | 'tool_call';
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  params?: any;
}

export type AgentEvent =
  | { type: 'agent_start'; timestamp: number }
  | { type: 'agent_end'; timestamp: number }
  | { type: 'message_start'; role: string; timestamp: number }
  | { type: 'message_update'; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; timestamp: number }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; params: any }
  | { type: 'tool_execution_update'; toolCallId: string; content: string }
  | { type: 'tool_execution_end'; toolCallId: string; result: any }
  | { type: 'turn_start'; timestamp: number }
  | { type: 'turn_end'; timestamp: number };

export interface AgentMessage {
  role: 'user' | 'assistant' | 'toolResult';
  content: string | ContentPart[];
  timestamp: number;
  thinking?: string;
}

export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  params: any;
  status: 'running' | 'success' | 'error';
  result?: any;
  startTime: number;
  endTime?: number;
}

export interface SessionInfo {
  path: string;
  name?: string;
  lastModified: number;
}

export interface AgentState {
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  sessionFile?: string;
}

export interface RpcConfig {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}
```

- [ ] **步骤 2：Commit**

```bash
git add hermes/src/lib/types.ts
git commit -m "feat: add Pi Agent type definitions"
```

---

### 任务 3：RPC 客户端（第一部分 - 核心结构）

**文件：**
- 创建：`hermes/src/lib/pi-rpc.ts`

- [ ] **步骤 1：实现 RPC 客户端基础结构**

```typescript
import type { 
  RpcCommand, 
  RpcResponse, 
  AgentEvent, 
  RpcConfig 
} from './types';

export class PiRpcClient {
  private eventHandlers: Map<string, Set<(event: AgentEvent) => void>> = new Map();
  private pendingRequests: Map<string, (response: RpcResponse) => void> = new Map();
  private messageBuffer = '';
  private requestIdCounter = 0;

  async start(cwd: string, config: RpcConfig): Promise<void> {
    console.log('Starting Pi Agent RPC client', { cwd, config });
    // 实际进程启动将在后续实现
  }

  on(eventType: string, handler: (event: AgentEvent) => void): () => void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Set());
    }
    this.eventHandlers.get(eventType)!.add(handler);
    
    return () => {
      const handlers = this.eventHandlers.get(eventType);
      if (handlers) {
        handlers.delete(handler);
      }
    };
  }

  async send<T = any>(command: RpcCommand): Promise<RpcResponse<T>> {
    const id = `req_${++this.requestIdCounter}`;
    const cmdWithId = { ...command, id };
    
    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve as any);
      console.log('Sending RPC command:', cmdWithId);
      // 实际发送逻辑将在后续实现
      setTimeout(() => {
        resolve({ id, type: 'response', command: command.type, success: true } as any);
        this.pendingRequests.delete(id);
      }, 100);
    });
  }

  async prompt(message: string): Promise<void> {
    await this.send({ type: 'prompt', message });
  }

  async abort(): Promise<void> {
    await this.send({ type: 'abort' });
  }

  async destroy(): Promise<void> {
    this.eventHandlers.clear();
    this.pendingRequests.clear();
  }
}
```

- [ ] **步骤 2：Commit**

```bash
git add hermes/src/lib/pi-rpc.ts
git commit -m "feat: add RPC client base structure"
```

---

### 任务 4：消息 Store

**文件：**
- 创建：`hermes/src/store/messages.ts`

- [ ] **步骤 1：实现消息状态管理**

```typescript
import { create } from 'zustand';
import type { AgentMessage, ToolExecution } from '../lib/types';

interface MessageStore {
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  isStreaming: boolean;
  toolExecutions: Map<string, ToolExecution>;
  
  addMessage: (msg: AgentMessage) => void;
  updateStreamingMessage: (delta: string) => void;
  setStreamingThinking: (thinking: string) => void;
  finishStreaming: () => void;
  clearMessages: () => void;
  addToolExecution: (toolCallId: string, execution: ToolExecution) => void;
  updateToolExecution: (toolCallId: string, update: Partial<ToolExecution>) => void;
}

export const useMessageStore = create<MessageStore>((set) => ({
  messages: [],
  streamingMessage: null,
  isStreaming: false,
  toolExecutions: new Map(),
  
  addMessage: (msg) => set((state) => ({
    messages: [...state.messages, msg],
  })),
  
  updateStreamingMessage: (delta) => set((state) => {
    const current = state.streamingMessage || { role: 'assistant' as const, content: '', timestamp: Date.now() };
    const currentContent = typeof current.content === 'string' ? current.content : '';
    return {
      streamingMessage: { ...current, content: currentContent + delta },
      isStreaming: true,
    };
  }),
  
  setStreamingThinking: (thinking) => set((state) => ({
    streamingMessage: { ...state.streamingMessage, thinking },
  })),
  
  finishStreaming: () => set((state) => {
    if (!state.streamingMessage) return state;
    return {
      messages: [...state.messages, state.streamingMessage as AgentMessage],
      streamingMessage: null,
      isStreaming: false,
    };
  }),
  
  clearMessages: () => set({ messages: [], streamingMessage: null, isStreaming: false }),
  
  addToolExecution: (toolCallId, execution) => set((state) => {
    const newMap = new Map(state.toolExecutions);
    newMap.set(toolCallId, execution);
    return { toolExecutions: newMap };
  }),
  
  updateToolExecution: (toolCallId, update) => set((state) => {
    const existing = state.toolExecutions.get(toolCallId);
    if (!existing) return state;
    const newMap = new Map(state.toolExecutions);
    newMap.set(toolCallId, { ...existing, ...update });
    return { toolExecutions: newMap };
  }),
}));
```

- [ ] **步骤 2：Commit**

```bash
git add hermes/src/store/messages.ts
git commit -m "feat: add message store with Zustand"
```

---

### 任务 5：会话 Store

**文件：**
- 创建：`hermes/src/store/session.ts`

- [ ] **步骤 1：实现会话状态管理**

```typescript
import { create } from 'zustand';
import type { SessionInfo } from '../lib/types';

interface SessionStore {
  sessions: SessionInfo[];
  activeSessionPath: string | null;
  isLoading: boolean;
  error: string | null;
  
  setSessions: (sessions: SessionInfo[]) => void;
  setActiveSession: (path: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  activeSessionPath: null,
  isLoading: false,
  error: null,
  
  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (path) => set({ activeSessionPath: path }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
}));
```

- [ ] **步骤 2：Commit**

```bash
git add hermes/src/store/session.ts
git commit -m "feat: add session store"
```

---

### 任务 6：UI Store

**文件：**
- 创建：`hermes/src/store/ui.ts`
- 创建：`hermes/src/store/index.ts`

- [ ] **步骤 1：实现 UI 状态管理**

```typescript
import { create } from 'zustand';

interface UIStore {
  sidebarOpen: boolean;
  theme: 'light' | 'dark' | 'auto';
  
  toggleSidebar: () => void;
  setTheme: (theme: 'light' | 'dark' | 'auto') => void;
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarOpen: true,
  theme: 'auto',
  
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setTheme: (theme) => set({ theme }),
}));
```

- [ ] **步骤 2：创建 Store 统一导出**

```typescript
export { useMessageStore } from './messages';
export { useSessionStore } from './session';
export { useUIStore } from './ui';
```

- [ ] **步骤 3：Commit**

```bash
git add hermes/src/store/
git commit -m "feat: add UI store and unified exports"
```

---

### 任务 7：RPC 客户端钩子

**文件：**
- 创建：`hermes/src/hooks/useRpcClient.ts`

- [ ] **步骤 1：实现 RPC 客户端钩子**

```typescript
import { useEffect, useMemo } from 'react';
import { PiRpcClient } from '../lib/pi-rpc';
import { useMessageStore } from '../store';
import type { RpcConfig } from '../lib/types';

export function useRpcClient(workspace: string, config: RpcConfig = {}) {
  const client = useMemo(() => new PiRpcClient(), []);
  const addMessage = useMessageStore((state) => state.addMessage);
  const updateStreamingMessage = useMessageStore((state) => state.updateStreamingMessage);
  const setStreamingThinking = useMessageStore((state) => state.setStreamingThinking);
  const finishStreaming = useMessageStore((state) => state.finishStreaming);
  const addToolExecution = useMessageStore((state) => state.addToolExecution);
  const updateToolExecution = useMessageStore((state) => state.updateToolExecution);
  
  useEffect(() => {
    client.on('message_update', (event) => {
      if (event.type === 'message_update') {
        const msgEvent = event.assistantMessageEvent;
        if (msgEvent.type === 'text_delta' && msgEvent.delta) {
          updateStreamingMessage(msgEvent.delta);
        } else if (msgEvent.type === 'thinking_delta' && msgEvent.delta) {
          setStreamingThinking(msgEvent.delta);
        }
      }
    });
    
    client.on('message_end', () => {
      finishStreaming();
    });
    
    client.on('tool_execution_start', (event) => {
      if (event.type === 'tool_execution_start') {
        addToolExecution(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          params: event.params,
          status: 'running',
          startTime: Date.now(),
        });
      }
    });
    
    client.on('tool_execution_end', (event) => {
      if (event.type === 'tool_execution_end') {
        updateToolExecution(event.toolCallId, {
          status: 'success',
          result: event.result,
          endTime: Date.now(),
        });
      }
    });
    
    client.start(workspace, config);
    
    return () => {
      client.destroy();
    };
  }, [client, workspace]);
  
  return client;
}
```

- [ ] **步骤 2：Commit**

```bash
git add hermes/src/hooks/useRpcClient.ts
git commit -m "feat: add RPC client hook with event handling"
```

---

### 任务 8：聊天输入组件

**文件：**
- 创建：`hermes/src/features/chat/ChatInput.tsx`

- [ ] **步骤 1：实现聊天输入框（使用 LobeUI）**

```typescript
import { ChatInputArea } from '@lobehub/ui/chat';
import { useMessageStore } from '../../store';

interface ChatInputProps {
  onSend: (message: string) => Promise<void>;
  onAbort: () => Promise<void>;
}

export function ChatInput({ onSend, onAbort }: ChatInputProps) {
  const isStreaming = useMessageStore((state) => state.isStreaming);
  
  return (
    <ChatInputArea
      onSend={onSend}
      onStop={onAbort}
      loading={isStreaming}
      placeholder="Type a message..."
    />
  );
}
```

- [ ] **步骤 2：Commit**

```bash
mkdir -p hermes/src/features/chat
git add hermes/src/features/chat/ChatInput.tsx
git commit -m "feat: add chat input component with LobeUI"
```

---

### 任务 9：消息组件

**文件：**
- 创建：`hermes/src/features/chat/UserMessage.tsx`
- 创建：`hermes/src/features/chat/AssistantMessage.tsx`

- [ ] **步骤 1：实现用户消息组件**

```typescript
import type { AgentMessage } from '../../lib/types';

interface UserMessageProps {
  message: AgentMessage;
}

export function UserMessage({ message }: UserMessageProps) {
  const content = typeof message.content === 'string' 
    ? message.content 
    : message.content.map(p => p.text).join('');
  
  return (
    <div className="flex justify-end mb-4">
      <div className="max-w-[70%] rounded-lg bg-blue-500 text-white px-4 py-2">
        {content}
      </div>
    </div>
  );
}
```

- [ ] **步骤 2：实现助手消息组件**

```typescript
import type { AgentMessage } from '../../lib/types';

interface AssistantMessageProps {
  message: AgentMessage;
}

export function AssistantMessage({ message }: AssistantMessageProps) {
  const content = typeof message.content === 'string' 
    ? message.content 
    : message.content.map(p => p.text).join('');
  
  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[70%] rounded-lg bg-gray-100 text-gray-900 px-4 py-2">
        <div>{content}</div>
        {message.thinking && (
          <details className="mt-2 text-sm text-gray-600">
            <summary className="cursor-pointer">Thinking...</summary>
            <div className="mt-1 whitespace-pre-wrap">{message.thinking}</div>
          </details>
        )}
      </div>
    </div>
  );
}
```

- [ ] **步骤 3：Commit**

```bash
git add hermes/src/features/chat/UserMessage.tsx hermes/src/features/chat/AssistantMessage.tsx
git commit -m "feat: add user and assistant message components"
```

---

### 任务 10：消息列表组件

**文件：**
- 创建：`hermes/src/features/chat/MessageList.tsx`

- [ ] **步骤 1：实现消息列表**

```typescript
import { useMessageStore } from '../../store';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';

export function MessageList() {
  const messages = useMessageStore((state) => state.messages);
  const streamingMessage = useMessageStore((state) => state.streamingMessage);
  
  return (
    <div className="flex-1 overflow-y-auto p-4">
      {messages.map((msg, idx) => {
        if (msg.role === 'user') {
          return <UserMessage key={idx} message={msg} />;
        } else if (msg.role === 'assistant') {
          return <AssistantMessage key={idx} message={msg} />;
        }
        return null;
      })}
      
      {streamingMessage && (
        <AssistantMessage message={streamingMessage as any} />
      )}
    </div>
  );
}
```

- [ ] **步骤 2：Commit**

```bash
git add hermes/src/features/chat/MessageList.tsx
git commit -m "feat: add message list with streaming support"
```

---

### 任务 11：聊天视图容器

**文件：**
- 创建：`hermes/src/features/chat/ChatView.tsx`

- [ ] **步骤 1：实现聊天视图容器**

```typescript
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { useRpcClient } from '../../hooks/useRpcClient';

export function ChatView() {
  const client = useRpcClient('.', {});
  
  const handleSend = async (message: string) => {
    await client.prompt(message);
  };
  
  const handleAbort = async () => {
    await client.abort();
  };
  
  return (
    <div className="flex flex-col h-full">
      <MessageList />
      <ChatInput onSend={handleSend} onAbort={handleAbort} />
    </div>
  );
}
```

- [ ] **步骤 2：Commit**

```bash
git add hermes/src/features/chat/ChatView.tsx
git commit -m "feat: add chat view container"
```

---

### 任务 12：应用入口

**文件：**
- 创建：`hermes/src/App.tsx`
- 创建：`hermes/src/main.tsx`
- 创建：`hermes/index.html`

- [ ] **步骤 1：实现应用入口组件**

```typescript
import { ChatView } from './features/chat/ChatView';

export default function App() {
  return (
    <div className="h-screen flex flex-col">
      <header className="h-12 bg-gray-800 text-white flex items-center px-4">
        <h1 className="text-lg font-bold">Hermes</h1>
      </header>
      <main className="flex-1 overflow-hidden">
        <ChatView />
      </main>
    </div>
  );
}
```

- [ ] **步骤 2：创建 React 挂载点**

```typescript
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **步骤 3：创建 index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Hermes</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **步骤 4：创建基础样式**

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

保存到 `hermes/src/index.css`

- [ ] **步骤 5：运行开发服务器**

```bash
cd hermes
npm run dev
```

预期：Vite 启动，访问 http://localhost:5173 看到 Hermes 界面

- [ ] **步骤 6：Commit**

```bash
git add hermes/src/App.tsx hermes/src/main.tsx hermes/index.html hermes/src/index.css
git commit -m "feat: add app entry and basic layout"
```

---

## Phase 1 验收

运行 `npm run dev`，验证：
- [ ] 应用启动无错误
- [ ] 看到 Hermes 标题
- [ ] 输入框可见
- [ ] 可以输入消息（虽然 RPC 是 mock 的）

---

## Phase 2: 会话管理和工具可视化

### 任务 13：会话列表组件

**文件：**
- 创建：`hermes/src/features/sessions/SessionItem.tsx`
- 创建：`hermes/src/features/sessions/SessionList.tsx`

- [ ] **步骤 1：实现会话项组件**

```typescript
import { Trash2 } from 'lucide-react';
import type { SessionInfo } from '../../lib/types';

interface SessionItemProps {
  session: SessionInfo;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function SessionItem({ session, active, onSelect, onDelete }: SessionItemProps) {
  return (
    <div
      className={`flex items-center justify-between p-3 cursor-pointer hover:bg-gray-100 ${
        active ? 'bg-blue-50 border-l-4 border-blue-500' : ''
      }`}
      onClick={onSelect}
    >
      <div className="flex-1">
        <div className="font-medium">{session.name || 'Untitled'}</div>
        <div className="text-xs text-gray-500">
          {new Date(session.lastModified).toLocaleDateString()}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="p-2 hover:bg-red-100 rounded"
      >
        <Trash2 size={16} className="text-gray-600" />
      </button>
    </div>
  );
}
```

- [ ] **步骤 2：实现会话列表**

```typescript
import { Plus } from 'lucide-react';
import { useSessionStore } from '../../store';
import { SessionItem } from './SessionItem';

interface SessionListProps {
  onCreateSession: () => Promise<void>;
  onSwitchSession: (path: string) => Promise<void>;
  onDeleteSession: (path: string) => Promise<void>;
}

export function SessionList({ onCreateSession, onSwitchSession, onDeleteSession }: SessionListProps) {
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionPath = useSessionStore((state) => state.activeSessionPath);
  
  return (
    <div className="flex flex-col h-full bg-white border-r">
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="font-bold">Sessions</h2>
        <button
          onClick={onCreateSession}
          className="p-2 hover:bg-gray-100 rounded"
          title="New Session"
        >
          <Plus size={20} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.map((session) => (
          <SessionItem
            key={session.path}
            session={session}
            active={session.path === activeSessionPath}
            onSelect={() => onSwitchSession(session.path)}
            onDelete={() => onDeleteSession(session.path)}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **步骤 3：Commit**

```bash
mkdir -p hermes/src/features/sessions
git add hermes/src/features/sessions/
git commit -m "feat: add session list components"
```

---

### 任务 14：工具执行可视化

**文件：**
- 创建：`hermes/src/features/tools/ToolExecution.tsx`

- [ ] **步骤 1：实现工具执行组件**

```typescript
import type { ToolExecution as ToolExecutionType } from '../../lib/types';

interface ToolExecutionProps {
  execution: ToolExecutionType;
}

export function ToolExecution({ execution }: ToolExecutionProps) {
  const { toolName, params, status, result } = execution;
  
  const statusColor = {
    running: 'bg-blue-100 text-blue-800',
    success: 'bg-green-100 text-green-800',
    error: 'bg-red-100 text-red-800',
  }[status];
  
  return (
    <div className={`my-2 p-3 rounded-lg border ${statusColor}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono font-bold text-sm">{toolName}</span>
        <span className="text-xs uppercase">{status}</span>
      </div>
      
      <details className="text-sm">
        <summary className="cursor-pointer text-gray-600">Parameters</summary>
        <pre className="mt-1 text-xs overflow-x-auto">
          {JSON.stringify(params, null, 2)}
        </pre>
      </details>
      
      {result && (
        <div className="mt-2 text-sm">
          <div className="font-medium mb-1">Result:</div>
          <pre className="text-xs bg-white p-2 rounded overflow-x-auto">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
```

- [ ] **步骤 2：集成到消息列表**

修改 `hermes/src/features/chat/MessageList.tsx`，添加工具执行展示：

```typescript
import { useMessageStore } from '../../store';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ToolExecution } from '../tools/ToolExecution';

export function MessageList() {
  const messages = useMessageStore((state) => state.messages);
  const streamingMessage = useMessageStore((state) => state.streamingMessage);
  const toolExecutions = useMessageStore((state) => state.toolExecutions);
  
  return (
    <div className="flex-1 overflow-y-auto p-4">
      {messages.map((msg, idx) => {
        if (msg.role === 'user') {
          return <UserMessage key={idx} message={msg} />;
        } else if (msg.role === 'assistant') {
          return <AssistantMessage key={idx} message={msg} />;
        }
        return null;
      })}
      
      {Array.from(toolExecutions.values()).map((execution) => (
        <ToolExecution key={execution.toolCallId} execution={execution} />
      ))}
      
      {streamingMessage && (
        <AssistantMessage message={streamingMessage as any} />
      )}
    </div>
  );
}
```

- [ ] **步骤 3：Commit**

```bash
mkdir -p hermes/src/features/tools
git add hermes/src/features/tools/ToolExecution.tsx hermes/src/features/chat/MessageList.tsx
git commit -m "feat: add tool execution visualization"
```

---

### 任务 15：更新应用布局（集成会话列表）

**文件：**
- 修改：`hermes/src/App.tsx`

- [ ] **步骤 1：更新 App 组件，添加会话侧边栏**

```typescript
import { useState } from 'react';
import { ChatView } from './features/chat/ChatView';
import { SessionList } from './features/sessions/SessionList';
import { useSessionStore } from './store';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const setSessions = useSessionStore((state) => state.setSessions);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  
  const handleCreateSession = async () => {
    const newSession = {
      path: `/session-${Date.now()}`,
      name: 'New Session',
      lastModified: Date.now(),
    };
    const sessions = useSessionStore.getState().sessions;
    setSessions([...sessions, newSession]);
    setActiveSession(newSession.path);
  };
  
  const handleSwitchSession = async (path: string) => {
    setActiveSession(path);
  };
  
  const handleDeleteSession = async (path: string) => {
    const sessions = useSessionStore.getState().sessions;
    setSessions(sessions.filter((s) => s.path !== path));
  };
  
  return (
    <div className="h-screen flex">
      {sidebarOpen && (
        <div className="w-64 border-r">
          <SessionList
            onCreateSession={handleCreateSession}
            onSwitchSession={handleSwitchSession}
            onDeleteSession={handleDeleteSession}
          />
        </div>
      )}
      
      <div className="flex-1 flex flex-col">
        <header className="h-12 bg-gray-800 text-white flex items-center px-4 justify-between">
          <h1 className="text-lg font-bold">Hermes</h1>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600"
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </header>
        <main className="flex-1 overflow-hidden">
          <ChatView />
        </main>
      </div>
    </div>
  );
}
```

- [ ] **步骤 2：测试侧边栏功能**

运行 `npm run dev`，验证：
- 会话侧边栏显示
- 可以创建新会话
- 可以切换会话
- 可以删除会话
- 侧边栏可折叠

- [ ] **步骤 3：Commit**

```bash
git add hermes/src/App.tsx
git commit -m "feat: integrate session list into app layout"
```

---

## Phase 2 验收

运行 `npm run dev`，验证：
- [ ] 会话侧边栏正常显示
- [ ] 可以创建、切换、删除会话
- [ ] 工具执行组件渲染正常（虽然暂时没有真实工具调用）
- [ ] 侧边栏可折叠

---

## 实现计划总结

**Phase 1 完成：**
- ✅ RPC 客户端基础架构
- ✅ Zustand Store（messages、session、ui）
- ✅ 聊天组件（输入框、消息列表）
- ✅ 基础应用布局

**Phase 2 完成：**
- ✅ 会话管理（列表、创建、切换、删除）
- ✅ 工具执行可视化
- ✅ 集成布局

**Phase 3（后续）：**
- RPC 客户端完整实现（真实进程通信）
- 扩展 UI 对话框
- 错误处理和加载状态
- 性能优化

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-11-hermes-ui-implementation.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

**选哪种方式？**

