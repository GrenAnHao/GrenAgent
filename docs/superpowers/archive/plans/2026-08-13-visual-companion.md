# Visual Companion 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 GrenAgent 中实现视觉伴侣功能，让 AI 通过 `show_visual` / `read_visual_choice` 工具在聊天流（内联卡片）或右侧面板中展示可交互的 HTML 视觉内容。

**架构：** Pi 扩展注册两个工具，通过 `ctx.ui.setStatus('visual', ...)` 经现有 `pi://ui-request` 管道把 HTML 载荷推到前端；前端 `ExtensionUiHost` 分发到 `visualStore`，根据 mode 渲染 `VisualCard`（内联）或 `VisualPanel`（右侧面板）；用户点击后通过 `pi.respondUi` 把选择回传，扩展 Promise resolve。

**技术栈：** TypeScript (extensions)、React 19 + Zustand + antd-style (frontend)、Tauri v2 事件/IPC

---

## 文件清单

### 新建文件

| 文件 | 职责 |
|------|------|
| `extensions/visual-companion/index.ts` | 扩展入口，注册两个工具 |
| `extensions/visual-companion/autoMode.ts` | auto 模式检测（纯字符串） |
| `extensions/visual-companion/package.json` | 包声明 |
| `tauri-agent/src/stores/visualStore.ts` | Zustand store，持有 html/mode/pending 状态 |
| `tauri-agent/src/features/visual/VisualCard.tsx` | 内联卡片（iframe，挂到 notice 消息） |
| `tauri-agent/src/features/visual/VisualPanel.tsx` | 右侧面板（iframe，插入 App 布局） |
| `tauri-agent/src/features/visual/frameAssets.ts` | 内嵌 frame-template CSS + helper.js |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `extensions/index.ts` | 导入并注册 visualCompanion |
| `tauri-agent/src/features/extensionUi/ExtensionUiHost.tsx` | 分发 `visual` statusKey 到 visualStore |
| `tauri-agent/src/features/chat/ChatMessageItems.tsx` | 新增 `visual-inline` 消息类型 → VisualCard |
| `tauri-agent/src/App.tsx` | 在 `RightPanelColumn` 旁边加入 `VisualPanel` |

---

## 任务 1：autoMode.ts — auto 模式检测

**文件：** 创建 `extensions/visual-companion/autoMode.ts`

- [ ] **步骤 1：编写测试**

创建 `extensions/visual-companion/autoMode.test.ts`：

```typescript
import { detectMode } from './autoMode.js';

test('inline: 简单选项无 mockup', () => {
  const html = '<div class="options"><div class="option">A</div></div>';
  expect(detectMode(html)).toBe('inline');
});

test('panel: 含 mockup 类', () => {
  const html = '<div class="mockup"><div class="mockup-body">...</div></div>';
  expect(detectMode(html)).toBe('panel');
});

test('panel: 含 split 类', () => {
  const html = '<div class="split"><div class="mockup">left</div></div>';
  expect(detectMode(html)).toBe('panel');
});

test('panel: 含 cards 类', () => {
  const html = '<div class="cards"><div class="card">item</div></div>';
  expect(detectMode(html)).toBe('panel');
});

test('panel: 含 mock-nav', () => {
  const html = '<div class="mock-nav">Logo</div>';
  expect(detectMode(html)).toBe('panel');
});

test('inline: 空字符串', () => {
  expect(detectMode('')).toBe('inline');
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd extensions && node --experimental-vm-modules node_modules/.bin/vitest run visual-companion/autoMode.test.ts 2>&1 | tail -5
```
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 autoMode.ts**

```typescript
// 纯字符串检测，无 DOM 依赖。
const PANEL_SIGNALS = [
  '.mockup', '.split', '.cards', 'mockup-body', 'mockup-header',
  'mock-nav', 'mock-sidebar', 'mock-content',
];

export function detectMode(html: string): 'inline' | 'panel' {
  return PANEL_SIGNALS.some((s) => html.includes(s)) ? 'panel' : 'inline';
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd extensions && node --experimental-vm-modules node_modules/.bin/vitest run visual-companion/autoMode.test.ts 2>&1 | tail -5
```
预期：PASS，6 个测试全部通过

- [ ] **步骤 5：commit**

```bash
git add extensions/visual-companion/autoMode.ts extensions/visual-companion/autoMode.test.ts
git commit -m "feat(visual-companion): autoMode detection"
```

---

## 任务 2：扩展入口 — show_visual + read_visual_choice

**文件：** 创建 `extensions/visual-companion/index.ts` 和 `extensions/visual-companion/package.json`

- [ ] **步骤 1：创建 package.json**

```json
{
  "name": "visual-companion",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts"
}
```

- [ ] **步骤 2：编写 index.ts**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { detectMode } from "./autoMode.js";

// 每个 workspace 独立维护一个 pending resolver（read_visual_choice 的阻塞 Promise）。
const pendingResolvers = new Map<string, (data: unknown) => void>();

export default function (pi: ExtensionAPI) {
  // ── show_visual ──────────────────────────────────────────────
  pi.registerTool({
    name: "show_visual",
    label: "Show Visual",
    description:
      "在 GrenAgent 界面展示 HTML 视觉内容（选项卡、原型、架构图等）。" +
      "mode='auto'（默认）：含 .mockup/.split/.cards 类 → 右侧面板；其余 → 聊天流内联卡片。" +
      "调用后立即返回；用 read_visual_choice 阻塞等待用户选择。",
    parameters: Type.Object({
      html: Type.String({ description: "HTML 片段或完整文档（支持 frame-template CSS 类）" }),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal("inline"), Type.Literal("panel"), Type.Literal("auto")],
          { description: "渲染位置，默认 auto" },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const html = (params.html ?? "").trim();
      if (!html) {
        return { content: [{ type: "text", text: "show_visual: html 不能为空。" }] };
      }
      const mode = params.mode === "inline" || params.mode === "panel"
        ? params.mode
        : detectMode(html);

      // 推给前端：复用 setStatus 管道，statusKey='visual'，statusText=JSON
      const payload = JSON.stringify({ action: "show", html, mode });
      ctx.ui.setStatus("visual", payload);

      return { content: [{ type: "text", text: `[visual shown, mode=${mode}]` }] };
    },
  });

  // ── read_visual_choice ───────────────────────────────────────
  pi.registerTool({
    name: "read_visual_choice",
    label: "Read Visual Choice",
    description:
      "阻塞等待用户在视觉伴侣中点击选项，返回选择结果。必须在 show_visual 之后调用。",
    parameters: Type.Object({
      timeout: Type.Optional(
        Type.Number({ description: "超时秒数（默认 300）", default: 300 }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const timeout = (params.timeout ?? 300) * 1000;

      // 前端点击后通过 extension_ui_respond 回传 { id, value: { choice, text, timestamp } }
      // 复用 ctx.ui.input 作为阻塞信道：input 挂起直到 pi.respondUi 回传 value。
      const sentinel = JSON.stringify({ __visualChoice: 1 });
      const raw = await Promise.race([
        ctx.ui.input(sentinel, undefined, { signal }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("read_visual_choice timeout")), timeout),
        ),
      ]);

      if (typeof raw === "string") {
        try {
          return { content: [{ type: "text", text: raw }] };
        } catch {
          return { content: [{ type: "text", text: String(raw) }] };
        }
      }
      return {
        content: [{ type: "text", text: '{"error":"no choice received"}' }],
      };
    },
  });
}
```

> **注意：** `ctx.ui.input` 是现有的阻塞信道（ask_user 也在用），前端识别 `__visualChoice` 哨兵后渲染 VisualCard/Panel；用户点击后调用 `extensionUiRespond` 回传 choice，input Promise resolve。

- [ ] **步骤 3：注册到 extensions/index.ts**

在 `extensions/index.ts` 中加入（参照现有 tts 的方式）：

```diff
 import tts from "./tts/index.js";
+import visualCompanion from "./visual-companion/index.js";
 import webFetch from "./web-fetch/index.js";
```

```diff
 export {
   ...
   tts,
+  visualCompanion,
   imGateway,
```

```diff
 export const allExtensions = [
   ...
   tts,
+  visualCompanion,
   imGateway,
```

```diff
 export const namedExtensions = [
   ...
   { name: "tts", factory: tts },
+  { name: "visual-companion", factory: visualCompanion },
   { name: "im-gateway", factory: imGateway },
```

- [ ] **步骤 4：编译检查**

```bash
cd extensions && npx tsc --noEmit 2>&1 | head -20
```
预期：无类型错误（若有，根据报错修正）

- [ ] **步骤 5：commit**

```bash
git add extensions/visual-companion/ extensions/index.ts
git commit -m "feat(visual-companion): register show_visual + read_visual_choice tools"
```

---

## 任务 3：visualStore — 前端状态管理

**文件：** 创建 `tauri-agent/src/stores/visualStore.ts`

- [ ] **步骤 1：编写测试**

创建 `tauri-agent/src/stores/visualStore.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

// 直接测试 store 逻辑（不依赖 Tauri）
describe('visualStore', () => {
  beforeEach(() => {
    // 重置 store
    const { useVisualStore } = require('./visualStore');
    useVisualStore.setState({ html: null, mode: null, pending: false, sessionId: 0 });
  });

  it('setVisual 更新 html/mode/pending/sessionId', () => {
    const { useVisualStore } = require('./visualStore');
    useVisualStore.getState().setVisual('<h2>Test</h2>', 'inline');
    const s = useVisualStore.getState();
    expect(s.html).toBe('<h2>Test</h2>');
    expect(s.mode).toBe('inline');
    expect(s.pending).toBe(true);
    expect(s.sessionId).toBe(1);
  });

  it('clearVisual 重置状态', () => {
    const { useVisualStore } = require('./visualStore');
    useVisualStore.getState().setVisual('<h2>Test</h2>', 'panel');
    useVisualStore.getState().clearVisual();
    const s = useVisualStore.getState();
    expect(s.html).toBeNull();
    expect(s.pending).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd tauri-agent && npx vitest run src/stores/visualStore.test.ts 2>&1 | tail -5
```
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 visualStore.ts**

```typescript
import { create } from 'zustand';

export interface VisualState {
  html: string | null;
  mode: 'inline' | 'panel' | null;
  /** true = show_visual 已推送，read_visual_choice 正在等待 */
  pending: boolean;
  /** 每次 setVisual 递增，用于 key 强制重挂载 iframe */
  sessionId: number;
  /** 当前 pending 对应的 ui-request id（用于 respondUi 回传） */
  requestId: string | null;
  setVisual: (html: string, mode: 'inline' | 'panel') => void;
  setPending: (pending: boolean, requestId?: string) => void;
  clearVisual: () => void;
}

export const useVisualStore = create<VisualState>()((set, get) => ({
  html: null,
  mode: null,
  pending: false,
  sessionId: 0,
  requestId: null,

  setVisual: (html, mode) =>
    set((s) => ({
      html,
      mode,
      pending: s.pending, // pending 由 setPending 管理
      sessionId: s.sessionId + 1,
    })),

  setPending: (pending, requestId) =>
    set({ pending, requestId: requestId ?? get().requestId }),

  clearVisual: () => set({ html: null, mode: null, pending: false, requestId: null }),
}));
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd tauri-agent && npx vitest run src/stores/visualStore.test.ts 2>&1 | tail -5
```
预期：PASS

- [ ] **步骤 5：commit**

```bash
git add tauri-agent/src/stores/visualStore.ts tauri-agent/src/stores/visualStore.test.ts
git commit -m "feat(visual-companion): visualStore"
```

---

## 任务 4：ExtensionUiHost — 分发 visual 事件

**文件：** 修改 `tauri-agent/src/features/extensionUi/ExtensionUiHost.tsx`

- [ ] **步骤 1：添加 visual setStatus 分发**

在 `ExtensionUiHost.tsx` 的 `setStatus` 分支中，在 `approval-policy` 分支后加入（`tauri-agent/src/features/extensionUi/ExtensionUiHost.tsx:105`）：

```diff
         } else if (r.statusKey === 'approval-policy') {
           if (isApprovalPolicy(r.statusText)) useApprovalStore.getState().setLevel(e.workspace, r.statusText);
+        } else if (r.statusKey === 'visual') {
+          try {
+            const d = typeof r.statusText === 'string' ? JSON.parse(r.statusText) : null;
+            if (d?.action === 'show' && typeof d.html === 'string') {
+              useVisualStore.getState().setVisual(d.html, d.mode === 'panel' ? 'panel' : 'inline');
+            }
+          } catch { /* ignore malformed */ }
         }
```

在 `input` 方法分支中，识别 `__visualChoice` 哨兵（在 `parseAskUserPayload` 检查之后）：

```diff
       if (method === 'input') {
         const data = parseAskUserPayload((e.request as { title?: unknown }).title);
         if (data) {
           useInlineQuestionStore.getState().setRequest({ workspace: e.workspace, id: e.request.id, data });
           return;
         }
+        // visual choice 哨兵：read_visual_choice 阻塞中，标记 pending 并记录 requestId
+        try {
+          const sentinel = typeof (e.request as { title?: unknown }).title === 'string'
+            ? JSON.parse((e.request as { title: string }).title) : null;
+          if (sentinel?.__visualChoice === 1) {
+            useVisualStore.getState().setPending(true, e.request.id);
+            return;
+          }
+        } catch { /* not visual */ }
       }
```

- [ ] **步骤 2：添加 import**

在文件顶部 imports 中加入：

```diff
+import { useVisualStore } from '../../stores/visualStore';
```

- [ ] **步骤 3：TypeScript 编译检查**

```bash
cd tauri-agent && npx tsc --noEmit 2>&1 | head -20
```
预期：无新增类型错误

- [ ] **步骤 4：commit**

```bash
git add tauri-agent/src/features/extensionUi/ExtensionUiHost.tsx tauri-agent/src/stores/visualStore.ts
git commit -m "feat(visual-companion): dispatch visual status to visualStore"
```

---

## 任务 5：frameAssets — 内嵌 CSS + helper.js

**文件：** 创建 `tauri-agent/src/features/visual/frameAssets.ts`

- [ ] **步骤 1：提取 frame-template.html 的样式**

读取 `C:\Users\rxstudio\.config\opencode\skills\brainstorming\scripts\frame-template.html`，提取 `<style>` 块内容；读取 `helper.js` 全文。

- [ ] **步骤 2：创建 frameAssets.ts**

将样式和脚本以字符串常量嵌入（这里用占位 — 实现时替换为真实内容）：

```typescript
// 从 brainstorming skill 的 frame-template.html 提取的 CSS（深色主题优先）
export const FRAME_CSS = `
/* ==== 粘贴 frame-template.html 内 <style> 块的全部内容 ==== */
`;

// 从 brainstorming skill 的 helper.js 提取的客户端脚本
export const HELPER_JS = `
/* ==== 粘贴 helper.js 的全部内容 ==== */
`;

/**
 * 把 HTML 片段（或完整文档）包裹进 frame-template，并注入 helper.js。
 * 如果输入是完整文档（以 <!DOCTYPE 或 <html 开头），仅注入 helper.js。
 */
export function buildSrcDoc(html: string): string {
  const isFullDoc = /^\s*<!doctype|^\s*<html/i.test(html);
  const helperTag = `<script>\n${HELPER_JS}\n</script>`;

  if (isFullDoc) {
    return html.includes('</body>')
      ? html.replace('</body>', `${helperTag}\n</body>`)
      : html + helperTag;
  }

  // 片段：包裹进 frame-template 结构
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${FRAME_CSS}</style>
</head>
<body>
${html}
${helperTag}
</body>
</html>`;
}
```

> **实现时**：运行以下命令提取实际内容替换占位符：
> ```bash
> # 提取 CSS（<style>…</style> 之间的内容）
> # 提取 helper.js 全文
> # 粘贴到 FRAME_CSS 和 HELPER_JS 常量中
> ```
> 读取路径：`C:\Users\rxstudio\.config\opencode\skills\brainstorming\scripts\frame-template.html` 和 `helper.js`

- [ ] **步骤 3：TypeScript 检查**

```bash
cd tauri-agent && npx tsc --noEmit 2>&1 | grep "frameAssets" | head -10
```
预期：无错误

- [ ] **步骤 4：commit**

```bash
git add tauri-agent/src/features/visual/frameAssets.ts
git commit -m "feat(visual-companion): frameAssets with frame-template CSS + helper.js"
```

---

## 任务 6：VisualCard — 内联卡片组件

**文件：** 创建 `tauri-agent/src/features/visual/VisualCard.tsx`

- [ ] **步骤 1：实现组件**

```tsx
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { useVisualStore } from '../../stores/visualStore';
import { buildSrcDoc } from './frameAssets';
import { extensionUiRespond } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    width: 100%;
    min-width: 0;
    margin: 4px 0;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: ${cssVar.colorPrimary};
    text-transform: uppercase;
  `,
  dot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
    flex-shrink: 0;
  `,
  frame: css`
    border: none;
    width: 100%;
    display: block;
  `,
  done: css`
    padding: 8px 12px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-align: center;
  `,
}));

/**
 * 内联视觉卡片：渲染 visualStore 中的 html（iframe sandbox）。
 * 挂载点：ChatMessageItems → notice customType="visual-inline"
 */
export const VisualCard = memo(function VisualCard() {
  const { workspace } = useAgentStoreContext();
  const { html, sessionId, pending, requestId } = useVisualStore((s) => ({
    html: s.html,
    sessionId: s.sessionId,
    pending: s.pending,
    requestId: s.requestId,
  }));
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(280);
  const [submitted, setSubmitted] = useState(false);

  // 监听 iframe 内 helper.js 的 postMessage（toggleSelect 后自动发送）
  const onMessage = useCallback(
    (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;
      const { type, choice, text } = e.data as { type?: string; choice?: string; text?: string };
      if (type !== 'visual-choice' || !choice) return;
      if (submitted || !pending || !requestId) return;
      setSubmitted(true);
      const answer = JSON.stringify({ choice, text: text ?? '', timestamp: Date.now() });
      extensionUiRespond(workspace, { id: requestId, value: answer });
      useVisualStore.getState().setPending(false);
    },
    [submitted, pending, requestId, workspace],
  );

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onMessage]);

  // 接收 iframe 高度通知（helper.js 发 resize 消息）
  const onResize = useCallback((e: MessageEvent) => {
    if (e.data?.type === 'visual-resize' && typeof e.data.height === 'number') {
      setFrameHeight(Math.max(120, Math.min(e.data.height + 32, 800)));
    }
  }, []);

  useEffect(() => {
    window.addEventListener('message', onResize);
    return () => window.removeEventListener('message', onResize);
  }, [onResize]);

  // html 变化时重置 submitted
  useEffect(() => { setSubmitted(false); }, [sessionId]);

  if (!html) return null;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.dot} />
        Visual
        {submitted ? ' · 已选择' : pending ? ' · 等待选择' : ''}
      </div>
      {submitted ? (
        <div className={styles.done}>已提交选择</div>
      ) : (
        <iframe
          key={sessionId}
          ref={iframeRef}
          className={styles.frame}
          sandbox="allow-scripts"
          srcDoc={buildSrcDoc(html)}
          style={{ height: frameHeight }}
          title="Visual Companion"
        />
      )}
    </div>
  );
});
```

> **注意：** `helper.js` 需要在 iframe 内发 `postMessage({ type: 'visual-choice', choice, text })` 和 `postMessage({ type: 'visual-resize', height })` 到父窗口。见任务 7 的 helper.js 修改。

- [ ] **步骤 2：挂载到 ChatMessageItems**

在 `tauri-agent/src/features/chat/ChatMessageItems.tsx` 中：

```diff
 import { SubAgentGroupInline, type NumberedUnit } from './SubAgentGroupInline';
+import { VisualCard } from '../visual/VisualCard';
```

```diff
     case 'notice':
       if (msg.customType === 'agent-answer') return <AnswerCard content={msg.content} />;
       if (msg.customType === 'agent-plan') return <PlanCard content={msg.content} />;
       if (msg.customType === 'agent-questions') {
         return <QuestionsCard answered={answeredQuestions.has(msg.id)} content={msg.content} />;
       }
+      if (msg.customType === 'visual-inline') return <VisualCard />;
       return <NoticePill customType={msg.customType} content={msg.content} />;
```

- [ ] **步骤 3：TypeScript 检查**

```bash
cd tauri-agent && npx tsc --noEmit 2>&1 | head -20
```
预期：无错误

- [ ] **步骤 4：commit**

```bash
git add tauri-agent/src/features/visual/VisualCard.tsx tauri-agent/src/features/chat/ChatMessageItems.tsx
git commit -m "feat(visual-companion): VisualCard inline component"
```

---

## 任务 7：helper.js 适配 — 添加 postMessage

**文件：** `frameAssets.ts` 中的 `HELPER_JS` 常量（在任务 5 基础上扩展）

`helper.js` 的 `toggleSelect` 函数需要在用户点击后发送 `postMessage` 给父窗口。在提取的 `helper.js` 末尾追加（或修改 `toggleSelect`）：

```javascript
// 视觉伴侣：选定后通知父窗口
function notifyChoice(el) {
  const choice = el.dataset.choice || el.closest('[data-choice]')?.dataset.choice || '';
  const text = el.querySelector('.content h3, .letter')?.textContent?.trim() || choice;
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'visual-choice', choice, text }, '*');
  }
}

// 高度通知：DOM 渲染后发送实际高度
function notifyResize() {
  const height = document.body.scrollHeight;
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'visual-resize', height }, '*');
  }
}

// 在原 toggleSelect 调用后触发 notifyChoice
const _origToggle = typeof toggleSelect === 'function' ? toggleSelect : null;
if (_origToggle) {
  window.toggleSelect = function(el) {
    _origToggle(el);
    notifyChoice(el);
  };
}

window.addEventListener('DOMContentLoaded', notifyResize);
window.addEventListener('load', notifyResize);
```

**实现步骤：**

- [ ] **步骤 1：读取原始 helper.js 内容**

```
读取：C:\Users\rxstudio\.config\opencode\skills\brainstorming\scripts\helper.js
```

- [ ] **步骤 2：更新 frameAssets.ts 的 HELPER_JS 常量**

将读取到的内容与上方 postMessage 扩展拼接后写入 `HELPER_JS`。

- [ ] **步骤 3：手动测试**（在浏览器 DevTools 中）

在任意包含 `.option[data-choice]` 的页面中注入脚本，点击选项后验证 `window.parent.postMessage` 被调用（若在同域下可通过 `window.addEventListener('message', console.log)` 验证）。

- [ ] **步骤 4：commit**

```bash
git add tauri-agent/src/features/visual/frameAssets.ts
git commit -m "feat(visual-companion): frameAssets postMessage integration"
```

---

## 任务 8：VisualPanel — 右侧面板组件

**文件：** 创建 `tauri-agent/src/features/visual/VisualPanel.tsx`

- [ ] **步骤 1：实现组件**

```tsx
import { memo, useCallback, useEffect, useState } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { X } from 'lucide-react';
import { ActionIcon } from '@lobehub/ui';
import { useVisualStore } from '../../stores/visualStore';
import { buildSrcDoc } from './frameAssets';
import { extensionUiRespond } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    flex-shrink: 0;
  `,
  title: css`
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 700;
    color: ${cssVar.colorPrimary};
    letter-spacing: 0.05em;
    text-transform: uppercase;
  `,
  dot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
  `,
  frame: css`
    flex: 1;
    border: none;
    width: 100%;
    min-height: 0;
  `,
  empty: css`
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

interface VisualPanelProps {
  onClose?: () => void;
}

export const VisualPanel = memo(function VisualPanel({ onClose }: VisualPanelProps) {
  const { workspace } = useAgentStoreContext();
  const { html, sessionId, pending, requestId } = useVisualStore((s) => ({
    html: s.html,
    sessionId: s.sessionId,
    pending: s.pending,
    requestId: s.requestId,
  }));
  const [submitted, setSubmitted] = useState(false);

  const onMessage = useCallback(
    (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;
      const { type, choice, text } = e.data as { type?: string; choice?: string; text?: string };
      if (type !== 'visual-choice' || !choice) return;
      if (submitted || !pending || !requestId) return;
      setSubmitted(true);
      const answer = JSON.stringify({ choice, text: text ?? '', timestamp: Date.now() });
      extensionUiRespond(workspace, { id: requestId, value: answer });
      useVisualStore.getState().setPending(false);
    },
    [submitted, pending, requestId, workspace],
  );

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onMessage]);

  useEffect(() => { setSubmitted(false); }, [sessionId]);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>
          <span className={styles.dot} />
          Visual
          {submitted ? ' · 已选择' : pending ? ' · 等待选择' : ''}
        </span>
        {onClose && (
          <ActionIcon icon={X} size="small" onClick={onClose} title="关闭面板" />
        )}
      </div>
      {html ? (
        <iframe
          key={sessionId}
          className={styles.frame}
          sandbox="allow-scripts"
          srcDoc={buildSrcDoc(html)}
          title="Visual Companion Panel"
        />
      ) : (
        <div className={styles.empty}>等待 Agent 推送内容…</div>
      )}
    </div>
  );
});
```

- [ ] **步骤 2：集成到 App.tsx 的 RightPanelColumn**

当 `visualStore.mode === 'panel'` 且 `html != null` 时，自动打开右侧面板并渲染 `VisualPanel`：

在 `tauri-agent/src/App.tsx` 的 `RightPanelColumn` 组件中修改：

```diff
+import { VisualPanel } from './features/visual/VisualPanel';
+import { useVisualStore } from './stores/visualStore';
```

```diff
 const RightPanelColumn = memo(function RightPanelColumn() {
   const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);
+  const setRightPanelOpen = useLayoutStore((s) => s.setRightPanelOpen);
+  const visualMode = useVisualStore((s) => s.mode);
+  const visualHtml = useVisualStore((s) => s.html);
+
+  // 当 show_visual 推送 panel 模式时自动打开右侧面板
+  useEffect(() => {
+    if (visualMode === 'panel' && visualHtml) {
+      setRightPanelOpen(true);
+    }
+  }, [visualMode, visualHtml, setRightPanelOpen]);

   return (
     <RightPanelShell>
-      <DockPanel region="right" onCollapse={toggleRightPanel} />
+      {visualMode === 'panel' && visualHtml ? (
+        <VisualPanel onClose={() => { toggleRightPanel(); }} />
+      ) : (
+        <DockPanel region="right" onCollapse={toggleRightPanel} />
+      )}
     </RightPanelShell>
   );
 });
```

需要在 `RightPanelColumn` 内引入 `useEffect`（已在文件顶部 import）。

- [ ] **步骤 3：TypeScript 检查**

```bash
cd tauri-agent && npx tsc --noEmit 2>&1 | head -20
```
预期：无错误

- [ ] **步骤 4：commit**

```bash
git add tauri-agent/src/features/visual/VisualPanel.tsx tauri-agent/src/App.tsx
git commit -m "feat(visual-companion): VisualPanel right-side panel"
```

---

## 任务 9：扩展触发 show_visual → notice 消息推送

**文件：** 修改 `extensions/visual-companion/index.ts`

`show_visual` 调用后，除了 `setStatus` 推 HTML 给前端，还需要根据 mode 推一条 notice 消息，让聊天流中有 `visual-inline` 类型的 notice（内联卡片的挂载点）。仅 `inline` 模式需要：

```diff
       // 推给前端：复用 setStatus 管道
       const payload = JSON.stringify({ action: "show", html, mode });
       ctx.ui.setStatus("visual", payload);

+      // inline 模式：往对话流追加一条 visual-inline notice，为 VisualCard 提供挂载点
+      if (mode === "inline") {
+        pi.sendMessage(
+          { customType: "visual-inline", content: "", display: true },
+          { triggerTurn: false },
+        );
+      }

       return { content: [{ type: "text", text: `[visual shown, mode=${mode}]` }] };
```

- [ ] **步骤 1：修改 extensions/visual-companion/index.ts**（按上方 diff）

- [ ] **步骤 2：TypeScript 检查**

```bash
cd extensions && npx tsc --noEmit 2>&1 | head -10
```

- [ ] **步骤 3：commit**

```bash
git add extensions/visual-companion/index.ts
git commit -m "feat(visual-companion): send visual-inline notice for chat mount point"
```

---

## 任务 10：端到端验证

- [ ] **步骤 1：启动开发服务器**

```bash
cd tauri-agent && bun run tauri dev
```

- [ ] **步骤 2：测试内联模式**

在 GrenAgent 中发送以下提示：
```
调用 show_visual，html 为：
<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content"><h3>选项 A</h3><p>测试内联</p></div>
  </div>
  <div class="option" data-choice="b" onclick="toggleSelect(this)">
    <div class="letter">B</div>
    <div class="content"><h3>选项 B</h3><p>另一个</p></div>
  </div>
</div>
然后立即调用 read_visual_choice 等待结果，并把结果告诉我。
```

预期：聊天流中出现 VisualCard，点击 A 或 B 后，AI 在下一轮回复选择结果。

- [ ] **步骤 3：测试面板模式**

发送含 `.mockup` 类的 html，验证右侧 VisualPanel 自动弹出。

- [ ] **步骤 4：测试超时**

设置 `timeout=5`，5 秒内不点击，验证 AI 收到 timeout 错误后继续。

- [ ] **步骤 5：commit（若有修复）**

```bash
git add -A && git commit -m "fix(visual-companion): e2e fixes"
```

---

## 规格覆盖检查

| 规格章节 | 对应任务 |
|---------|---------|
| 扩展 show_visual | 任务 2 |
| 扩展 read_visual_choice | 任务 2 |
| auto 模式检测 | 任务 1 |
| Tauri IPC 事件桥 | 任务 4（复用现有 setStatus 管道，无需新增 Rust 代码） |
| visualStore | 任务 3 |
| VisualCard 内联 | 任务 6 |
| ChatMessageItems 挂载 | 任务 6 |
| frameAssets CSS 兼容 | 任务 5、7 |
| VisualPanel 面板 | 任务 8 |
| App.tsx 集成 | 任务 8 |
| 超时处理 | 任务 2 |
| 连续 show_visual 覆盖 | 任务 3（sessionId 递增） |
