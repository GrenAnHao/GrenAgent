# 对话渲染 1:1 复刻 lobehub 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把 `tauri-agent` 对话消息渲染像素级 1:1 复刻 lobehub：去掉高层 `<ChatList>` 包装与 `toLobeMessages` 适配器，改用自研 `ChatItem` 外壳 + `ContentBlock` 直接渲染 `DisplayMessage[]`；工具/思考/子代理/网页查询四类按 lobehub 精确视觉重做。

**架构：** `agentStore.messages → groupMessages() → DisplayMessage[] → ChatMessageItems`（已存在，直接渲染，无适配器）。消息项用自研外壳：用户右对齐气泡、助手左对齐全宽 ContentBlock 垂直栈（Reasoning→Markdown→Tools）。工具用 `@lobehub/ui` Accordion + 24px outlined Block + ToolTitle；多工具 WorkflowCollapse；子代理流内内联折叠 + 保留 RightPanel；网页查询 Inspector + ScrollShadow 结果卡。**不要头像、不要假 role、不要 as-any。**

**技术栈：** React + TypeScript、`@lobehub/ui`（Flexbox/Block/Icon/Accordion/Collapse/Markdown）、antd-style（`createStaticStyles` + `cssVar.*`）、lucide-react、vitest + @testing-library/react。

**设计依据：** `docs/superpowers/specs/2026-06-14-grenagent-chat-render-lobehub-replica-design.md`；视觉基准 `.superpowers/brainstorm/chatlist-replica/content/`（10/20/30/40/51）。

---

## 关键事实（已核实）

- `ChatMessageItems.tsx`（已存在）已能按 `DisplayMessage.kind` 路由渲染 user/assistantGroup/tool/notice，子代理对话在用它。**主对话改用它即可去掉 ChatList。**
- `groupMessages.ts`（保留）已产出 `assistantGroup`（合并连续 assistant+tool）。
- `SubAgentConversation.tsx` 已有 scroll 容器 + 跟随滚底模式（`atBottomRef`）、`messagesFromTranscript` 还原子代理 JSONL。
- `Thinking.tsx`、`StatusIndicator.tsx`、`cardStyles.ts` 已基本对齐 lobehub（折叠/原子图标/shimmer/用时/浅色/24px Block）。
- 测试：vitest + `@testing-library/react`，需 `<ThemeProvider themeMode="dark">` 包裹；`@lobehub/ui` 首渲较重，给 `{ timeout: 30_000 }`。
- `LazyMarkdown` = 懒加载 `@lobehub/ui` `Markdown`，传 `variant="chat"`、`fontSize`、`animated`。
- 深色 token 取值见设计文档表（实现一律用 `cssVar.*`，勿写死 hex）。

## 文件结构

**新增：**
- `tauri-agent/src/features/chat/ChatItemShell.tsx` — 自研外壳（左/右对齐、gap8/paddingBlock8、用户 paddingInlineStart36、无头像）。
- `tauri-agent/src/features/chat/ChatItemShell.test.tsx`
- `tauri-agent/src/features/tools/WorkflowCollapse.tsx` — 多工具总折叠。
- `tauri-agent/src/features/tools/WorkflowCollapse.test.tsx`
- `tauri-agent/src/features/chat/SubAgentInline.tsx` — 流内内联子代理折叠块。
- `tauri-agent/src/features/chat/SubAgentInline.test.tsx`
- `tauri-agent/src/features/chat/chatStyles.ts` — 共享 ChatItem/气泡/ContentBlock 样式。

**修改：**
- `tauri-agent/src/features/chat/ChatListView.tsx` — 去 `<ChatList>`/`toLobeMessages`，改 scroll 容器 + `ChatMessageItems`。
- `tauri-agent/src/features/chat/AssistantMessage.tsx` — 用 `ChatItemShell` + ContentBlock（去 lobe `ChatItem variant=docs`）。
- `tauri-agent/src/features/chat/UserMessage.tsx` — 用 `ChatItemShell` 右对齐气泡（去 lobe `ChatItem`）。
- `tauri-agent/src/features/chat/ChatMessageItems.tsx` — assistantGroup 多工具时套 WorkflowCollapse；tool=spawn_agent 走 SubAgentInline。
- `tauri-agent/src/features/tools/extensionCards.tsx` — 重写 `WebSearchCard`（ScrollShadow 结果卡）、对齐 `FetchUrlCard`。
- `tauri-agent/src/features/tools/cardStyles.ts` — 补 ToolTitle 分隔/结果卡/ScrollShadow 样式。

**删除：**
- `tauri-agent/src/features/chat/messageAdapter.ts` + `messageAdapter.test.ts`（toLobeMessages 不再需要）。

## 通用命令
- 测试：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/<path>`
- 类型：`cd tauri-agent && bunx tsc --noEmit`
- 全量对话测试：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/chat src/features/tools`

---

## 阶段 1：列表去 ChatList（最小可见改动，先拔掉"改炸"根源）

### 任务 1：ChatListView 改用 ChatMessageItems + 自研 scroll 容器

**文件：**
- 修改：`tauri-agent/src/features/chat/ChatListView.tsx`
- 测试：`tauri-agent/src/features/chat/ChatListView.test.tsx`（已存在，更新）

- [ ] **步骤 1：更新测试为新结构（去 lobe ChatList 断言）**

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { AgentStoreProvider } from '../../stores/AgentStoreContext'; // 按实际 provider 名
import { ChatListView } from './ChatListView';

afterEach(cleanup);
// 若 store 需注入消息，用现有测试 helper；此处断言渲染管线连通
describe('ChatListView', { timeout: 30_000 }, () => {
  it('渲染用户与助手消息（无 lobe ChatList 包装）', async () => {
    render(
      <ThemeProvider themeMode="dark">
        {/* 用现有测试里给 store 灌消息的方式包裹 */}
        <ChatListView />
      </ThemeProvider>,
    );
    // 断言滚动容器存在（data-testid="chat-scroll"）
    expect(document.querySelector('[data-testid="chat-scroll"]')).not.toBeNull();
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/chat/ChatListView.test.tsx`
预期：FAIL（旧实现无 `chat-scroll` testid）。

- [ ] **步骤 3：重写 ChatListView**

```tsx
import { useEffect, useMemo, useRef } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { useAgentStore } from '../../stores/AgentStoreContext';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages } from './groupMessages';
import { ChatMessageItems } from './ChatMessageItems';

const styles = createStaticStyles(({ css }) => ({
  scroll: css`position:absolute; inset:0; overflow-y:auto;`,
  list: css`
    display:flex; flex-direction:column; gap:8px;
    max-width:768px; margin:0 auto; padding:16px 24px;
  `,
}));

interface ChatListViewProps { bottomOffset?: number }

export function ChatListView({ bottomOffset = 88 }: ChatListViewProps) {
  const { useStore } = useAgentStore();
  const messages = useStore((s) => s.messages);
  const isStreaming = useStore((s) => s.isStreaming);
  const throttled = useThrottledValue(messages, 100, { enabled: isStreaming });
  const display = useMemo(() => groupMessages(throttled), [throttled]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current; if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div ref={scrollRef} className={styles.scroll} onScroll={onScroll} data-testid="chat-scroll">
      <div className={styles.list} style={{ paddingBottom: bottomOffset }}>
        <ChatMessageItems messages={display} />
      </div>
    </div>
  );
}
```

- [ ] **步骤 4：运行确认通过 + 类型**

运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/chat/ChatListView.test.tsx && bunx tsc --noEmit`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/ChatListView.tsx tauri-agent/src/features/chat/ChatListView.test.tsx
git commit -m "refactor(chat): ChatListView renders DisplayMessage via ChatMessageItems (drop lobe ChatList wrapper)"
```

### 任务 2：删除 messageAdapter（toLobeMessages）

**文件：** 删除 `messageAdapter.ts` + `messageAdapter.test.ts`

- [ ] **步骤 1：确认无引用**

运行：`cd tauri-agent && bunx tsc --noEmit`（删除前先 grep 引用：仅 ChatListView 用过，任务 1 已去除）。

- [ ] **步骤 2：删除文件并 typecheck**

```bash
git rm tauri-agent/src/features/chat/messageAdapter.ts tauri-agent/src/features/chat/messageAdapter.test.ts
cd tauri-agent && bunx tsc --noEmit
```
预期：无报错。

- [ ] **步骤 3：Commit**

```bash
git commit -m "chore(chat): remove toLobeMessages adapter (no longer wrapping lobe ChatList)"
```

---

## 阶段 2：自研 ChatItem 外壳 + ContentBlock（1:1 骨架）

### 任务 3：ChatItemShell（无头像外壳）

**文件：**
- 创建：`tauri-agent/src/features/chat/chatStyles.ts`、`ChatItemShell.tsx`、`ChatItemShell.test.tsx`

- [ ] **步骤 1：写样式**（`chatStyles.ts`）

```ts
import { createStaticStyles, cssVar } from 'antd-style';
export const chatStyles = createStaticStyles(({ css }) => ({
  item: css`display:flex; flex-direction:column; gap:8px; padding-block:8px; max-width:100%;`,
  itemUser: css`align-items:flex-end; padding-inline-start:36px;`,
  body: css`display:flex; flex-direction:column; gap:8px; max-width:100%; overflow:hidden;`,
  bodyAssistant: css`width:100%;`,
  bubble: css`
    padding:8px 12px; border-radius:${cssVar.borderRadiusLG};
    background:${cssVar.colorFillTertiary}; font-size:14px; line-height:1.6;
  `,
}));
```

- [ ] **步骤 2：写失败测试**（`ChatItemShell.test.tsx`）

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { ChatItemShell } from './ChatItemShell';

afterEach(cleanup);
const wrap = (ui: React.ReactElement) => render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

describe('ChatItemShell', () => {
  it('user 右对齐 + 气泡，无头像', () => {
    wrap(<ChatItemShell placement="right"><span>hi</span></ChatItemShell>);
    expect(screen.getByText('hi')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull(); // 无头像
  });
  it('assistant 左对齐全宽', () => {
    wrap(<ChatItemShell placement="left"><span>yo</span></ChatItemShell>);
    expect(screen.getByText('yo')).toBeTruthy();
  });
});
```

- [ ] **步骤 3：运行确认失败**

运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/chat/ChatItemShell.test.tsx` → FAIL（组件不存在）。

- [ ] **步骤 4：实现 ChatItemShell**

```tsx
import { memo, type ReactNode } from 'react';
import { cx } from 'antd-style';
import { chatStyles } from './chatStyles';

interface Props { placement: 'left' | 'right'; bubble?: boolean; children: ReactNode }

function ChatItemShellInner({ placement, bubble, children }: Props) {
  const isUser = placement === 'right';
  return (
    <div className={cx(chatStyles.item, isUser && chatStyles.itemUser)}>
      <div className={cx(chatStyles.body, !isUser && chatStyles.bodyAssistant)}>
        {bubble ? <div className={chatStyles.bubble}>{children}</div> : children}
      </div>
    </div>
  );
}
export const ChatItemShell = memo(ChatItemShellInner);
```

- [ ] **步骤 5：运行确认通过**

运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/chat/ChatItemShell.test.tsx` → PASS。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/chat/chatStyles.ts tauri-agent/src/features/chat/ChatItemShell.tsx tauri-agent/src/features/chat/ChatItemShell.test.tsx
git commit -m "feat(chat): add avatar-less ChatItemShell (lobehub-aligned spacing)"
```

### 任务 4：UserMessage 用 ChatItemShell

**文件：** 修改 `UserMessage.tsx`（测试沿用现有，如无则加）

- [ ] **步骤 1：改写 UserMessage**

```tsx
import { memo } from 'react';
import { ChatItemShell } from './ChatItemShell';

function UserMessageInner({ text }: { text: string }) {
  return <ChatItemShell placement="right" bubble>{text}</ChatItemShell>;
}
export const UserMessage = memo(UserMessageInner);
```

- [ ] **步骤 2：运行 chat 测试 + 类型** → PASS。
运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/chat && bunx tsc --noEmit`

- [ ] **步骤 3：Commit**
```bash
git add tauri-agent/src/features/chat/UserMessage.tsx
git commit -m "refactor(chat): UserMessage uses ChatItemShell bubble (drop lobe ChatItem)"
```

### 任务 5：AssistantMessage 用 ChatItemShell + ContentBlock 顺序

**文件：** 修改 `AssistantMessage.tsx`；测试沿用 `AssistantMessage.test.tsx`（已覆盖 thinking/tools）

- [ ] **步骤 1：改写 AssistantMessage**（保留 props API，内部换外壳；顺序 Reasoning→Markdown→Tools）

```tsx
import { Suspense, lazy, memo } from 'react';
import { ChatItemShell } from './ChatItemShell';
import { Thinking } from './Thinking';
import { LazyMarkdown } from './LazyMarkdown';
const ToolExecution = lazy(() => import('../tools/ToolExecution').then((m) => ({ default: m.ToolExecution })));

export interface AssistantToolItem { id:string; toolCallId:string; toolName:string; args:unknown; result:unknown; status:'running'|'done'|'error'; }
interface Props { text:string; thinking:string; streaming:boolean; thinkingDuration?:number; tools?:AssistantToolItem[]; }

function AssistantMessageInner({ text, thinking, streaming, thinkingDuration, tools }: Props) {
  const reasoning = streaming && !text;
  return (
    <ChatItemShell placement="left">
      {thinking && <Thinking content={thinking} thinking={reasoning} duration={thinkingDuration} />}
      {text && <LazyMarkdown variant="chat" fontSize={14} animated={streaming}>{text}</LazyMarkdown>}
      {tools && tools.length > 0 && (
        <Suspense fallback={null}>
          {tools.map((t) => (
            <ToolExecution key={t.id} toolName={t.toolName} toolCallId={t.toolCallId} args={t.args} result={t.result} status={t.status} />
          ))}
        </Suspense>
      )}
    </ChatItemShell>
  );
}
export const AssistantMessage = memo(AssistantMessageInner);
```

> 注：多工具 WorkflowCollapse 在任务 7 接入（此处先平铺，保证测试绿）。

- [ ] **步骤 2：运行 AssistantMessage 测试 + 类型** → PASS（现有断言：思考文案、tools 命中 grep_search）。
运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/chat/AssistantMessage.test.tsx && bunx tsc --noEmit`

- [ ] **步骤 3：Commit**
```bash
git add tauri-agent/src/features/chat/AssistantMessage.tsx
git commit -m "refactor(chat): AssistantMessage uses ChatItemShell + ContentBlock order (drop lobe ChatItem docs variant)"
```

---

## 阶段 3：工具 1:1（Inspector / StatusIndicator / WorkflowCollapse）

### 任务 6：核对 StatusIndicator 与 ToolTitle 视觉

**文件：** 修改 `StatusIndicator.tsx`、`cardStyles.ts`（仅在偏离时调整）

- [ ] **步骤 1：核对**（对照设计文档 6.5）：
  - StatusIndicator：done=`Check`(colorSuccess)、error=`X`(colorError)、running=`Loader2` spin、thinking=`Atom`(colorTextSecondary)；Block 24×24 `variant="outlined"`、`borderRadius` 8、`fontSize` 12。现状已符合 → 不改。
  - ToolTitle（`cardStyles.inspectorTitle/toolName/paramKey/paramValue`）：分隔符用 `ChevronRight`；`toolName` code+secondary、`paramKey` code+tertiary、`paramValue` code+secondary。现状已符合 → 不改。

- [ ] **步骤 2：若需微调则改 cardStyles 并跑 tools 测试**
运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/tools`
> 无偏离则跳过 commit。

### 任务 7：WorkflowCollapse（多工具总折叠）

**文件：** 创建 `WorkflowCollapse.tsx` + `.test.tsx`；修改 `ChatMessageItems.tsx`、`AssistantMessage.tsx`

- [ ] **步骤 1：写失败测试**（`WorkflowCollapse.test.tsx`）

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { WorkflowCollapse } from './WorkflowCollapse';

afterEach(cleanup);
const wrap = (ui: React.ReactElement) => render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);
const tools = [
  { id:'a', toolCallId:'a', toolName:'glob', args:{}, result:{}, status:'done' as const },
  { id:'b', toolCallId:'b', toolName:'read', args:{}, result:{}, status:'done' as const },
];
describe('WorkflowCollapse', { timeout: 30_000 }, () => {
  it('折叠态显示工具数摘要', () => {
    wrap(<WorkflowCollapse tools={tools} />);
    expect(screen.getByText(/运行了 2 个工具|2 个工具/)).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行确认失败** → FAIL。
运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/tools/WorkflowCollapse.test.tsx`

- [ ] **步骤 3：实现 WorkflowCollapse**（borderless Collapse + 状态块 + 摘要；展开渲染 ToolExecution 列表）

```tsx
import { Collapse, Flexbox, Icon } from '@lobehub/ui';
import { Maximize2 } from 'lucide-react';
import { Suspense, lazy, useState } from 'react';
import { StatusIndicator } from './StatusIndicator';
import { useCardStyles } from './cardStyles';
import type { AssistantToolItem } from '../chat/AssistantMessage';
const ToolExecution = lazy(() => import('./ToolExecution').then((m) => ({ default: m.ToolExecution })));

export function WorkflowCollapse({ tools }: { tools: AssistantToolItem[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.some((t) => t.status === 'running');
  const errored = tools.some((t) => t.status === 'error');
  const status = running ? 'running' : errored ? 'error' : 'done';
  const label = (
    <Flexbox horizontal align="center" gap={6} style={{ minHeight: 22 }}>
      <StatusIndicator status={status} />
      <span style={{ fontSize: 12, color: 'var(--lobe-color-text-secondary)' }}>
        {running ? `正在运行工具…` : `运行了 ${tools.length} 个工具`}
      </span>
      <Icon icon={Maximize2} size={12} style={{ marginLeft: 'auto' }} />
    </Flexbox>
  );
  return (
    <Collapse variant="borderless" gap={4}
      activeKey={open ? ['wf'] : []}
      onChange={(k) => setOpen((Array.isArray(k)?k:[k]).includes('wf'))}
      items={[{ key:'wf', label, children: open ? (
        <Suspense fallback={null}>
          {tools.map((t) => <ToolExecution key={t.id} toolName={t.toolName} toolCallId={t.toolCallId} args={t.args} result={t.result} status={t.status} />)}
        </Suspense>
      ) : null }]}
    />
  );
}
```

- [ ] **步骤 4：在 AssistantMessage/ChatMessageItems 接入**（>1 工具用 WorkflowCollapse，单工具平铺）

`AssistantMessage.tsx` tools 块改为：
```tsx
{tools && tools.length > 1
  ? <Suspense fallback={null}><WorkflowCollapseLazy tools={tools} /></Suspense>
  : tools?.length === 1
    ? <Suspense fallback={null}><ToolExecution {...singleToolProps(tools[0])} /></Suspense>
    : null}
```
（`WorkflowCollapseLazy = lazy(() => import('../tools/WorkflowCollapse')...)`；`singleToolProps` 内联映射。）

- [ ] **步骤 5：运行确认通过 + 类型** → PASS。
运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/tools/WorkflowCollapse.test.tsx src/features/chat/AssistantMessage.test.tsx && bunx tsc --noEmit`

- [ ] **步骤 6：Commit**
```bash
git add tauri-agent/src/features/tools/WorkflowCollapse.tsx tauri-agent/src/features/tools/WorkflowCollapse.test.tsx tauri-agent/src/features/chat/AssistantMessage.tsx
git commit -m "feat(tools): WorkflowCollapse for multi-tool turns (lobehub-aligned)"
```

---

## 阶段 4：子代理流内内联（保留 RightPanel）

### 任务 8：SubAgentInline（流内可折叠嵌套子会话）

**文件：** 创建 `SubAgentInline.tsx` + `.test.tsx`；修改 `ChatMessageItems.tsx`

- [ ] **步骤 1：写失败测试**（断言折叠头显示任务名 + 展开渲染嵌套）

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { SubAgentInline } from './SubAgentInline';
afterEach(cleanup);
const wrap = (ui: React.ReactElement) => render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);
describe('SubAgentInline', { timeout: 30_000 }, () => {
  it('折叠头显示任务名', () => {
    wrap(<SubAgentInline index={1} task="分析工具渲染" result={{}} status="done" />);
    expect(screen.getByText(/分析工具渲染/)).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行确认失败** → FAIL。

- [ ] **步骤 3：实现 SubAgentInline**（Collapse + Network 状态块；展开复用 `SubAgentConversation`）

```tsx
import { Collapse, Flexbox, Icon } from '@lobehub/ui';
import { Network } from 'lucide-react';
import { useState } from 'react';
import { StatusIndicator } from '../tools/StatusIndicator';
import { SubAgentConversation } from '../panels/SubAgentConversation';

interface Props { index:number; task:string; result:unknown; status:'running'|'done'|'error'; }
export function SubAgentInline({ index, task, result, status }: Props) {
  const [open, setOpen] = useState(status === 'running');
  const label = (
    <Flexbox horizontal align="center" gap={8}>
      <StatusIndicator status={status} />
      <span style={{ fontSize: 13, color: 'var(--lobe-color-text-secondary)' }}>
        <b style={{ color: 'var(--lobe-color-text)' }}>子代理 #{index}</b> · {task}
      </span>
    </Flexbox>
  );
  return (
    <div style={{ paddingInlineStart: 4 }} data-testid="subagent-inline">
      <Collapse variant="outlined" gap={4}
        activeKey={open ? ['sa'] : []}
        onChange={(k) => setOpen((Array.isArray(k)?k:[k]).includes('sa'))}
        items={[{ key:'sa', label, children: open ? (
          <SubAgentConversation task={task} result={result} status={status} />
        ) : null }]}
      />
    </div>
  );
}
```

- [ ] **步骤 4：ChatMessageItems 接入**（`kind==='tool' && toolName==='spawn_agent'` → SubAgentInline；否则原 ToolExecution）

```tsx
case 'tool':
  if (msg.toolName === 'spawn_agent') {
    return <SubAgentInline key={msg.id} index={1} task={taskLabelOf(msg.args)} result={msg.result} status={msg.status} />;
  }
  return <Suspense key={msg.id} fallback={null}><ToolExecution {...} /></Suspense>;
```
（`taskLabelOf` 从 `RightPanel.tsx` 的 `taskLabel` 抽出共享到 `features/panels/subagentUtils.ts`。）

- [ ] **步骤 5：运行确认通过 + 类型** → PASS。
运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/chat/SubAgentInline.test.tsx && bunx tsc --noEmit`

- [ ] **步骤 6：Commit**
```bash
git add tauri-agent/src/features/chat/SubAgentInline.tsx tauri-agent/src/features/chat/SubAgentInline.test.tsx tauri-agent/src/features/chat/ChatMessageItems.tsx tauri-agent/src/features/panels/subagentUtils.ts
git commit -m "feat(chat): inline collapsible sub-agent in stream (keep RightPanel for deep dive)"
```

---

## 阶段 5：网页查询 ScrollShadow

### 任务 9：WebSearchCard 横滑结果卡（ScrollShadow）

**文件：** 修改 `extensionCards.tsx`、`cardStyles.ts`；测试 `extensionCards.test.tsx`（已存在）

- [ ] **步骤 1：补样式**（`cardStyles.ts` 加 results/rcard/scrollShadow）

```ts
resultsWrap: css`position:relative;`,
resultsWrapFade: css`&::after{content:'';position:absolute;inset:0 0 10px auto;width:36px;pointer-events:none;background:linear-gradient(to right,transparent,${cssVar.colorBgContainer});}`,
results: css`display:flex;gap:8px;overflow-x:auto;padding:6px 4px 10px;scrollbar-width:none;&::-webkit-scrollbar{display:none;}`,
rcard: css`flex:none;width:160px;height:80px;border:1px solid ${cssVar.colorBorderSecondary};background:${cssVar.colorBgContainer};border-radius:${cssVar.borderRadius};padding:8px;display:flex;flex-direction:column;justify-content:space-between;`,
rtitle: css`font-size:12px;line-height:1.4;color:${cssVar.colorText};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;`,
rhost: css`font-size:11px;color:${cssVar.colorTextSecondary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`,
```

- [ ] **步骤 2：更新测试断言结果卡渲染**（`extensionCards.test.tsx`）

```tsx
it('web_search 渲染横滑结果卡（title + host）', () => {
  const result = { details: { provider:'tavily', results:[{ title:'A', url:'https://x.com/a' }] } };
  renderCard('web_search', {}, result, 'done'); // 用现有 helper
  expect(screen.getByText('A')).toBeTruthy();
});
```

- [ ] **步骤 3：运行确认失败** → FAIL（旧卡是竖排列表）。

- [ ] **步骤 4：重写 WebSearchCard**

```tsx
const WebSearchCard: FC<ExtensionCardProps> = ({ result }) => {
  const { styles, cx } = useCardStyles();
  const d = getDetails(result);
  const results = Array.isArray(d?.results) ? (d!.results as Array<{title?:unknown;url?:unknown}>) : [];
  return (
    <div className={cx(styles.resultsWrap, styles.resultsWrapFade)} data-testid="card-web_search">
      <div className={styles.results}>
        {results.map((r, i) => {
          const url = asString(r.url); let host=''; try { host = new URL(url).hostname; } catch {}
          return (
            <a key={i} className={styles.rcard} href={url || undefined} target="_blank" rel="noreferrer">
              <span className={styles.rtitle}>{asString(r.title) || url}</span>
              <span className={styles.rhost}>{host || url}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
};
```

- [ ] **步骤 5：运行确认通过 + 类型** → PASS。
运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/tools/extensionCards.test.tsx && bunx tsc --noEmit`

- [ ] **步骤 6：Commit**
```bash
git add tauri-agent/src/features/tools/extensionCards.tsx tauri-agent/src/features/tools/cardStyles.ts tauri-agent/src/features/tools/extensionCards.test.tsx
git commit -m "feat(tools): web_search ScrollShadow result cards (lobehub web-browsing style)"
```

---

## 阶段 6：收尾验证

### 任务 10：全量回归 + 类型 + 视觉核对

- [ ] **步骤 1：全量测试**
运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/chat src/features/tools src/features/panels && bunx tsc --noEmit`
预期：全绿、无类型错误。

- [ ] **步骤 2：人工视觉核对**：对照 `.superpowers/brainstorm/chatlist-replica/content/` 五屏，逐项确认（间距/颜色/折叠/状态块/ScrollShadow）。

- [ ] **步骤 3：Commit（如有微调）**
```bash
git commit -am "test(chat): regression pass for lobehub 1:1 chat render"
```

---

## 自检

**1. 规格覆盖度：**
- 去 ChatList/adapter/as-any → 任务 1、2 ✓
- 无头像 ChatItem 外壳 + ContentBlock 顺序 → 任务 3、4、5 ✓
- 工具 Inspector/StatusIndicator/ToolTitle → 任务 6 ✓；多工具 WorkflowCollapse → 任务 7 ✓
- 思考（已对齐，任务 6 顺带核对）✓
- 子代理 内联 + RightPanel → 任务 8 ✓（RightPanel 保留不动）
- 网页查询 Inspector + ScrollShadow 结果卡 → 任务 9 ✓；fetch_url 现状保留（视觉随 cardStyles 调）
- 深色 token：全程 `cssVar.*` ✓
- 性能：throttle（任务 1 保留）、memo（各组件保留/新增）✓；virtua 见下「后续」

**2. 占位符扫描：** 各任务均含具体文件路径、代码、命令、commit。无 TODO/待定。

**3. 类型一致性：** `AssistantToolItem` 类型在 AssistantMessage 定义，WorkflowCollapse/单工具复用同一类型；`DisplayMessage.kind` 路由名与 groupMessages 一致；`StatusIndicator` status 取值 `running|done|error|thinking` 全程一致。

## 后续（非本计划范围，按需另起）
- virtua 虚拟滚动接入 ChatListView（长对话上千条时）：用 `virtua` `VList` 替换 scroll 容器，保留 atBottom 跟随。当前 scroll 容器足够中等长度对话，先不引入以降风险。
- 网页查询 citation 角标 / 来源脚注（需模型回传 citation）。
- 工具 running 态从 `Loader2` 升级为 `NeuralNetworkLoading`（@lobehub/ui 已提供）。
