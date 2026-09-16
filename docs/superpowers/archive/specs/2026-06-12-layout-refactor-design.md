# Hermes 布局重构设计

**日期:** 2026-06-12  
**范围:** 纯布局重构,不新增功能  
**目标:** 解决当前四区平铺布局的空间挤占和输入框定位问题,对齐 PiAgentUI 参考的停靠行为

---

## 背景与问题

当前 Hermes(tauri-agent)采用四区固定平铺布局:Sessions(左) | (Chat + Terminal)(中) | Context(右)。核心问题:

1. **空面板挤占核心区** — Context(右侧固定 280px)和 Terminal(底部固定 200px)目前都是空壳占位,却各自占一大块,把对话区压成中间一条窄带
2. **输入框位置和形态怪** — 夹在 Chat 与 Terminal 之间,高度计算错误导致冒出竖直滚动条
3. **对话区过空过宽** — 消息贴顶、铺满整宽、中间大片留白

**根因:** 四个区域被当成"同等常驻"平铺,但实际只有 Chat 是核心,其余应按需出现。

**参考:** PiAgentUI 的布局逻辑 — 底部 dock 默认完全隐藏,右上角三个开关分别切换左侧栏/底部 dock/右侧栏,输入框浮在 dock 之上(absolute 定位),始终可见。

---

## 设计方案

### 整体架构

三层嵌套结构:

```
App (h-screen flex flex-col)
├─ Header (固定 44px 高,顶栏)
│   ├─ 左侧:导航图标(前进/后退/文件夹/设置)
│   ├─ 中间:应用标题"Hermes"
│   └─ 右侧:三个切换按钮(左侧栏/dock/右侧栏)
├─ Main (flex-1,三栏 grid)
│   └─ grid-template-columns: ${left} 1fr ${right}
│       ├─ Sessions(条件渲染,宽度 240px 或 0)
│       ├─ ChatView(flex-1,position: relative)
│       └─ Context(条件渲染,宽度 280px 或 0)
└─ 浮动层(脱离文档流)
    ├─ ChatInput (absolute bottom-4,z-index 20,相对 ChatView)
    └─ DockPanel (fixed bottom-0,z-index 10,条件渲染)
```

**关键改动:**
- 移除原 grid 的 Terminal 行(从四区简化为三列单行)
- 输入框从 flex 子元素改为 absolute 定位
- Terminal 从 grid 子元素改为 fixed 底部面板,条件渲染

### 状态管理

在 `store/ui.ts`(zustand)或 App local state 增加三个布尔值:

```typescript
{
  leftSidebarOpen: boolean,   // 默认 true,控制 Sessions 显示
  rightSidebarOpen: boolean,  // 默认 false,控制 Context 显示
  dockOpen: boolean            // 默认 false,控制底部 dock 显示
}
```

### 组件职责

#### 新增组件

**1. Header.tsx**

```typescript
// 顶栏,44px 高,三段式布局
<header className="h-11 bg-[#161616] border-b border-white/10 flex items-center justify-between px-3">
  {/* 左侧:导航图标 */}
  <div className="flex gap-2">
    <ActionIcon icon={ChevronLeft} />
    <ActionIcon icon={ChevronRight} />
    <ActionIcon icon={Folder} />
    <ActionIcon icon={Settings} />
  </div>
  
  {/* 中间:标题 */}
  <h1 className="text-sm font-semibold text-white">Hermes</h1>
  
  {/* 右侧:三按钮 */}
  <div className="flex gap-1">
    <ActionIcon 
      icon={PanelLeft} 
      active={leftSidebarOpen} 
      onClick={() => toggleLeftSidebar()} 
    />
    <ActionIcon 
      icon={PanelBottom} 
      active={dockOpen} 
      onClick={() => toggleDock()} 
    />
    <ActionIcon 
      icon={PanelRight} 
      active={rightSidebarOpen} 
      onClick={() => toggleRightSidebar()} 
    />
  </div>
</header>
```

- 使用 `@lobehub/ui` 的 `ActionIcon`,图标来自 `lucide-react`
- `active` 状态时背景高亮(`bg-primary/10`)

**2. DockPanel.tsx**

```typescript
// 底部停靠面板,条件渲染
{dockOpen && (
  <div className="fixed bottom-0 left-0 right-0 h-[200px] bg-[#0a0a0a] border-t border-white/10 z-10">
    <TerminalPanel />
  </div>
)}
```

- `fixed` 定位,`z-index: 10`(低于输入框的 20)
- 高度固定 200px
- 无展开/收起动画(简化实现,直接条件渲染)
- 当前内容只有 TerminalPanel,后续可扩展为多标签容器

#### 修改组件

**1. App.tsx**

- 增加 `<Header />` 在最顶部
- Main 区域从 `grid-template: 4区` 改为 `grid-template-columns`:

```typescript
const gridCols = `${leftSidebarOpen ? '240px' : '0px'} 1fr ${rightSidebarOpen ? '280px' : '0px'}`;

<main className="flex-1 overflow-hidden" style={{ 
  display: 'grid', 
  gridTemplateColumns: gridCols 
}}>
  {leftSidebarOpen && <SessionList />}
  <ChatView />
  {rightSidebarOpen && <ContextPanel />}
</main>
```

- 移除原来 grid 里的 Terminal 行
- 在 Main 之后渲染 `{dockOpen && <DockPanel />}`

**2. ChatView.tsx**

- 容器加 `position: relative`(让输入框 absolute 相对它)
- MessageList 改为 `absolute top-0 bottom-88px left-0 right-0 overflow-y-auto`(给输入框留高度)
- ChatInput 移到容器末尾,改为 absolute 定位

**3. ChatInput.tsx**

```typescript
<div className="absolute bottom-4 left-4 right-4 z-20 
                bg-black/80 backdrop-blur-sm 
                border border-white/10 rounded-lg shadow-lg p-3">
  <ChatInputAreaInner ... />
  <ChatSendButton ... />
</div>
```

- `absolute bottom-4`(相对 ChatView)
- `z-index: 20`(高于 dock 的 10)
- 半透明背景 + 毛玻璃效果
- dock 打开时输入框**不上移**(因为是 absolute 相对 ChatView,不受 fixed dock 影响)

**4. Sessions/Context 不动**

- 组件内部不变,只是外层 grid 列宽变成动态的
- 宽度为 0 时通过条件渲染隐藏(避免内容溢出)

---

## 样式细节

### Header 三按钮

- 右上角间距 `gap-1`
- 按钮尺寸 32x32px,圆角 6px
- active 状态:背景 `rgba(100,150,255,0.1)`,边框 `rgba(255,255,255,0.15)`,图标颜色主题色
- inactive 状态:背景透明,边框 `rgba(255,255,255,0.1)`,图标 `#888`

### DockPanel

- 高度固定 200px
- 背景 `#0a0a0a`
- 顶部边框 `1px solid rgba(255,255,255,0.1)`
- 无展开/收起动画(条件渲染,open 显示 / close 移除 DOM)

### ChatInput

- 定位:`absolute bottom-4 left-4 right-4`(相对 ChatView)
- `z-index: 20`
- 背景:`bg-black/80`,毛玻璃:`backdrop-blur-sm`
- 边框:`border border-white/10`,圆角 8px
- 阴影:`shadow-lg`

### 侧栏收起

- `leftSidebarOpen=false` → grid 列 `0px 1fr ...`,Sessions 组件不渲染
- `rightSidebarOpen=false` → grid 列 `... 1fr 0px`,Context 组件不渲染

---

## 实现步骤(供参考)

1. **增加状态** — 在 `store/ui.ts` 或 App state 加 `leftSidebarOpen/rightSidebarOpen/dockOpen` 三个布尔值
2. **创建 Header** — 新建 `Header.tsx`,放导航图标 + 标题 + 三按钮,绑定 toggle 函数
3. **创建 DockPanel** — 新建 `DockPanel.tsx`,包裹现有 TerminalPanel,条件渲染在 App 末尾
4. **改造 App 布局** — 顶部加 `<Header />`,Main 的 grid 从四区简化为三列,移除 Terminal 行,grid 列宽度改为动态(基于 state)
5. **改造 ChatView** — 容器加 `relative`,MessageList 改 absolute 定位,ChatInput 移到末尾改 absolute
6. **改造 ChatInput** — 样式改为半透明浮动卡片,z-index 20
7. **验证** — 点击三按钮测试侧栏/dock 开关,确认输入框始终浮在 dock 之上,dock 打开时对话区底部被遮挡但输入框可见

---

## 验收标准

- [ ] Header 顶栏 44px 高,右上角三按钮可点击切换状态
- [ ] 左侧栏关闭时 Sessions 不显示,对话区占据全宽
- [ ] 右侧栏关闭时 Context 不显示,对话区扩展到右侧
- [ ] 底部 dock 默认隐藏,点击按钮打开后从底部出现(fixed,200px 高)
- [ ] 输入框始终浮在对话区底部,z-index 高于 dock,半透明背景
- [ ] dock 打开时输入框不上移,仍在原位可见
- [ ] 对话区消息列表正常滚动,不被输入框遮挡(MessageList 的 bottom 留出 88px)
- [ ] 三按钮的 active 状态正确反映当前开关状态(背景高亮)

---

## 未来扩展(不在本轮)

- dock 展开/收起动画(framer-motion)
- dock 内多标签支持(Terminal / 文件 / 变更 / MCP 等)
- 顶栏左侧导航图标的真实功能
- 模型选择器、上下文用量指示器
- 会话列表搜索、最近/活跃 tab
