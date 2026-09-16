# 子代理内联横条重设计 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤用复选框（`- [ ]`）跟踪进度。

**目标：** 把 `spawn_agent` 的内联横条改成双行（角色前置 + 实时/摘要第二行）、模型靠右、左侧状态图标悬停即停止、展开走"结果优先 E1"。

**架构：** 纯函数（角色提取 / 最新一步摘要）放 `subagentUtils.ts`；运行中实时数据用一个轮询 hook（提炼自 `SubAgentLogBody` 的 registry 轮询）；展示层改 `ConvStrip`（双行 + 模型 + 停止）、`StatusGlyph`（悬停变停止）、`SubAgentInline`（组装）。完整流式回放仍在右坞。

**技术栈：** React 19 + TypeScript + antd-style（createStaticStyles/cssVar）+ lucide-react + vitest + @testing-library/react；包管理 bun。

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `tauri-agent/src/features/panels/subagentUtils.ts` | 新增 `subAgentRoleLabel`、`latestStepFromMessages`、`latestSubAgentStep` | 修改 |
| `tauri-agent/src/features/panels/subagentUtils.test.ts` | 上述纯函数单测 | 修改 |
| `tauri-agent/src/hooks/useSubAgentLive.ts` | 运行中按 agentId 轮询 registry，产出 `{model, step, action, status}` | 创建 |
| `tauri-agent/src/hooks/useSubAgentLive.test.ts` | hook 轮询单测（spy pi.subagentList + 假定时器） | 创建 |
| `tauri-agent/src/features/chat/conv/StatusGlyph.tsx` | 运行态在行 hover 下变红色停止键（接 `onStop`） | 修改 |
| `tauri-agent/src/features/chat/conv/ConvStrip.tsx` | 支持第二行 `line2`、模型 `model`、把 `onStop` 透传 StatusGlyph | 修改 |
| `tauri-agent/src/features/chat/conv/ConvStrip.test.tsx` | 双行 / 模型 / 停止 行为 | 修改 |
| `tauri-agent/src/features/chat/SubAgentInline.tsx` | 组装：角色、模型、实时第二行、展开 E1、停止接线 | 修改 |
| `tauri-agent/src/preview.tsx` | 同步 ConvStrip 示例（双行 + 模型） | 修改 |

测试命令（仓库根目录）：`cd tauri-agent && bunx vitest run <file>`
类型检查：`cd tauri-agent && npx tsc --noEmit`

---

## 任务 1：纯函数（角色提取 + 最新一步摘要）

**文件：**
- 修改：`tauri-agent/src/features/panels/subagentUtils.ts`
- 测试：`tauri-agent/src/features/panels/subagentUtils.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `subagentUtils.test.ts` 顶部 import 增加被测函数与类型：

```ts
import {
  expandSubAgents,
  subAgentMode,
  subAgentRoleLabel,
  latestStepFromMessages,
  latestSubAgentStep,
  subAgentUnitView,
  taskLabel,
} from './subagentUtils';
import type { ChatMessage } from '../../stores/agentReducer';
```

文件末尾追加：

```ts
describe('subAgentRoleLabel', () => {
  it('extracts the bold role after 角色', () => {
    expect(subAgentRoleLabel('## 角色 你是 **Rust/系统架构倡导者**. 任务...')).toBe('Rust/系统架构倡导者');
  });
  it('falls back to first non-empty line stripped of markdown', () => {
    expect(subAgentRoleLabel('# 审查这段并发代码的安全性\n\n更多...')).toBe('审查这段并发代码的安全性');
  });
  it('truncates long fallback with ellipsis', () => {
    expect(subAgentRoleLabel('一'.repeat(50))).toBe(`${'一'.repeat(40)}…`);
  });
  it('empty → 子代理任务', () => {
    expect(subAgentRoleLabel('')).toBe('子代理任务');
  });
});

describe('latestStepFromMessages', () => {
  it('empty → null', () => {
    expect(latestStepFromMessages([])).toBeNull();
  });
  it('latest tool → 调用 toolName，step 计 assistant+tool', () => {
    const msgs = [
      { kind: 'assistant', id: 'a1', text: 'hi', thinking: '', streaming: false } as ChatMessage,
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'read_file', args: {}, result: {}, status: 'done' } as ChatMessage,
    ];
    expect(latestStepFromMessages(msgs)).toEqual({ step: 2, action: '调用 read_file' });
  });
  it('latest assistant → 生成回复中…', () => {
    const msgs = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'grep', args: {}, result: {}, status: 'done' } as ChatMessage,
      { kind: 'assistant', id: 'a1', text: '结论...', thinking: '', streaming: false } as ChatMessage,
    ];
    expect(latestStepFromMessages(msgs)).toEqual({ step: 2, action: '生成回复中…' });
  });
});

describe('latestSubAgentStep', () => {
  it('empty transcript → null', () => {
    expect(latestSubAgentStep('')).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && bunx vitest run src/features/panels/subagentUtils.test.ts`
预期：FAIL，报 `subAgentRoleLabel is not a function`（及其余未定义导出）。

- [ ] **步骤 3：编写最少实现**

在 `subagentUtils.ts`（已 `import { messagesFromTranscript } from '../../stores/agentReducer';`，需再加 `ChatMessage` 类型 import）顶部 import 改为：

```ts
import { messagesFromTranscript, type ChatMessage } from '../../stores/agentReducer';
```

在 `taskLabel` 之后追加：

```ts
/** 从子代理任务文本提取简短角色：识别「角色 ... **X**」，回退首个非空行剥 markdown 截断。 */
export function subAgentRoleLabel(task: string): string {
  const t = (task ?? '').trim();
  if (!t) return '子代理任务';
  const m = t.match(/角色[^\n]*?\*\*(.+?)\*\*/);
  if (m && m[1].trim()) return m[1].trim();
  const firstLine = t.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? t;
  const plain = firstLine.replace(/^#{1,6}\s*/, '').replace(/[*_`>]/g, '').trim();
  return plain.length > 40 ? `${plain.slice(0, 40)}…` : plain;
}

/** 从已解析消息列表取「第 N 步 + 当前动作」（step 计 assistant+tool）。 */
export function latestStepFromMessages(msgs: ChatMessage[]): { step: number; action: string } | null {
  const steps = msgs.filter((m) => m.kind === 'assistant' || m.kind === 'tool');
  if (steps.length === 0) return null;
  const last = steps[steps.length - 1];
  const action = last.kind === 'tool' ? `调用 ${last.toolName}` : '生成回复中…';
  return { step: steps.length, action };
}

/** 从运行中子代理增量 transcript 取最新一步摘要，供折叠态第二行实时显示。 */
export function latestSubAgentStep(transcript: string): { step: number; action: string } | null {
  if (!transcript) return null;
  return latestStepFromMessages(messagesFromTranscript(transcript));
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && bunx vitest run src/features/panels/subagentUtils.test.ts`
预期：PASS（全部用例）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/panels/subagentUtils.ts tauri-agent/src/features/panels/subagentUtils.test.ts
git commit -m "feat(chat): add subagent role label and latest-step helpers"
```

---

## 任务 2：运行中实时数据 hook `useSubAgentLive`

**文件：**
- 创建：`tauri-agent/src/hooks/useSubAgentLive.ts`
- 测试：`tauri-agent/src/hooks/useSubAgentLive.test.ts`

职责：给定 `agentId` 与是否运行中，运行期每 2.5s 轮询 `pi.subagentList`，解析出 `{ model, step, action }`；非运行或无 agentId 时不轮询。复用 `SubAgentLogBody` 的轮询范式与 `latestSubAgentStep`。

- [ ] **步骤 1：编写失败的测试**

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pi } from '../lib/pi';
import { useSubAgentLive } from './useSubAgentLive';

describe('useSubAgentLive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('running + agentId → polls registry and exposes model', async () => {
    vi.spyOn(pi, 'subagentList').mockResolvedValue([
      { id: 'ag1', task: 't', status: 'running', model: 'gpt-5.3-codex', transcript: '', createdAt: 0, updatedAt: 0 },
    ]);
    const { result } = renderHook(() => useSubAgentLive('ws', 'ag1', true));
    await act(async () => { await Promise.resolve(); });
    expect(pi.subagentList).toHaveBeenCalledWith('ws');
    await waitFor(() => expect(result.current.model).toBe('gpt-5.3-codex'));
  });

  it('not running → never polls', () => {
    const spy = vi.spyOn(pi, 'subagentList').mockResolvedValue([]);
    renderHook(() => useSubAgentLive('ws', 'ag1', false));
    expect(spy).not.toHaveBeenCalled();
  });

  it('no agentId → never polls', () => {
    const spy = vi.spyOn(pi, 'subagentList').mockResolvedValue([]);
    renderHook(() => useSubAgentLive('ws', null, true));
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && bunx vitest run src/hooks/useSubAgentLive.test.ts`
预期：FAIL，报无法解析 `./useSubAgentLive`。

- [ ] **步骤 3：编写最少实现**

```ts
import { useEffect, useState } from 'react';
import { pi } from '../lib/pi';
import { latestSubAgentStep } from '../features/panels/subagentUtils';

const POLL_MS = 2500;

export interface SubAgentLive {
  model: string | null;
  step: number | null;
  action: string | null;
}

/** 运行中按 agentId 轮询 registry，解析模型 + 最新一步；非运行/无 id 时静默。 */
export function useSubAgentLive(workspace: string, agentId: string | null, running: boolean): SubAgentLive {
  const [live, setLive] = useState<SubAgentLive>({ model: null, step: null, action: null });

  useEffect(() => {
    if (!workspace || !agentId || !running) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const rows = await pi.subagentList(workspace);
        if (cancelled) return;
        const row = rows.find((r) => r.id === agentId);
        if (!row) return;
        const ls = latestSubAgentStep(row.transcript ?? '');
        setLive({ model: row.model ?? null, step: ls?.step ?? null, action: ls?.action ?? null });
      } catch {
        // 跨进程读 registry 偶发 SQLITE_BUSY：保留上次结果，下个 tick 再试。
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspace, agentId, running]);

  return live;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && bunx vitest run src/hooks/useSubAgentLive.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/hooks/useSubAgentLive.ts tauri-agent/src/hooks/useSubAgentLive.test.ts
git commit -m "feat(chat): add useSubAgentLive polling hook for live model/step"
```

---

## 任务 3：`StatusGlyph` 悬停变停止

**文件：**
- 修改：`tauri-agent/src/features/chat/conv/StatusGlyph.tsx`

行为：当 `status==='running'` 且传入 `onStop` 时，正常显示转圈；父级 `.strip:hover` 状态下显示红色停止方块（`lucide` `Square` 填充），点击 `onStop`（阻止冒泡）。终态忽略 `onStop`。用 CSS 由父 hover 控制两个图标互相显隐，避免额外 JS 状态。

- [ ] **步骤 1：编写实现**

```tsx
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Check, Loader2, Square, X } from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import { convStyles } from './convTokens';

export type ConvStatus = 'running' | 'done' | 'error';

const COLOR: Record<ConvStatus, string> = {
  running: cssVar.colorInfo,
  done: cssVar.colorSuccess,
  error: cssVar.colorError,
};

const styles = createStaticStyles(({ css }) => ({
  // 运行可停止：默认显示 spinner，父 .strip:hover 时切到红色停止方块
  spinner: css`
    .conv-strip:hover & {
      display: none;
    }
  `,
  stop: css`
    display: none;
    color: ${cssVar.colorError};
    cursor: pointer;
    .conv-strip:hover & {
      display: inline-flex;
    }
  `,
}));

/** 行首状态图标；运行且可停止时，父行 hover 切换为红色停止键。 */
export const StatusGlyph = memo(function StatusGlyph({
  status,
  onStop,
}: {
  status: ConvStatus;
  onStop?: (e: MouseEvent) => void;
}) {
  if (status === 'running' && onStop) {
    return (
      <span className={convStyles.lead} data-status="running">
        <span className={styles.spinner} style={{ color: COLOR.running, display: 'inline-flex' }}>
          <Icon icon={Loader2} size={13} spin />
        </span>
        <span className={styles.stop} title="停止子代理" onClick={onStop}>
          <Icon icon={Square} size={12} fill={cssVar.colorError} />
        </span>
      </span>
    );
  }
  const icon = status === 'running' ? Loader2 : status === 'error' ? X : Check;
  return (
    <span className={convStyles.lead} data-status={status} style={{ color: COLOR[status] }}>
      <Icon icon={icon} size={13} spin={status === 'running'} />
    </span>
  );
});
```

说明：`.conv-strip` 是 `ConvStrip` 根节点将新增的类名（任务 4）；hover 选择器据此切换。`spinner` 行内 `display:inline-flex` 作为默认，CSS 在 hover 时覆盖为 none。

- [ ] **步骤 2：类型检查**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无报错（`StatusGlyph` 新增可选 `onStop`，旧调用兼容）。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/chat/conv/StatusGlyph.tsx
git commit -m "feat(chat): StatusGlyph morphs to stop button on row hover when running"
```

---

## 任务 4：`ConvStrip` 支持双行 + 模型 + 停止透传

**文件：**
- 修改：`tauri-agent/src/features/chat/conv/ConvStrip.tsx`
- 测试：`tauri-agent/src/features/chat/conv/ConvStrip.test.tsx`

变更：根节点加类名 `conv-strip`（供 StatusGlyph hover 选择器）；新增 props `line2?: ReactNode`、`model?: ReactNode`、`onStop?`；整体改为「第一行 + 可选第二行」纵向布局；右侧只放 `model` + 展开箭头（去掉 meta/actions 默认右挤，保留 `actions` 但置于 model 左侧供特殊场景）。

- [ ] **步骤 1：编写失败的测试**

在 `ConvStrip.test.tsx` 追加：

```ts
it('renders line2 and model; stop on hover calls onStop not toggle', () => {
  const onToggle = vi.fn();
  const onStop = vi.fn();
  render(
    <ConvStrip
      status="running"
      icon={Bot}
      title="子代理 #1"
      model="gpt-5.3-codex"
      line2="第 3 步 · 正在读取 x.rs"
      onStop={onStop}
      onToggle={onToggle}
    />,
  );
  expect(screen.getByText('gpt-5.3-codex')).toBeTruthy();
  expect(screen.getByText('第 3 步 · 正在读取 x.rs')).toBeTruthy();
  fireEvent.click(screen.getByTitle('停止子代理'));
  expect(onStop).toHaveBeenCalled();
  expect(onToggle).not.toHaveBeenCalled();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && bunx vitest run src/features/chat/conv/ConvStrip.test.tsx`
预期：FAIL（`gpt-5.3-codex` 未渲染 / 无 `停止子代理` 标题节点）。

- [ ] **步骤 3：编写实现**

```tsx
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { memo, type MouseEvent, type ReactNode } from 'react';
import { Disclosure } from './Disclosure';
import { StatusGlyph, type ConvStatus } from './StatusGlyph';

const styles = createStaticStyles(({ css }) => ({
  strip: css`
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-block: 2px;
    padding: 6px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    font-size: 12.5px;
    cursor: pointer;
    transition: border-color 0.12s ease;
    &:hover {
      border-color: ${cssVar.colorBorder};
    }
  `,
  l1: css`
    display: flex;
    align-items: center;
    gap: 8px;
  `,
  title: css`
    flex: none;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  role: css`
    flex: none;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  spacer: css`
    flex: 1;
    min-width: 0;
  `,
  right: css`
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
  `,
  model: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
    padding: 1px 6px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 4px;
    background: ${cssVar.colorFillTertiary};
    white-space: nowrap;
  `,
  l2: css`
    padding-inline-start: 22px;
    overflow: hidden;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

interface ConvStripProps {
  status: ConvStatus;
  icon: LucideIcon;
  title: string;
  /** 角色 / 任务短标签（第一行主文案，非 code）。 */
  role?: ReactNode;
  /** 第二行（实时步骤 / 终态摘要）。 */
  line2?: ReactNode;
  /** 模型 chip（第一行最右）。 */
  model?: ReactNode;
  /** 运行可停止：传入后左侧状态图标 hover 变停止键。 */
  onStop?: (e: MouseEvent) => void;
  /** 其它右侧操作（置于 model 左侧）。 */
  actions?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  'data-testid'?: string;
}

/** L3 横条：双行 surface（角色前置 + 实时/摘要第二行 + 模型靠右）。 */
export const ConvStrip = memo(function ConvStrip({
  status,
  icon,
  title,
  role,
  line2,
  model,
  onStop,
  actions,
  open = false,
  onToggle,
  'data-testid': testId,
}: ConvStripProps) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div className={`conv-strip ${styles.strip}`} data-testid={testId} onClick={onToggle}>
      <div className={styles.l1}>
        <StatusGlyph status={status} onStop={onStop} />
        <Icon icon={icon} size={14} style={{ color: cssVar.colorInfo, flex: 'none' }} />
        <span className={styles.title}>{title}</span>
        {role != null ? (
          <>
            <span style={{ flex: 'none', color: cssVar.colorTextQuaternary }}>·</span>
            <span className={styles.role}>{role}</span>
          </>
        ) : null}
        <span className={styles.spacer} />
        <div className={styles.right} onClick={stop}>
          {actions}
          {model != null ? <span className={styles.model}>{model}</span> : null}
          {onToggle ? <Disclosure open={open} /> : null}
        </div>
      </div>
      {line2 != null ? <div className={styles.l2}>{line2}</div> : null}
    </div>
  );
});
```

注意：`onStop` 的点击在 StatusGlyph 内 `stopPropagation`（任务 3 的 `onClick={onStop}` 需包一层阻止冒泡——见下方修正）。为确保点停止不触发整条 toggle，任务 3 的 `onStop` 调用处改为：

```tsx
<span className={styles.stop} title="停止子代理" onClick={(e) => { e.stopPropagation(); onStop(e); }}>
```

（实现任务 3 时即按此写；此处显式声明以保持一致。）

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && bunx vitest run src/features/chat/conv/ConvStrip.test.tsx`
预期：PASS。注意旧用例用到 `num`/`chip`/`meta` 已移除——同步删除/改写这两条旧用例为新结构（断言 `title` 渲染 + 点击 toggle、点击 actions 不 toggle）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/conv/ConvStrip.tsx tauri-agent/src/features/chat/conv/ConvStrip.test.tsx
git commit -m "feat(chat): ConvStrip two-line layout with role, second line, model, stop"
```

---

## 任务 5：`SubAgentInline` 组装（角色 / 模型 / 实时第二行 / 展开 E1 / 停止）

**文件：**
- 修改：`tauri-agent/src/features/chat/SubAgentInline.tsx`

变更要点：
1. 折叠头用新 `ConvStrip`：`title={`子代理 #${index}`}`、`role={subAgentRoleLabel(task)}`、`model={modelLabel}`、`line2={line2}`、`onStop`（仅运行中）。
2. 运行中用 `useSubAgentLive(workspace, agentId, running)` 取 `model/step/action`；`agentId = subAgentId(result)`（后台 spawn 运行中即有；前台无则回退）。
3. `line2`：运行中 = `live.step ? `第 ${live.step} 步 · ${live.action}` : '运行中…'`；终态 = `${badge}${summary ? ` · ${summary}` : ''}`，`summary` 终态取任务摘要纯文本（D1 默认），出错优先错误首句。
4. `modelLabel`：运行中 `live.model`；终态 `stats?.model`；无则不显示。
5. 展开（E1）：统计头（model · steps · tokens · 用时？用时若无数据则略）+「打开完整对话」+ 结果（终态 finalText / 运行中 hint）+ 指令默认折叠（`<details>` 或本地 `showPrompt` state）。

- [ ] **步骤 1：编写实现**

关键片段（替换折叠头与第二行/模型计算；保留既有 effect/stop 逻辑，停止改为传给 ConvStrip 的 `onStop`）：

```tsx
import { subAgentRoleLabel } from '../panels/subagentUtils';
import { useSubAgentLive } from '../../hooks/useSubAgentLive';
// ...existing imports...

// 组件内：
const live = useSubAgentLive(workspace, agentId, running);

const modelLabel = running ? live.model ?? undefined : stats?.model;

const errorFirstLine = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? '';
const summary = subAgentRoleLabel(task) === task ? task : taskPlain(task);
// taskPlain：剥 markdown 的任务摘要（见下）

const line2: string = running
  ? live.step != null
    ? `第 ${live.step} 步 · ${live.action ?? '进行中…'}`
    : '运行中…'
  : [badge, effectiveStatus === 'error' && finalText ? errorFirstLine(finalText) : summary]
      .filter(Boolean)
      .join(' · ');
```

新增本地纯函数（文件内，或并入 subagentUtils）：

```ts
function taskPlain(task: string): string {
  const oneLine = (task ?? '').replace(/\s+/g, ' ').trim();
  const plain = oneLine.replace(/[#*_`>]/g, '').trim();
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
}
```

折叠头替换为：

```tsx
<ConvStrip
  status={effectiveStatus}
  icon={Bot}
  title={`子代理 #${index}`}
  role={subAgentRoleLabel(task)}
  model={modelLabel}
  line2={line2}
  open={expanded}
  onToggle={() => setExpanded((v) => !v)}
  onStop={running ? (e) => stop(e as unknown as MouseEvent) : undefined}
/>
```

展开体（E1）替换原 `指令框 + 结果框`：先放统计头 + 打开完整对话；结果区按 running/终态；指令默认折叠：

```tsx
{expanded ? (
  <div className={styles.body}>
    <div className={styles.statRow}>
      {modelLabel ? <span className={styles.statKey}>{modelLabel}</span> : null}
      <span>{running ? '运行中' : badge}</span>
      {statsText ? <span>· {statsText}</span> : null}
      <button type="button" className={styles.openLink} onClick={openInDock}>
        <Icon icon={PanelRightOpen} size={12} />
        打开完整对话
      </button>
    </div>
    <div>
      <div className={styles.sectionLabel} style={{ marginBlockEnd: 4 }}>结果</div>
      {running ? (
        <div className={styles.hint}>运行中…（点「打开完整对话」在右侧看实时进度）</div>
      ) : finalText ? (
        <div className={styles.resultBox}><LazyMarkdown variant="chat" fontSize={13}>{finalText}</LazyMarkdown></div>
      ) : (
        <div className={styles.hint}>（无输出）</div>
      )}
    </div>
    <button type="button" className={styles.toggleLink} onClick={() => setShowPrompt((v) => !v)}>
      {showPrompt ? '收起指令' : '查看指令'}
    </button>
    {showPrompt ? (
      <div className={styles.promptBox}><LazyMarkdown variant="chat" fontSize={13}>{task}</LazyMarkdown></div>
    ) : null}
  </div>
) : null}
```

新增 state：`const [showPrompt, setShowPrompt] = useState(false);`
新增样式 `statRow`/`statKey`/`toggleLink`（参考现有 `sectionLabelRow`/`openLink`，用 `createStaticStyles` + `cssVar`）。

- [ ] **步骤 2：类型检查 + 既有测试**

运行：`cd tauri-agent && npx tsc --noEmit`
运行：`cd tauri-agent && bunx vitest run src/features/chat/SubAgentInline.test.tsx`
预期：tsc 无错；`SubAgentInline.test.tsx` 通过（如旧断言依赖 chip 文案，按新结构改：断言 `子代理 #1` 与 `role` 文案存在）。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/chat/SubAgentInline.tsx
git commit -m "feat(chat): two-line subagent strip with role, live step, model, E1 expand"
```

---

## 任务 6：同步 preview 示例

**文件：**
- 修改：`tauri-agent/src/preview.tsx`

把三条 `ConvStrip` 示例（done/running/error）改为新 props：`role` + `line2` + `model`，running 示例加 `onStop={() => {}}`，移除已废弃的 `num`/`chip`/`meta`。

- [ ] **步骤 1：编写实现**

```tsx
<ConvStrip status="done" icon={Bot} title="子代理 #1" role="性能工程师" model="deepseek-v4-flash" line2="已完成 · 6 步 · 12.3k · 审查刚才的改动" onToggle={() => {}} />
<ConvStrip status="running" icon={Bot} title="子代理 #2" role="测试工程师" model="gpt-5.3-codex" line2="第 3 步 · 调用 read_file" onStop={() => {}} onToggle={() => {}} />
<ConvStrip status="error" icon={Bot} title="子代理 #3" role="构建工程师" model="claude-4.6-sonnet" line2="出错 · 3 步 · 构建 sidecar 失败" onToggle={() => {}} />
```

- [ ] **步骤 2：类型检查**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无报错。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/preview.tsx
git commit -m "chore(chat): update ConvStrip preview to new two-line props"
```

---

## 任务 7：全量校验

- [ ] **步骤 1：类型检查 + 全量测试**

运行：`cd tauri-agent && npx tsc --noEmit && bunx vitest run`
预期：tsc 无错；测试全绿。

- [ ] **步骤 2：手动验收（dev）**

运行：`cd tauri-agent && bun run dev`，触发一次多子代理 spawn：确认折叠态可一眼区分角色、模型在最右、运行中第二行实时刷新、左图标 hover 变停止可中止、展开为 E1（结果优先 + 指令默认折叠 + 打开完整对话）。

- [ ] **步骤 3：（如需）汇总 commit**

无新增改动则跳过。

---

## 自检

- **规格覆盖度：** 折叠态双行（任务 4/5）、角色提取（任务 1）、模型靠右（任务 4/5）、状态下移第二行（任务 5 line2）、停止 A（任务 3/4/5）、展开 E1（任务 5）、数据源 registry 轮询（任务 2）、D1 终态第二行默认（任务 5 line2）、D2 实时边界回退（任务 5：agentId 缺失→`运行中…`）。`SubAgentGroupInline` 明确不在范围（规格 §5）。
- **占位符扫描：** 无 TODO/待定；每步含实际代码与命令。
- **类型一致性：** `subAgentRoleLabel`/`latestStepFromMessages`/`latestSubAgentStep`（任务 1）→ `useSubAgentLive`（任务 2）→ `ConvStrip` props `role/line2/model/onStop`（任务 4）→ `SubAgentInline` 使用（任务 5）一致；`StatusGlyph onStop`（任务 3）与 ConvStrip 透传一致；`conv-strip` 类名在任务 3（hover 选择器）与任务 4（根节点）一致。

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-06-29-subagent-strip-redesign.md`。两种执行方式：

1. **子代理驱动（推荐）**：每个任务一个新子代理 + 任务间审查（subagent-driven-development）。
2. **内联执行**：当前会话用 executing-plans 批量执行并设检查点。
