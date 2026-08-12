# Visual Companion — 设计规格

**日期：** 2026-08-13  
**状态：** 草稿，待实现

---

## 1. 背景与目标

Superpowers 头脑风暴技能的「视觉伴侣」功能通过本地 HTTP 服务器 + 外部浏览器展示 HTML 原型，让 AI 可以在头脑风暴过程中呈现可交互的视觉内容（布局选项、架构图、线框图）。

由于该机制依赖外部浏览器，体验割裂。GrenAgent 是 Tauri 桌面应用，具备内嵌 WebView，可直接在软件内渲染，消除外部浏览器依赖。

**目标：** 在 GrenAgent 内实现等价的视觉伴侣功能，支持：
- 简单 A/B/C 选项 → 内联在聊天流中（`VisualCard`）
- 复杂原型/架构图 → 右侧可折叠面板（`VisualPanel`）
- AI 通过工具调用驱动展示与交互，阻塞式等待用户选择

---

## 2. 决策记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 渲染位置 | **两者结合**（内联 + 面板） | 简单选项内联不打断流，复杂原型需要更大空间 |
| 触发方式 | **工具调用**（show_visual / read_visual_choice） | 双向通信，与现有 speak / generate_image 工具同一模式 |
| 交互回传 | **阻塞式** read_visual_choice() | AI 显式等待，逻辑清晰；可配置超时 |
| CSS 兼容性 | **复用 frame-template.html** 的 CSS | 同一份 HTML 片段在浏览器和 GrenAgent 中都能工作 |

---

## 3. 架构总览

```
Pi Extension (visual-companion)
  ├── show_visual(html, mode?)   →  Tauri event: visual:show
  └── read_visual_choice()       ←  Tauri event: visual:choice (阻塞 Promise)
           ↕
Tauri IPC (commands + events)
           ↕
React Frontend
  ├── visualStore.ts             — Zustand，持有 html / mode / pending 状态
  ├── VisualCard.tsx             — 内联卡片（iframe sandbox，notice 消息挂载点）
  └── VisualPanel.tsx            — 右侧面板（iframe sandbox，layout 侧栏区域）
```

---

## 4. Pi 扩展层

### 4.1 文件位置

```
extensions/
  visual-companion/
    index.ts          ← 扩展入口，注册两个工具
    autoMode.ts       ← auto 模式判断逻辑（纯字符串检测）
```

### 4.2 `show_visual(html, mode?)`

```typescript
pi.registerTool('show_visual', {
  description: '在 GrenAgent 界面中展示 HTML 视觉内容（选项卡、原型、架构图）。',
  parameters: {
    html: { type: 'string', description: 'HTML 片段或完整文档' },
    mode: {
      type: 'string',
      enum: ['inline', 'panel', 'auto'],
      description: '渲染模式。auto（默认）：含 .mockup/.split/.cards → panel，其余 → inline',
      default: 'auto',
    },
  },
  async execute({ html, mode = 'auto' }) {
    const resolved = mode === 'auto' ? detectMode(html) : mode;
    await pi.emit('visual:show', { html, mode: resolved });
    return { shown: true, mode: resolved };
  },
});
```

### 4.3 `read_visual_choice(timeout?)`

```typescript
pi.registerTool('read_visual_choice', {
  description: '等待用户在视觉伴侣中点击选项，返回选择结果。必须在 show_visual 之后调用。',
  parameters: {
    timeout: {
      type: 'number',
      description: '超时秒数（默认 300）',
      default: 300,
    },
  },
  async execute({ timeout = 300 }) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('visual choice timeout')), timeout * 1000);
      pi.once('visual:choice', (data) => {
        clearTimeout(timer);
        resolve(data); // { choice, text, timestamp }
      });
    });
  },
});
```

### 4.4 auto 模式检测（`autoMode.ts`）

```typescript
export function detectMode(html: string): 'inline' | 'panel' {
  const panelSignals = ['.mockup', '.split', '.cards', 'mockup-body', 'mock-nav', 'mock-sidebar'];
  return panelSignals.some(s => html.includes(s)) ? 'panel' : 'inline';
}
```

---

## 5. Tauri IPC 层

### 5.1 Rust 后端事件转发

在 `src-tauri/src/` 增加事件桥接，将来自 Pi sidecar（通过现有 RPC 管道）的 `visual:show` 事件转发到前端 WebView，并将前端发来的 `visual:choice` 事件转发回 sidecar。

具体实现复用现有 `pi_event` 转发机制（参见 `src-tauri/src/commands/`）。

### 5.2 事件结构

```typescript
// visual:show（extension → frontend）
interface VisualShowPayload {
  html: string;
  mode: 'inline' | 'panel';
}

// visual:choice（frontend → extension）
interface VisualChoicePayload {
  choice: string;       // data-choice 属性值（如 "a", "b", "layout-1"）
  text: string;         // 选项文字
  timestamp: number;    // Unix ms
}
```

---

## 6. 前端层

### 6.1 文件结构

```
tauri-agent/src/features/visual/
  index.ts            ← 导出
  visualStore.ts      ← Zustand store
  VisualCard.tsx      ← 内联卡片（inline 模式）
  VisualPanel.tsx     ← 右侧面板（panel 模式）
  frameAssets.ts      ← 内嵌 frame-template CSS + helper.js
```

### 6.2 `visualStore.ts`

```typescript
interface VisualState {
  html: string | null;
  mode: 'inline' | 'panel' | null;
  pending: boolean;          // true = 等待用户选择中
  sessionId: number;         // 每次 show_visual 递增，用于 key 强制重挂载
  submitChoice: (choice: string, text: string) => void;
}
```

- 启动时监听 Tauri 事件 `visual:show`，更新 html / mode / pending / sessionId
- `submitChoice()` emit `visual:choice` 到 Tauri，设 `pending = false`

### 6.3 `VisualCard.tsx`（内联）

挂载点：`ChatMessageItems.tsx` 的 `renderMessageBody`，新增：

```typescript
if (msg.customType === 'visual-inline') return <VisualCard />;
```

`VisualCard` 从 `visualStore` 读 html，用 `<iframe>` 渲染：

```tsx
<iframe
  sandbox="allow-scripts"
  srcDoc={buildSrcDoc(html)}   // 注入 frame-template CSS + helper.js
  style={{ border: 'none', width: '100%', height: frameHeight }}
  onLoad={handleFrameLoad}
/>
```

`buildSrcDoc()` 将 html 片段包裹进 frame-template（复用 brainstorming skill 的 CSS，适配深色主题 token）。

iframe 通过 `window.postMessage` 向外传递点击事件，`VisualCard` 监听并调用 `submitChoice()`。

### 6.4 `VisualPanel.tsx`（面板）

插入位置：现有 layout 右侧区域（与 Terminal Dock 同级）。面板结构：

```
┌─ Visual ─────────────────── [×] ┐
│  <iframe sandbox srcDoc={…} />   │
└──────────────────────────────────┘
```

- 当 `visualStore.mode === 'panel'` 且 `html != null` 时自动展开
- 标题栏显示「Visual」+ 关闭按钮（关闭不影响 pending 状态，用户仍可重新打开）
- 宽度默认 380px，可拖动调整（复用现有 `ResizeHandle`）

### 6.5 CSS 兼容（`frameAssets.ts`）

从 `~/.config/opencode/skills/brainstorming/scripts/frame-template.html` 提取样式表，适配为：
- 深色主题默认（`@media (prefers-color-scheme: dark)` 已内置）
- 移除服务器依赖的 WebSocket reload 脚本
- 保留所有 CSS 类：`.options`, `.option`, `.mockup`, `.split`, `.cards`, `.card`, `.pros-cons`, `.mock-nav`, `.mock-sidebar`, `.mock-content` 等

`helper.js` 的 `toggleSelect()` 和 `postMessage` 逻辑直接复用，无需修改。

---

## 7. 完整调用序列

```
AI                    Extension              Tauri IPC          Frontend
─┬─                   ─┬─                    ─┬─                ─┬─
 │  show_visual(html) │                       │                  │
 ├──────────────────→ │                       │                  │
 │                    │  emit visual:show     │                  │
 │                    ├──────────────────────→│                  │
 │                    │                       │  event → store   │
 │                    │                       ├─────────────────→│
 │  {shown:true}      │                       │                  │ render VisualCard/Panel
 │←────────────────── │                       │                  │
 │                    │                       │                  │
 │  read_visual_choice│                       │                  │
 ├──────────────────→ │  (Promise 阻塞)        │                  │
 │                    │                       │                  │ 用户点击
 │                    │                       │  visual:choice ← │
 │                    │←──────────────────────│                  │
 │  {choice,text,…}   │                       │                  │
 │←────────────────── │                       │                  │
─┴─                   ─┴─                    ─┴─                ─┴─
```

---

## 8. 错误处理

| 场景 | 处理方式 |
|------|---------|
| `read_visual_choice` 超时 | 工具返回 `{error: "timeout"}`，AI 自行决定重试或跳过 |
| iframe 加载失败 | `VisualCard` 显示错误卡片，`submitChoice` 仍可调用（自动传 `{choice:"error"}`）|
| 面板被用户关闭后再次 show_visual | 面板自动重新展开 |
| 连续两次 show_visual（未等 choice）| 新 html 覆盖旧内容，sessionId 递增触发 iframe 重挂载，旧 Promise 被 reject |

---

## 9. 范围外（不在本次实现）

- 多选模式（`data-multiselect`）—— CSS 已支持，暂不接入 choice 回传
- 视觉内容历史记录（已展示过的 html 存档）
- 流式更新（逐步渲染 html 片段）
- 移动/触屏适配

---

## 10. 实现顺序（给 writing-plans 参考）

1. `extensions/visual-companion/` — 两个工具 + autoMode
2. Tauri 事件桥（复用现有转发机制）
3. `visualStore.ts` + Tauri 事件监听
4. `VisualCard.tsx` + `frameAssets.ts`（内联先跑通）
5. `ChatMessageItems.tsx` 挂载 VisualCard
6. `VisualPanel.tsx` + layout 集成
7. 端到端测试：show_visual → read_visual_choice → 返回 choice
