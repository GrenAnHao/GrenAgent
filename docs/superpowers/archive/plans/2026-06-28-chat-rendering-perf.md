# 聊天渲染性能加固 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让聊天主对话与子代理对话的渲染开销与可见消息数成正比、与会话总长无关（虚拟化 + 全局预计算缓存 + agent_end 定点清流式 + Rust 流式读会话文件）。

**架构：** 抽共享 `VirtualizedMessageList`（基于已依赖的 `virtua`）做窗口化渲染 + 贴底滚动，主对话/子代理对话共用；两个全局预计算（子代理连号、提问已答）抽成纯函数并在调用方 `useMemo` 缓存；`agent_end` 只克隆仍 streaming 的 assistant；Rust `find_entry_id_by_timestamp` 改流式读。`LazyMount` 退役。

**技术栈：** React 19 + TypeScript、`virtua`（已在 `tauri-agent/package.json` 依赖）、Vitest（前端）、Rust + serde_json（Tauri 命令）、cargo test。

设计规格：`docs/superpowers/specs/2026-06-28-chat-rendering-perf-design.md`。

> **对规格 item 3 的细化（计划阶段决定）：** 规格写"记 `streamingMessageId` 定点更新"。改为更稳的等效做法——`agent_end` 只克隆仍 `streaming` 的 assistant、其余保留引用。同样消除"每轮克隆整段历史"，但无需在 message_start/message_end/abort 多路径维护新状态字段（更不易出错）。性能目标一致。

---

## 文件结构

- 创建：`tauri-agent/src/features/chat/messagePrecompute.ts` —— 两个全局预计算纯函数（从 `ChatMessageItems` 抽出）。职责：输入 `DisplayMessage[]`，输出 `Map<string, NumberedUnit[]>`（子代理连号）与 `Set<string>`（已答提问 id）。
- 创建：`tauri-agent/src/features/chat/messagePrecompute.test.ts` —— 上述纯函数单测。
- 创建：`tauri-agent/src/features/chat/VirtualizedMessageList.tsx` —— 共享虚拟列表：virtua `VList` + 贴底跟随。职责：窗口化渲染 + atBottom 自动滚底。
- 创建：`tauri-agent/src/features/chat/VirtualizedMessageList.test.tsx` —— 冒烟渲染测试。
- 修改：`tauri-agent/src/features/chat/ChatMessageItems.tsx` —— 改为接收外部预计算（props），用 `VirtualizedMessageList` 渲染；导出 `renderMessageBody` 作为 item 渲染器。删除内部两循环与 `LazyMount`。
- 修改：`tauri-agent/src/features/chat/ChatListView.tsx` —— `useMemo` 预计算；改用 `VirtualizedMessageList`；移除手写滚动（`useLayoutEffect`/`ResizeObserver`）；`PreparingIndicator` 作为列表 footer。
- 修改：`tauri-agent/src/features/panels/SubAgentConversation.tsx` —— `useMemo` 预计算；改用 `VirtualizedMessageList`；移除手写滚动。
- 删除：`tauri-agent/src/features/chat/LazyMount.tsx`（退役）。
- 修改：`tauri-agent/src/stores/agentReducer.ts` —— `agent_end` 只克隆 streaming 的 assistant。
- 修改：`tauri-agent/src/stores/agentReducer.test.ts` —— 新增 agent_end 身份保留 + 正确性用例。
- 修改：`tauri-agent/src-tauri/src/commands/agent.rs` —— `find_entry_id_by_timestamp` 改 `BufReader` 流式读 + `#[cfg(test)]` 单测。

---

## 任务 1：抽出全局预计算纯函数（TDD）

**文件：**
- 创建：`tauri-agent/src/features/chat/messagePrecompute.ts`
- 测试：`tauri-agent/src/features/chat/messagePrecompute.test.ts`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/chat/messagePrecompute.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import type { DisplayMessage } from './groupMessages';
import * as subagentUtils from '../panels/subagentUtils';
import { computeSubAgentUnits, computeAnsweredQuestions } from './messagePrecompute';

const tool = (id: string, toolName: string): DisplayMessage =>
  ({ kind: 'tool', id, toolCallId: `${id}-c`, toolName, args: {}, result: {}, status: 'done' }) as DisplayMessage;
const user = (id: string): DisplayMessage => ({ kind: 'user', id, text: 'hi' }) as DisplayMessage;
const questions = (id: string): DisplayMessage =>
  ({ kind: 'notice', id, customType: 'agent-questions', content: '{}' }) as DisplayMessage;

describe('computeSubAgentUnits', () => {
  it('assigns continuous #N across multiple spawn_agent messages, skips non-spawn', () => {
    // 用 spy 控制每个 spawn 展开的子代理条数，验证连号跨调用累加。
    vi.spyOn(subagentUtils, 'expandSubAgents')
      .mockReturnValueOnce([{ task: 'a' }, { task: 'b' }] as never) // m1 → 2 个
      .mockReturnValueOnce([{ task: 'c' }] as never); // m2 → 1 个
    const map = computeSubAgentUnits([tool('m1', 'spawn_agent'), tool('x', 'read'), tool('m2', 'spawn_agent')]);
    expect(map.get('m1')!.map((u) => u.no)).toEqual([1, 2]);
    expect(map.get('m2')!.map((u) => u.no)).toEqual([3]);
    expect(map.has('x')).toBe(false);
  });
});

describe('computeAnsweredQuestions', () => {
  it('marks a questions notice as answered when a user message follows it', () => {
    const set = computeAnsweredQuestions([questions('q1'), user('u1'), questions('q2')]);
    expect(set.has('q1')).toBe(true); // 其后有 user
    expect(set.has('q2')).toBe(false); // 其后无 user（最后一张可交互）
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/chat/messagePrecompute.test.ts`（工作目录 `tauri-agent`）
预期：FAIL，报错 "Failed to resolve import './messagePrecompute'"。

- [ ] **步骤 3：编写最少实现代码**

`tauri-agent/src/features/chat/messagePrecompute.ts`：

```ts
import type { DisplayMessage } from './groupMessages';
import { expandSubAgents } from '../panels/subagentUtils';
import type { NumberedUnit } from './SubAgentGroupInline';

/** 把每次 spawn_agent 展开成逐个子代理并赋全局连续序号（#N，跨调用累加）。 */
export function computeSubAgentUnits(messages: DisplayMessage[]): Map<string, NumberedUnit[]> {
  const unitsByMessage = new Map<string, NumberedUnit[]>();
  let counter = 0;
  for (const msg of messages) {
    if (msg.kind === 'tool' && msg.toolName === 'spawn_agent') {
      const units = expandSubAgents(msg.id, msg.args, msg.result, msg.status).map((unit) => ({
        unit,
        no: ++counter,
      }));
      unitsByMessage.set(msg.id, units);
    }
  }
  return unitsByMessage;
}

/** 提问卡「已答」判定：其后若已出现用户消息，则定格为只读已答态（最后一张未答仍可交互）。 */
export function computeAnsweredQuestions(messages: DisplayMessage[]): Set<string> {
  const answered = new Set<string>();
  let seenUserAfter = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === 'user') seenUserAfter = true;
    else if (m.kind === 'notice' && m.customType === 'agent-questions' && seenUserAfter) {
      answered.add(m.id);
    }
  }
  return answered;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/chat/messagePrecompute.test.ts`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/messagePrecompute.ts tauri-agent/src/features/chat/messagePrecompute.test.ts
git commit -m "refactor(chat): extract message precompute into pure functions"
```

---

## 任务 2：agent_end 只克隆 streaming 的 assistant（TDD）

**文件：**
- 修改：`tauri-agent/src/stores/agentReducer.ts:186-196`（`agent_end` 分支）
- 测试：`tauri-agent/src/stores/agentReducer.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `tauri-agent/src/stores/agentReducer.test.ts` 的 `describe('applyEvent', ...)` 内新增：

```ts
it('agent_end clears only the streaming assistant and preserves identity of settled messages', () => {
  let s = initialAgentState();
  // 先落一条已完成（非 streaming）assistant
  s = applyEvent(s, { type: 'message_end', message: { role: 'assistant', content: 'earlier' } } as AgentEvent);
  const settled = s.messages[0];
  expect(settled.kind === 'assistant' && settled.streaming).toBe(false);
  // 再开一条 streaming assistant
  s = applyEvent(s, { type: 'message_start', message: { role: 'assistant', content: 'live...' } } as AgentEvent);
  const streamingMsg = s.messages[1];
  expect(streamingMsg.kind === 'assistant' && streamingMsg.streaming).toBe(true);
  // agent_end：只该 streaming 条被克隆改 false，已完成条保持引用不变
  s = applyEvent(s, { type: 'agent_end' } as AgentEvent);
  expect(s.messages[0]).toBe(settled); // 引用不变 → 未被克隆
  const last = s.messages[1];
  expect(last.kind === 'assistant' && last.streaming).toBe(false);
  expect(s.isStreaming).toBe(false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/stores/agentReducer.test.ts -t "preserves identity"`
预期：FAIL，`expect(s.messages[0]).toBe(settled)` 不成立（现实现 map 克隆了所有 assistant）。

- [ ] **步骤 3：编写最少实现代码**

把 `tauri-agent/src/stores/agentReducer.ts` 的 `agent_end` 分支替换为：

```ts
    case 'agent_end': {
      // 只克隆仍处于 streaming 的 assistant（通常 0~1 条），其余保留引用，避免每轮克隆整段历史。
      let touched = false;
      const messages = state.messages.map((m) => {
        if (m.kind === 'assistant' && m.streaming) {
          touched = true;
          return { ...m, streaming: false };
        }
        return m;
      });
      return {
        ...state,
        isStreaming: false,
        awaitingResponse: false,
        aborting: false,
        compacting: false,
        messages: touched ? messages : state.messages,
      };
    }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/stores/agentReducer.test.ts`
预期：PASS（含新用例与既有 agent_end/compaction 用例全绿）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/stores/agentReducer.ts tauri-agent/src/stores/agentReducer.test.ts
git commit -m "perf(chat): agent_end clones only the streaming assistant"
```

---

## 任务 3：Rust 流式读会话文件（TDD）

**文件：**
- 修改：`tauri-agent/src-tauri/src/commands/agent.rs`（`find_entry_id_by_timestamp` + 新增 `#[cfg(test)]`）

- [ ] **步骤 1：编写失败的测试**

在 `tauri-agent/src-tauri/src/commands/agent.rs` 末尾新增：

```rust
#[cfg(test)]
mod rewind_tests {
    use super::find_entry_id_by_timestamp;
    use std::io::Write;

    fn write_tmp(name: &str, body: &str) -> String {
        let mut p = std::env::temp_dir();
        p.push(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        p.to_string_lossy().to_string()
    }

    #[test]
    fn returns_last_matching_message_entry_id() {
        let body = concat!(
            "{\"type\":\"message\",\"id\":\"a\",\"message\":{\"timestamp\":100}}\n",
            "{\"type\":\"other\",\"id\":\"skip\",\"message\":{\"timestamp\":100}}\n",
            "\n",
            "{\"type\":\"message\",\"id\":\"b\",\"message\":{\"timestamp\":100}}\n",
            "{\"type\":\"message\",\"id\":\"c\",\"message\":{\"timestamp\":200}}\n"
        );
        let path = write_tmp("rewind_test_1.jsonl", body);
        let got = find_entry_id_by_timestamp(&path, 100).unwrap();
        assert_eq!(got, Some("b".to_string())); // 取最后匹配，忽略非 message 行
        assert_eq!(find_entry_id_by_timestamp(&path, 999).unwrap(), None);
    }
}
```

- [ ] **步骤 2：运行测试验证失败/通过基线**

运行：`cargo test find_entry_id_by_timestamp`（工作目录 `tauri-agent/src-tauri`）
预期：当前 `read_to_string` 版本应已通过（行为不变）。本任务用测试**锁定行为**，再改实现保持绿。若环境缺 Rust 工具链，记录跳过并在手动验收中补跑。

- [ ] **步骤 3：改为流式读实现（保持行为）**

把 `find_entry_id_by_timestamp` 的读取改为逐行流式，恒定内存：

```rust
fn find_entry_id_by_timestamp(session_file: &str, timestamp: i64) -> Result<Option<String>, String> {
    use std::io::BufRead;
    let file = std::fs::File::open(session_file).map_err(|e| format!("read session failed: {e}"))?;
    let reader = std::io::BufReader::new(file);
    let mut found: Option<String> = None;
    for line in reader.lines() {
        let line = line.map_err(|e| format!("read session failed: {e}"))?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(|v| v.as_str()) != Some("message") {
            continue;
        }
        let ts = entry
            .get("message")
            .and_then(|m| m.get("timestamp"))
            .and_then(|v| v.as_i64());
        if ts == Some(timestamp) {
            if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
                found = Some(id.to_string());
            }
        }
    }
    Ok(found)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cargo test find_entry_id_by_timestamp`
预期：PASS（行为与 `read_to_string` 版一致，内存由 O(file) 降为 O(1)）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/agent.rs
git commit -m "perf(rewind): stream session file line-by-line in find_entry_id_by_timestamp"
```

---

## 任务 4：共享 `VirtualizedMessageList`（virtua）

**文件：**
- 创建：`tauri-agent/src/features/chat/VirtualizedMessageList.tsx`
- 测试：`tauri-agent/src/features/chat/VirtualizedMessageList.test.tsx`

- [ ] **步骤 1：编写冒烟测试**

`tauri-agent/src/features/chat/VirtualizedMessageList.test.tsx`：

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { DisplayMessage } from './groupMessages';
import { VirtualizedMessageList } from './VirtualizedMessageList';

afterEach(cleanup);

describe('VirtualizedMessageList', () => {
  it('mounts with the scroll container testid and invokes renderItem', () => {
    const msgs: DisplayMessage[] = [
      { kind: 'user', id: 'u1', text: 'a' } as DisplayMessage,
      { kind: 'user', id: 'u2', text: 'b' } as DisplayMessage,
    ];
    const renderItem = vi.fn((m: DisplayMessage) => <div data-testid={`item-${m.id}`}>x</div>);
    const { getByTestId } = render(
      <VirtualizedMessageList display={msgs} renderItem={renderItem} data-testid="vlist" />,
    );
    expect(getByTestId('vlist')).toBeTruthy();
    // jsdom 无真实测高，虚拟化可能只渲染部分；至少首条会被渲染。
    expect(renderItem).toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/chat/VirtualizedMessageList.test.tsx`
预期：FAIL，"Failed to resolve import './VirtualizedMessageList'"。

- [ ] **步骤 3：编写实现**

`tauri-agent/src/features/chat/VirtualizedMessageList.tsx`：

```tsx
import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { VList, type VListHandle } from 'virtua';
import type { DisplayMessage } from './groupMessages';

interface VirtualizedMessageListProps {
  display: DisplayMessage[];
  /** 单条消息渲染器（user/turn/tool/notice 分发）。 */
  renderItem: (msg: DisplayMessage) => ReactNode;
  /** 列表末尾附加元素（如「准备响应中」占位），作为最后一个虚拟条目。 */
  footer?: ReactNode;
  'data-testid'?: string;
}

// 距底多少像素内算「贴底」：与原手写滚动阈值一致。
const BOTTOM_THRESHOLD = 120;

/**
 * 共享虚拟化消息列表：virtua 只渲染视口 ± overscan 的条目（离屏卸载），
 * 并在用户停留在底部时随新内容/流式增长自动滚底（上滑后不打扰）。
 * 主对话与子代理对话共用，替代旧的 LazyMount + 手写 scrollTop/ResizeObserver。
 */
export function VirtualizedMessageList({
  display,
  renderItem,
  footer,
  'data-testid': testId,
}: VirtualizedMessageListProps) {
  const ref = useRef<VListHandle>(null);
  const atBottomRef = useRef(true);

  const children: ReactNode[] = display.map((msg) => <Fragment key={msg.id}>{renderItem(msg)}</Fragment>);
  if (footer) children.push(<Fragment key="__footer">{footer}</Fragment>);
  const count = children.length;

  // 内容变化（新消息 / 流式增长）后，若用户停留在底部则滚到最后一条。
  useEffect(() => {
    if (atBottomRef.current && ref.current && count > 0) {
      ref.current.scrollToIndex(count - 1, { align: 'end' });
    }
  });

  return (
    <VList
      ref={ref}
      data-testid={testId}
      style={{ flex: 1, minHeight: 0 }}
      onScroll={() => {
        const h = ref.current;
        if (!h) return;
        atBottomRef.current = h.scrollOffset + h.viewportSize >= h.scrollSize - BOTTOM_THRESHOLD;
      }}
    >
      {children}
    </VList>
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/chat/VirtualizedMessageList.test.tsx`
预期：PASS（冒烟）。若 virtua 在 jsdom 下首屏渲染 0 条导致 `renderItem` 未被调用，则把断言放宽为 `expect(getByTestId('vlist')).toBeTruthy()` 并把"首条渲染"移入手动验收（见任务 9）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/VirtualizedMessageList.tsx tauri-agent/src/features/chat/VirtualizedMessageList.test.tsx
git commit -m "feat(chat): shared virtua VirtualizedMessageList with stick-to-bottom"
```

---

## 任务 5：重构 `ChatMessageItems` 消费外部预计算并用虚拟列表

**文件：**
- 修改：`tauri-agent/src/features/chat/ChatMessageItems.tsx`

- [ ] **步骤 1：改写实现**

把 `ChatMessageItems.tsx` 改为：预计算改由调用方传入（props），列表渲染交给 `VirtualizedMessageList`，导出 `renderMessageBody`。完整替换文件内容：

```tsx
import { lazy, Suspense, type ReactNode } from 'react';
import type { DisplayMessage } from './groupMessages';
import { UserMessage } from './UserMessage';
import { TurnTimeline } from './TurnTimeline';
import { NoticePill } from './NoticePill';
import { AnswerCard } from './AnswerCard';
import { PlanCard } from './PlanCard';
import { QuestionsCard } from './QuestionsCard';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import { subAgentMode, taskLabel } from '../panels/subagentUtils';
import type { NumberedUnit } from './SubAgentGroupInline';

const ToolExecution = lazy(() =>
  import('../tools/ToolExecution').then((m) => ({ default: m.ToolExecution })),
);
const SubAgentInline = lazy(() =>
  import('./SubAgentInline').then((m) => ({ default: m.SubAgentInline })),
);
const SubAgentGroupInline = lazy(() =>
  import('./SubAgentGroupInline').then((m) => ({ default: m.SubAgentGroupInline })),
);

interface ChatMessageItemsProps {
  messages: DisplayMessage[];
  /** 全局预计算（由调用方 useMemo 缓存后传入）。 */
  unitsByMessage: Map<string, NumberedUnit[]>;
  answeredQuestions: Set<string>;
  /** 列表末尾附加元素（如「准备响应中」占位）。 */
  footer?: ReactNode;
  'data-testid'?: string;
}

/** 单条消息渲染器：user/assistant(turn)/tool/notice 分发；主对话与子代理对话共用。 */
export function renderMessageBody(
  msg: DisplayMessage,
  unitsByMessage: Map<string, NumberedUnit[]>,
  answeredQuestions: Set<string>,
): ReactNode {
  switch (msg.kind) {
    case 'user':
      return <UserMessage text={msg.text} images={msg.images} timestamp={msg.timestamp} />;
    case 'turn':
      return <TurnTimeline segments={msg.segments} timestamp={msg.timestamp} />;
    case 'tool':
      if (msg.toolName === 'spawn_agent') {
        const numbered = unitsByMessage.get(msg.id) ?? [];
        if (numbered.length <= 1) {
          const only = numbered[0];
          return (
            <Suspense fallback={null}>
              <SubAgentInline
                messageId={msg.id}
                toolCallId={msg.toolCallId}
                index={only?.no ?? 1}
                task={only?.unit.task ?? taskLabel(msg.args)}
                result={msg.result}
                status={msg.status}
              />
            </Suspense>
          );
        }
        return (
          <Suspense fallback={null}>
            <SubAgentGroupInline
              messageId={msg.id}
              toolCallId={msg.toolCallId}
              mode={subAgentMode(msg.args)}
              status={msg.status}
              units={numbered}
            />
          </Suspense>
        );
      }
      return (
        <Suspense fallback={null}>
          <ToolExecution
            toolName={msg.toolName}
            toolCallId={msg.toolCallId}
            args={msg.args}
            result={msg.result}
            status={msg.status}
          />
        </Suspense>
      );
    case 'notice':
      if (msg.customType === 'agent-answer') return <AnswerCard content={msg.content} />;
      if (msg.customType === 'agent-plan') return <PlanCard content={msg.content} />;
      if (msg.customType === 'agent-questions') {
        return <QuestionsCard answered={answeredQuestions.has(msg.id)} content={msg.content} />;
      }
      return <NoticePill customType={msg.customType} content={msg.content} />;
    default:
      return null;
  }
}

/** 共享的对话气泡渲染：主对话与子代理对话复用同一套虚拟化 + 气泡组件。 */
export function ChatMessageItems({
  messages,
  unitsByMessage,
  answeredQuestions,
  footer,
  'data-testid': testId,
}: ChatMessageItemsProps) {
  return (
    <VirtualizedMessageList
      display={messages}
      footer={footer}
      data-testid={testId}
      renderItem={(msg) => renderMessageBody(msg, unitsByMessage, answeredQuestions)}
    />
  );
}
```

- [ ] **步骤 2：类型检查（此步会暴露调用方未传新 props，下一任务修复）**

运行：`npx tsc --noEmit`（工作目录 `tauri-agent`）
预期：报错指向 `ChatListView.tsx` 与 `SubAgentConversation.tsx`（缺 `unitsByMessage`/`answeredQuestions`、传了已移除的 `lazy`）。这是预期，由任务 6/7 修复。

- [ ] **步骤 3：暂不 commit**

待任务 6、7 把调用方改完、`tsc` 全绿后统一 commit（见任务 7 步骤 5），避免中间态半成品 commit。

---

## 任务 6：接线 `ChatListView`

**文件：**
- 修改：`tauri-agent/src/features/chat/ChatListView.tsx`

- [ ] **步骤 1：改写实现**

完整替换 `ChatListView.tsx`：

```tsx
import { useMemo } from 'react';
import { useAgentStore } from '../../stores/AgentStoreContext';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages } from './groupMessages';
import { ChatMessageItems } from './ChatMessageItems';
import { computeSubAgentUnits, computeAnsweredQuestions } from './messagePrecompute';
import { PreparingIndicator } from './PreparingIndicator';

export function ChatListView() {
  const { useStore } = useAgentStore();
  const messages = useStore((s) => s.messages);
  const isStreaming = useStore((s) => s.isStreaming);
  const awaitingResponse = useStore((s) => s.awaitingResponse);

  // streaming 中 100ms 节流，避免每 token 触发整列重算（详见 useThrottledValue 契约）。
  const throttledMessages = useThrottledValue(messages, 100, { enabled: isStreaming });
  const display = useMemo(() => groupMessages(throttledMessages), [throttledMessages]);
  const unitsByMessage = useMemo(() => computeSubAgentUnits(display), [display]);
  const answeredQuestions = useMemo(() => computeAnsweredQuestions(display), [display]);

  // 等待占位：仅在「还没有助手 turn」时用独立占位。一旦存在 turn/tool，由其它组件接管。
  const last = display[display.length - 1];
  const lastIsSteer = last?.kind === 'user' && last.steering === true;
  const showPreparing =
    (isStreaming || Boolean(awaitingResponse)) &&
    !lastIsSteer &&
    (!last || (last.kind !== 'turn' && last.kind !== 'tool'));

  return (
    <ChatMessageItems
      messages={display}
      unitsByMessage={unitsByMessage}
      answeredQuestions={answeredQuestions}
      footer={showPreparing ? <PreparingIndicator /> : undefined}
      data-testid="chat-scroll"
    />
  );
}
```

- [ ] **步骤 2：更新 `ChatListView.test.tsx` 的 mock（若需要）**

运行：`npx vitest run src/features/chat/ChatListView.test.tsx`
预期：若失败多为「找不到滚动容器/占位」断言。把对滚动容器的断言对齐到 `data-testid="chat-scroll"`（仍由 `VirtualizedMessageList` 透传），「准备响应中」占位断言保留（footer 渲染）。按实际报错最小化修改测试，不改变其意图。

- [ ] **步骤 3：暂不 commit**（与任务 7 合并）

---

## 任务 7：接线 `SubAgentConversation` 并统一 commit

**文件：**
- 修改：`tauri-agent/src/features/panels/SubAgentConversation.tsx`

- [ ] **步骤 1：改写实现**

把 `SubAgentConversation.tsx` 的渲染部分（`scrollRef`/`handleScroll`/`useEffect` 贴底 + 外层 scroll/list div）替换为使用 `ChatMessageItems`：

```tsx
import { useMemo } from 'react';
import { type ChatMessage, messagesFromTranscript } from '../../stores/agentReducer';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages } from '../chat/groupMessages';
import { ChatMessageItems } from '../chat/ChatMessageItems';
import { computeSubAgentUnits, computeAnsweredQuestions } from '../chat/messagePrecompute';

// transcriptOf / fallbackText 保持不变（此处省略，沿用现有实现）。

interface SubAgentConversationProps {
  task: string;
  result: unknown;
  status: 'running' | 'done' | 'error';
  'data-testid'?: string;
}

export function SubAgentConversation({ task, result, status, 'data-testid': testId }: SubAgentConversationProps) {
  const liveResult = useThrottledValue(result, 100, { enabled: status === 'running' });
  const messages = useMemo<ChatMessage[]>(() => {
    const out: ChatMessage[] = [{ kind: 'user', id: 'sa-task', text: task }];
    const transcript = transcriptOf(liveResult);
    if (transcript) {
      out.push(...messagesFromTranscript(transcript));
    } else {
      const text = fallbackText(liveResult);
      if (text) out.push({ kind: 'assistant', id: 'sa-out', text, thinking: '', streaming: status === 'running' });
    }
    return out;
  }, [task, liveResult, status]);

  const display = useMemo(() => groupMessages(messages), [messages]);
  const unitsByMessage = useMemo(() => computeSubAgentUnits(display), [display]);
  const answeredQuestions = useMemo(() => computeAnsweredQuestions(display), [display]);

  return (
    <ChatMessageItems
      messages={display}
      unitsByMessage={unitsByMessage}
      answeredQuestions={answeredQuestions}
      data-testid={testId}
    />
  );
}
```

保留文件中原有的 `transcriptOf` 与 `fallbackText` 函数定义不动；仅删除 `createStaticStyles` 的 `styles`（scroll/list）、`scrollRef`、`atBottomRef`、`handleScroll`、贴底 `useEffect` 与外层 div。

- [ ] **步骤 2：类型检查全绿**

运行：`npx tsc --noEmit`
预期：PASS（ChatMessageItems 调用方 props 已补齐，无残留 `lazy` 用法）。

- [ ] **步骤 3：跑相关测试**

运行：`npx vitest run src/features/chat src/features/panels src/stores`
预期：PASS（必要时按任务 6 步骤 2 微调断言）。

- [ ] **步骤 4：手动验收冒烟（dev）**

运行：`npx tsc --noEmit && echo TYPECHECK_OK`
（完整 UI 验收在任务 9 的清单里集中做。）

- [ ] **步骤 5：Commit（任务 5+6+7 一起）**

```bash
git add tauri-agent/src/features/chat/ChatMessageItems.tsx tauri-agent/src/features/chat/ChatListView.tsx tauri-agent/src/features/chat/ChatListView.test.tsx tauri-agent/src/features/panels/SubAgentConversation.tsx
git commit -m "perf(chat): virtualize shared message list, memoize precompute (main + sub-agent)"
```

---

## 任务 8：退役 `LazyMount`

**文件：**
- 删除：`tauri-agent/src/features/chat/LazyMount.tsx`

- [ ] **步骤 1：确认无引用**

运行（工作目录 `tauri-agent`）：`npx rg -n "LazyMount" src` 或用 Grep 工具搜索 `LazyMount`。
预期：除自身文件外无引用（任务 5 已移除 `ChatMessageItems` 里的 import 与用法）。若有残留引用，先清掉。

- [ ] **步骤 2：删除文件**

```bash
git rm tauri-agent/src/features/chat/LazyMount.tsx
```

若存在 `LazyMount.test.tsx` 一并 `git rm`。

- [ ] **步骤 3：类型检查 + 测试**

运行：`npx tsc --noEmit && npx vitest run src/features/chat`
预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "chore(chat): retire LazyMount (superseded by virtua virtualization)"
```

---

## 任务 9：整体验证与手动验收

**文件：** 无（验证）

- [ ] **步骤 1：前端类型检查**

运行：`npx tsc --noEmit`（`tauri-agent`）
预期：PASS。

- [ ] **步骤 2：前端测试（受影响范围）**

运行：`npx vitest run src/features/chat src/features/panels src/stores`
预期：全绿。（整库 `npx vitest run` 在本机较慢且偶发环境性超时，按需单文件复跑确认。）

- [ ] **步骤 3：Rust 测试**

运行：`cargo test`（`tauri-agent/src-tauri`）
预期：`find_entry_id_by_timestamp` 用例 PASS。

- [ ] **步骤 4：手动验收清单（dev 运行 `npm run tauri dev` 或既有 dev 流程）**

逐项确认（这是虚拟化的真实验收，jsdom 测不了）：
- 长会话（>200 条）滚动流畅、内存不随滚动无限增长。
- 流式回答时自动贴底；用户上滑后不被强制拉回；停回底部后恢复跟随。
- 切换会话：首屏正确、滚动位置合理、无空白长帧。
- 子代理对话面板（运行中 / 终态）渲染正确、贴底正常。
- 「准备响应中」占位在无 turn 时出现、有 turn 后消失。
- 工具卡 / 子代理组 / 提问卡（已答/可交互）/ 计划卡 / notice 均正常渲染。
- 「回退到此」功能正常（item 4 改动后行为不变）。

- [ ] **步骤 5：最终 commit（若验收期有微调）**

```bash
git add -A
git commit -m "test(chat): finalize perf hardening validation tweaks"
```

---

## 自检

**1. 规格覆盖度：**
- item 1（每渲染全量预计算）→ 任务 1（抽纯函数）+ 任务 6/7（调用方 `useMemo` 缓存）。✓
- item 2（虚拟化，做进共享 ChatMessageItems，主+子代理）→ 任务 4（VirtualizedMessageList）+ 任务 5（ChatMessageItems 改用）+ 任务 6/7（两调用方接线）。✓
- item 3（agent_end 全量 map）→ 任务 2。✓（以"只克隆 streaming"等效细化实现，已在头部声明）
- item 4（Rust 整文件读）→ 任务 3。✓
- LazyMount 直接替换（无开关）→ 任务 8。✓
- 测试策略（纯函数 TDD + 列表冒烟 + 手动验收 + Rust 单测）→ 任务 1/2/3/4 + 任务 9。✓

**2. 占位符扫描：** 各代码步骤均给出完整代码与精确命令/预期；`SubAgentConversation` 的 `transcriptOf`/`fallbackText` 明确"保持不变沿用现有实现"，非占位。无 TODO/待定。✓

**3. 类型一致性：** `computeSubAgentUnits`/`computeAnsweredQuestions`（任务 1 定义）在任务 6/7 调用名一致；`renderMessageBody`/`ChatMessageItems` 新签名（任务 5）与任务 6/7 传参一致（`unitsByMessage`/`answeredQuestions`/`footer`/`data-testid`）；`VirtualizedMessageList` props（任务 4）与任务 5 使用一致。✓

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-28-chat-rendering-perf.md`。两种执行方式：

1. **子代理驱动（推荐）** —— 每个任务调度一个新子代理，任务间审查，快速迭代。
2. **内联执行** —— 当前会话用 executing-plans 批量执行并设检查点。
