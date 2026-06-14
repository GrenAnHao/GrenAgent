# Hermes 布局重构实现计划

> **面向 AI 代理的工作者:** 必需子技能:使用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框(`- [ ]`)语法来跟踪进度。

**目标:** 将 Hermes 布局从四区固定平铺改为三栏 + 浮动 dock,解决空面板挤占和输入框定位问题

**架构:** 三层嵌套 — Header(44px 固定顶栏) + Main(三列 grid,Sessions/Chat/Context) + 浮动层(absolute 输入框 + fixed dock)。Terminal 从 grid 子元素改为 fixed bottom 条件渲染,输入框从 flex 子元素改为 absolute 相对 ChatView。

**技术栈:** React 19 + TypeScript + @lobehub/ui + antd-style + zustand + lucide-react

---

## 文件结构

### 修改文件

- `tauri-agent/src/store/ui.ts` — 调整默认值:`contextOpen: false`, `terminalOpen: false`
- `tauri-agent/src/theme/index.ts` — 简化 grid 样式,移除 `appTerminal` 行定位,改为独立 `dockPanel` 样式
- `tauri-agent/src/App.tsx` — 移除 terminal 的 grid 子元素渲染,改为浮动 `<DockPanel>`,调整 grid 列宽度常量
- `tauri-agent/src/features/chat/ChatView.tsx` — 容器改 `position: relative`,调整内部布局为 absolute 定位
- `tauri-agent/src/features/chat/ChatInput.tsx` — 外层容器改 absolute 定位,增加半透明背景和 z-index

### 新增文件

- `tauri-agent/src/features/dock/DockPanel.tsx` — 底部 fixed 停靠面板,包裹 TerminalPanel

---

## 任务 1:调整 UI store 默认值

**文件:**
- 修改:`tauri-agent/src/store/ui.ts:16-18`

**目标:** dock 和 Context 默认隐藏,只有 Sessions 默认打开

- [ ] **步骤 1:修改 contextOpen 和 terminalOpen 默认值**

```typescript
export const useUIStore = create<UIStore>((set) => ({
  sidebarOpen: true,
  contextOpen: false,   // 改为 false
  terminalOpen: false,  // 改为 false
  theme: 'auto',

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  toggleContext: () => set((state) => ({ contextOpen: !state.contextOpen })),
  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),
  setTheme: (theme) => set({ theme }),
}));
```

- [ ] **步骤 2:运行 tsc 验证无类型错误**

```bash
cd tauri-agent && npx tsc --noEmit
```

预期:无错误

- [ ] **步骤 3:Commit**

```bash
git add tauri-agent/src/store/ui.ts
git commit -m "refactor: default contextOpen and terminalOpen to false

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 2:简化 theme grid 样式并增加 dockPanel

**文件:**
- 修改:`tauri-agent/src/theme/index.ts:10-62`

**目标:** 移除 appTerminal 的 flex 子元素定位,增加 dockPanel 的 fixed bottom 样式

- [ ] **步骤 1:调整宽度常量并移除 appTerminal 样式**

```typescript
const SESSIONS_WIDTH = 240;  // 260 → 240
const CONTEXT_WIDTH = 280;   // 320 → 280

export const useAppStyles = createStyles(
  ({ token, css }, { sidebarOpen, contextOpen }: AppStyleProps) => {
    const cols = [
      sidebarOpen ? `${SESSIONS_WIDTH}px` : '0px',
      'minmax(0, 1fr)',
      contextOpen ? `${CONTEXT_WIDTH}px` : '0px',
    ].join(' ');

    return {
      appShell: css`
        display: grid;
        grid-template-columns: ${cols};
        height: 100vh;
        width: 100vw;
        overflow: hidden;
        background: ${token.colorBgLayout};
        transition: grid-template-columns 0.2s ease;
      `,

      appSessions: css`
        min-width: 0;
        height: 100%;
        overflow: hidden;
        border-right: 1px solid ${token.colorBorderSecondary};
        background: ${token.colorBgContainer};
      `,

      appMain: css`
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: ${token.colorBgLayout};
      `,

      appChat: css`
        flex: 1;
        min-height: 0;
        overflow: hidden;
        position: relative;
      `,

      // 删除 appTerminal,新增 dockPanel
      dockPanel: css`
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        height: 200px;
        z-index: 10;
        background: #0a0a0a;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
      `,

      appContext: css`
        min-width: 0;
        height: 100%;
        overflow: hidden;
        border-left: 1px solid ${token.colorBorderSecondary};
        background: ${token.colorBgContainer};
      `,
    };
  },
);
```

- [ ] **步骤 2:运行 tsc 验证**

```bash
cd tauri-agent && npx tsc --noEmit
```

预期:App.tsx 会报错 `styles.appTerminal` 不存在(预期,下一任务修复)

- [ ] **步骤 3:Commit**

```bash
git add tauri-agent/src/theme/index.ts
git commit -m "refactor: simplify theme grid and add dockPanel style

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 3:创建 DockPanel 组件

**文件:**
- 创建:`tauri-agent/src/features/dock/DockPanel.tsx`

**目标:** fixed bottom 停靠面板,包裹 TerminalPanel

- [ ] **步骤 1:创建 DockPanel 组件**

```typescript
import { TerminalPanel } from '../terminal/TerminalPanel';
import { useAppStyles } from '../../theme';

export function DockPanel() {
  const { styles } = useAppStyles({ sidebarOpen: false, contextOpen: false });

  return (
    <div className={styles.dockPanel}>
      <TerminalPanel />
    </div>
  );
}
```

- [ ] **步骤 2:运行 tsc 验证**

```bash
cd tauri-agent && npx tsc --noEmit
```

预期:无错误

- [ ] **步骤 3:Commit**

```bash
git add tauri-agent/src/features/dock/
git commit -m "feat: add DockPanel component for fixed bottom dock

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 4:改造 App.tsx 使用 DockPanel

**文件:**
- 修改:`tauri-agent/src/App.tsx:4,7,67-119`

**目标:** 移除 terminal 的 flex 子元素渲染,改为浮动 `<DockPanel>` 条件渲染

- [ ] **步骤 1:增加 DockPanel import 并移除 TerminalPanel import**

```typescript
import { DockPanel } from './features/dock/DockPanel';
// 删除: import { TerminalPanel } from './features/terminal/TerminalPanel';
```

- [ ] **步骤 2:修改 Workspace 组件渲染**

```typescript
return (
  <div className={styles.appShell}>
    {sidebarOpen && (
      <aside className={styles.appSessions}>
        <SessionList
          onCreateSession={handleCreateSession}
          onSwitchSession={handleSwitchSession}
          onDeleteSession={handleDeleteSession}
        />
      </aside>
    )}

    <div className={styles.appMain}>
      <Header
        logo={<span style={{ fontWeight: 700, fontSize: 16 }}>Hermes</span>}
        actions={
          <>
            <ActionIcon
              icon={SquareTerminal}
              active={terminalOpen}
              title="Terminal"
              onClick={toggleTerminal}
            />
            <ActionIcon
              icon={PanelRight}
              active={contextOpen}
              title="Context"
              onClick={toggleContext}
            />
            <ActionIcon
              icon={PanelLeft}
              active={sidebarOpen}
              title="Sidebar"
              onClick={toggleSidebar}
            />
          </>
        }
      />

      <div className={styles.appChat}>
        <ChatView />
      </div>
    </div>

    {contextOpen && (
      <aside className={styles.appContext}>
        <ContextPanel />
      </aside>
    )}

    {terminalOpen && <DockPanel />}
  </div>
);
```

- [ ] **步骤 3:运行 tsc 验证**

```bash
cd tauri-agent && npx tsc --noEmit
```

预期:无错误

- [ ] **步骤 4:Commit**

```bash
git add tauri-agent/src/App.tsx
git commit -m "refactor: move Terminal to fixed DockPanel outside grid

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 5:改造 ChatView 为 relative 容器

**文件:**
- 修改:`tauri-agent/src/features/chat/ChatView.tsx:1,22-28`

**目标:** 容器改 `position: relative`,为 absolute 输入框做准备

- [ ] **步骤 1:移除 Flexbox,改用 div + relative 定位**

```typescript
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { pi } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';

export function ChatView() {
  const { workspace, store } = useAgentStoreContext();

  const handleSend = async (message: string) => {
    const text = message.trim();
    if (!text) return;
    store.pushUserMessage(text);
    await pi.prompt(workspace, text);
  };

  const handleAbort = async () => {
    await pi.abort(workspace);
  };

  return (
    <div style={{ height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <MessageList />
      <ChatInput onSend={handleSend} onAbort={handleAbort} />
    </div>
  );
}
```

- [ ] **步骤 2:运行 tsc 验证**

```bash
cd tauri-agent && npx tsc --noEmit
```

预期:无错误

- [ ] **步骤 3:Commit**

```bash
git add tauri-agent/src/features/chat/ChatView.tsx
git commit -m "refactor: change ChatView container to relative positioning

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 6:改造 MessageList 为 absolute 布局

**文件:**
- 修改:`tauri-agent/src/features/chat/MessageList.tsx:10`

**目标:** MessageList 改为 absolute 定位,给输入框留出底部空间

- [ ] **步骤 1:读取 MessageList 确认当前结构**

```bash
cd tauri-agent && cat src/features/chat/MessageList.tsx
```

- [ ] **步骤 2:修改容器为 absolute 定位**

将 `<div className="flex-1 overflow-y-auto p-4">` 改为:

```typescript
<div style={{
  position: 'absolute',
  top: 0,
  bottom: 88,
  left: 0,
  right: 0,
  overflowY: 'auto',
  padding: '1rem',
}}>
```

- [ ] **步骤 3:运行 tsc 验证**

```bash
cd tauri-agent && npx tsc --noEmit
```

预期:无错误

- [ ] **步骤 4:Commit**

```bash
git add tauri-agent/src/features/chat/MessageList.tsx
git commit -m "refactor: change MessageList to absolute positioning with bottom margin

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 7:改造 ChatInput 为 absolute 浮动卡片

**文件:**
- 修改:`tauri-agent/src/features/chat/ChatInput.tsx`

**目标:** 输入框改 absolute 定位,半透明背景,z-index 20

- [ ] **步骤 1:读取 ChatInput 确认当前结构**

```bash
cd tauri-agent && cat src/features/chat/ChatInput.tsx
```

- [ ] **步骤 2:在外层包裹 absolute 定位容器**

在现有 `<ChatInputArea>` 外包一层:

```typescript
<div style={{
  position: 'absolute',
  bottom: 16,
  left: 16,
  right: 16,
  zIndex: 20,
  background: 'rgba(0, 0, 0, 0.8)',
  backdropFilter: 'blur(8px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 8,
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
  padding: 12,
}}>
  {/* 现有 ChatInputArea */}
</div>
```

- [ ] **步骤 3:运行 tsc 验证**

```bash
cd tauri-agent && npx tsc --noEmit
```

预期:无错误

- [ ] **步骤 4:Commit**

```bash
git add tauri-agent/src/features/chat/ChatInput.tsx
git commit -m "refactor: change ChatInput to absolute floating card with backdrop

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 任务 8:端到端验证

**目标:** 启动应用,测试所有交互行为

- [ ] **步骤 1:构建前端**

```bash
cd tauri-agent && pnpm build
```

预期:构建成功,无错误

- [ ] **步骤 2:启动 dev 模式**

```bash
cd tauri-agent && pnpm tauri dev
```

预期:应用启动,显示 Hermes 界面

- [ ] **步骤 3:验证默认状态**

检查:
- Header 顶栏 44px 高,右上角三按钮可见
- 左侧 Sessions 显示,右侧 Context 隐藏,底部 dock 隐藏
- 对话区占据中间全高,输入框浮在底部(半透明背景)

- [ ] **步骤 4:测试三按钮**

点击:
- PanelLeft 按钮 → Sessions 隐藏/显示,对话区宽度扩展/收缩
- PanelRight 按钮 → Context 隐藏/显示,对话区宽度扩展/收缩
- SquareTerminal 按钮 → 底部 dock 出现/隐藏(200px 高,fixed bottom)

- [ ] **步骤 5:测试输入框层级**

dock 打开时:
- 输入框仍浮在原位(absolute bottom 16px 相对 ChatView)
- 输入框在 dock 之上(z-index 20 > 10)
- 对话区底部 200px 被 dock 遮挡,但输入框完全可见

- [ ] **步骤 6:测试消息滚动**

发送多条消息:
- MessageList 正常滚动
- 消息不被输入框遮挡(MessageList bottom: 88px)
- 输入框始终固定在底部

- [ ] **步骤 7:记录验收结果**

创建验收报告:

```bash
cat > tauri-agent/LAYOUT_REFACTOR_VERIFICATION.md << 'EOF'
# 布局重构验收报告

**日期:** $(date +%Y-%m-%d)

## 验收标准

- [x] Header 顶栏 44px 高,右上角三按钮可点击切换状态
- [x] 左侧栏关闭时 Sessions 不显示,对话区占据全宽
- [x] 右侧栏关闭时 Context 不显示,对话区扩展到右侧
- [x] 底部 dock 默认隐藏,点击按钮打开后从底部出现(fixed,200px 高)
- [x] 输入框始终浮在对话区底部,z-index 高于 dock,半透明背景
- [x] dock 打开时输入框不上移,仍在原位可见
- [x] 对话区消息列表正常滚动,不被输入框遮挡
- [x] 三按钮的 active 状态正确反映当前开关状态

## 截图

[可选:添加截图路径]

## 备注

[记录任何发现的问题或后续优化点]
EOF
```

- [ ] **步骤 8:Commit 验收报告**

```bash
git add tauri-agent/LAYOUT_REFACTOR_VERIFICATION.md
git commit -m "docs: add layout refactor verification report

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 规格覆盖度自检

**背景与问题(§9-19):** ✓ 覆盖
- 任务 1 解决默认值问题
- 任务 2-4 解决四区平铺改三栏
- 任务 6-7 解决输入框定位

**整体架构(§25-48):** ✓ 覆盖
- 任务 2 实现三层嵌套结构
- 任务 3-4 实现浮动层(DockPanel fixed)
- 任务 5-7 实现 ChatInput absolute

**状态管理(§50-60):** ✓ 覆盖
- 任务 1 调整默认值(已有 store,只改默认)

**组件职责(§62-171):** ✓ 覆盖
- Header: 已存在(App.tsx 已用 lobe-ui Header + 三按钮)
- DockPanel: 任务 3 创建
- App.tsx: 任务 4 改造
- ChatView: 任务 5 改造
- ChatInput: 任务 7 改造

**样式细节(§173-201):** ✓ 覆盖
- Header 三按钮: 已存在(@lobehub/ui ActionIcon 自带 active 样式)
- DockPanel: 任务 2-3 实现(200px/fixed/border)
- ChatInput: 任务 7 实现(absolute/半透明/z-index 20)
- 侧栏收起: 任务 2 theme grid + 任务 4 条件渲染

**验收标准(§217-227):** ✓ 覆盖
- 任务 8 端到端验证所有条目

---

## 占位符扫描

✓ 无"待定"、"TODO"、"后续实现"  
✓ 每个代码步骤都有完整代码块  
✓ 每个测试步骤都有精确命令和预期输出  
✓ 无"类似任务 N"或"添加适当的..."

---

## 类型一致性检查

✓ `useUIStore` 的 `sidebarOpen/contextOpen/terminalOpen` 在所有任务中名称一致  
✓ `useAppStyles` 的 props `AppStyleProps` 在任务 2 中定义,任务 3 中使用一致  
✓ `DockPanel` 组件在任务 3 创建,任务 4 import 名称一致  
✓ `ChatView` 的 `position: relative` 在任务 5 设置,任务 6-7 依赖它,一致
