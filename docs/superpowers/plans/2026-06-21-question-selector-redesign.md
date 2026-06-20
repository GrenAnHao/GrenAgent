# ask_user 内联阻塞选择面板重设计 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 `ask_user` 选择面板从"浮在输入框上方的单选卡"改造为"内联进对话流、皮肤精致、支持多选/多题分页/选项滚动"的阻塞式卡片。

**架构：** `ask_user.execute` 用 `ctx.ui.input` 把整张卡的 JSON 作为载荷（哨兵 `{__askUser:1,data}`）传到前端；前端 `ExtensionUiHost` 识别哨兵后路由到 `inlineQuestionStore`，由消息列表末尾的 `InlineQuestionCard` 用共享组件 `QuestionSelector`（皮肤2 + 步骤 + 多选 + 滚动）渲染；提交时回传 `[我的选择]` 文本经 `extension_ui_response` resolve 阻塞。不改 pi core。

**技术栈：** TypeScript；扩展端 typebox + pi ExtensionAPI；前端 React 19 + zustand + antd-style；测试 vitest（+ @testing-library/react）。

**规格：** `docs/superpowers/specs/2026-06-21-question-selector-redesign-design.md`

---

## 文件结构

**扩展端（`extensions/agent-mode/`）**
- 修改 `questions.ts` — 移除 `collectAnswers`/`AskUserUi`（被 ctx.ui.input 通路取代）；`normalizeQuestions` 增加最多 8 题上限。
- 修改 `index.ts` — 重写 `ask_user.execute`：`hasUI` 走 ctx.ui.input 载荷通路，`!hasUI` 保留非阻塞回退。
- 修改 `questions.test.ts` — 删 `collectAnswers` 用例，加 8 题上限用例。

**前端（`tauri-agent/src/`）**
- 新增 `components/QuestionSelector/answers.ts` — 把 `formatAnswers`/`formatChoiceLabels`/`parseAskUserPayload` 抽到共享模块（DRY）。
- 修改 `components/QuestionSelector/index.tsx` — 皮肤2 + 多选方形徽章 + 多题分页步骤 + 选项区限高滚动 + 左对齐限宽。
- 修改 `features/chat/QuestionsCard.tsx` — `formatAnswers` 改为从 `answers.ts` 导入（保持现有导出）。
- 新增 `stores/inlineQuestionStore.ts` — 暂存当前内联问题请求 `{id,data}`，按 workspace 一条。
- 新增 `features/chat/InlineQuestionCard.tsx` — 从 store 读取并渲染 `QuestionSelector`，提交/取消 → `extensionUiRespond`。
- 修改 `features/extensionUi/ExtensionUiHost.tsx` — `input` 请求带 `__askUser` 哨兵 → 写 `inlineQuestionStore`；其余不变。
- 修改 `features/chat/ChatListView.tsx` — 在消息列表末尾挂 `<InlineQuestionCard />`。
- 新增 `components/QuestionSelector/answers.test.ts`、`stores/inlineQuestionStore.test.ts`、`features/chat/InlineQuestionCard.test.tsx`、`components/QuestionSelector/QuestionSelector.test.tsx`。

每个文件单一职责；一起变更的放一起（选择渲染与其数据通路）。

---

## 任务 1：扩展端 — `normalizeQuestions` 加 8 题上限

**文件：**
- 修改：`extensions/agent-mode/questions.ts`
- 测试：`extensions/agent-mode/questions.test.ts`

- [ ] **步骤 1：写失败测试**

在 `questions.test.ts` 的 `describe("normalizeQuestions", …)` 内新增：

```ts
  it("caps questions at 8", () => {
    const raw: RawQuestion[] = Array.from({ length: 11 }, (_, i) => ({
      question: `Q${i + 1}`,
      options: [{ label: "x" }],
    }));
    const out = normalizeQuestions(raw, "q-1");
    expect(out?.questions).toHaveLength(8);
    expect(out?.questions[7].title).toBe("Q8");
  });
```

- [ ] **步骤 2：运行验证失败**

运行：`cd extensions/agent-mode && npx vitest run questions.test.ts`
预期：FAIL（当前返回 11 题）。

- [ ] **步骤 3：实现上限**

在 `questions.ts` 顶部常量区加：

```ts
/** ask_user 单次最多渲染的问题数（载荷与 UI 体量上限）。 */
export const MAX_QUESTIONS = 8;
```

在 `normalizeQuestions` 内 `if (questions.length === 0) return null;` 之前插入：

```ts
  if (questions.length > MAX_QUESTIONS) questions.length = MAX_QUESTIONS;
```

- [ ] **步骤 4：运行验证通过**

运行：`cd extensions/agent-mode && npx vitest run questions.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/agent-mode/questions.ts extensions/agent-mode/questions.test.ts
git commit -m "feat(ask_user): cap questions at 8 in normalizeQuestions"
```

---

## 任务 2：扩展端 — 移除 `collectAnswers`，重写 `ask_user.execute`

**文件：**
- 修改：`extensions/agent-mode/questions.ts`（删 `AskUserUi`/`MULTI_DONE_LABEL`/`collectAnswers`）
- 修改：`extensions/agent-mode/index.ts:165` 的 `ask_user` 工具（execute 重写、import 调整）
- 测试：`extensions/agent-mode/questions.test.ts`（删 `collectAnswers` 用例）

- [ ] **步骤 1：删除 `collectAnswers` 的测试**

在 `questions.test.ts` 中删除整个 `describe("collectAnswers", …)` 块，并把首行 import 改回：

```ts
import { CUSTOM_OPTION_ID, MAX_QUESTIONS, makeQuestionsId, normalizeQuestions, type RawQuestion } from "./questions.js";
```

（`MAX_QUESTIONS` 供任务 1 用例引用；若未引用可省。）

- [ ] **步骤 2：删除 `questions.ts` 中的 `AskUserUi`/`MULTI_DONE_LABEL`/`collectAnswers`**

删除 `export interface AskUserUi {…}`、`const MULTI_DONE_LABEL = …`、`export async function collectAnswers(…) {…}` 三段。保留 `CUSTOM_OPTION_ID` 导出、`normalizeQuestions`、`makeQuestionsId`、所有类型与 `MAX_QUESTIONS`。

- [ ] **步骤 3：改 `index.ts` 的 import**

`index.ts` 顶部把：

```ts
import { makeQuestionsId, normalizeQuestions, collectAnswers, type RawAskUserParams } from "./questions.js";
```

改为：

```ts
import { makeQuestionsId, normalizeQuestions, type RawAskUserParams } from "./questions.js";
```

- [ ] **步骤 4：重写 `ask_user` 的 `execute`**

把 `name:"ask_user"` 工具的整个 `async execute(...)` 替换为：

```ts
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const id = makeQuestionsId();
      const p = params as RawAskUserParams;
      if ((p.questions?.length ?? 0) > 8) {
        console.error(`[ask_user] 题目数 ${p.questions?.length} 超过上限 8，已截断。`);
      }
      const data = normalizeQuestions(p.questions ?? [], id, {
        allowExtra: p.allowExtra,
        allowExtraImages: p.allowExtraImages,
        extraPlaceholder: p.extraPlaceholder,
      });
      if (!data) {
        return {
          content: [{ type: "text", text: "ask_user：未提供有效问题（每个问题至少要有 question 文本）。" }],
        };
      }

      // 阻塞式富卡：整张卡 JSON 作载荷经 ctx.ui.input 传给前端；前端内联渲染并回传
      // `[我的选择] …` 文本，resolve 本次调用——模型拿到真实答案前不会继续。
      if (ctx.hasUI) {
        const payload = JSON.stringify({ __askUser: 1, data });
        const answer = await ctx.ui.input(payload, undefined, { signal });
        if (typeof answer === "string" && answer.trim()) {
          return { content: [{ type: "text", text: answer }] };
        }
        return { content: [{ type: "text", text: "用户取消了 ask_user 选择（未作答）。" }] };
      }

      // !hasUI（print/headless）：无对话框，回退到非阻塞对话流卡。
      pi.sendMessage(
        { customType: "agent-questions", content: JSON.stringify(data), display: true },
        { triggerTurn: false },
      );
      return {
        content: [
          {
            type: "text",
            text:
              `已在对话流展示提问卡片（${data.questions.length} 个问题）。当前环境不支持阻塞式对话框，` +
              "请停止当前回合，等待用户在卡片上选择并回复后再继续——不要替用户作答。",
          },
        ],
      };
    },
```

- [ ] **步骤 5：运行验证**

运行：`cd extensions/agent-mode && npx vitest run`
预期：PASS（`collectAnswers` 用例已删，其余绿）。

- [ ] **步骤 6：Commit**

```bash
git add extensions/agent-mode/index.ts extensions/agent-mode/questions.ts extensions/agent-mode/questions.test.ts
git commit -m "feat(ask_user): block via ctx.ui.input rich-card transport"
```

---

## 任务 3：前端 — 抽取 `formatAnswers` 与载荷解析到共享模块

**文件：**
- 创建：`tauri-agent/src/components/QuestionSelector/answers.ts`
- 修改：`tauri-agent/src/features/chat/QuestionsCard.tsx`（改为从 `answers.ts` 导入）
- 测试：`tauri-agent/src/components/QuestionSelector/answers.test.ts`

- [ ] **步骤 1：创建 `answers.ts`（含类型、formatAnswers、parseAskUserPayload）**

```ts
import { CUSTOM_OPTION_ID } from './constants';

export interface QSOption { id: string; label: string }
export interface QSQuestion {
  id: string;
  title: string;
  options: QSOption[];
  allowMultiple?: boolean;
  allowCustom?: boolean;
}
export interface QSData {
  kind: 'questions';
  id: string;
  questions: QSQuestion[];
  allowExtra?: boolean;
  allowExtraImages?: boolean;
  extraPlaceholder?: string;
}

function formatChoiceLabels(
  q: QSQuestion,
  ids: string[],
  customTexts?: Record<string, string>,
): string[] {
  return ids
    .map((oid) => {
      if (oid === CUSTOM_OPTION_ID) {
        const t = customTexts?.[q.id]?.trim();
        return t ? `其他：${t}` : '其他';
      }
      return q.options.find((o) => o.id === oid)?.label;
    })
    .filter((x): x is string => Boolean(x));
}

/** 把用户选择拼成人类可读、AI 可解析的回传文本。 */
export function formatAnswers(
  data: QSData,
  selected: Record<string, string[]>,
  customTexts?: Record<string, string>,
  extraNote?: string,
): string {
  const lines = data.questions.map((q, i) => {
    const labels = formatChoiceLabels(q, selected[q.id] ?? [], customTexts);
    return `${i + 1}. ${q.title}：${labels.length > 0 ? labels.join('、') : '(未选)'}`;
  });
  const note = extraNote?.trim();
  if (note) lines.push(`补充说明：${note}`);
  return `[我的选择]\n${lines.join('\n')}`;
}

/** 解析 ask_user 经 ctx.ui.input 传来的载荷（哨兵 __askUser）。非该载荷返回 null。 */
export function parseAskUserPayload(title: unknown): QSData | null {
  if (typeof title !== 'string' || title[0] !== '{') return null;
  try {
    const obj = JSON.parse(title) as { __askUser?: unknown; data?: QSData };
    if (obj && obj.__askUser && obj.data && obj.data.kind === 'questions') return obj.data;
  } catch {
    return null;
  }
  return null;
}
```

- [ ] **步骤 2：写测试**

`answers.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { CUSTOM_OPTION_ID } from './constants';
import { formatAnswers, parseAskUserPayload, type QSData } from './answers';

const data: QSData = {
  kind: 'questions',
  id: 'q1',
  questions: [
    { id: 'q1', title: '选方案', options: [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }], allowMultiple: true },
    { id: 'q2', title: '确认', options: [{ id: 'y', label: '是' }] },
  ],
};

describe('formatAnswers', () => {
  it('joins multi-select with、and numbers questions', () => {
    expect(formatAnswers(data, { q1: ['o1', 'o2'], q2: ['y'] })).toBe('[我的选择]\n1. 选方案：A、B\n2. 确认：是');
  });
  it('renders custom text and extra note', () => {
    const d: QSData = { ...data, questions: [{ id: 'q1', title: '选方案', options: [{ id: CUSTOM_OPTION_ID, label: '其他' }], allowCustom: true }] };
    expect(formatAnswers(d, { q1: [CUSTOM_OPTION_ID] }, { q1: '我的方案' }, '看截图')).toBe('[我的选择]\n1. 选方案：其他：我的方案\n补充说明：看截图');
  });
  it('marks unanswered as (未选)', () => {
    expect(formatAnswers(data, { q2: ['y'] })).toBe('[我的选择]\n1. 选方案：(未选)\n2. 确认：是');
  });
});

describe('parseAskUserPayload', () => {
  it('returns data for the sentinel envelope', () => {
    const t = JSON.stringify({ __askUser: 1, data });
    expect(parseAskUserPayload(t)?.questions).toHaveLength(2);
  });
  it('returns null for plain input title', () => {
    expect(parseAskUserPayload('输入名称')).toBeNull();
    expect(parseAskUserPayload(undefined)).toBeNull();
  });
});
```

- [ ] **步骤 3：运行验证失败 → 通过**

运行：`cd tauri-agent && npx vitest run src/components/QuestionSelector/answers.test.ts`
预期：PASS（实现已在步骤 1）。

- [ ] **步骤 4：`QuestionsCard.tsx` 改用共享 `formatAnswers`**

删除 `QuestionsCard.tsx` 内本地的 `formatChoiceLabels` 与 `formatAnswers` 定义，改为：

```ts
import { formatAnswers } from '../../components/QuestionSelector/answers';
```

并保留 `QuestionsCard.tsx` 末尾的 `export { formatAnswers }`（若现有测试从此处导入）；其余逻辑不动。

- [ ] **步骤 5：运行验证**

运行：`cd tauri-agent && npx vitest run src/features/chat/QuestionsCard.test.ts`
预期：PASS（输出格式不变）。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/components/QuestionSelector/answers.ts tauri-agent/src/components/QuestionSelector/answers.test.ts tauri-agent/src/features/chat/QuestionsCard.tsx
git commit -m "refactor(question-selector): extract formatAnswers + askUser payload parser"
```

---

## 任务 4：前端 — `QuestionSelector` 皮肤2 + 多选 + 多题分页 + 滚动

**文件：**
- 修改：`tauri-agent/src/components/QuestionSelector/index.tsx`
- 测试：`tauri-agent/src/components/QuestionSelector/QuestionSelector.test.tsx`

- [ ] **步骤 1：写失败测试**

`QuestionSelector.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionSelector, type QuestionSelectorQuestion } from './index';

afterEach(cleanup);

const single: QuestionSelectorQuestion[] = [
  { id: 'q1', title: '单题', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
];
const multiQ: QuestionSelectorQuestion[] = [
  { id: 'q1', title: '第一题', options: [{ id: 'a', label: 'A' }] },
  { id: 'q2', title: '第二题', options: [{ id: 'c', label: 'C' }] },
];

function Harness({ questions }: { questions: QuestionSelectorQuestion[] }) {
  const [sel, setSel] = (globalThis as any).React.useState({});
  return (
    <QuestionSelector
      questions={questions}
      selected={sel}
      onToggle={(qid, oid) => setSel((p: any) => ({ ...p, [qid]: [oid] }))}
      onContinue={() => {}}
      onSkip={() => {}}
    />
  );
}

describe('QuestionSelector', () => {
  it('single question shows 确定, no step nav', () => {
    render(<QuestionSelector questions={single} selected={{}} onToggle={() => {}} onContinue={() => {}} onSkip={() => {}} continueLabel="确定" />);
    expect(screen.getByTestId('question-selector-continue')).toBeTruthy();
    expect(screen.queryByTestId('question-selector-next')).toBeNull();
  });

  it('multi question shows step nav and reaches 提交 on last page', () => {
    render(<QuestionSelector questions={multiQ} selected={{ q1: ['a'], q2: ['c'] }} onToggle={() => {}} onContinue={() => {}} onSkip={() => {}} />);
    // 第 1 页：上一题禁用、有下一题
    expect((screen.getByTestId('question-selector-prev') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('question-selector-next'));
    // 第 2 页：出现提交
    expect(screen.getByTestId('question-selector-submit')).toBeTruthy();
  });

  it('next is disabled until current question answered', () => {
    render(<QuestionSelector questions={multiQ} selected={{}} onToggle={() => {}} onContinue={() => {}} onSkip={() => {}} />);
    expect((screen.getByTestId('question-selector-next') as HTMLButtonElement).disabled).toBe(true);
  });
});
```

（注：测试用 `React.useState` 经 `globalThis.React`；若项目测试约定不同，按现有 `*.test.tsx` 写法调整为受控渲染——核心断言是 `-continue`/`-next`/`-prev`/`-submit` 这几个 testid 的出现与禁用态。）

- [ ] **步骤 2：运行验证失败**

运行：`cd tauri-agent && npx vitest run src/components/QuestionSelector/QuestionSelector.test.tsx`
预期：FAIL（无 `-next`/`-submit` testid）。

- [ ] **步骤 3：用皮肤2 + 步骤重写 `QuestionSelector/index.tsx`**

完整替换为：

```tsx
import { Button, Icon } from '@lobehub/ui';
import { Check, MessageCircleQuestion } from 'lucide-react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo, useState } from 'react';
import type { ImageAttachment } from '../../features/chat/input/ChatInputContext';
import { CUSTOM_OPTION_ID } from './constants';
import { ExtraContent } from './ExtraContent';

export { CUSTOM_OPTION_ID } from './constants';

export interface QuestionSelectorOption { id: string; label: string }
export interface QuestionSelectorQuestion {
  id: string;
  title: string;
  options: QuestionSelectorOption[];
  allowMultiple?: boolean;
  allowCustom?: boolean;
}
export interface QuestionSelectorProps {
  questions: QuestionSelectorQuestion[];
  selected: Record<string, string[]>;
  customTexts?: Record<string, string>;
  onToggle: (questionId: string, optionId: string, allowMultiple: boolean) => void;
  onCustomTextChange?: (questionId: string, value: string) => void;
  onContinue?: () => void;
  onSkip?: () => void;
  disabled?: boolean;
  doneLabel?: string;
  allowExtra?: boolean;
  allowExtraImages?: boolean;
  extraText?: string;
  onExtraTextChange?: (value: string) => void;
  extraImages?: ImageAttachment[];
  onExtraImagesChange?: (items: ImageAttachment[]) => void;
  extraPlaceholder?: string;
  continueLabel?: string;
  skipLabel?: string;
  headerTitle?: string;
  className?: string;
  'data-testid'?: string;
}

const styles = createStaticStyles(({ css }) => ({
  root: css`
    width: 100%;
    max-width: 600px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  `,
  bar: css`height: 3px; background: ${cssVar.colorFillQuaternary};`,
  barFill: css`height: 100%; background: ${cssVar.colorPrimary}; border-radius: 0 2px 2px 0; transition: width 0.2s ease;`,
  head: css`
    display: flex; gap: 7px; align-items: center;
    padding: 10px 14px; border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 11px; color: ${cssVar.colorTextTertiary};
  `,
  dot: css`width: 6px; height: 6px; border-radius: 50%; background: ${cssVar.colorPrimary};`,
  count: css`margin-inline-start: auto; color: ${cssVar.colorPrimary};`,
  dots: css`display: flex; gap: 6px; margin-inline-start: auto;`,
  step: css`
    width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid ${cssVar.colorTextTertiary};
    font-size: 9px; color: ${cssVar.colorTextTertiary};
    display: inline-flex; align-items: center; justify-content: center;
  `,
  stepDone: css`background: ${cssVar.colorPrimary}; border-color: ${cssVar.colorPrimary}; color: ${cssVar.colorBgContainer};`,
  stepCur: css`border-color: ${cssVar.colorPrimary}; color: ${cssVar.colorPrimary};`,
  body: css`padding: 12px 14px; max-height: 260px; overflow: auto;`,
  question: css`font-size: 14px; font-weight: 600; line-height: 1.45; color: ${cssVar.colorText}; margin-block-end: 10px;`,
  options: css`display: flex; flex-direction: column; gap: 7px;`,
  option: css`
    display: flex; gap: 10px; align-items: flex-start; width: 100%;
    padding: 9px 11px; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 9px;
    background: ${cssVar.colorFillQuaternary}; color: ${cssVar.colorText}; font-size: 13px;
    text-align: start; cursor: pointer; transition: border-color 0.12s ease, background 0.12s ease;
    &:hover { border-color: ${cssVar.colorPrimary}; }
  `,
  optionSelected: css`border-color: ${cssVar.colorPrimary}; background: ${cssVar.colorPrimaryBg};`,
  letter: css`
    flex: none; width: 19px; height: 19px; border-radius: 50%;
    background: ${cssVar.colorFillSecondary}; color: ${cssVar.colorTextSecondary};
    font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; margin-block-start: 1px;
  `,
  letterMulti: css`border-radius: 6px;`,
  letterSelected: css`background: ${cssVar.colorPrimary}; color: ${cssVar.colorBgContainer};`,
  optionLabel: css`flex: 1; line-height: 1.4;`,
  check: css`flex: none; margin-inline-start: auto; color: ${cssVar.colorPrimary};`,
  customInput: css`
    width: 100%; margin-block-start: 7px; padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 8px;
    background: ${cssVar.colorFillQuaternary}; color: ${cssVar.colorText}; font-size: 13px; resize: vertical;
  `,
  footer: css`
    display: flex; gap: 8px; align-items: center; justify-content: flex-end;
    padding: 10px 14px; border-block-start: 1px solid ${cssVar.colorBorderSecondary}; background: ${cssVar.colorFillQuaternary};
  `,
  footMid: css`margin-inline-end: auto; font-size: 11px; color: ${cssVar.colorTextTertiary};`,
  doneText: css`
    padding: 10px 14px; border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFillQuaternary}; font-size: 12px; color: ${cssVar.colorTextTertiary};
  `,
}));

function questionSatisfied(
  q: QuestionSelectorQuestion,
  selected: Record<string, string[]>,
  customTexts?: Record<string, string>,
): boolean {
  const ids = selected[q.id] ?? [];
  if (q.options.length === 0) return q.allowCustom ? Boolean(customTexts?.[q.id]?.trim()) : false;
  if (ids.length === 0) return false;
  if (ids.includes(CUSTOM_OPTION_ID) && !customTexts?.[q.id]?.trim()) return false;
  return true;
}

export const QuestionSelector = memo(function QuestionSelector({
  questions,
  selected,
  customTexts = {},
  onToggle,
  onCustomTextChange,
  onContinue,
  onSkip,
  disabled = false,
  doneLabel,
  allowExtra = false,
  allowExtraImages = true,
  extraText = '',
  onExtraTextChange,
  extraImages = [],
  onExtraImagesChange,
  extraPlaceholder,
  continueLabel = '确定',
  skipLabel = '取消',
  headerTitle = '请选择',
  className,
  'data-testid': testId = 'question-selector',
}: QuestionSelectorProps) {
  const [step, setStep] = useState(0);
  const paged = questions.length > 1;
  const idx = Math.min(step, questions.length - 1);
  const q = questions[idx];
  const showExtra = allowExtra && onExtraTextChange && !disabled;
  const isLast = idx === questions.length - 1;
  const curOk = q ? questionSatisfied(q, selected, customTexts) : false;
  const allOk = questions.every((qq) => questionSatisfied(qq, selected, customTexts));
  const picked = q ? (selected[q.id] ?? []) : [];
  const showCustom = q?.allowCustom && picked.includes(CUSTOM_OPTION_ID) && onCustomTextChange;

  const renderHead = () => (
    <div className={styles.head}>
      <Icon icon={MessageCircleQuestion} size={13} />
      <span className={styles.dot} />
      <span>{paged ? `第 ${idx + 1} / ${questions.length} 题` : headerTitle} · {q?.allowMultiple ? '可多选' : '单选'}</span>
      {paged ? (
        <span className={styles.dots}>
          {questions.map((qq, i) => (
            <span
              key={qq.id}
              className={cx(styles.step, i < idx && styles.stepDone, i === idx && styles.stepCur)}
            >
              {i < idx ? '✓' : i + 1}
            </span>
          ))}
        </span>
      ) : q?.allowMultiple ? (
        <span className={styles.count}>已选 {picked.filter((id) => id !== CUSTOM_OPTION_ID || customTexts[q.id]?.trim()).length}</span>
      ) : null}
    </div>
  );

  return (
    <div className={cx(styles.root, className)} data-testid={testId}>
      {paged ? <div className={styles.bar}><div className={styles.barFill} style={{ width: `${((idx + 1) / questions.length) * 100}%` }} /></div> : null}
      {renderHead()}

      {q ? (
        <div className={styles.body}>
          <div className={styles.question}>{q.title}</div>
          <div className={styles.options}>
            {q.options.map((o, oi) => {
              const isSel = picked.includes(o.id);
              return (
                <button
                  key={o.id}
                  className={cx(styles.option, isSel && styles.optionSelected)}
                  data-testid={`${testId}-opt-${q.id}-${o.id}`}
                  disabled={disabled}
                  onClick={() => onToggle(q.id, o.id, Boolean(q.allowMultiple))}
                  type="button"
                >
                  <span className={cx(styles.letter, q.allowMultiple && styles.letterMulti, isSel && styles.letterSelected)}>
                    {String.fromCharCode(65 + oi)}
                  </span>
                  <span className={styles.optionLabel}>{o.label}</span>
                  {isSel ? <Icon className={styles.check} icon={Check} size={14} /> : null}
                </button>
              );
            })}
          </div>
          {showCustom ? (
            <textarea
              className={styles.customInput}
              data-testid={`${testId}-custom-${q.id}`}
              onChange={(e) => onCustomTextChange(q.id, e.target.value)}
              placeholder="请输入自定义答案"
              rows={2}
              value={customTexts[q.id] ?? ''}
            />
          ) : null}
        </div>
      ) : null}

      {showExtra && isLast ? (
        <ExtraContent
          allowImages={allowExtraImages}
          data-testid={`${testId}-extra`}
          images={extraImages}
          onImagesChange={onExtraImagesChange ?? (() => {})}
          onTextChange={onExtraTextChange}
          placeholder={extraPlaceholder}
          text={extraText}
        />
      ) : null}

      {doneLabel ? <div className={styles.doneText}>{doneLabel}</div> : null}

      {!disabled && !doneLabel ? (
        <div className={styles.footer}>
          {paged ? (
            <>
              <Button data-testid={`${testId}-prev`} disabled={idx === 0} onClick={() => setStep(idx - 1)} size="small">
                ← 上一题
              </Button>
              <span className={styles.footMid}>已答 {questions.filter((qq) => questionSatisfied(qq, selected, customTexts)).length} / {questions.length}</span>
              {isLast ? (
                <Button data-testid={`${testId}-submit`} disabled={!allOk} onClick={onContinue} size="small" type="primary">
                  ✓ 提交
                </Button>
              ) : (
                <Button data-testid={`${testId}-next`} disabled={!curOk} onClick={() => setStep(idx + 1)} size="small" type="primary">
                  下一题 →
                </Button>
              )}
            </>
          ) : (
            <>
              {onSkip ? (
                <Button data-testid={`${testId}-skip`} onClick={onSkip} size="small">{skipLabel}</Button>
              ) : null}
              {onContinue ? (
                <Button data-testid={`${testId}-continue`} disabled={!allOk} onClick={onContinue} size="small" type="primary">
                  {continueLabel}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
});
```

- [ ] **步骤 4：运行验证通过**

运行：`cd tauri-agent && npx vitest run src/components/QuestionSelector/QuestionSelector.test.tsx`
预期：PASS。同时跑 `npx vitest run src/features/chat/input/PromptRequestCard.test.tsx` 确认旧用法（单题、`-continue`/`-skip`）仍绿。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/components/QuestionSelector/index.tsx tauri-agent/src/components/QuestionSelector/QuestionSelector.test.tsx
git commit -m "feat(question-selector): skin refresh + multi-select + paged stepper + scroll"
```

> 说明：移除了旧的 `otherText`/`onOtherTextChange` 兼容字段（已无引用）。若 `tsc` 报有引用，改回那处调用用 `extraText`/`onExtraTextChange`。

---

## 任务 5：前端 — `inlineQuestionStore`

**文件：**
- 创建：`tauri-agent/src/stores/inlineQuestionStore.ts`
- 测试：`tauri-agent/src/stores/inlineQuestionStore.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { useInlineQuestionStore } from './inlineQuestionStore';
import type { QSData } from '../components/QuestionSelector/answers';

const data: QSData = { kind: 'questions', id: 'q1', questions: [] };

beforeEach(() => useInlineQuestionStore.setState({ byWorkspace: {} }));

describe('inlineQuestionStore', () => {
  it('stores one request per workspace and clears by id', () => {
    useInlineQuestionStore.getState().setRequest({ workspace: '/ws', id: 'u1', data });
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']?.id).toBe('u1');
    useInlineQuestionStore.getState().clear('/ws', 'other');
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']?.id).toBe('u1'); // 不同 id 不清
    useInlineQuestionStore.getState().clear('/ws', 'u1');
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toBeUndefined();
  });
});
```

- [ ] **步骤 2：实现 store**

```ts
import { create } from 'zustand';
import type { QSData } from '../components/QuestionSelector/answers';

export interface InlineQuestionItem {
  workspace: string;
  id: string;
  data: QSData;
}

interface InlineQuestionState {
  byWorkspace: Record<string, InlineQuestionItem>;
  setRequest: (item: InlineQuestionItem) => void;
  clear: (workspace: string, id?: string) => void;
}

export const useInlineQuestionStore = create<InlineQuestionState>((set) => ({
  byWorkspace: {},
  setRequest: (item) => set((s) => ({ byWorkspace: { ...s.byWorkspace, [item.workspace]: item } })),
  clear: (workspace, id) =>
    set((s) => {
      const cur = s.byWorkspace[workspace];
      if (!cur || (id && cur.id !== id)) return s;
      const next = { ...s.byWorkspace };
      delete next[workspace];
      return { byWorkspace: next };
    }),
}));
```

- [ ] **步骤 3：运行验证 → 通过**

运行：`cd tauri-agent && npx vitest run src/stores/inlineQuestionStore.test.ts`
预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/stores/inlineQuestionStore.ts tauri-agent/src/stores/inlineQuestionStore.test.ts
git commit -m "feat(ask_user): add inlineQuestionStore for in-flow question requests"
```

---

## 任务 6：前端 — `InlineQuestionCard`

**文件：**
- 创建：`tauri-agent/src/features/chat/InlineQuestionCard.tsx`
- 测试：`tauri-agent/src/features/chat/InlineQuestionCard.test.tsx`

- [ ] **步骤 1：写失败测试**

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { respond } = vi.hoisted(() => ({ respond: vi.fn(() => Promise.resolve()) }));
vi.mock('../../lib/pi', () => ({ extensionUiRespond: respond }));
vi.mock('../../stores/AgentStoreContext', () => ({ useAgentStoreContext: () => ({ workspace: '/ws' }) }));

import { InlineQuestionCard } from './InlineQuestionCard';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';

afterEach(() => { cleanup(); respond.mockClear(); useInlineQuestionStore.setState({ byWorkspace: {} }); });

const data = {
  kind: 'questions' as const, id: 'q1',
  questions: [{ id: 'q1', title: 'T', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
};

describe('InlineQuestionCard', () => {
  it('renders nothing without a request', () => {
    const { container } = render(<InlineQuestionCard />);
    expect(container.firstChild).toBeNull();
  });
  it('submits formatted answer and clears', () => {
    useInlineQuestionStore.getState().setRequest({ workspace: '/ws', id: 'u1', data });
    render(<InlineQuestionCard />);
    fireEvent.click(screen.getByText('B'));
    fireEvent.click(screen.getByTestId('inline-question-continue'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u1', value: '[我的选择]\n1. T：B' });
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toBeUndefined();
  });
  it('cancels with { cancelled: true }', () => {
    useInlineQuestionStore.getState().setRequest({ workspace: '/ws', id: 'u2', data });
    render(<InlineQuestionCard />);
    fireEvent.click(screen.getByTestId('inline-question-skip'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u2', cancelled: true });
  });
});
```

- [ ] **步骤 2：实现组件**

```tsx
import { memo, useEffect, useState } from 'react';
import { createStaticStyles } from 'antd-style';
import { QuestionSelector } from '../../components/QuestionSelector';
import { formatAnswers } from '../../components/QuestionSelector/answers';
import type { ImageAttachment } from './input/ChatInputContext';
import { extensionUiRespond } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`margin-block: 6px 2px;`,
}));

export const InlineQuestionCard = memo(function InlineQuestionCard() {
  const { workspace } = useAgentStoreContext();
  const item = useInlineQuestionStore((s) => s.byWorkspace[workspace]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [extraText, setExtraText] = useState('');
  const [extraImages, setExtraImages] = useState<ImageAttachment[]>([]);

  const reqId = item?.id;
  useEffect(() => {
    setSelected({}); setCustomTexts({}); setExtraText(''); setExtraImages([]);
  }, [reqId]);

  if (!item) return null;
  const { data } = item;

  const respond = (payload: Record<string, unknown>) => {
    void extensionUiRespond(workspace, { type: 'extension_ui_response', id: item.id, ...payload });
    useInlineQuestionStore.getState().clear(workspace, item.id);
  };

  const toggle = (qid: string, oid: string, multi: boolean) =>
    setSelected((prev) => {
      const cur = prev[qid] ?? [];
      if (multi) {
        return { ...prev, [qid]: cur.includes(oid) ? cur.filter((x) => x !== oid) : [...cur, oid] };
      }
      return { ...prev, [qid]: [oid] };
    });

  return (
    <div className={styles.wrap}>
      <QuestionSelector
        allowExtra={Boolean(data.allowExtra)}
        allowExtraImages={data.allowExtraImages !== false}
        customTexts={customTexts}
        data-testid="inline-question"
        extraImages={extraImages}
        extraPlaceholder={data.extraPlaceholder}
        extraText={extraText}
        onContinue={() => respond({ value: formatAnswers(data, selected, customTexts, extraText) })}
        onCustomTextChange={(qid, v) => setCustomTexts((p) => ({ ...p, [qid]: v }))}
        onExtraImagesChange={setExtraImages}
        onExtraTextChange={setExtraText}
        onSkip={() => respond({ cancelled: true })}
        onToggle={toggle}
        questions={data.questions}
        selected={selected}
      />
    </div>
  );
});
```

> 注意 testid：`QuestionSelector` 的页脚按钮是 `${testId}-continue`/`-skip`/`-next`/`-prev`/`-submit`；本卡传 `data-testid="inline-question"`，故测试用 `inline-question-continue`/`-skip`。

- [ ] **步骤 3：运行验证 → 通过**

运行：`cd tauri-agent && npx vitest run src/features/chat/InlineQuestionCard.test.tsx`
预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/features/chat/InlineQuestionCard.tsx tauri-agent/src/features/chat/InlineQuestionCard.test.tsx
git commit -m "feat(ask_user): InlineQuestionCard renders blocking question in chat flow"
```

---

## 任务 7：前端 — `ExtensionUiHost` 路由 ask_user 载荷

**文件：**
- 修改：`tauri-agent/src/features/extensionUi/ExtensionUiHost.tsx`

- [ ] **步骤 1：加入路由分支**

在 `ExtensionUiHost.tsx` 顶部加 import：

```ts
import { parseAskUserPayload } from '../../components/QuestionSelector/answers';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';
```

把现有处理 `confirm/select/input` 的那段（约 115-117 行）：

```ts
      if (method === 'confirm' || method === 'select' || method === 'input') {
        useUiPromptStore.getState().setRequest({ workspace: e.workspace, request: e.request });
      }
```

改为：

```ts
      if (method === 'input') {
        const data = parseAskUserPayload((e.request as { title?: unknown }).title);
        if (data) {
          // ask_user 富卡：内联渲染到消息流末尾，而非输入框上方。
          useInlineQuestionStore.getState().setRequest({ workspace: e.workspace, id: e.request.id, data });
          return;
        }
      }
      if (method === 'confirm' || method === 'select' || method === 'input') {
        useUiPromptStore.getState().setRequest({ workspace: e.workspace, request: e.request });
      }
```

- [ ] **步骤 2：手动/类型校验**

运行：`cd tauri-agent && npx tsc --noEmit`（或项目既有 `npm run typecheck`）
预期：无错误。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/extensionUi/ExtensionUiHost.tsx
git commit -m "feat(ask_user): route ctx.ui.input askUser payload to inline store"
```

---

## 任务 8：前端 — 在对话列末尾挂载 `InlineQuestionCard`

**文件：**
- 修改：`tauri-agent/src/features/chat/ChatListView.tsx`

- [ ] **步骤 1：挂载**

`ChatListView.tsx` 顶部加 import：

```ts
import { InlineQuestionCard } from './InlineQuestionCard';
```

把渲染处（79-82 行）：

```tsx
      <div ref={listRef} className={styles.list}>
        <ChatMessageItems messages={display} lazy />
        {showPreparing ? <PreparingIndicator /> : null}
      </div>
```

改为：

```tsx
      <div ref={listRef} className={styles.list}>
        <ChatMessageItems messages={display} lazy />
        {showPreparing ? <PreparingIndicator /> : null}
        <InlineQuestionCard />
      </div>
```

- [ ] **步骤 2：类型校验**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/chat/ChatListView.tsx
git commit -m "feat(ask_user): mount InlineQuestionCard at end of chat list"
```

---

## 任务 9：全量回归 + 手动验证

- [ ] **步骤 1：扩展端测试**

运行：`cd extensions/agent-mode && npx vitest run` 与 `cd extensions/fable-behavior && npx vitest run`
预期：全 PASS。

- [ ] **步骤 2：前端测试 + 类型**

运行：`cd tauri-agent && npx vitest run && npx tsc --noEmit`
预期：全 PASS、无类型错误。

- [ ] **步骤 3：构建并手动验证**

构建 sidecar 与前端（按项目方式，如 `cd tauri-agent && npm run tauri dev`），在真实 app 里验证：
1. 单选题：卡片出现在**对话流末尾**（紧跟提问消息），选 → 确定 → 模型拿到 `[我的选择]` 后继续；未选时"确定"禁用。
2. 多选题：可多选、页眉"已选 N"、≥1 可确定。
3. 多题：分页步骤,上一题/下一题/提交,未答禁用下一步,进度圆点正确。
4. 选项很多：卡内滚动,页眉/页脚固定。
5. 取消：回传 cancelled,工具返回"用户取消"。

- [ ] **步骤 4：最终 commit（如有手动修正）**

```bash
git add -A
git commit -m "test(ask_user): regression + manual verification fixes"
```

---

## 自检结果

**规格覆盖度：** §3 决定表逐项 → 内联(任务6/8)、皮肤2(任务4)、多选(任务4)、多题分页(任务4)、选项滚动(任务4)、布局限宽(任务4)、单题(任务4)、颜色用 cssVar(任务4)；§4 通路 → 任务2(后端)+任务3(解析)+任务7(路由)+任务6(渲染回传);§5 文件 → 任务1-8 全覆盖;§8 回退 → 任务2 的 !hasUI 分支。无遗漏。

**占位符扫描：** 无 TODO/"待补充"；每个代码步骤含完整代码与精确路径/命令。

**类型一致性：** `QSData`/`QSQuestion`(answers.ts) 与 `QuestionSelectorQuestion`(index.tsx) 结构兼容(InlineQuestionCard 把 `data.questions` 直接传给 `QuestionSelector`，字段 id/title/options/allowMultiple/allowCustom 一致)；testid 命名统一 `${testId}-continue/-skip/-next/-prev/-submit`，调用方 `inline-question-*`/`question-selector-*`/`prompt-request-select-*` 前缀一致;`extensionUiRespond(ws, {type,id,...})` 与现有签名一致;`useInlineQuestionStore.clear(ws,id)` 在任务5定义、任务6调用一致。

## 风险

- 载荷走 `ctx.ui.input` 的 `title`，依赖 pi core 原样转发该字符串(见规格 §8)。
- `QuestionSelector` 重写移除了 `otherText`/`onOtherTextChange` 旧兼容字段;若 `tsc` 报旧引用，改用 `extraText`/`onExtraTextChange`。
