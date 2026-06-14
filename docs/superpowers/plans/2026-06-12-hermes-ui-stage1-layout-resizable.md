# Hermes UI 重构 - 阶段 1：布局系统 + Resizable 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立新的布局架构（Sidebar | Main+Right | Terminal），支持面板 resize，保持现有对话功能可用。

**架构：** 使用 @lobehub/ui DraggablePanel 实现 resize，创建 layoutStore 管理面板尺寸，重构 App.tsx 为新的三区域布局。

**技术栈：** React + @lobehub/ui + zustand + antd-style + TypeScript

---

## 文件结构

### 新建文件

- `tauri-agent/src/stores/layoutStore.ts` — 布局状态管理（面板尺寸、开关）
- `tauri-agent/src/stores/layoutStore.test.ts` — layoutStore 单元测试
- `tauri-agent/src/components/ResizeHandle.tsx` — 通用 resize handle 组件
- `tauri-agent/src/features/panels/RightPanel.tsx` — 右侧面板骨架
- `tauri-agent/src/features/panels/index.ts` — panels 导出

### 修改文件

- `tauri-agent/src/App.tsx` — 重构为新布局结构
- `tauri-agent/src/features/terminal/TerminalPanel.tsx` — 调整为新位置
- `tauri-agent/src/features/sessions/SessionList.tsx` — 微调样式适配新布局

---

## 任务 1：创建 layoutStore

**文件：**
- 创建：`tauri-agent/src/stores/layoutStore.ts`
- 创建：`tauri-agent/src/stores/layoutStore.test.ts`

- [ ] **步骤 1：编写 layoutStore 测试**

```typescript
// tauri-agent/src/stores/layoutStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayoutStore } from './layoutStore'

describe('layoutStore', () => {
  beforeEach(() => {
    useLayoutStore.setState({
      sidebarWidth: 240,
      sidebarOpen: true,
      rightPanelWidth: 320,
      rightPanelOpen: false,
      terminalHeight: 200,
      terminalOpen: false,
    })
  })

  it('should have default values', () => {
    const state = useLayoutStore.getState()
    expect(state.sidebarWidth).toBe(240)
    expect(state.rightPanelWidth).toBe(320)
    expect(state.terminalHeight).toBe(200)
  })

  it('should update sidebar width', () => {
    useLayoutStore.getState().setSidebarWidth(300)
    expect(useLayoutStore.getState().sidebarWidth).toBe(300)
  })

  it('should toggle sidebar', () => {
    useLayoutStore.getState().toggleSidebar()
    expect(useLayoutStore.getState().sidebarOpen).toBe(false)
    useLayoutStore.getState().toggleSidebar()
    expect(useLayoutStore.getState().sidebarOpen).toBe(true)
  })

  it('should update right panel width', () => {
    useLayoutStore.getState().setRightPanelWidth(400)
    expect(useLayoutStore.getState().rightPanelWidth).toBe(400)
  })

  it('should toggle right panel', () => {
    useLayoutStore.getState().toggleRightPanel()
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true)
    useLayoutStore.getState().toggleRightPanel()
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false)
  })

  it('should update terminal height', () => {
    useLayoutStore.getState().setTerminalHeight(300)
    expect(useLayoutStore.getState().terminalHeight).toBe(300)
  })

  it('should toggle terminal', () => {
    useLayoutStore.getState().toggleTerminal()
    expect(useLayoutStore.getState().terminalOpen).toBe(true)
    useLayoutStore.getState().toggleTerminal()
    expect(useLayoutStore.getState().terminalOpen).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- layoutStore.test.ts
```

预期：FAIL，报错 "Cannot find module './layoutStore'"

- [ ] **步骤 3：实现 layoutStore**

```typescript
// tauri-agent/src/stores/layoutStore.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const DEFAULT_SIDEBAR_WIDTH = 240
const DEFAULT_RIGHT_PANEL_WIDTH = 320
const DEFAULT_TERMINAL_HEIGHT = 200

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

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      sidebarOpen: true,
      rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
      rightPanelOpen: false,
      terminalHeight: DEFAULT_TERMINAL_HEIGHT,
      terminalOpen: false,

      setSidebarWidth: (width: number) =>
        set({ sidebarWidth: Math.max(180, Math.min(width, 600)) }),
      
      toggleSidebar: () =>
        set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      
      setRightPanelWidth: (width: number) =>
        set({ rightPanelWidth: Math.max(200, Math.min(width, 800)) }),
      
      toggleRightPanel: () =>
        set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
      
      setTerminalHeight: (height: number) =>
        set({ terminalHeight: Math.max(100, Math.min(height, 600)) }),
      
      toggleTerminal: () =>
        set((state) => ({ terminalOpen: !state.terminalOpen })),
    }),
    {
      name: 'hermes-layout',
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        rightPanelWidth: state.rightPanelWidth,
        terminalHeight: state.terminalHeight,
        sidebarOpen: state.sidebarOpen,
        rightPanelOpen: state.rightPanelOpen,
        terminalOpen: state.terminalOpen,
      }),
    }
  )
)
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- layoutStore.test.ts
```

预期：PASS，所有测试通过

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/stores/layoutStore.ts tauri-agent/src/stores/layoutStore.test.ts
git commit -m "feat(layout): add layoutStore for panel size management

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 2：创建 ResizeHandle 组件

**文件：**
- 创建：`tauri-agent/src/components/ResizeHandle.tsx`

- [ ] **步骤 1：实现 ResizeHandle 包装组件**

```typescript
// tauri-agent/src/components/ResizeHandle.tsx
import { DraggablePanel, type DraggablePanelProps } from '@lobehub/ui'

interface ResizeHandleProps {
  direction: 'vertical' | 'horizontal'
  defaultSize: number
  minSize: number
  maxSize: number
  onResize: (size: number) => void
  children?: React.ReactNode
}

export function ResizeHandle({
  direction,
  defaultSize,
  minSize,
  maxSize,
  onResize,
  children,
}: ResizeHandleProps) {
  const mode: DraggablePanelProps['mode'] = direction === 'vertical' ? 'left' : 'top'

  return (
    <DraggablePanel
      mode={mode}
      defaultSize={defaultSize}
      minWidth={direction === 'vertical' ? minSize : undefined}
      maxWidth={direction === 'vertical' ? maxSize : undefined}
      minHeight={direction === 'horizontal' ? minSize : undefined}
      maxHeight={direction === 'horizontal' ? maxSize : undefined}
      onSizeChange={onResize}
    >
      {children}
    </DraggablePanel>
  )
}
```

- [ ] **步骤 2：验证组件编译**

```bash
npm run typecheck
```

预期：无类型错误

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/components/ResizeHandle.tsx
git commit -m "feat(components): add ResizeHandle wrapper for DraggablePanel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 3：创建 RightPanel 骨架

**文件：**
- 创建：`tauri-agent/src/features/panels/RightPanel.tsx`
- 创建：`tauri-agent/src/features/panels/index.ts`

- [ ] **步骤 1：实现 RightPanel 空骨架**

```typescript
// tauri-agent/src/features/panels/RightPanel.tsx
import { Flexbox } from '@lobehub/ui'
import { createStyles } from 'antd-style'

const useStyles = createStyles(({ token, css }) => ({
  container: css`
    background: ${token.colorBgContainer};
    border-left: 1px solid ${token.colorBorder};
    height: 100%;
  `,
  header: css`
    height: 64px;
    border-bottom: 1px solid ${token.colorBorder};
    padding: 0 16px;
  `,
  content: css`
    flex: 1;
    min-height: 0;
    padding: 16px;
    color: ${token.colorTextSecondary};
  `,
}))

export function RightPanel() {
  const { styles } = useStyles()

  return (
    <Flexbox className={styles.container}>
      <Flexbox
        horizontal
        align="center"
        className={styles.header}
      >
        <span style={{ fontWeight: 600, fontSize: 14 }}>Panel</span>
      </Flexbox>
      <Flexbox className={styles.content}>
        <div>Right panel placeholder (tabs will be added in stage 4)</div>
      </Flexbox>
    </Flexbox>
  )
}
```

- [ ] **步骤 2：创建导出文件**

```typescript
// tauri-agent/src/features/panels/index.ts
export { RightPanel } from './RightPanel'
```

- [ ] **步骤 3：验证编译**

```bash
npm run typecheck
```

预期：无类型错误

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/features/panels/
git commit -m "feat(panels): add RightPanel skeleton component

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 4：重构 App.tsx 布局

**文件：**
- 修改：`tauri-agent/src/App.tsx`

- [ ] **步骤 1：读取现有 App.tsx 理解结构**

```bash
cat tauri-agent/src/App.tsx
```

- [ ] **步骤 2：备份现有布局逻辑到注释**

在 App.tsx 顶部添加注释：
```typescript
/* 
 * Layout V2: Sidebar | (Main + Right) | Terminal
 * - Sidebar: full height, left, resizable
 * - Main + Right: top area, Main is chat, Right is panel tabs
 * - Terminal: bottom area, only under Main+Right, resizable height
 */
```

- [ ] **步骤 3：重构 App.tsx 为新布局**

```typescript
// tauri-agent/src/App.tsx
import { Flexbox } from '@lobehub/ui'
import { createStyles } from 'antd-style'
import { SessionList } from './features/sessions'
import { ChatView } from './features/chat'
import { TerminalPanel } from './features/terminal'
import { RightPanel } from './features/panels'
import { ResizeHandle } from './components/ResizeHandle'
import { useLayoutStore } from './stores/layoutStore'

const useStyles = createStyles(({ token, css }) => ({
  root: css`
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: ${token.colorBgLayout};
  `,
  sidebar: css`
    background: ${token.colorBgContainer};
    border-right: 1px solid ${token.colorBorder};
    height: 100%;
  `,
}))

export function App() {
  const { styles } = useStyles()
  const {
    sidebarWidth,
    setSidebarWidth,
    rightPanelWidth,
    setRightPanelWidth,
    rightPanelOpen,
    terminalHeight,
    setTerminalHeight,
    terminalOpen,
  } = useLayoutStore()

  return (
    <Flexbox horizontal className={styles.root}>
      {/* Sidebar */}
      <ResizeHandle
        direction="vertical"
        defaultSize={sidebarWidth}
        minSize={180}
        maxSize={600}
        onResize={setSidebarWidth}
      >
        <div className={styles.sidebar} style={{ width: sidebarWidth }}>
          <SessionList
            onCreateSession={async () => {}}
            onSwitchSession={async () => {}}
            onDeleteSession={async () => {}}
          />
        </div>
      </ResizeHandle>

      {/* Right Container: (Main + Right) + Terminal */}
      <Flexbox flex={1} style={{ minWidth: 0 }}>
        {/* Top: Main + Right Panel */}
        <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
          {/* Main Chat Area */}
          <Flexbox flex={1} style={{ minWidth: 0 }}>
            <ChatView />
          </Flexbox>

          {/* Right Panel */}
          {rightPanelOpen && (
            <ResizeHandle
              direction="vertical"
              defaultSize={rightPanelWidth}
              minSize={200}
              maxSize={800}
              onResize={setRightPanelWidth}
            >
              <div style={{ width: rightPanelWidth, height: '100%' }}>
                <RightPanel />
              </div>
            </ResizeHandle>
          )}
        </Flexbox>

        {/* Terminal Panel */}
        {terminalOpen && (
          <ResizeHandle
            direction="horizontal"
            defaultSize={terminalHeight}
            minSize={100}
            maxSize={600}
            onResize={setTerminalHeight}
          >
            <div style={{ height: terminalHeight, width: '100%' }}>
              <TerminalPanel />
            </div>
          </ResizeHandle>
        )}
      </Flexbox>
    </Flexbox>
  )
}
```

- [ ] **步骤 4：验证编译**

```bash
npm run typecheck
```

预期：无类型错误

- [ ] **步骤 5：启动开发服务器测试布局**

```bash
npm run dev
```

手动验证：
- Sidebar 显示在左侧
- ChatView 显示在中间
- 布局不崩溃

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/App.tsx
git commit -m "refactor(app): restructure layout to Sidebar | Main+Right | Terminal

BREAKING CHANGE: App layout completely restructured

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 5：调整 SessionList 样式适配新布局

**文件：**
- 修改：`tauri-agent/src/features/sessions/SessionList.tsx:40-50`

- [ ] **步骤 1：读取现有 SessionList 代码**

```bash
cat tauri-agent/src/features/sessions/SessionList.tsx | head -70
```

- [ ] **步骤 2：调整 header 高度为 64px 与主区域对齐**

找到 SessionList 的 header Flexbox，修改：

```typescript
// 修改前（示例）
<Flexbox
  horizontal
  align="center"
  distribution="space-between"
  padding="0 16px"
  style={{ height: 64 }}  // 确保是 64px
>
  <Text strong size={16}>Sessions</Text>
  <ActionIcon icon={Plus} title="New Session" onClick={() => void onCreateSession()} />
</Flexbox>
```

- [ ] **步骤 3：确保 Empty 状态垂直居中**

确保 SessionList 的空状态有 `align="center" justify="center"`：

```typescript
<Flexbox flex={1} style={{ minHeight: 0, overflowY: 'auto' }} align="center" justify="center">
  {items.length === 0 ? (
    <Empty description="No sessions" style={{ margin: '2rem 0' }} />
  ) : (
    <List
      items={items}
      activeKey={activeSessionPath ?? undefined}
      onClick={({ key }) => void onSwitchSession(key)}
    />
  )}
</Flexbox>
```

- [ ] **步骤 4：验证编译和运行**

```bash
npm run typecheck
npm run dev
```

手动验证：Sessions header 高度与 Main header 对齐

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/sessions/SessionList.tsx
git commit -m "style(sessions): align SessionList header height with main area

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 6：调整 TerminalPanel 到新位置

**文件：**
- 修改：`tauri-agent/src/features/terminal/TerminalPanel.tsx`

- [ ] **步骤 1：读取现有 TerminalPanel**

```bash
cat tauri-agent/src/features/terminal/TerminalPanel.tsx
```

- [ ] **步骤 2：确保 TerminalPanel 高度为 100%**

确保根容器使用 `height: 100%` 而不是固定高度：

```typescript
// tauri-agent/src/features/terminal/TerminalPanel.tsx
export function TerminalPanel() {
  return (
    <Flexbox style={{ height: '100%', minHeight: 0 }}>
      {/* 现有内容保持不变 */}
    </Flexbox>
  )
}
```

- [ ] **步骤 3：验证 terminal 在新布局中显示正常**

```bash
npm run dev
```

手动验证：
- 打开 terminal（如果有开关按钮）
- Terminal 显示在 Main+Right 下方
- Terminal 不延伸到 Sidebar 下方

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/features/terminal/TerminalPanel.tsx
git commit -m "refactor(terminal): adjust TerminalPanel for new layout position

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 7：添加 toggle 按钮到 Header

**文件：**
- 修改：`tauri-agent/src/features/chat/ChatView.tsx`

- [ ] **步骤 1：读取 ChatView 找到 Header**

```bash
grep -n "Header" tauri-agent/src/features/chat/ChatView.tsx
```

- [ ] **步骤 2：添加 toggle 按钮到 Header**

在 ChatView 的 Header 中添加 Right Panel 和 Terminal toggle 按钮：

```typescript
// tauri-agent/src/features/chat/ChatView.tsx
import { ActionIcon, Flexbox } from '@lobehub/ui'
import { PanelRight, Terminal as TerminalIcon } from 'lucide-react'
import { useLayoutStore } from '../../stores/layoutStore'

// 在 Header 中添加
<Flexbox
  horizontal
  align="center"
  justify="space-between"
  style={{
    height: 64,
    borderBottom: '1px solid token.colorBorder',
    padding: '0 24px',
  }}
>
  <span style={{ fontWeight: 700, fontSize: 16 }}>Hermes</span>
  <Flexbox horizontal gap={8}>
    <ActionIcon
      icon={PanelRight}
      title="Toggle Right Panel"
      onClick={() => useLayoutStore.getState().toggleRightPanel()}
    />
    <ActionIcon
      icon={TerminalIcon}
      title="Toggle Terminal"
      onClick={() => useLayoutStore.getState().toggleTerminal()}
    />
  </Flexbox>
</Flexbox>
```

- [ ] **步骤 3：验证按钮功能**

```bash
npm run dev
```

手动验证：
- 点击 PanelRight 按钮，Right Panel 显示/隐藏
- 点击 Terminal 按钮，Terminal 显示/隐藏

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/features/chat/ChatView.tsx
git commit -m "feat(chat): add toggle buttons for RightPanel and Terminal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 8：端到端测试和修复

- [ ] **步骤 1：测试 Sidebar resize**

手动测试：
1. 启动 `npm run dev`
2. 拖拽 Sidebar 右侧边缘
3. 验证宽度平滑调整
4. 刷新页面，验证宽度保存

预期：Sidebar 可拖拽，宽度保存到 localStorage

- [ ] **步骤 2：测试 Right Panel toggle 和 resize**

手动测试：
1. 点击 toggle 按钮
2. Right Panel 显示
3. 拖拽 Right Panel 左侧边缘
4. 验证宽度调整
5. 刷新页面，验证状态保存

预期：Right Panel 可开关，可 resize，状态持久化

- [ ] **步骤 3：测试 Terminal toggle 和 resize**

手动测试：
1. 点击 Terminal toggle 按钮
2. Terminal 显示在 Main+Right 下方
3. 拖拽 Terminal 顶部边缘
4. 验证高度调整
5. 验证 Terminal 不延伸到 Sidebar 下

预期：Terminal 位置正确，可 resize

- [ ] **步骤 4：测试现有对话功能**

手动测试：
1. 创建新 session
2. 发送消息
3. 查看回复
4. 切换 session

预期：所有对话功能正常，无回归

- [ ] **步骤 5：修复发现的问题**

如果测试中发现问题：
1. 记录问题
2. 修复代码
3. 重新测试
4. Commit 修复

示例 commit：
```bash
git add <modified-files>
git commit -m "fix(layout): resolve [specific issue]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **步骤 6：最终验收 commit**

```bash
git add .
git commit -m "chore(stage1): complete layout system and resizable panels

All tests passing:
- Sidebar resizable and persists width
- Right Panel toggle and resize working
- Terminal toggle and resize working
- Terminal positioned correctly (Main+Right area only)
- Existing chat functionality preserved

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 验收标准

**功能要求：**
- [ ] Sidebar 可拖拽调整宽度（180-600px）
- [ ] Right Panel 可开关
- [ ] Right Panel 可拖拽调整宽度（200-800px）
- [ ] Terminal 可开关
- [ ] Terminal 可拖拽调整高度（100-600px）
- [ ] Terminal 只在 Main+Right 区域下方，不延伸到 Sidebar
- [ ] 所有面板尺寸保存到 localStorage
- [ ] 刷新页面后状态恢复

**兼容性要求：**
- [ ] 现有 session 创建/切换/删除功能正常
- [ ] 现有消息发送/显示功能正常
- [ ] 现有 SessionList 显示正常

**代码质量：**
- [ ] 所有 TypeScript 类型检查通过
- [ ] layoutStore 单元测试通过
- [ ] 无 console 错误或警告

---

## 故障排查

### 问题 1：DraggablePanel 不按预期工作

**症状：** 拖拽没有反应或面板尺寸不变

**排查步骤：**
1. 检查 @lobehub/ui 版本是否安装
2. 查看浏览器 console 是否有错误
3. 验证 `mode` 参数是否正确（'left' vs 'top'）
4. 检查 `minWidth`/`maxWidth` vs `minHeight`/`maxHeight` 是否对应

**解决方案：**
- 确保 @lobehub/ui 已安装：`npm install @lobehub/ui`
- 参考 @lobehub/ui 文档确认 DraggablePanel API

### 问题 2：Terminal 延伸到 Sidebar 下方

**症状：** Terminal 宽度覆盖整个窗口

**排查步骤：**
1. 检查 App.tsx 布局结构
2. 确认 Terminal 是在 "Right Container" 内部，不是根 Flexbox 的直接子元素

**解决方案：**
```typescript
// 正确的嵌套
<Flexbox horizontal>
  <Sidebar />
  <Flexbox flex={1}>  {/* Right Container */}
    <TopArea />  {/* Main + Right */}
    <Terminal />  {/* 这里！*/}
  </Flexbox>
</Flexbox>
```

### 问题 3：localStorage 状态不保存

**症状：** 刷新页面后面板尺寸恢复默认值

**排查步骤：**
1. 打开浏览器 DevTools > Application > Local Storage
2. 查看是否有 `hermes-layout` 键
3. 检查 zustand persist 配置

**解决方案：**
- 确保 persist middleware 正确配置
- 验证 `partialize` 函数包含所有需要持久化的字段

---

## 下一步

阶段 1 完成后，继续：
- **阶段 2：** InputBox 升级 + Model Selector
- **阶段 3：** Attachment + Commands + Mention  
- **阶段 4：** Terminal Tabs + Right Panel Tabs + Collapsed Capsules
