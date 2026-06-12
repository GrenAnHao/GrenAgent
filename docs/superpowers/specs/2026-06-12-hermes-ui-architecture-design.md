# Hermes UI 架构设计

> **日期：** 2026-06-12  
> **状态：** 设计完成，待实施  
> **参考：** PiAgentUI 组件设计  
> **技术栈：** @lobehub/ui + antd-style + zustand

---

## 一、设计目标

将 Hermes 从简单的三栏布局升级为功能完整的 AI Agent UI，参考 PiAgentUI 的设计理念，同时保留 @lobehub/ui 作为基础组件库。

### 核心功能

1. **Resizable Panels** — Sidebar、Right Panel、Terminal 都可拖拽调整大小
2. **Right Panel Tabs** — 支持多标签页（Sub Agent Chat、File Browser、Context）
3. **Terminal Tabs** — 多终端标签页管理
4. **功能完整的 InputBox** — 带 toolbar（Attach、Commands、Mention、Model Selector）
5. **Attachment System** — 图片/文件/文件夹附件
6. **Slash Commands** — / 命令菜单
7. **@ Mention** — 文件/目录引用
8. **Collapsed Capsules** — 权限/问题对话框折叠提示

---

## 二、整体布局架构

### 布局结构

```
┌─ Sidebar ─┬──────── Main (Chat) ─────────┬─ Right Panel (Tabs) ─┐
│ Sessions  │  Messages                    │ ┌Tab1┐┌Tab2┐┌Tab3┐  │
│           │  Input Box                   │ │ Sub-agent Chat    │ │
│           │                              │ │ or File Tree      │ │
│           │                              │ │ or Tools          │ │
└───────────┴──────────────────────────────┴──────────────────────┘
            └── Terminal (tabs) ────────────────────────────────────┘
```

### 层级关系

```
App
├─ Sidebar (full height, left)
│  └─ SessionList
└─ MainContainer (right side)
   ├─ TopContainer (Main + Right Panel)
   │  ├─ ChatView
   │  │  ├─ Header
   │  │  ├─ MessageList
   │  │  └─ InputBox (with toolbar)
   │  ├─ ResizeHandle (vertical)
   │  └─ RightPanel (tabs)
   │     ├─ TabBar
   │     └─ TabContent (SubAgent/Files/Context)
   ├─ ResizeHandle (horizontal)
   └─ TerminalPanel (tabs)
      ├─ TabBar
      └─ TerminalView (xterm.js)
```

### 关键约束

- **Sidebar**：独占左侧，高度 100%，可拖拽调整宽度
- **Main**：单一对话区，无标签页，显示当前 session
- **Right Panel**：多标签页，支持 Sub Agent、Files、Context 等类型
- **Terminal**：只在 Main + Right Panel 下方，不延伸到 Sidebar

---

## 三、状态管理

### 3.1 layoutStore

```typescript
// tauri-agent/src/stores/layoutStore.ts
interface LayoutState {
  sidebarWidth: number
  sidebarOpen: boolean
  rightPanelWidth: number
  rightPanelOpen: boolean
  terminalHeight: number
  terminalOpen: boolean
  
  setSidebarWidth: (width: number) => void
  toggleSidebar: () => void
  setRightPanelWidth: (width: number) => void
  toggleRightPanel: () => void
  setTerminalHeight: (height: number) => void
  toggleTerminal: () => void
}

// 默认值
const DEFAULT_SIDEBAR_WIDTH = 240
const DEFAULT_RIGHT_PANEL_WIDTH = 320
const DEFAULT_TERMINAL_HEIGHT = 200
```

### 3.2 rightPanelStore

```typescript
// tauri-agent/src/stores/rightPanelStore.ts
type RightPanelTabType = 'subagent' | 'files' | 'context'

interface RightPanelTab {
  id: string
  type: RightPanelTabType
  title: string
  data?: any  // 类型特定数据
}

interface RightPanelState {
  tabs: RightPanelTab[]
  activeTabId: string | null
  
  addTab: (tab: Omit<RightPanelTab, 'id'>) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTab: (id: string, updates: Partial<RightPanelTab>) => void
}
```

### 3.3 terminalStore

```typescript
// tauri-agent/src/stores/terminalStore.ts
interface TerminalTab {
  id: string
  title: string
  ptySessionId: string
  status: 'connecting' | 'ready' | 'error'
}

interface TerminalState {
  tabs: TerminalTab[]
  activeTabId: string | null
  
  createTab: (cwd?: string) => Promise<void>
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  renameTab: (id: string, title: string) => void
}
```

### 3.4 sessionStore（已存在）

保持现有结构，无需修改。

---

## 四、核心组件设计

### 4.1 ResizeHandle

**技术方案：** 使用 @lobehub/ui 的 `DraggablePanel`

**位置：**
- Sidebar 右侧边缘
- Main/Right Panel 分隔条
- Terminal 顶部边缘

**实现：**

```typescript
// tauri-agent/src/components/ResizeHandle.tsx
import { DraggablePanel } from '@lobehub/ui'

interface ResizeHandleProps {
  direction: 'vertical' | 'horizontal'
  defaultSize: number
  minSize: number
  maxSize: number
  onResize: (size: number) => void
}

export function ResizeHandle({ direction, defaultSize, minSize, maxSize, onResize }: ResizeHandleProps) {
  return (
    <DraggablePanel
      mode={direction === 'vertical' ? 'left' : 'top'}
      defaultSize={defaultSize}
      minSize={minSize}
      maxSize={maxSize}
      onSizeChange={onResize}
    />
  )
}
```

### 4.2 RightPanel

**技术方案：** 使用 @lobehub/ui 的 `TabsNav` 作为标签栏

**结构：**

```typescript
// tauri-agent/src/features/panels/RightPanel.tsx
import { TabsNav } from '@lobehub/ui'
import { useRightPanelStore } from '../../stores/rightPanelStore'

export function RightPanel() {
  const { tabs, activeTabId, setActiveTab, addTab, closeTab } = useRightPanelStore()
  
  return (
    <Flexbox height="100%" style={{ minHeight: 0 }}>
      <TabsNav
        activeKey={activeTabId}
        items={tabs.map(tab => ({
          key: tab.id,
          label: tab.title,
          closable: true,
        }))}
        onChange={setActiveTab}
        onClose={closeTab}
      />
      <Flexbox flex={1} style={{ minHeight: 0, overflowY: 'auto' }}>
        {activeTab && renderTabContent(activeTab)}
      </Flexbox>
    </Flexbox>
  )
}

function renderTabContent(tab: RightPanelTab) {
  switch (tab.type) {
    case 'subagent':
      return <SubAgentView tabId={tab.id} />
    case 'files':
      return <FileTreeView />
    case 'context':
      return <ContextView />
    default:
      return null
  }
}
```

**Tab 类型：**

1. **SubAgentView** — 子 agent 对话窗口
   - 独立的消息列表
   - 独立的输入框
   - 与主对话独立的状态

2. **FileTreeView** — 文件浏览器
   - 树形目录结构
   - 点击打开文件
   - 支持搜索过滤

3. **ContextView** — 上下文信息
   - Session stats
   - MCP tools 列表
   - 其他元数据

### 4.3 TerminalPanel

**技术方案：** xterm.js + @lobehub/ui TabsNav

**结构：**

```typescript
// tauri-agent/src/features/terminal/TerminalPanel.tsx
import { TabsNav } from '@lobehub/ui'
import { Terminal } from '@xterm/xterm'
import { useTerminalStore } from '../../stores/terminalStore'

export function TerminalPanel() {
  const { tabs, activeTabId, setActiveTab, createTab, closeTab } = useTerminalStore()
  
  return (
    <Flexbox height="100%" style={{ minHeight: 0 }}>
      <Flexbox
        horizontal
        align="center"
        gap={8}
        padding="0 12px"
        style={{ height: 40, borderBottom: '1px solid token.colorBorderSecondary' }}
      >
        <TabsNav
          activeKey={activeTabId}
          items={tabs.map(tab => ({
            key: tab.id,
            label: tab.title,
            closable: true,
          }))}
          onChange={setActiveTab}
          onClose={closeTab}
        />
        <ActionIcon icon={Plus} title="New Terminal" onClick={() => createTab()} />
      </Flexbox>
      <Flexbox flex={1} style={{ minHeight: 0 }}>
        {tabs.map(tab => (
          <TerminalView
            key={tab.id}
            tabId={tab.id}
            visible={tab.id === activeTabId}
          />
        ))}
      </Flexbox>
    </Flexbox>
  )
}
```

**TerminalView：**

```typescript
// tauri-agent/src/features/terminal/TerminalView.tsx
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalViewProps {
  tabId: string
  visible: boolean
}

export function TerminalView({ tabId, visible }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  
  useEffect(() => {
    if (!containerRef.current) return
    
    const terminal = new Terminal({
      theme: {
        background: '#0a0a0a',
        foreground: '#4aff4a',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()
    
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    
    // Connect to PTY session
    connectToPty(tabId, terminal)
    
    return () => {
      terminal.dispose()
    }
  }, [tabId])
  
  return (
    <div
      ref={containerRef}
      style={{
        display: visible ? 'block' : 'none',
        width: '100%',
        height: '100%',
      }}
    />
  )
}
```

### 4.4 InputBox 升级

**技术方案：** 基于 @lobehub/ui 的 `ChatInputArea`

**结构：**

```typescript
// tauri-agent/src/features/chat/InputBox.tsx
import { ChatInputArea } from '@lobehub/ui/chat'
import { InputToolbar } from './InputToolbar'
import { SlashCommandMenu } from './SlashCommandMenu'
import { MentionMenu } from './MentionMenu'
import { AttachmentPreview } from './AttachmentPreview'

interface InputBoxProps {
  onSend: (text: string, attachments: Attachment[]) => Promise<void>
  onAbort: () => void
  isStreaming: boolean
}

export function InputBox({ onSend, onAbort, isStreaming }: InputBoxProps) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  
  const handleInput = (value: string) => {
    setText(value)
    
    // Detect triggers
    if (value.endsWith('/')) setShowSlashMenu(true)
    if (value.endsWith('@')) setShowMentionMenu(true)
  }
  
  const handleSend = async () => {
    if (!text.trim() || isStreaming) return
    await onSend(text, attachments)
    setText('')
    setAttachments([])
  }
  
  return (
    <div style={{
      position: 'absolute',
      bottom: 16,
      left: 16,
      right: 16,
      background: 'rgba(0,0,0,0.85)',
      backdropFilter: 'blur(12px)',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 12,
      padding: 12,
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    }}>
      <InputToolbar
        onAttach={() => /* open file picker */}
        onCommandClick={() => setShowSlashMenu(true)}
        onMentionClick={() => setShowMentionMenu(true)}
      />
      
      {attachments.length > 0 && (
        <AttachmentPreview
          attachments={attachments}
          onRemove={(id) => setAttachments(prev => prev.filter(a => a.id !== id))}
        />
      )}
      
      <Flexbox horizontal align="flex-end" gap={8}>
        <ChatInputArea
          value={text}
          loading={isStreaming}
          placeholder="Type a message..."
          autoSize={{ minRows: 1, maxRows: 8 }}
          onInput={handleInput}
          onSend={handleSend}
        />
        <ActionIcon
          icon={isStreaming ? Square : SendHorizontal}
          onClick={isStreaming ? onAbort : handleSend}
          size="large"
        />
      </Flexbox>
      
      {showSlashMenu && (
        <SlashCommandMenu
          onSelect={(command) => {
            executeCommand(command)
            setShowSlashMenu(false)
          }}
          onClose={() => setShowSlashMenu(false)}
        />
      )}
      
      {showMentionMenu && (
        <MentionMenu
          onSelect={(file) => {
            insertMention(file)
            setShowMentionMenu(false)
          }}
          onClose={() => setShowMentionMenu(false)}
        />
      )}
    </div>
  )
}
```

**InputToolbar：**

```typescript
// tauri-agent/src/features/chat/InputToolbar.tsx
import { Paperclip, Command, AtSign } from 'lucide-react'
import { ActionIcon } from '@lobehub/ui'
import { ModelSelector } from './ModelSelector'

interface InputToolbarProps {
  onAttach: () => void
  onCommandClick: () => void
  onMentionClick: () => void
}

export function InputToolbar({ onAttach, onCommandClick, onMentionClick }: InputToolbarProps) {
  return (
    <Flexbox
      horizontal
      align="center"
      gap={8}
      style={{
        marginBottom: 8,
        paddingBottom: 8,
        borderBottom: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <ActionIcon icon={Paperclip} title="Attach" size="small" onClick={onAttach} />
      <ActionIcon icon={Command} title="Commands" size="small" onClick={onCommandClick} />
      <ActionIcon icon={AtSign} title="Mention" size="small" onClick={onMentionClick} />
      
      <div style={{ marginLeft: 'auto' }}>
        <ModelSelector />
      </div>
    </Flexbox>
  )
}
```

### 4.5 Collapsed Capsules

**用途：** 将权限/问题对话框折叠成小胶囊提示

**实现：**

```typescript
// tauri-agent/src/components/CollapsedCapsule.tsx
import { Flexbox } from '@lobehub/ui'
import { AlertCircle } from 'lucide-react'

interface CollapsedCapsuleProps {
  label: string
  count?: number
  onExpand: () => void
}

export function CollapsedCapsule({ label, count, onExpand }: CollapsedCapsuleProps) {
  return (
    <div
      onClick={onExpand}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        background: 'rgba(74, 158, 255, 0.15)',
        border: '1px solid rgba(74, 158, 255, 0.3)',
        borderRadius: 16,
        cursor: 'pointer',
        fontSize: 13,
      }}
    >
      <AlertCircle size={14} />
      <span>{label}</span>
      {count !== undefined && (
        <span style={{
          background: 'rgba(74, 158, 255, 0.3)',
          padding: '2px 6px',
          borderRadius: 8,
          fontSize: 11,
        }}>
          {count}
        </span>
      )}
    </div>
  )
}
```

---

## 五、四阶段实施计划

### 阶段 1：布局系统 + Resizable（2-3 天）

**目标：** 建立新的布局架构，支持面板 resize

**任务：**
1. 创建 `layoutStore`
2. 重构 `App.tsx` 布局结构
3. 集成 `@lobehub/ui DraggablePanel`
4. 创建 `RightPanel` 骨架
5. 迁移 `TerminalPanel` 到新位置
6. 测试 resize 功能

**交付物：**
- 新布局架构运行正常
- 三个面板可拖拽调整
- 现有对话功能不受影响

### 阶段 2：InputBox 升级 + Model Selector（3-4 天）

**目标：** 升级输入框，添加 toolbar 和 model selector

**任务：**
1. 重构 `ChatInput` 为 `InputBox`
2. 实现 `ModelSelector`
3. 添加 `InputToolbar`（占位符按钮）
4. 保持消息发送逻辑
5. 测试

**交付物：**
- InputBox 带 toolbar 可见
- Model selector 可切换模型
- 消息发送正常

### 阶段 3：Attachment + Commands + Mention（4-5 天）

**目标：** 实现附件、命令和 mention 功能

**任务：**
1. **Attachment System**
   - `AttachmentPreview` 组件
   - 文件上传逻辑
   - 支持图片/PDF/文本
   
2. **Slash Commands**
   - 检测 "/" 触发
   - `SlashCommandMenu` 组件
   - 内置命令：/help, /clear, /new
   
3. **@ Mention**
   - 检测 "@" 触发
   - `MentionMenu` 组件
   - 模糊搜索文件
   - 插入路径

**交付物：**
- 可上传和预览附件
- / 命令菜单可用
- @ mention 文件可用

### 阶段 4：Terminal Tabs + Right Panel + Collapsed Capsules（3-4 天）

**目标：** 实现多标签功能和折叠提示

**任务：**
1. **Terminal Tabs**
   - `terminalStore`
   - TabBar 组件
   - 新建/关闭/重命名
   - 独立 PTY session
   
2. **Right Panel Tabs**
   - `rightPanelStore`
   - TabBar 组件
   - `SubAgentView`
   - `FileTreeView`
   - `ContextView`
   
3. **Collapsed Capsules**
   - `CollapsedCapsule` 组件
   - 权限/问题对话框折叠
   
4. 端到端测试
5. 性能优化

**交付物：**
- Terminal 支持多标签
- Right Panel 可添加多种标签
- Collapsed capsules 可用
- 所有功能整合完成

---

## 六、技术细节

### 6.1 使用 @lobehub/ui 组件

**优先使用的组件：**
- `Flexbox` — 布局容器
- `ActionIcon` — 图标按钮
- `DraggablePanel` — 可拖拽面板
- `TabsNav` — 标签导航
- `ChatInputArea` — 输入框
- `Empty` — 空状态

**自定义组件：**
- `ResizeHandle` — 包装 DraggablePanel
- `SlashCommandMenu` — 命令菜单
- `MentionMenu` — 文件引用菜单
- `AttachmentPreview` — 附件预览
- `CollapsedCapsule` — 折叠提示

### 6.2 样式系统

**继续使用 antd-style：**

```typescript
import { createStyles } from 'antd-style'

const useStyles = createStyles(({ token, css }) => ({
  container: css`
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorder};
    border-radius: ${token.borderRadiusLG}px;
  `,
}))
```

**保持现有主题系统不变。**

### 6.3 状态持久化

**localStorage 存储：**
- `layoutStore` 的面板尺寸
- `rightPanelStore` 的标签列表
- `terminalStore` 的标签列表（不保存 PTY session）

**实现：**

```typescript
// tauri-agent/src/stores/layoutStore.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      // state and actions
    }),
    {
      name: 'hermes-layout',
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        rightPanelWidth: state.rightPanelWidth,
        terminalHeight: state.terminalHeight,
      }),
    }
  )
)
```

### 6.4 PTY Session 管理

**每个 terminal tab 对应一个独立的 PTY session：**

```typescript
// tauri-agent/src/api/pty.ts
import { invoke } from '@tauri-apps/api/core'

export async function createPtySession(options: { cwd?: string }) {
  const id = await invoke<string>('create_pty_session', { cwd: options.cwd })
  return { id, title: 'Terminal' }
}

export async function closePtySession(id: string) {
  await invoke('close_pty_session', { id })
}

export async function writeToPty(id: string, data: string) {
  await invoke('write_to_pty', { id, data })
}
```

---

## 七、验收标准

### 功能完整性

- [ ] Sidebar 可拖拽调整宽度
- [ ] Right Panel 可拖拽调整宽度
- [ ] Terminal 可拖拽调整高度
- [ ] Right Panel 支持多标签页（Sub Agent、Files、Context）
- [ ] Terminal 支持多标签页
- [ ] InputBox 带 toolbar（Attach、Commands、Mention、Model）
- [ ] 可上传附件（图片、文件）
- [ ] Slash commands 菜单可用
- [ ] @ mention 文件可用
- [ ] Collapsed capsules 显示正常
- [ ] Model selector 可切换模型
- [ ] 所有面板尺寸保存到 localStorage

### 性能要求

- [ ] Resize 拖拽流畅（60fps）
- [ ] 标签页切换无延迟
- [ ] Terminal 输入响应 < 50ms
- [ ] 消息列表滚动流畅

### 兼容性

- [ ] 现有对话功能正常
- [ ] 现有消息历史保留
- [ ] 现有 session 管理不受影响

---

## 八、风险和缓解

### 风险 1：@lobehub/ui DraggablePanel 不符合需求

**缓解：** 如果 DraggablePanel API 不够灵活，可以参考 PiAgentUI 自定义实现 ResizeHandle。

### 风险 2：xterm.js 性能问题

**缓解：** 限制 terminal 历史行数，使用虚拟滚动，延迟渲染非活跃 tab。

### 风险 3：状态管理复杂度增加

**缓解：** 拆分 store（layout、rightPanel、terminal），职责清晰，避免单一巨型 store。

### 风险 4：实施周期超预期

**缓解：** 每个阶段独立验收，可以根据实际进度调整后续阶段的范围。

---

## 九、后续优化方向

1. **快捷键支持** — 切换标签、打开/关闭面板、聚焦输入框
2. **主题定制** — 更多颜色主题选项
3. **Command Palette** — Cmd/Ctrl+K 快捷命令面板
4. **Split Panes（可选）** — 如果未来需要左右分屏对话
5. **语音输入（可选）** — 如果需要语音转文字功能

---

## 十、总结

本设计采用渐进式迁移策略，分四个阶段逐步升级 Hermes UI：

1. **阶段 1** — 建立核心布局架构
2. **阶段 2** — 升级输入框功能
3. **阶段 3** — 实现附件和命令系统
4. **阶段 4** — 完成标签页和折叠提示

总开发周期：**12-16 天（约 2-3 周）**

设计充分利用 @lobehub/ui 的现成组件，减少重复开发，同时参考 PiAgentUI 的成熟设计，确保功能完整性和用户体验。
