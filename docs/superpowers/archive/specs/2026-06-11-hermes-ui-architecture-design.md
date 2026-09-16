# Hermes UI 架构设计

> 设计日期：2026-06-11  
> 设计目标：基于 Pi Agent 能力，建立清晰、可扩展的 UI 层架构  
> 参考架构：PiAgentUI (feature-based) + LobeUI (组件库)

---

## 1. 架构原则

### 1.1 三大支柱

**分层清晰（Layered）**
- RPC 通信层 → Store 状态层 → Feature 业务层 → Component 展示层
- 单向数据流：RPC Events → Store Actions → UI Updates
- 每层职责单一，接口明确

**功能内聚（Feature-based）**
- 按功能域组织（chat/sessions/tools/controls）
- 每个 feature 独立可测试
- 避免跨 feature 依赖

**渐进增强（Progressive）**
- P0 核心功能优先（chat + sessions）
- P1/P2 功能后续迭代
- 预留扩展接口

### 1.2 设计约束

- 技术栈：React 19.2 + TypeScript + Zustand + LobeUI
- 通信协议：JSONL over stdin/stdout (RPC)
- 支持平台：Tauri Desktop（Web 可选）
- 不自己实现：会话持久化、工具执行（由 Pi Agent 负责）

---

## 2. 目录结构

```
hermes/
├── src/
│   ├── lib/
│   │   ├── pi-rpc.ts           # RPC 客户端核心
│   │   └── types.ts            # Pi Agent 类型定义
│   │
│   ├── store/
│   │   ├── session.ts          # 会话状态（Zustand）
│   │   ├── messages.ts         # 消息流状态
│   │   ├── ui.ts               # UI 状态（侧边栏、面板）
│   │   └── index.ts            # Store 导出
│   │
│   ├── features/
│   │   ├── chat/
│   │   │   ├── ChatView.tsx          # 聊天容器
│   │   │   ├── MessageList.tsx       # 消息列表
│   │   │   ├── UserMessage.tsx       # 用户消息
│   │   │   ├── AssistantMessage.tsx  # 助手消息
│   │   │   ├── ThinkingBlock.tsx     # Thinking 块
│   │   │   └── ChatInput.tsx         # 输入框
│   │   │
│   │   ├── sessions/
│   │   │   ├── SessionList.tsx       # 会话列表
│   │   │   ├── SessionItem.tsx       # 会话项
│   │   │   └── SessionHeader.tsx     # 会话头部
│   │   │
│   │   ├── tools/
│   │   │   ├── ToolExecution.tsx     # 工具执行卡片
│   │   │   ├── BashExecution.tsx     # Bash 执行
│   │   │   └── ToolResult.tsx        # 工具结果
│   │   │
│   │   ├── controls/
│   │   │   ├── ModelSelector.tsx     # 模型选择器
│   │   │   ├── ThinkingLevelControl.tsx
│   │   │   └── ActionBar.tsx         # 操作栏
│   │   │
│   │   └── extension-ui/
│   │       ├── ExtensionSelect.tsx   # 选择对话框
│   │       ├── ExtensionConfirm.tsx  # 确认对话框
│   │       └── ExtensionInput.tsx    # 输入对话框
│   │
│   ├── components/ui/          # 基础 UI 组件（LobeUI）
│   │   └── index.ts            # 统一导出
│   │
│   ├── hooks/
│   │   ├── useRpcClient.ts     # RPC 客户端钩子
│   │   ├── useMessages.ts      # 消息流钩子
│   │   └── useSession.ts       # 会话钩子
│   │
│   ├── App.tsx                 # 应用入口
│   └── main.tsx                # React 挂载
│
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## 3. 数据流设计

### 3.1 整体数据流

```
Pi Agent Process (RPC)
  ↓ (JSONL Events)
RPC Client (lib/pi-rpc.ts)
  ↓ (Event Handlers)
Zustand Stores (store/*)
  ↓ (Selectors)
React Components (features/*)
  ↓ (User Actions)
RPC Commands
  ↓
Pi Agent Process
```

### 3.2 Store 设计

**SessionStore (store/session.ts)**
```typescript
interface SessionStore {
  // 状态
  sessions: SessionInfo[];
  activeSessionPath: string | null;
  isLoading: boolean;
  error: string | null;
  
  // 操作
  setSessions: (sessions: SessionInfo[]) => void;
  setActiveSession: (path: string) => void;
  createSession: () => Promise<void>;
  switchSession: (path: string) => Promise<void>;
  deleteSession: (path: string) => Promise<void>;
  renameSession: (path: string, name: string) => Promise<void>;
}
```

**MessageStore (store/messages.ts)**
```typescript
interface MessageStore {
  // 状态
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  isStreaming: boolean;
  toolExecutions: Map<string, ToolExecution>;
  
  // 操作
  addMessage: (msg: AgentMessage) => void;
  updateStreamingMessage: (delta: string) => void;
  finishStreaming: () => void;
  clearMessages: () => void;
  addToolExecution: (toolCallId: string, execution: ToolExecution) => void;
  updateToolExecution: (toolCallId: string, update: Partial<ToolExecution>) => void;
}
```

**UIStore (store/ui.ts)**
```typescript
interface UIStore {
  // 状态
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;
  theme: 'light' | 'dark' | 'auto';
  extensionUIRequests: Map<string, ExtensionUIRequest>;
  
  // 操作
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setTheme: (theme: 'light' | 'dark' | 'auto') => void;
  addExtensionUIRequest: (id: string, request: ExtensionUIRequest) => void;
  resolveExtensionUIRequest: (id: string, response: any) => void;
}
```

---

## 4. RPC 通信层

### 4.1 核心类设计

```typescript
// lib/pi-rpc.ts
class PiRpcClient {
  private process: ChildProcess;
  private eventHandlers: Map<string, Set<(event: AgentEvent) => void>>;
  private pendingRequests: Map<string, (response: RpcResponse) => void>;
  private messageBuffer: string = '';
  
  // 启动 Pi Agent 进程
  async start(cwd: string, config: RpcConfig): Promise<void>;
  
  // 发送命令
  async send<T = any>(command: RpcCommand): Promise<RpcResponse<T>>;
  
  // 订阅事件
  on(eventType: string, handler: (event: AgentEvent) => void): () => void;
  
  // 快捷方法
  async prompt(message: string, images?: ImageContent[]): Promise<void>;
  async abort(): Promise<void>;
  async steer(message: string): Promise<void>;
  async switchSession(path: string): Promise<RpcResponse>;
  async newSession(parentSession?: string): Promise<string>;
  async getMessages(): Promise<AgentMessage[]>;
  async getState(): Promise<AgentState>;
  async setModel(provider: string, modelId: string): Promise<void>;
  async setThinkingLevel(level: ThinkingLevel): Promise<void>;
  async compact(customInstructions?: string): Promise<void>;
  async bash(command: string, excludeFromContext?: boolean): Promise<void>;
  
  // 扩展 UI 响应
  respondToExtensionUI(requestId: string, response: ExtensionUIResponse): void;
  
  // 清理
  async destroy(): Promise<void>;
}
```

### 4.2 类型定义

```typescript
// lib/types.ts
export type RpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: ImageContent[] }
  | { id?: string; type: "steer"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "bash"; command: string; excludeFromContext?: boolean };

export interface RpcResponse<T = any> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export type AgentEvent =
  | { type: "agent_start"; timestamp: number }
  | { type: "agent_end"; timestamp: number }
  | { type: "message_start"; role: string; timestamp: number }
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; timestamp: number }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; params: any }
  | { type: "tool_execution_update"; toolCallId: string; content: string }
  | { type: "tool_execution_end"; toolCallId: string; result: ToolResult }
  | { type: "turn_start"; timestamp: number }
  | { type: "turn_end"; timestamp: number }
  | { type: "extension_ui_request"; id: string; method: string; [key: string]: any };

export interface AgentMessage {
  role: "user" | "assistant" | "toolResult" | "bashExecution" | "custom";
  content: string | ContentPart[];
  timestamp: number;
  thinking?: string;
  tools?: ToolCall[];
}

export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  params: any;
  status: "running" | "success" | "error";
  result?: ToolResult;
  startTime: number;
  endTime?: number;
}
```

---

## 5. Feature 模块设计

### 5.1 Chat Feature

**ChatView.tsx（容器）**
```typescript
export function ChatView() {
  const messages = useMessageStore(state => state.messages);
  const streamingMessage = useMessageStore(state => state.streamingMessage);
  const toolExecutions = useMessageStore(state => state.toolExecutions);
  
  return (
    <div className="flex flex-col h-full">
      <MessageList 
        messages={messages}
        streamingMessage={streamingMessage}
        toolExecutions={toolExecutions}
      />
      <ChatInput />
    </div>
  );
}
```

**MessageList.tsx（使用 LobeUI）**
```typescript
import { ChatList } from '@lobehub/ui/chat';

export function MessageList({ messages, streamingMessage, toolExecutions }) {
  const formattedMessages = useMemo(() => {
    return messages.map(msg => ({
      id: msg.timestamp.toString(),
      role: msg.role,
      content: msg.content,
      createdAt: msg.timestamp,
      extra: {
        thinking: msg.thinking,
        tools: msg.tools,
      },
    }));
  }, [messages]);
  
  return (
    <ChatList
      data={formattedMessages}
      renderMessages={{
        assistant: (props) => <AssistantMessage {...props} />,
        user: (props) => <UserMessage {...props} />,
      }}
    />
  );
}
```

**ChatInput.tsx（使用 LobeUI）**
```typescript
import { ChatInputArea } from '@lobehub/ui/chat';

export function ChatInput() {
  const rpcClient = useRpcClient();
  const isStreaming = useMessageStore(state => state.isStreaming);
  
  const handleSend = async (message: string) => {
    await rpcClient.prompt(message);
  };
  
  const handleAbort = async () => {
    await rpcClient.abort();
  };
  
  return (
    <ChatInputArea
      onSend={handleSend}
      onStop={handleAbort}
      loading={isStreaming}
      placeholder="Type a message..."
    />
  );
}
```

### 5.2 Sessions Feature

**SessionList.tsx（使用 LobeUI）**
```typescript
import { List, ActionIcon } from '@lobehub/ui';
import { Plus, Trash2 } from 'lucide-react';

export function SessionList() {
  const sessions = useSessionStore(state => state.sessions);
  const activeSessionPath = useSessionStore(state => state.activeSessionPath);
  const switchSession = useSessionStore(state => state.switchSession);
  const createSession = useSessionStore(state => state.createSession);
  const deleteSession = useSessionStore(state => state.deleteSession);
  
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b">
        <ActionIcon icon={Plus} onClick={createSession} title="New Session" />
      </div>
      <List>
        {sessions.map(session => (
          <SessionItem
            key={session.path}
            session={session}
            active={session.path === activeSessionPath}
            onSelect={() => switchSession(session.path)}
            onDelete={() => deleteSession(session.path)}
          />
        ))}
      </List>
    </div>
  );
}
```

### 5.3 Tools Feature

**ToolExecution.tsx**
```typescript
import { Alert, Markdown } from '@lobehub/ui';

export function ToolExecution({ execution }: { execution: ToolExecution }) {
  const { toolName, params, status, result } = execution;
  
  return (
    <Alert
      type={status === 'error' ? 'error' : 'info'}
      showIcon
      className="my-2"
    >
      <div className="font-mono text-sm">
        <div className="font-bold">{toolName}</div>
        <div className="text-gray-500">
          {JSON.stringify(params, null, 2)}
        </div>
        {result && (
          <div className="mt-2">
            <Markdown>{result.content}</Markdown>
          </div>
        )}
      </div>
    </Alert>
  );
}
```

### 5.4 Controls Feature

**ModelSelector.tsx**
```typescript
import { Select } from '@lobehub/ui';

export function ModelSelector() {
  const rpcClient = useRpcClient();
  const [models, setModels] = useState<Model[]>([]);
  const [currentModel, setCurrentModel] = useState<string>();
  
  useEffect(() => {
    rpcClient.send({ type: 'get_available_models' })
      .then(res => setModels(res.data));
  }, []);
  
  const handleChange = async (value: string) => {
    const [provider, modelId] = value.split(':');
    await rpcClient.setModel(provider, modelId);
  };
  
  return (
    <Select
      value={currentModel}
      onChange={handleChange}
      options={models.map(m => ({
        label: `${m.provider} - ${m.id}`,
        value: `${m.provider}:${m.id}`,
      }))}
    />
  );
}
```

---

## 6. 布局设计

### 6.1 整体布局

```typescript
// App.tsx
import { ThemeProvider } from '@lobehub/ui';
import { LayoutSidebar, DraggablePanel } from '@lobehub/ui';

export default function App() {
  const sidebarOpen = useUIStore(state => state.sidebarOpen);
  const rightPanelOpen = useUIStore(state => state.rightPanelOpen);
  
  return (
    <ThemeProvider>
      <div className="flex h-screen">
        {/* 左侧边栏 - 会话列表 */}
        {sidebarOpen && (
          <LayoutSidebar width={280}>
            <SessionList />
          </LayoutSidebar>
        )}
        
        {/* 主内容区 - 聊天 */}
        <div className="flex-1 flex flex-col">
          <ChatView />
        </div>
        
        {/* 右侧面板 - 上下文/设置 */}
        {rightPanelOpen && (
          <DraggablePanel placement="right" defaultSize={{ width: 320 }}>
            <ContextPanel />
          </DraggablePanel>
        )}
      </div>
      
      {/* 扩展 UI 对话框 */}
      <ExtensionUIHandler />
    </ThemeProvider>
  );
}
```

---

## 7. 实现路线图

### Phase 1：MVP（2-3 天）

**目标**：基本可用的聊天界面

- [ ] RPC 客户端实现（lib/pi-rpc.ts）
- [ ] 类型定义（lib/types.ts）
- [ ] SessionStore + MessageStore（store/）
- [ ] SessionList（features/sessions/）
- [ ] ChatView + MessageList（features/chat/）
- [ ] ChatInput（features/chat/）
- [ ] 基础布局（App.tsx）

**验收标准**：
- 能创建/切换会话
- 能发送消息并看到流式响应
- 消息正确分角色展示

### Phase 2：核心增强（2-3 天）

**目标**：完整的消息交互

- [ ] AssistantMessage 组件（支持 Thinking）
- [ ] ToolExecution 组件（工具可视化）
- [ ] BashExecution 组件
- [ ] ModelSelector（features/controls/）
- [ ] ActionBar（abort/steer）
- [ ] ThinkingBlock 折叠展开

**验收标准**：
- 工具调用可视化
- 支持中断执行
- Thinking 内容可折叠
- 可切换模型

### Phase 3：体验优化（1-2 天）

**目标**：扩展功能和错误处理

- [ ] ExtensionUIHandler（features/extension-ui/）
- [ ] 错误提示和重试
- [ ] 加载状态
- [ ] 会话重命名
- [ ] 消息复制/编辑

**验收标准**：
- 扩展 UI 请求正常响应
- 错误有友好提示
- 所有操作有加载状态

---

## 8. 组件扩展机制

### 8.1 三层组件体系

```
基础层（components/ui/）
  ↓ 导入
功能层（features/*/）
  ↓ 组合
布局层（App.tsx）
```

### 8.2 扩展点

**消息类型扩展**
```typescript
// features/chat/MessageList.tsx
const messageRenderers = {
  assistant: AssistantMessage,
  user: UserMessage,
  tool: ToolMessage,
  bash: BashMessage,
  // 可扩展：自定义消息类型
};
```

**工具可视化扩展**
```typescript
// features/tools/ToolRegistry.tsx
const toolComponents = {
  read: ReadToolResult,
  write: WriteToolResult,
  bash: BashToolResult,
  // 可扩展：自定义工具展示
};
```

**主题扩展**
```typescript
// App.tsx
<ThemeProvider theme={{
  colorPrimary: '#1890ff',
  borderRadius: 8,
  // 可扩展：自定义颜色、字体
}}>
```

---

## 9. 技术栈

### 9.1 核心依赖

```json
{
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
    "@tauri-apps/cli": "^2",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "~5.6.2",
    "vite": "^6.0.3"
  }
}
```

### 9.2 Vite 配置

```typescript
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['@lobehub/ui'],
  },
  build: {
    transpileDependencies: ['@lobehub/ui'],
  },
});
```

---

## 10. 性能优化

### 10.1 渲染优化

- 使用 Zustand selector 避免过度渲染
- 消息列表虚拟滚动（长对话场景）
- 流式消息使用 requestAnimationFrame 节流
- 工具结果懒加载（大文件内容）

### 10.2 内存优化

- 限制内存中消息数量（超过阈值压缩历史）
- 工具执行结果按需展开
- 及时清理已销毁组件的事件监听器

---

## 11. 测试策略

### 11.1 单元测试

- RPC 客户端逻辑（mock 进程通信）
- Store actions 和 selectors
- 纯展示组件（快照测试）

### 11.2 集成测试

- RPC 事件流处理
- Store 和组件交互
- 扩展 UI 请求/响应流程

### 11.3 E2E 测试

- 会话创建/切换流程
- 消息发送和响应
- 工具调用可视化

---

## 12. 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| RPC 进程异常退出 | 高 | 进程监控 + 自动重启 |
| 流式消息解析错误 | 中 | JSONL 解析容错 + 错误边界 |
| LobeUI 版本兼容性 | 低 | 锁定版本 + 测试覆盖 |
| 消息列表性能问题 | 中 | 虚拟滚动 + 懒加载 |

---

## 13. 总结

Hermes 架构基于以下核心理念：

1. **职责分离**：RPC ↔ Store ↔ Feature ↔ Component 各层边界清晰
2. **功能内聚**：按功能域组织，易于维护和扩展
3. **组件复用**：全面基于 LobeUI，减少重复开发
4. **渐进实现**：P0 → P1 → P2 分阶段交付

预计开发周期：
- Phase 1（MVP）：2-3 天
- Phase 2（核心增强）：2-3 天  
- Phase 3（体验优化）：1-2 天
- **总计**：5-8 天

下一步：编写实现计划（调用 writing-plans 技能）。
