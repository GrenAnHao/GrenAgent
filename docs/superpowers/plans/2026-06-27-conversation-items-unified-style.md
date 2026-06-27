# 对话项统一视觉系统 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把 `tauri-agent` 对话区 7 类渲染项收敛到一套「设计 token + 共享基元」，呈现 Cursor/Linear 紧凑技术感、四级层次，且行为/`data-testid` 不变。

**架构：** 新增 `src/features/chat/conv/` 放零运行时基元（`createStaticStyles` + `cssVar`）：`convTokens / StatusGlyph / Disclosure / CodeSurface / ConvRow / ConvStrip / MutedLine / ConvCard / OptionRow`。再逐个把现有叶子组件改为用这些基元；`ChatMessageItems / TurnTimeline / groupMessages` 分发逻辑不动。

**技术栈：** React 19 + TypeScript、antd-style（`createStaticStyles` / `cssVar` / `cx`）、`@lobehub/ui`（`Icon`）、`lucide-react`、vitest + @testing-library/react。

参考规格：`docs/superpowers/specs/2026-06-27-conversation-items-unified-style-design.md`。

---

## 约定

- 测试：`cd tauri-agent && npx vitest run <file>`（**不要**裸跑全量）。
- 类型：`cd tauri-agent && npx tsc --noEmit`。
- 每个新基元放独立文件（单一职责）；样式集中在 `convTokens.ts`，组件内不写散值。
- 图标：`import { Icon } from '@lobehub/ui'` + `lucide-react`，禁用 emoji。
- commit 前缀用 gitmoji（仓库习惯），如 `:lipstick:` / `:sparkles:` / `:recycle:`。
- 迁移保持每个组件的 `data-testid` 与对外行为不变，使现有 `*.test.tsx` 断言无需改动。

## 文件结构

| 文件 | 职责 |
|---|---|
| 创建 `src/features/chat/conv/convTokens.ts` | 设计 token（`createStaticStyles` 样式 + 常量映射 cssVar） |
| 创建 `src/features/chat/conv/StatusGlyph.tsx` | 状态(running/done/error)→ 图标 + 颜色 |
| 创建 `src/features/chat/conv/Disclosure.tsx` | 统一 chevron 折叠指示（旋转动画） |
| 创建 `src/features/chat/conv/CodeSurface.tsx` | 展开体代码/输出/diff 块（淡底 + hairline + 等宽 + 限高滚动） |
| 创建 `src/features/chat/conv/ConvRow.tsx` | L2 纯行（lead + 图标 + 名·参数 + 右槽 meta + 可展开 body） |
| 创建 `src/features/chat/conv/ConvStrip.tsx` | L3 横条（surface 单行） |
| 创建 `src/features/chat/conv/MutedLine.tsx` | L1 低调行（思考/注入） |
| 创建 `src/features/chat/conv/ConvCard.tsx` | L4 卡片（label/title/body/footer 槽） |
| 创建 `src/features/chat/conv/OptionRow.tsx` | ask_user 单/多选行 |
| 创建 `src/features/chat/conv/index.ts` | 统一导出 |
| 修改 `src/features/tools/ToolExecution.tsx` | inspector/detail 改用 ConvRow + CodeSurface |
| 修改 `src/features/chat/SubAgentInline.tsx` | 头改用 ConvStrip |
| 修改 `src/features/chat/SubAgentGroupInline.tsx` | 行改用 ConvStrip |
| 修改 `src/features/chat/ReasoningInline.tsx` | 改用 MutedLine + CodeSurface |
| 修改 `src/features/chat/NoticePill.tsx` | 改用 MutedLine |
| 修改 `src/features/chat/PlanCard.tsx` | 改用 ConvCard |
| 修改 `src/features/chat/InlineQuestionCard.tsx` / `QuestionsCard.tsx` / `AnswerCard.tsx` / `tools/AnsweredQuestionsCard.tsx` | 改用 ConvCard + OptionRow |
| 修改 `src/features/chat/chatStyles.ts` / `tools/cardStyles.ts` | 收敛被 token 取代的散值 |
| 修改 `src/preview.tsx` | 基元画廊（视觉回归参照） |

---

## 任务 1：设计 token + StatusGlyph

**文件：**
- 创建：`tauri-agent/src/features/chat/conv/convTokens.ts`
- 创建：`tauri-agent/src/features/chat/conv/StatusGlyph.tsx`
- 测试：`tauri-agent/src/features/chat/conv/StatusGlyph.test.tsx`

- [ ] **步骤 1：写 convTokens.ts**

```ts
import { createStaticStyles, cssVar } from 'antd-style';

/** 对话项统一设计 token（零运行时；切主题只换 cssVar 值）。所有视觉数值集中于此。 */
export const conv = {
  radius: cssVar.borderRadius,
  gap: { xs: 4, sm: 6, md: 8, lg: 10 },
  rowH: 26,
  stripH: 30,
  headH: 28,
} as const;

export const convStyles = createStaticStyles(({ css }) => ({
  // L4/L3 共享 surface
  surface: css`
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  // 等宽
  mono: css`
    font-family: ${cssVar.fontFamilyCode};
    font-feature-settings: 'liga' 0;
  `,
  // 行首 lead 槽（状态图标固定宽度，保证名称左缘对齐）
  lead: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 16px;
  `,
}));
```

- [ ] **步骤 2：写失败测试 StatusGlyph.test.tsx**

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusGlyph } from './StatusGlyph';

describe('StatusGlyph', () => {
  it('renders a spinner for running', () => {
    const { container } = render(<StatusGlyph status="running" />);
    expect(container.querySelector('[data-status="running"]')).toBeTruthy();
  });
  it('renders check for done and x for error', () => {
    const { container: a } = render(<StatusGlyph status="done" />);
    const { container: b } = render(<StatusGlyph status="error" />);
    expect(a.querySelector('[data-status="done"]')).toBeTruthy();
    expect(b.querySelector('[data-status="error"]')).toBeTruthy();
  });
});
```

- [ ] **步骤 3：运行确认失败**

运行：`cd tauri-agent && npx vitest run src/features/chat/conv/StatusGlyph.test.tsx`
预期：FAIL（模块不存在）。

- [ ] **步骤 4：写 StatusGlyph.tsx**

```tsx
import { Icon } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { Check, Loader2, X } from 'lucide-react';
import { memo } from 'react';
import { convStyles } from './convTokens';

export type ConvStatus = 'running' | 'done' | 'error';

const COLOR: Record<ConvStatus, string> = {
  running: cssVar.colorInfo,
  done: cssVar.colorSuccess,
  error: cssVar.colorError,
};

/** 行首状态图标：运行=转圈(Info)、完成=勾(Success)、出错=叉(Error)。无彩色竖条。 */
export const StatusGlyph = memo(function StatusGlyph({ status }: { status: ConvStatus }) {
  const icon = status === 'running' ? Loader2 : status === 'error' ? X : Check;
  return (
    <span className={convStyles.lead} data-status={status} style={{ color: COLOR[status] }}>
      <Icon icon={icon} size={13} spin={status === 'running'} />
    </span>
  );
});
```

- [ ] **步骤 5：运行确认通过**

运行：`cd tauri-agent && npx vitest run src/features/chat/conv/StatusGlyph.test.tsx`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/chat/conv/convTokens.ts tauri-agent/src/features/chat/conv/StatusGlyph.tsx tauri-agent/src/features/chat/conv/StatusGlyph.test.tsx
git commit -m ":sparkles: conv: add design tokens + StatusGlyph primitive"
```

---

## 任务 2：Disclosure + CodeSurface

**文件：**
- 创建：`tauri-agent/src/features/chat/conv/Disclosure.tsx`
- 创建：`tauri-agent/src/features/chat/conv/CodeSurface.tsx`
- 测试：`tauri-agent/src/features/chat/conv/CodeSurface.test.tsx`

- [ ] **步骤 1：写 Disclosure.tsx**

```tsx
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { ChevronRight } from 'lucide-react';
import { memo } from 'react';

const s = createStaticStyles(({ css }) => ({
  chev: css`
    flex: none;
    color: ${cssVar.colorTextQuaternary};
    transition: transform 0.15s ease;
  `,
  open: css`
    transform: rotate(90deg);
  `,
}));

/** 统一折叠指示：一个会旋转的 chevron（替代 Collapse/Accordion/各自 chevron 三套）。 */
export const Disclosure = memo(function Disclosure({ open }: { open: boolean }) {
  return <Icon className={cx(s.chev, open && s.open)} icon={ChevronRight} size={12} />;
});
```

- [ ] **步骤 2：写失败测试 CodeSurface.test.tsx**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeSurface } from './CodeSurface';

describe('CodeSurface', () => {
  it('renders children text in a code block', () => {
    render(<CodeSurface>hello-output</CodeSurface>);
    expect(screen.getByText('hello-output')).toBeTruthy();
  });
});
```

- [ ] **步骤 3：运行确认失败**

运行：`cd tauri-agent && npx vitest run src/features/chat/conv/CodeSurface.test.tsx`
预期：FAIL。

- [ ] **步骤 4：写 CodeSurface.tsx**

```tsx
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo, type ReactNode } from 'react';

const s = createStaticStyles(({ css }) => ({
  box: css`
    overflow: auto;
    max-height: min(50vh, 360px);
    padding: 9px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.65;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
}));

/** 展开体里的代码/输出/diff 块：淡底 + hairline + 等宽 + 限高滚动。无 terminal 头栏、不重复命令。 */
export const CodeSurface = memo(function CodeSurface({
  children,
  isError,
}: {
  children: ReactNode;
  isError?: boolean;
}) {
  return <div className={cx(s.box, isError && s.error)}>{children}</div>;
});
```

- [ ] **步骤 5：运行确认通过**

运行：`cd tauri-agent && npx vitest run src/features/chat/conv/CodeSurface.test.tsx`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/chat/conv/Disclosure.tsx tauri-agent/src/features/chat/conv/CodeSurface.tsx tauri-agent/src/features/chat/conv/CodeSurface.test.tsx
git commit -m ":sparkles: conv: add Disclosure + CodeSurface primitives"
```

---

## 任务 3：ConvRow（L2 纯行）

**文件：**
- 创建：`tauri-agent/src/features/chat/conv/ConvRow.tsx`
- 测试：`tauri-agent/src/features/chat/conv/ConvRow.test.tsx`

- [ ] **步骤 1：写失败测试 ConvRow.test.tsx**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { Boxes } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ConvRow } from './ConvRow';

describe('ConvRow', () => {
  it('shows name and args, toggles body on click when expandable', () => {
    const onToggle = vi.fn();
    render(
      <ConvRow
        status="done"
        icon={Boxes}
        name="read"
        args="agents.ts"
        meta="+52"
        open={false}
        onToggle={onToggle}
        body={<div>BODY</div>}
      />,
    );
    expect(screen.getByText('read')).toBeTruthy();
    expect(screen.getByText('agents.ts')).toBeTruthy();
    expect(screen.queryByText('BODY')).toBeNull();
    fireEvent.click(screen.getByText('read'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders body when open', () => {
    render(
      <ConvRow status="done" icon={Boxes} name="bash" open body={<div>OUT</div>} onToggle={() => {}} />,
    );
    expect(screen.getByText('OUT')).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`cd tauri-agent && npx vitest run src/features/chat/conv/ConvRow.test.tsx`
预期：FAIL。

- [ ] **步骤 3：写 ConvRow.tsx**

```tsx
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { StatusGlyph, type ConvStatus } from './StatusGlyph';
import { Disclosure } from './Disclosure';
import { convStyles } from './convTokens';

const s = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 7px;
    margin: 0 -7px;
    border-radius: 6px;
    font-size: 12.5px;
    transition: background 0.12s ease;
    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  clickable: css`
    cursor: pointer;
  `,
  name: css`
    flex: none;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  sep: css`
    color: ${cssVar.colorTextQuaternary};
  `,
  arg: css`
    overflow: hidden;
    min-width: 0;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11.5px;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  right: css`
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    margin-inline-start: auto;
  `,
  meta: css`
    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};
    font-variant-numeric: tabular-nums;
  `,
  body: css`
    margin: 2px 0 8px 24px;
  `,
}));

interface ConvRowProps {
  status: ConvStatus;
  icon: LucideIcon;
  name: string;
  args?: ReactNode;
  meta?: ReactNode;
  /** 提供 body 即可展开；不提供则为纯展示行（无 chevron）。 */
  body?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  'data-testid'?: string;
}

/** L2 纯行：状态图标 + 工具图标 + 等宽名·参数 + 右侧 meta + 折叠箭头；展开 body 轻缩进、无左竖线。 */
export const ConvRow = memo(function ConvRow({
  status,
  icon,
  name,
  args,
  meta,
  body,
  open = false,
  onToggle,
  'data-testid': testId,
}: ConvRowProps) {
  const expandable = body != null && onToggle != null;
  return (
    <div data-testid={testId}>
      <div
        className={cx(s.row, expandable && s.clickable)}
        onClick={expandable ? onToggle : undefined}
      >
        <StatusGlyph status={status} />
        <Icon icon={icon} size={14} style={{ color: cssVar.colorTextTertiary, flex: 'none' }} />
        <span className={s.name}>{name}</span>
        {args != null ? (
          <>
            <span className={s.sep}>·</span>
            <span className={s.arg}>{args}</span>
          </>
        ) : null}
        <div className={s.right}>
          {meta != null ? <span className={s.meta}>{meta}</span> : null}
          {expandable ? <Disclosure open={open} /> : null}
        </div>
      </div>
      {expandable && open ? <div className={s.body}>{body}</div> : null}
    </div>
  );
});
```

- [ ] **步骤 4：运行确认通过**

运行：`cd tauri-agent && npx vitest run src/features/chat/conv/ConvRow.test.tsx`
预期：PASS。

- [ ] **步骤 5：写 index.ts 汇总导出**

```ts
export * from './convTokens';
export * from './StatusGlyph';
export * from './Disclosure';
export * from './CodeSurface';
export * from './ConvRow';
```

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/chat/conv/ConvRow.tsx tauri-agent/src/features/chat/conv/ConvRow.test.tsx tauri-agent/src/features/chat/conv/index.ts
git commit -m ":sparkles: conv: add ConvRow primitive + barrel export"
```

---

## 任务 4：迁移 ToolExecution → ConvRow + CodeSurface

把 `ToolExecution` 的「inspector 标题行 + Accordion 折叠 + detail」改写为 `ConvRow`（标题=name/args，body=detail），终端类详情用 `CodeSurface`，**去掉 TerminalCard 的头栏与 `$` 命令重复**。保留所有分支（read/write/edit/bash/grep/glob/code_search/ls/todo/generate_image/ask_user）与 `renderExtensionCard`，仅换外壳。

**文件：**
- 修改：`tauri-agent/src/features/tools/ToolExecution.tsx`
- 测试：`tauri-agent/src/features/tools/ToolExecution.test.tsx`（已存在，断言不变）

- [ ] **步骤 1：先跑现有测试，确认基线通过**

运行：`cd tauri-agent && npx vitest run src/features/tools/ToolExecution.test.tsx`
预期：PASS（迁移前基线）。

- [ ] **步骤 2：改写 `ToolExecutionInner` 的返回结构**

把 `ToolExecutionInner`（`ToolExecution.tsx` 末段）替换为用 `ConvRow`。`ToolInspector` 拆成「name + args 摘要」喂给 ConvRow；`ToolDetail` 作为 body。保留 `ask_user`/`todo`/`generate_image` 的 early return 分支不变。

```tsx
import { ConvRow } from '../chat/conv/ConvRow';
import type { ConvStatus } from '../chat/conv/StatusGlyph';
import { toolMeta } from './toolUtils';
// ……（保留原有 imports，移除不再使用的 Accordion/AccordionItem/ScrollArea/StatusIndicator）

function ToolExecutionInner({ toolName, args, result, status }: ToolExecutionProps) {
  const [expanded, setExpanded] = useState(status === 'running');
  const hasDetail = useMemo(() => {
    if (status === 'running') return true;
    return Boolean(extractText(result) || getDiff(result) || stringifyJson(result));
  }, [result, status]);

  const bareName = toolName.toLowerCase();
  if (bareName === 'ask_user') {
    return status === 'done' ? (
      <AnsweredQuestionsCard args={args} result={result} />
    ) : (
      <InlineQuestionCard />
    );
  }
  if (bareName === 'todo' || bareName === 'generate_image') {
    const card = renderExtensionCard({ toolName, args, result, status });
    if (card) return <ErrorBoundary>{card}</ErrorBoundary>;
  }

  const { icon } = toolMeta(toolName);
  const summary = argSummary(args);
  const cStatus = status as ConvStatus;

  return (
    <ConvRow
      data-testid="tool-execution"
      status={cStatus}
      icon={icon}
      name={toolName}
      args={summary || undefined}
      open={expanded}
      onToggle={hasDetail || status === 'running' ? () => setExpanded((v) => !v) : undefined}
      body={
        hasDetail || status === 'running' ? (
          <ErrorBoundary>
            <ToolDetail toolName={toolName} args={args} result={result} status={status} />
          </ErrorBoundary>
        ) : undefined
      }
    />
  );
}
```

> 说明：原 `ToolInspector` 里「搜索/技能/fetch_url」等富标题，本步先用通用 `name + summary` 落地（保证测试通过）；富标题在任务 4b 以 ConvRow 的 `args` 传入 ReactNode 复原（见下）。

- [ ] **步骤 3：把 TerminalCard 改为无头栏（去冗余）**

将 `TerminalCard` 替换为直接渲染 `CodeSurface`（命令已由 ConvRow 的 `args` 展示，不再重复 `$ command` 与 terminal 头）：

```tsx
import { CodeSurface } from '../chat/conv/CodeSurface';

// ToolDetail 内 bash 分支：
if (name === 'bash' || name === 'shell' || name === 'run_terminal_cmd') {
  if (status === 'running' && !text) return <CodeSurface>运行中…</CodeSurface>;
  return <CodeSurface isError={isError}>{text || '(无输出)'}</CodeSurface>;
}
```

read/write/edit 分支保留 `LazyHighlighter`，但路径标签 `pathLabel` 保留（它不是冗余，是 body 内的文件名）。

- [ ] **步骤 4：运行现有测试确认仍通过**

运行：`cd tauri-agent && npx vitest run src/features/tools/ToolExecution.test.tsx`
预期：PASS。若断言依赖旧 `Accordion` 结构而失败，按新结构更新对应断言（仅结构断言，不改语义）。

- [ ] **步骤 5：类型检查**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无新增错误（移除未用 imports）。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/tools/ToolExecution.tsx tauri-agent/src/features/tools/ToolExecution.test.tsx
git commit -m ":recycle: tools: migrate ToolExecution to ConvRow + CodeSurface (drop terminal header redundancy)"
```

### 任务 4b：复原富标题（搜索/技能/fetch_url）

ConvRow 的 `name`/`args` 接受 `ReactNode`，把原 `ToolInspector` 的富标题逻辑改造成「返回 `{name, args}` 片段」喂入 ConvRow。

- [ ] **步骤 1：把 `ToolInspector` 重构为 `toolTitle(toolName,args,result,status) => { name: ReactNode; args?: ReactNode }`**

```tsx
function toolTitle(toolName: string, args: unknown, result: unknown, status: ConvStatus): { name: ReactNode; args?: ReactNode } {
  const styles = cardStyles;
  const skillName = skillNameFromRead(toolName, args);
  if (skillName) return { name: <>使用技能 <span className={styles.skillName}>{skillName}</span></> };

  const lname = toolName.toLowerCase();
  if (lname === 'web_search' || lname === 'search') {
    const query = getArgString(args, 'query');
    return { name: '搜索', args: query ? <span className={styles.queryHighlight}>{query}</span> : toolName };
  }
  if (lname === 'fetch_url') {
    return { name: '读取页面内容', args: <span className={styles.paramValue}>{getArgString(args, 'url')}</span> };
  }
  if (lname === 'grep' || lname === 'ripgrep') return { name: '检索', args: getArgString(args, 'pattern') };
  if (lname === 'glob') return { name: '查找文件', args: getArgString(args, 'pattern') };
  if (lname === 'code_search') return { name: '代码检索', args: getArgString(args, 'query') };
  return { name: toolName, args: argSummary(args) || undefined };
}
```

- [ ] **步骤 2：在 `ToolExecutionInner` 用 `toolTitle` 替换 name/args**

```tsx
const title = toolTitle(toolName, args, result, cStatus);
// <ConvRow ... name={title.name} args={title.args} ... />
```

`name` 现为 ReactNode：把 `ConvRow` 的 `name: string` 放宽为 `name: ReactNode`（同步改 `ConvRow.tsx` 与其测试）。

- [ ] **步骤 3：运行测试 + tsc**

运行：`cd tauri-agent && npx vitest run src/features/tools/ToolExecution.test.tsx src/features/tools/SearchCards.test.tsx src/features/chat/conv/ConvRow.test.tsx`
预期：PASS。运行 `npx tsc --noEmit` 无错。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/features/tools/ToolExecution.tsx tauri-agent/src/features/chat/conv/ConvRow.tsx tauri-agent/src/features/chat/conv/ConvRow.test.tsx
git commit -m ":lipstick: tools: restore rich tool titles on ConvRow"
```

---

## 任务 5：ConvStrip + 迁移子代理

**文件：**
- 创建：`tauri-agent/src/features/chat/conv/ConvStrip.tsx`
- 测试：`tauri-agent/src/features/chat/conv/ConvStrip.test.tsx`
- 修改：`tauri-agent/src/features/chat/SubAgentInline.tsx`、`SubAgentGroupInline.tsx`

- [ ] **步骤 1：写 ConvStrip.tsx**

```tsx
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode, type MouseEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { StatusGlyph, type ConvStatus } from './StatusGlyph';
import { Disclosure } from './Disclosure';

const s = createStaticStyles(({ css }) => ({
  strip: css`
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    margin-block: 2px;
    padding: 0 10px;
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
  title: css`
    flex: none;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  num: css`
    flex: none;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11.5px;
    color: ${cssVar.colorTextTertiary};
  `,
  chip: css`
    overflow: hidden;
    min-width: 0;
    padding: 1px 7px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 4px;
    background: ${cssVar.colorFillTertiary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  right: css`
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    margin-inline-start: auto;
  `,
  meta: css`
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

interface ConvStripProps {
  status: ConvStatus;
  icon: LucideIcon;
  title: string;
  num?: string;
  chip?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  'data-testid'?: string;
}

/** L3 横条：整条 surface（底 + hairline + 圆角）单行，给侧重组件（子代理）以存在感。 */
export const ConvStrip = memo(function ConvStrip({
  status,
  icon,
  title,
  num,
  chip,
  meta,
  actions,
  open = false,
  onToggle,
  'data-testid': testId,
}: ConvStripProps) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div className={s.strip} data-testid={testId} onClick={onToggle}>
      <StatusGlyph status={status} />
      <Icon icon={icon} size={14} style={{ color: cssVar.colorInfo, flex: 'none' }} />
      <span className={s.title}>{title}</span>
      {num ? <span className={s.num}>{num}</span> : null}
      {chip != null ? <span className={s.chip}>{chip}</span> : null}
      <div className={s.right} onClick={stop}>
        {meta != null ? <span className={s.meta}>{meta}</span> : null}
        {actions}
        {onToggle ? <Disclosure open={open} /> : null}
      </div>
    </div>
  );
});
```

- [ ] **步骤 2：写测试 ConvStrip.test.tsx**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { Bot } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ConvStrip } from './ConvStrip';

describe('ConvStrip', () => {
  it('renders title/num/chip/meta and toggles', () => {
    const onToggle = vi.fn();
    render(
      <ConvStrip status="done" icon={Bot} title="子代理" num="#1" chip="审查改动" meta="完成·6步" open={false} onToggle={onToggle} />,
    );
    expect(screen.getByText('子代理')).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
    expect(screen.getByText('审查改动')).toBeTruthy();
    fireEvent.click(screen.getByText('子代理'));
    expect(onToggle).toHaveBeenCalled();
  });
});
```

- [ ] **步骤 3：运行测试（先失败后通过）**

运行：`cd tauri-agent && npx vitest run src/features/chat/conv/ConvStrip.test.tsx`
预期：写完 ConvStrip 后 PASS。

- [ ] **步骤 4：迁移 SubAgentInline 头部**

把 `SubAgentInline.tsx` 的 `styles.head`/`styles.left`/`styles.right` 折叠头替换为 `ConvStrip`，把现有 `effectiveStatus`→`ConvStatus`、`statsText`/`badge`→`meta`、`task`→`chip`、`#index`→`num`、`stop`/`openInDock` 的 ActionIcon→`actions`。展开 body（指令/结果框）保留现有 `styles.body` 块或改 `CodeSurface`。`data-testid="subagent-inline"` 保留。

```tsx
const cStatus: ConvStatus = effectiveStatus === 'running' ? 'running' : effectiveStatus === 'error' ? 'error' : 'done';
return (
  <div data-testid="subagent-inline">
    <ConvStrip
      status={cStatus}
      icon={running ? Loader2 : Bot}
      title="子代理"
      num={`#${index}`}
      chip={task}
      meta={running ? '运行中…' : [statsText, badge].filter(Boolean).join(' · ') || undefined}
      open={expanded}
      onToggle={() => setExpanded((v) => !v)}
      actions={
        <>
          {running ? <ActionIcon icon={CircleStop} size="small" title="停止子代理" onClick={stop} /> : null}
          <ActionIcon icon={PanelRightOpen} size="small" title="在右侧面板打开完整对话" onClick={openInDock} />
        </>
      }
    />
    {expanded ? (/* 保留现有 指令/结果 body，结果框可换 CodeSurface */) : null}
  </div>
);
```

- [ ] **步骤 5：迁移 SubAgentGroupInline**

每个 NumberedUnit 行改用 `ConvStrip`（`title="子代理"`, `num={#no}`, `chip={unit.task}`, `status` 来自 unit 状态）。保留组的展开/选中逻辑与 `data-testid`。

- [ ] **步骤 6：运行测试 + tsc**

运行：`cd tauri-agent && npx vitest run src/features/chat/SubAgentInline.test.tsx src/features/chat/conv/ConvStrip.test.tsx`
预期：PASS。`npx tsc --noEmit` 无错。

- [ ] **步骤 7：Commit**

```bash
git add tauri-agent/src/features/chat/conv/ConvStrip.tsx tauri-agent/src/features/chat/conv/ConvStrip.test.tsx tauri-agent/src/features/chat/SubAgentInline.tsx tauri-agent/src/features/chat/SubAgentGroupInline.tsx
git commit -m ":recycle: chat: migrate sub-agent to ConvStrip"
```

---

## 任务 6：MutedLine + 迁移 思考/注入

**文件：**
- 创建：`tauri-agent/src/features/chat/conv/MutedLine.tsx`
- 测试：`tauri-agent/src/features/chat/conv/MutedLine.test.tsx`
- 修改：`tauri-agent/src/features/chat/ReasoningInline.tsx`、`NoticePill.tsx`

- [ ] **步骤 1：写 MutedLine.tsx**

```tsx
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Disclosure } from './Disclosure';

const s = createStaticStyles(({ css }) => ({
  line: css`
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    cursor: pointer;
    transition: color 0.12s ease;
    &:hover {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  count: css`
    color: ${cssVar.colorTextQuaternary};
  `,
}));

interface MutedLineProps {
  icon: LucideIcon;
  text: ReactNode;
  count?: number;
  open?: boolean;
  onToggle?: () => void;
  'data-testid'?: string;
}

/** L1 低调行：环境信息（深度思考 / 注入），最弱权重；可折叠则带 chevron。 */
export const MutedLine = memo(function MutedLine({ icon, text, count, open = false, onToggle, 'data-testid': testId }: MutedLineProps) {
  return (
    <button type="button" className={s.line} data-testid={testId} aria-expanded={onToggle ? open : undefined} onClick={onToggle}>
      <Icon icon={icon} size={12} />
      <span>
        {text}
        {count ? <span className={s.count}> · {count} 条</span> : null}
      </span>
      {onToggle ? <Disclosure open={open} /> : null}
    </button>
  );
});
```

- [ ] **步骤 2：写测试 MutedLine.test.tsx**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { Brain } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { MutedLine } from './MutedLine';

describe('MutedLine', () => {
  it('renders text with count and toggles', () => {
    const onToggle = vi.fn();
    render(<MutedLine icon={Brain} text="已注入长期记忆" count={3} open={false} onToggle={onToggle} />);
    expect(screen.getByText('已注入长期记忆')).toBeTruthy();
    expect(screen.getByText(/3 条/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalled();
  });
});
```

- [ ] **步骤 3：运行测试（先失败后通过）**

运行：`cd tauri-agent && npx vitest run src/features/chat/conv/MutedLine.test.tsx`
预期：PASS。

- [ ] **步骤 4：迁移 ReasoningInline 的「已折叠摘要行」**

`ReasoningInline` 终态收起态的 `styles.summary` 按钮替换为 `MutedLine`（icon=Brain，text=`已深度思考 · X 秒`，可折叠）。流式态（呼吸点 + shinyText + 限高渐隐）保留不变。展开正文保留 `LazyMarkdown`。`data-testid="reasoning-inline"` 保留。

- [ ] **步骤 5：迁移 NoticePill**

`NoticePill` 用 `MutedLine`（icon=Sparkles，text=标题，count=条目数）替换 `Collapse` 折叠头；展开 body 保留 `LazyMarkdown`（用受控 `open` 状态）。`data-testid="notice-pill"` 保留。

- [ ] **步骤 6：运行测试 + tsc**

运行：`cd tauri-agent && npx vitest run src/features/chat/ReasoningInline.test.tsx src/features/chat/NoticePill.test.tsx src/features/chat/conv/MutedLine.test.tsx`
预期：PASS。`npx tsc --noEmit` 无错。

- [ ] **步骤 7：Commit**

```bash
git add tauri-agent/src/features/chat/conv/MutedLine.tsx tauri-agent/src/features/chat/conv/MutedLine.test.tsx tauri-agent/src/features/chat/ReasoningInline.tsx tauri-agent/src/features/chat/NoticePill.tsx
git commit -m ":recycle: chat: migrate reasoning/notice to MutedLine"
```

---

## 任务 7：ConvCard + OptionRow + 迁移 计划/ask_user/生图

**文件：**
- 创建：`tauri-agent/src/features/chat/conv/ConvCard.tsx`、`OptionRow.tsx`
- 测试：`tauri-agent/src/features/chat/conv/ConvCard.test.tsx`、`OptionRow.test.tsx`
- 修改：`PlanCard.tsx`、`InlineQuestionCard.tsx`、`QuestionsCard.tsx`、`AnswerCard.tsx`、`tools/AnsweredQuestionsCard.tsx`、`tools/extensionCards.tsx`(生图)

- [ ] **步骤 1：写 ConvCard.tsx**

```tsx
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

const s = createStaticStyles(({ css }) => ({
  card: css`
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  head: css`
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  `,
  tag: css`
    margin-inline-start: auto;
    font-family: ${cssVar.fontFamilyCode};
    text-transform: none;
    color: ${cssVar.colorTextQuaternary};
  `,
  footer: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 9px 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
}));

interface ConvCardProps {
  icon?: LucideIcon;
  label: string;
  tag?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  'data-testid'?: string;
}

/** L4 卡片：统一 surface（与 ConvStrip 同底/边/圆角）+ 卡头 + body + footer 槽。 */
export const ConvCard = memo(function ConvCard({ icon, label, tag, children, footer, 'data-testid': testId }: ConvCardProps) {
  return (
    <div className={s.card} data-testid={testId}>
      <div className={s.head}>
        {icon ? <Icon icon={icon} size={12} /> : null}
        <span>{label}</span>
        {tag != null ? <span className={s.tag}>{tag}</span> : null}
      </div>
      {children}
      {footer != null ? <div className={s.footer}>{footer}</div> : null}
    </div>
  );
});
```

- [ ] **步骤 2：写 OptionRow.tsx**

```tsx
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Check } from 'lucide-react';
import { memo } from 'react';

const s = createStaticStyles(({ css }) => ({
  opt: css`
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 9px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12.5px;
    cursor: pointer;
    transition: border-color 0.1s ease, background 0.1s ease;
    &:hover {
      border-color: ${cssVar.colorBorder};
      color: ${cssVar.colorText};
    }
  `,
  sel: css`
    border-color: ${cssVar.colorInfo};
    background: color-mix(in srgb, ${cssVar.colorInfo} 12%, transparent);
    color: ${cssVar.colorText};
  `,
  key: css`
    flex: none;
    width: 12px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 10.5px;
    color: ${cssVar.colorTextQuaternary};
  `,
  rec: css`
    margin-inline-start: auto;
    font-size: 10px;
    color: ${cssVar.colorInfo};
  `,
  ck: css`
    margin-inline-start: auto;
    color: ${cssVar.colorInfo};
  `,
}));

interface OptionRowProps {
  index: number;
  label: string;
  selected: boolean;
  recommended?: boolean;
  multi?: boolean;
  onClick: () => void;
}

/** ask_user 选项行：等宽序号 + 文本 + 选中(靛蓝边/淡底)；多选显勾、单选显推荐标。 */
export const OptionRow = memo(function OptionRow({ index, label, selected, recommended, multi, onClick }: OptionRowProps) {
  return (
    <div className={cx(s.opt, selected && s.sel)} onClick={onClick}>
      <span className={s.key}>{index}</span>
      <span>{label}</span>
      {multi && selected ? <Icon className={s.ck} icon={Check} size={13} /> : null}
      {!multi && recommended ? <span className={s.rec}>推荐</span> : null}
    </div>
  );
});
```

- [ ] **步骤 3：写测试（ConvCard + OptionRow）**

```tsx
// ConvCard.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConvCard } from './ConvCard';
describe('ConvCard', () => {
  it('renders label, body, footer', () => {
    render(<ConvCard label="PLAN" footer={<button>开始执行</button>}><div>BODY</div></ConvCard>);
    expect(screen.getByText('PLAN')).toBeTruthy();
    expect(screen.getByText('BODY')).toBeTruthy();
    expect(screen.getByText('开始执行')).toBeTruthy();
  });
});
```

```tsx
// OptionRow.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OptionRow } from './OptionRow';
describe('OptionRow', () => {
  it('fires onClick and shows recommended', () => {
    const onClick = vi.fn();
    render(<OptionRow index={1} label="选项 A" selected recommended onClick={onClick} />);
    fireEvent.click(screen.getByText('选项 A'));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByText('推荐')).toBeTruthy();
  });
});
```

- [ ] **步骤 4：运行测试（先失败后通过）**

运行：`cd tauri-agent && npx vitest run src/features/chat/conv/ConvCard.test.tsx src/features/chat/conv/OptionRow.test.tsx`
预期：PASS。

- [ ] **步骤 5：迁移 PlanCard**

`PlanCard` 外壳 `styles.card`+`head`+`title`+`summary`+`footer` 替换为 `ConvCard`（label="Plan", icon=ListChecks, tag=`${todos.length} steps`，footer=View Plan/开始执行）。步骤列表用现有 step 渲染（CheckCircle2/Circle）。解析失败回退分支保留。`data-testid="plan-card"` 保留。

- [ ] **步骤 6：迁移 ask_user 系列**

`InlineQuestionCard`（运行中提问）与 `QuestionsCard`（留痕）用 `ConvCard`（label="需要你确认"，icon=MessageCircleQuestion，tag="ask_user"）+ `OptionRow` 列表 + footer（跳过/提交）。`AnsweredQuestionsCard`/`AnswerCard`（已答）用 `MutedLine` 风的收起记录（`✓ 问 → 选了什么`）。保留各自 `data-testid` 与回答提交逻辑（沿用 `2026-06-21-question-selector-redesign` 的交互）。

- [ ] **步骤 7：迁移生图卡**

`extensionCards.tsx` 中 `generate_image` 卡外壳改用 `ConvCard`（label="生成图片"），预览/提示词/操作槽位保留。

- [ ] **步骤 8：运行相关测试 + tsc**

运行：`cd tauri-agent && npx vitest run src/features/chat/PlanCard.test.ts src/features/chat/QuestionsCard.test.ts src/features/chat/AnswerCard.test.ts src/features/chat/InlineQuestionCard.test.tsx src/features/tools/extensionCards.test.tsx src/features/chat/conv/ConvCard.test.tsx src/features/chat/conv/OptionRow.test.tsx`
预期：PASS。`npx tsc --noEmit` 无错。

- [ ] **步骤 9：Commit**

```bash
git add tauri-agent/src/features/chat/conv/ConvCard.tsx tauri-agent/src/features/chat/conv/OptionRow.tsx tauri-agent/src/features/chat/conv/ConvCard.test.tsx tauri-agent/src/features/chat/conv/OptionRow.test.tsx tauri-agent/src/features/chat/PlanCard.tsx tauri-agent/src/features/chat/InlineQuestionCard.tsx tauri-agent/src/features/chat/QuestionsCard.tsx tauri-agent/src/features/chat/AnswerCard.tsx tauri-agent/src/features/tools/AnsweredQuestionsCard.tsx tauri-agent/src/features/tools/extensionCards.tsx
git commit -m ":recycle: chat: migrate plan/ask_user/image to ConvCard + OptionRow"
```

---

## 任务 8：用户气泡 / 右坞复用 / 收尾清理 + 预览画廊

**文件：**
- 修改：`tauri-agent/src/features/chat/chatStyles.ts`（bubble 用 surface token；保留布局）
- 修改：`tauri-agent/src/features/tools/cardStyles.ts`（删被 token 取代的 terminal/page/thinking 散值，或改引用 convTokens）
- 修改：`tauri-agent/src/features/panels/SubAgentConversation.tsx`（结果/代码用 CodeSurface，可选）
- 修改：`tauri-agent/src/preview.tsx`（基元画廊）
- 测试：`barrel`、相关现有测试

- [ ] **步骤 1：用户气泡对齐 surface**

`chatStyles.bubble` 的 `background`/`border-radius` 改为与 conv surface 一致（`colorFillQuaternary` + `borderRadius`，加 `1px colorBorderSecondary`）；其余布局不动。

- [ ] **步骤 2：清理 cardStyles 冗余**

删除/收敛 `terminalCard`/`terminalHead`/`terminalPrompt`/`terminalCommandText`/`terminalCopy`/`terminalBodyDivided` 等已被 `CodeSurface` 取代的样式（确认无引用后删除）。`thinkingBody`/`pageCard` 等若仍被引用则保留或改引用 `convTokens`。

运行：`cd tauri-agent && npx vitest run` 之前先用 `rg` 确认无引用：
```bash
rg "terminalCard|terminalHead|terminalPrompt" tauri-agent/src
```
预期：仅历史引用已移除。

- [ ] **步骤 3：扩展 preview.tsx 为基元画廊**

在 `Gallery()` 增加「conv 基元」分区：直接渲染 `ConvRow`(done/running/error)、`ConvStrip`、`MutedLine`、`ConvCard` + `OptionRow`、`CodeSurface`，作为视觉回归参照。

```tsx
import { Boxes } from 'lucide-react';
import { ConvRow } from './features/chat/conv/ConvRow';
import { CodeSurface } from './features/chat/conv/CodeSurface';
// …在 Gallery 内：
<Section title="conv 基元">
  <ConvRow status="done" icon={Boxes} name="read" args="agents.ts" meta="+52" open onToggle={() => {}} body={<CodeSurface>output…</CodeSurface>} />
</Section>
```

- [ ] **步骤 4：全量回归**

运行：`cd tauri-agent && npx vitest run`
预期：全绿（含所有迁移组件测试与新基元测试）。

- [ ] **步骤 5：类型检查 + 构建**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：零错误。

- [ ] **步骤 6：浏览器人工核验**

运行：`cd tauri-agent && npx vite`（或 `bun run dev`），浏览器打开 `http://localhost:1420/preview.html` 核对四级层次与 surface 一致性。

- [ ] **步骤 7：Commit**

```bash
git add tauri-agent/src/features/chat/chatStyles.ts tauri-agent/src/features/tools/cardStyles.ts tauri-agent/src/features/panels/SubAgentConversation.tsx tauri-agent/src/preview.tsx
git commit -m ":recycle: chat: align user bubble + dock to conv surface, prune legacy styles, preview gallery"
```

---

## 自检

**1. 规格覆盖度：**
- 设计 token → 任务 1（convTokens）。
- 四级层次 L1/L2/L3/L4 → MutedLine(任务6)/ConvRow(任务3-4)/ConvStrip(任务5)/ConvCard(任务7)。
- 状态语义（无彩条）→ StatusGlyph(任务1)。
- 共享基元 8 个 → 任务 1/2/3/5/6/7 全覆盖。
- 对话项→基元映射 7 类 → 任务 4/5/6/7 全覆盖（含 ask_user、生图、用户气泡、右坞）。
- 去冗余（terminal 头/命令重复）→ 任务 4 步骤 3 + 任务 8 步骤 2。
- data-testid 保留 → 各迁移任务显式保留。
- 测试/tsc 全绿 → 每任务收尾步骤。

**2. 占位符扫描：** 无 "TODO/待定/类似任务 N"；各新基元给出完整代码；迁移步骤给出真实新 JSX（少数迁移正文以"保留现有 body"描述，因其逻辑不变、仅换外壳，非占位）。

**3. 类型一致性：** `ConvStatus`（StatusGlyph 定义）贯穿 ConvRow/ConvStrip；`ConvRow.name` 在任务 4b 放宽为 `ReactNode`（同步改测试）；`conv/index.ts` 统一导出，各处从 `../chat/conv/*` 直接引基元（与文件路径一致）。

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-06-27-conversation-items-unified-style.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每任务一个子代理 + 任务间审查（superpowers:subagent-driven-development）。
2. **内联执行** — 当前会话按任务批量执行并设检查点（superpowers:executing-plans）。
