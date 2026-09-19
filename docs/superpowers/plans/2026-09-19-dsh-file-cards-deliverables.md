# DSH 读写编卡片与回合产物 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 读写编展开体去掉文件名；写入/编辑按参数流式画 unified diff；读取等结果；回合尾出已编辑与 `present` 产物；点已编辑打开右坞审查。

**架构：** `fileDiffModel` 从工具 args/result 纯派生 diff。卡片和审查共用这块。回合尾从 `groupMessages` 的 turn segments 再派生。`present` 是新内置扩展。审查填现成 `review` tab。不接 git。

**技术栈：** TypeScript、React、antd-style、zustand、vitest + testing-library、Node `fs`（仅 present 扩展）。

**规格：** `docs/superpowers/specs/2026-09-19-dsh-file-cards-deliverables-design.md`

**硬约束：** TDD；不要隔离 worktree，在当前仓库原地做（工作区很脏）。每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。用户未要求提交则跳过各任务的 Commit 步骤。禁止 emoji。不要做 git 快照、左右分栏审查、侧边栏预览。子代理时间线不挂 `TurnTail`。

---

## 动工前必读

- 写入/编辑的 running 卡在 `agentReducer` 里已经存在（`message_update` 带上增长的 `arguments`）。本计划只改呈现，不改事件。
- `read` 某个 `SKILL.md` 仍显示「使用技能」，不要改成「读取」。
- `getArgString(args, 'path')` 在 path 不是 string 时会 `formatArgValue`，可能把对象变成摘要。新代码取路径只用 `typeof === 'string'` 的 `path` 或 `file_path`。
- Pi edit 的 `details.diff` 是 ` 1 text` / `-2 text` / `+2 text` 这种展示格式，不是标准 unified。`fileDiffModel` 必须两种都能解析。
- `ChatMessageItems` 主对话和子代理共用。`showDeliverables` 只许 `ChatListView` 传 `true`。
- `ReviewPayload` 已有 `workspace?: string`，只加 `turnId` / `fileIndex`，不要换 tab id 规则。
- 普通对话的通路没有「审查」；`openTurnReview` 不走 `canOpenLauncherKind`。
- Windows 测试命令见下。不要求点 Electron 真窗。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试>
```

扩展测试：

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions\present"; npx vitest run
```

CLI 侧扩展清单：

```powershell
cd "D:\OneDrive\Project Files\Pi\cli"; npm test -- src/agent-data-plugins.test.ts src/extension-profile.test.ts
```

涉及类型的任务再加：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit -p tsconfig.json
```

**提交（仅当用户明确要求时）：**

```powershell
git add <本任务文件>
git commit -m @"
feat(对话): <本任务一句话>

"@
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/features/tools/fileDiffModel.ts` | 工具名判定、intended/applied、行 diff、totals |
| `electron-agent/src/features/tools/fileDiffModel.test.ts` | 写入全绿、编辑红绿、details.diff、失败 null、末尾空行 |
| `electron-agent/src/features/tools/FileDiffBlock.tsx` | unified diff 块：复制、限高折叠、底栏统计、无文件名 |
| `electron-agent/src/features/tools/FileDiffBlock.test.tsx` | 无文件名、折叠、复制文本 |
| `electron-agent/src/features/tools/FileReadBlock.tsx` | 读取正文 + 行号 + 复制，无文件名 |
| `electron-agent/src/features/chat/turnDeliverables.ts` | settled / changes / presented / 工作区路径解析 |
| `electron-agent/src/features/chat/turnDeliverables.test.ts` | 同文件加总、read/失败不进、present 覆盖描述 |
| `electron-agent/src/features/chat/TurnTail.tsx` | 已编辑卡 + 产物卡 |
| `electron-agent/src/features/chat/TurnTail.test.tsx` | 折叠阈值、点击 fileIndex、打开/定位 |
| `electron-agent/src/features/chat/reviewView.ts` | 从 messages + ReviewPayload 得到审查视图 |
| `electron-agent/src/features/chat/reviewView.test.ts` | empty / missing / none / ready |
| `electron-agent/src/features/dock/TurnReviewBody.tsx` | 审查面板 |
| `electron-agent/src/features/dock/TurnReviewBody.test.tsx` | 空开占位、列表、切文件 |
| `extensions/present/present.ts` | 校验 files（工作区、存在、普通文件、1–8） |
| `extensions/present/present.test.ts` | 通过与失败用例 |
| `extensions/present/index.ts` | 注册 `present` 工具 |
| `extensions/present/package.json` | 与 `extensions/todo/package.json` 同形 |

修改：

| 文件 | 改动 |
| --- | --- |
| `electron-agent/src/features/tools/ToolExecution.tsx` | 中文动词、无 pathLabel、走 FileDiffBlock/FileReadBlock、present 单行 |
| `electron-agent/src/features/tools/ToolExecution.test.tsx` | 文件名只出现一次；写入流式；读取 running 无正文 |
| `electron-agent/src/features/chat/TurnTimeline.tsx` | `showDeliverables` 时挂 TurnTail |
| `electron-agent/src/features/chat/ChatMessageItems.tsx` | 把开关传进 TurnTimeline |
| `electron-agent/src/features/chat/ChatListView.tsx` | `showDeliverables` |
| `electron-agent/src/stores/dockStore.ts` | `ReviewPayload` 加字段 |
| `electron-agent/src/features/dock/openLauncherTab.ts` | `openTurnReview` |
| `electron-agent/src/features/dock/openLauncherTab.test.ts` | 复用 tab 并写入 payload |
| `electron-agent/src/features/dock/TabBodyRenderer.tsx` | review → TurnReviewBody |
| `extensions/index.ts` | 挂 present |
| `cli/src/extension-profile.ts` | `CORE_ALWAYS_ON` 加 `present` |
| `docs/architecture.md` | 内置扩展表加一行 |

删除：

| 文件 | 原因 |
| --- | --- |
| `electron-agent/src/features/tools/EditPreview.tsx` | 被 FileDiffBlock 取代 |
| `electron-agent/src/features/tools/EditPreview.test.tsx` | 断言迁走 |
| `electron-agent/src/features/dock/ReviewPlaceholderBody.tsx` | 被 TurnReviewBody 取代 |
| `electron-agent/src/features/dock/ReviewPlaceholderBody.test.tsx` | 被新空态测试取代 |

不修改：`agentReducer.ts` 的工具流式事件、`safety` 对 write/edit 的闸、Ask/Plan 的 write/edit 拦截、git / Host changes。

---

### 任务 1：fileDiffModel

**文件：**
- 创建：`electron-agent/src/features/tools/fileDiffModel.ts`
- 测试：`electron-agent/src/features/tools/fileDiffModel.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { fileCardVerb, fileDiffModel, isFileMutation, isFileRead } from './fileDiffModel';

describe('fileDiffModel', () => {
  it('recognizes read/write/edit aliases', () => {
    expect(isFileRead('read_file')).toBe(true);
    expect(isFileMutation('write_file')).toBe(true);
    expect(isFileMutation('search_replace')).toBe(true);
    expect(isFileMutation('read')).toBe(false);
    expect(fileCardVerb('write_file')).toBe('写入');
    expect(fileCardVerb('bash')).toBeNull();
  });

  it('write intended is all additions and drops a trailing empty line', () => {
    const diff = fileDiffModel(
      'write',
      { path: 'a.txt', content: 'one\ntwo\n' },
      {},
      'running',
    );
    expect(diff?.path).toBe('a.txt');
    expect(diff?.rows).toEqual([
      { marker: '+', text: 'one' },
      { marker: '+', text: 'two' },
    ]);
    expect(diff?.added).toBe(2);
    expect(diff?.deleted).toBe(0);
  });

  it('edit intended uses old_string / new_string', () => {
    const diff = fileDiffModel(
      'edit',
      { file_path: 'a.ts', old_string: 'foo', new_string: 'bar' },
      {},
      'running',
    );
    expect(diff?.path).toBe('a.ts');
    expect(diff?.rows).toEqual([
      { marker: '-', text: 'foo' },
      { marker: '+', text: 'bar' },
    ]);
  });

  it('prefers details.diff when the tool completed', () => {
    const diff = fileDiffModel(
      'edit',
      { path: 'a.ts', oldText: 'foo', newText: 'bar' },
      { details: { diff: ' 1 keep\n-2 foo\n+2 bar\n 3 next' } },
      'done',
    );
    expect(diff?.rows.map((row) => row.marker + row.text)).toEqual([' keep', '-foo', '+bar', ' next']);
    expect(diff?.added).toBe(1);
    expect(diff?.deleted).toBe(1);
  });

  it('returns null on error or identical-content result text', () => {
    expect(fileDiffModel('write', { path: 'a.txt', content: 'x' }, {}, 'error')).toBeNull();
    expect(
      fileDiffModel(
        'edit',
        { path: 'a.ts', oldText: 'same', newText: 'same' },
        { content: [{ type: 'text', text: 'No changes made. The replacement produced identical content.' }] },
        'done',
      ),
    ).toBeNull();
  });

  it('keeps intended write when details.diff is missing after success', () => {
    const diff = fileDiffModel('write', { path: 'a.txt', content: 'hello' }, { content: [] }, 'done');
    expect(diff?.rows).toEqual([{ marker: '+', text: 'hello' }]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/tools/fileDiffModel.test.ts
```

预期：FAIL，找不到 `./fileDiffModel`。

- [ ] **步骤 3：编写最少实现代码**

`fileDiffModel.ts` 必须导出：`isFileRead`、`isFileMutation`、`fileCardVerb`、`fileDiffModel`、`FileDiff`、`DiffRow`、`mutationPath`、`contentLines`。

`fileCardVerb(name)`：`读取` / `写入` / `编辑` / `null`（skill 判断仍在 ToolExecution）。任务 3 用它做标题，不要再复制一份 WRITE/EDIT Set。

```ts
import { extractText, getDiff, getEditTexts } from './toolUtils';

export type DiffMarker = '+' | '-' | ' ';
export interface DiffRow { marker: DiffMarker; text: string }
export interface FileDiff { path: string; rows: DiffRow[]; added: number; deleted: number }

const READ = new Set(['read', 'read_file']);
const WRITE = new Set(['write', 'write_file']);
const EDIT = new Set(['edit', 'search_replace', 'str_replace']);

export function isFileRead(name: string): boolean {
  return READ.has(name.toLowerCase());
}
export function isFileMutation(name: string): boolean {
  const lower = name.toLowerCase();
  return WRITE.has(lower) || EDIT.has(lower);
}

export function fileCardVerb(name: string): '读取' | '写入' | '编辑' | null {
  const lower = name.toLowerCase();
  if (READ.has(lower)) return '读取';
  if (WRITE.has(lower)) return '写入';
  if (EDIT.has(lower)) return '编辑';
  return null;
}

export function mutationPath(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const input = args as Record<string, unknown>;
  for (const key of ['path', 'file_path']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

export function contentLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/(?:\r?\n)+$/u, '').split(/\r?\n/);
}

function totals(rows: DiffRow[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const row of rows) {
    if (row.marker === '+') added += 1;
    if (row.marker === '-') deleted += 1;
  }
  return { added, deleted };
}

function lcsRows(prev: string[], next: string[]): DiffRow[] {
  const n = prev.length;
  const m = next.length;
  if (n + m > 256) {
    return [
      ...prev.map((text) => ({ marker: '-' as const, text })),
      ...next.map((text) => ({ marker: '+' as const, text })),
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = prev[i] === next[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (prev[i] === next[j]) {
      rows.push({ marker: ' ', text: prev[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ marker: '-', text: prev[i] });
      i += 1;
    } else {
      rows.push({ marker: '+', text: next[j] });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ marker: '-', text: prev[i] });
    i += 1;
  }
  while (j < m) {
    rows.push({ marker: '+', text: next[j] });
    j += 1;
  }
  return rows;
}

export function rowsFromTexts(oldText: string | null, newText: string): DiffRow[] {
  const next = contentLines(newText);
  if (oldText === null) return next.map((text) => ({ marker: '+', text }));
  return lcsRows(contentLines(oldText), next);
}

function parsePiDisplayDiff(diff: string): DiffRow[] | null {
  const lines = diff.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const rows: DiffRow[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) continue;
    const match = line.match(/^([ +\-])(?:\s*\d+|\s+)\s(.*)$/);
    if (!match) return null;
    const marker = match[1] === '+' || match[1] === '-' ? match[1] : ' ';
    rows.push({ marker, text: match[2] });
  }
  return rows.length ? rows : null;
}

function parseUnifiedDiff(diff: string): DiffRow[] | null {
  const rows: DiffRow[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (!line || line.startsWith('@@') || line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('+')) rows.push({ marker: '+', text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ marker: '-', text: line.slice(1) });
    else if (line.startsWith(' ')) rows.push({ marker: ' ', text: line.slice(1) });
    else return null;
  }
  return rows.length ? rows : null;
}

function rowsFromApplied(diff: string): DiffRow[] | null {
  return parsePiDisplayDiff(diff) ?? parseUnifiedDiff(diff);
}

function identicalContent(result: unknown): boolean {
  return /replacements? produced identical content/i.test(extractText(result));
}

export function fileDiffModel(
  toolName: string,
  args: unknown,
  result: unknown,
  status: 'running' | 'done' | 'error',
): FileDiff | null {
  if (!isFileMutation(toolName) || status === 'error' || identicalContent(result)) return null;
  const path = mutationPath(args);
  if (!path) return null;
  const applied = status === 'done' ? getDiff(result) : undefined;
  const rows = applied ? rowsFromApplied(applied) : null;
  if (rows) return { path, rows, ...totals(rows) };
  const lower = toolName.toLowerCase();
  if (WRITE.has(lower)) {
    const content = typeof (args as { content?: unknown } | null)?.content === 'string'
      ? (args as { content: string }).content
      : '';
    const intended = rowsFromTexts(null, content);
    return { path, rows: intended, ...totals(intended) };
  }
  const { oldText, newText } = getEditTexts(args);
  const intended = rowsFromTexts(oldText || null, newText);
  return { path, rows: intended, ...totals(intended) };
}
```

注意：edit 且 `oldText === ''` 时 `oldText || null` 会变成 `null`，整段变全绿。改成 `rowsFromTexts(oldText === '' && newText !== '' && !('old_string' in (args as object) || 'oldText' in (args as object)) ? null : oldText, newText)` 太绕。规格：缺一侧当空串。这里 **edit 一律 `rowsFromTexts(oldText, newText)`**，不要把空 old 收成 write。

把实现里 edit 分支改成：

```ts
  const { oldText, newText } = getEditTexts(args);
  const intended = rowsFromTexts(oldText, newText);
  return { path, rows: intended, ...totals(intended) };
```

`rowsFromTexts` 的 `oldText` 仍然接受 `string | null`，write 传 `null`，edit 传 string（可空）。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/tools/fileDiffModel.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

---

### 任务 2：FileDiffBlock 与 FileReadBlock

**文件：**
- 创建：`electron-agent/src/features/tools/FileDiffBlock.tsx`
- 创建：`electron-agent/src/features/tools/FileDiffBlock.test.tsx`
- 创建：`electron-agent/src/features/tools/FileReadBlock.tsx`
- 测试：同上，读取块的断言写在 `FileDiffBlock.test.tsx` 里即可，或另建 `FileReadBlock.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileDiffBlock } from './FileDiffBlock';
import { FileReadBlock } from './FileReadBlock';
import type { DiffRow } from './fileDiffModel';

afterEach(cleanup);

const many: DiffRow[] = Array.from({ length: 20 }, (_, i) => ({ marker: '+' as const, text: `L${i}` }));

describe('FileDiffBlock', () => {
  it('does not render the path, and copies +/- text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<FileDiffBlock path="secret.txt" rows={[{ marker: '+', text: 'hello' }]} added={1} deleted={0} />);
    expect(screen.queryByText('secret.txt')).toBeNull();
    expect(screen.getByTestId('file-diff-block').textContent).toContain('+ hello');
    expect(screen.getByText('+1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith('+ hello');
  });

  it('folds the middle when there are more than 16 lines', () => {
    render(<FileDiffBlock path="a.txt" rows={many} added={20} deleted={0} />);
    expect(screen.getByText('+ L0')).toBeTruthy();
    expect(screen.queryByText('+ L10')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /展开/ }));
    expect(screen.getByText('+ L10')).toBeTruthy();
  });
});

describe('FileReadBlock', () => {
  it('shows line numbers without the filename', () => {
    render(<FileReadBlock path="note.txt" text={'alpha\nbeta'} />);
    expect(screen.queryByText('note.txt')).toBeNull();
    expect(screen.getByTestId('file-read-block').textContent).toMatch(/1\s*alpha/);
    expect(screen.getByTestId('file-read-block').textContent).toMatch(/2\s*beta/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/tools/FileDiffBlock.test.tsx
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：编写最少实现代码**

`FileDiffBlock.tsx`：

- `CHAT_DIFF_MAX_LINES = 16`，折叠时头 6 + 尾 6。
- 顶栏右对齐「复制」；行用 `+ ` / `- ` / 两个空格；`+` 绿、`-` 红（`cssVar.colorSuccess` / `colorError`）。
- `data-testid="file-diff-block"`。
- 底栏：`+{added} -{deleted} · 1 个文件`。
- 复制：`rows.map(r => `${r.marker === ' ' ? ' ' : r.marker} ${r.text}`).join('\n')`。失败吞掉。
- **不要渲染 path。** path 只留在 props 里给审查「打开文件」用，本块不用。

`FileReadBlock.tsx`：

- 无 path 文本。行号 + 正文。`data-testid="file-read-block"`。
- 复制 `text` 原文。空 text 不渲染（返回 null）。

样式用 `createStaticStyles` + `cssVar`，不要 emoji，不要 lobehub Highlighter。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/tools/FileDiffBlock.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

---

### 任务 3：ToolExecution 接上新块

**文件：**
- 修改：`electron-agent/src/features/tools/ToolExecution.tsx`
- 修改：`electron-agent/src/features/tools/ToolExecution.test.tsx`
- 删除：`electron-agent/src/features/tools/EditPreview.tsx`
- 删除：`electron-agent/src/features/tools/EditPreview.test.tsx`

- [ ] **步骤 1：先改失败的旧断言，并补新测试**

把 `supports the edits array schema and shows only the filename` 改成：

```ts
  it('shows the Chinese verb and filename only on the title row', () => {
    wrap(
      <ToolExecution
        toolName="edit"
        args={{ path: 'D:/workspace/GeminiProvider.ts', edits: [{ oldText: 'old', newText: 'new' }] }}
        result={{ details: { diff: ' 1 old\n-2 old\n+2 new\n 3 next' }, content: [] }}
        status="done"
      />,
    );
    expect(screen.getByText('编辑')).toBeTruthy();
    expect(screen.getAllByText('GeminiProvider.ts')).toHaveLength(1);
    fireEvent.click(screen.getByText('编辑'));
    expect(screen.getAllByText('GeminiProvider.ts')).toHaveLength(1);
    expect(screen.getByTestId('file-diff-block').textContent).toContain('new');
  });
```

追加：

```ts
  it('streams write additions from growing args', () => {
    const { rerender } = wrap(
      <ToolExecution toolName="write" args={{ path: 'a.txt', content: 'a' }} result={{}} status="running" />,
    );
    expect(screen.getByText('写入')).toBeTruthy();
    expect(screen.getByTestId('file-diff-block').textContent).toContain('+ a');
    rerender(
      <ThemeProvider themeMode="dark">
        <ToolExecution toolName="write" args={{ path: 'a.txt', content: 'a\nb' }} result={{}} status="running" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('file-diff-block').textContent).toContain('+ b');
  });

  it('does not show read body while running without result text', () => {
    wrap(<ToolExecution toolName="read" args={{ path: 'a.txt' }} result={{}} status="running" />);
    expect(screen.getByText('读取')).toBeTruthy();
    expect(screen.queryByTestId('file-read-block')).toBeNull();
  });

  it('renders present as a single row', () => {
    wrap(
      <ToolExecution
        toolName="present"
        args={{ files: [{ path: 'a.txt', description: 'demo' }] }}
        result={{ details: { files: [{ path: 'a.txt', description: 'demo' }] } }}
        status="done"
      />,
    );
    expect(screen.getByText('交付文件')).toBeTruthy();
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(screen.queryByTestId('file-diff-block')).toBeNull();
  });
```

无改动的 identical-content 测试：点击目标从 `edit` 改成 `编辑`。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/tools/ToolExecution.test.tsx
```

预期：FAIL，标题仍是 `edit` / `write`，展开体还有 pathLabel。

- [ ] **步骤 3：改 ToolExecution**

1. `toolTitle`：在 skill / search 等特殊分支之后、bash 之前：

```ts
  const verb = fileCardVerb(toolName);
  if (verb && !skillNameFromRead(toolName, args)) {
    const path = mutationPath(args);
    const diff = verb === '读取' ? null : fileDiffModel(toolName, args, result, status);
    return {
      icon,
      name: verb,
      args: path ? fileNameFromPath(path) : undefined,
      meta: diff ? <DiffMeta added={diff.added} deleted={diff.deleted} /> : undefined,
    };
  }
  if (lname === 'present') {
    const files = presentedFiles(args, result);
    const label = files[0] ? fileNameFromPath(files[0].path) : undefined;
    return {
      icon: FilePlus,
      name: status === 'error' ? '交付失败' : '交付文件',
      args: status === 'running' ? '正在交付' : files.length > 1 ? `${files.length} 个文件` : label,
    };
  }
```

`toolTitle` 现在只返回 `{ icon, name, args }`。`ConvRow` 已有 `meta`。把 `toolTitle` 扩成可带 `meta?: ReactNode`，`ToolExecutionInner` 传给 `ConvRow`。

`DiffMeta`：

```tsx
function DiffMeta({ added, deleted }: { added: number; deleted: number }) {
  return (
    <>
      <span style={{ color: cssVar.colorSuccess }}>+{added}</span>{' '}
      <span style={{ color: cssVar.colorError }}>-{deleted}</span>
    </>
  );
}
```

2. `ToolDetail`：删掉 read/write 的 `pathLabel` 和 `LazyHighlighter` / `EditPreview`。

```tsx
  if (isFileRead(name)) {
    const text = extractText(result);
    if (!text) return status === 'running' ? null : <TerminalOutput text={stringifyJson(result)} isError={isError} />;
    return <FileReadBlock path={mutationPath(args)} text={text} />;
  }
  if (isFileMutation(name)) {
    const diff = fileDiffModel(toolName, args, result, status);
    if (!diff) {
      return text || isError ? <TerminalOutput text={text || stringifyJson(result)} isError={isError} /> : null;
    }
    return <FileDiffBlock path={diff.path} rows={diff.rows} added={diff.added} deleted={diff.deleted} />;
  }
```

3. `present`：在 `ToolExecutionInner` 里与 `todo` 一样只渲染 `ConvRow`，不给 `body`。

4. 删除 `EditPreview` 两文件。全局搜 `EditPreview`，只剩 ToolExecution 的 import 要去掉。

`presentedFiles`：优先 `getDetails(result)?.files`，否则 `args.files`。每项 `{ path: string, description?: string }`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/tools/ToolExecution.test.tsx src/features/tools/EditPreview.test.tsx src/features/tools/FileDiffBlock.test.tsx
```

预期：`EditPreview.test.tsx` 因文件已删而不被收集；其余 PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

---

### 任务 4：present 扩展

**文件：**
- 创建：`extensions/present/package.json`
- 创建：`extensions/present/present.ts`
- 创建：`extensions/present/present.test.ts`
- 创建：`extensions/present/index.ts`
- 修改：`extensions/index.ts`
- 修改：`cli/src/extension-profile.ts`
- 修改：`docs/architecture.md`（内置扩展表，`todo` 下行加 `present`）

- [ ] **步骤 1：编写失败的测试**

`present.test.ts`：用 `fs.mkdtempSync` 建临时目录，写一个普通文件。

```ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { presentFiles } from './present.ts';

let cwd = '';
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

function workspace() {
  cwd = mkdtempSync(join(tmpdir(), 'present-'));
  writeFileSync(join(cwd, 'ok.txt'), 'x');
  mkdirSync(join(cwd, 'dir'));
  return cwd;
}

describe('presentFiles', () => {
  it('accepts 1-8 existing workspace files and keeps the model path', () => {
    const root = workspace();
    const out = presentFiles(root, [{ path: 'ok.txt', description: 'demo' }]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.files).toEqual([{ path: 'ok.txt', description: 'demo' }]);
  });

  it('rejects missing, directory, escape, empty, and overflow', () => {
    const root = workspace();
    expect(presentFiles(root, [{ path: 'missing.txt' }]).ok).toBe(false);
    expect(presentFiles(root, [{ path: 'dir' }]).ok).toBe(false);
    expect(presentFiles(root, [{ path: '../outside.txt' }]).ok).toBe(false);
    expect(presentFiles(root, []).ok).toBe(false);
    expect(presentFiles(root, Array.from({ length: 9 }, (_, i) => ({ path: 'ok.txt', description: String(i) }))).ok).toBe(false);
    expect(presentFiles(root, [{ path: '   ' }]).ok).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions\present"; npx vitest run
```

预期：FAIL，模块不存在。若目录还没有 `package.json`，先写下第一步的文件再跑。

- [ ] **步骤 3：实现并挂载**

`present.ts`：

```ts
import { statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export interface PresentFile { path: string; description?: string }
export type PresentResult =
  | { ok: true; files: PresentFile[] }
  | { ok: false; error: string };

const MAX = 8;

function underCwd(path: string, cwd: string): boolean {
  const base = resolve(cwd);
  const target = resolve(cwd, path);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

export function presentFiles(cwd: string, files: PresentFile[]): PresentResult {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX) {
    return { ok: false, error: `present accepts 1 to ${MAX} files` };
  }
  const out: PresentFile[] = [];
  for (const file of files) {
    const path = typeof file.path === 'string' ? file.path.trim() : '';
    if (!path) return { ok: false, error: 'present requires a non-empty file path' };
    if (!underCwd(path, cwd) || (isAbsolute(path) && !underCwd(path, cwd))) {
      return { ok: false, error: `Cannot present ${file.path}: outside workspace` };
    }
    const abs = resolve(cwd, path);
    try {
      const info = statSync(abs);
      if (!info.isFile()) return { ok: false, error: `Cannot present ${file.path}: not a regular file` };
    } catch {
      return { ok: false, error: `Cannot present ${file.path}: file not found` };
    }
    out.push({
      path: file.path,
      ...(typeof file.description === 'string' ? { description: file.description } : {}),
    });
  }
  return { ok: true, files: out };
}
```

`index.ts`：照 `extensions/todo/index.ts` 注册。`execute` 调 `presentFiles(ctx.cwd, params.files)`；失败 `isError: true` 且不要 `details.files`；成功：

```ts
return {
  content: [{ type: 'text', text: result.files.map((f) => `Presented ${f.path}`).join('\n') }],
  details: { files: result.files },
};
```

description / promptGuidelines 用规格第 5 节原文（英文工具描述即可，与其它扩展一致）。

`package.json` 复制 `extensions/todo/package.json`，name 改 `pi-present`，`pi.extensions` 指向 `./index.ts`。

`extensions/index.ts`：`import present from "./present/index.js"`，放进 `export`、`allExtensions`、`namedExtensions`（紧挨 `todo`）。

`cli/src/extension-profile.ts`：`CORE_ALWAYS_ON` 加 `"present"`。

`docs/architecture.md` 表加：`present` | 把已有文件声明为本轮产物 | `present`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions\present"; npx vitest run
cd "D:\OneDrive\Project Files\Pi\cli"; npm test -- src/agent-data-plugins.test.ts src/extension-profile.test.ts
```

预期：PASS。`agent-data-plugins` 的「unmanaged 必须 core 或 excluded」在 `present` 进 `CORE_ALWAYS_ON` 后才会过。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

---

### 任务 5：turnDeliverables

**文件：**
- 创建：`electron-agent/src/features/chat/turnDeliverables.ts`
- 测试：`electron-agent/src/features/chat/turnDeliverables.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import type { TimelineSegment } from './groupMessages';
import {
  changesForTurn,
  presentedForTurn,
  resolveWorkspaceFile,
  turnSettled,
} from './turnDeliverables';

const write: TimelineSegment = {
  kind: 'tool', id: 'w', toolCallId: 'w1', toolName: 'write',
  args: { path: 'a.txt', content: 'one\ntwo' }, result: { content: [] }, status: 'done',
};
const edit: TimelineSegment = {
  kind: 'tool', id: 'e', toolCallId: 'e1', toolName: 'edit',
  args: { path: 'a.txt', old_string: 'two', new_string: 'TWO\nthree' }, result: { content: [] }, status: 'done',
};
const read: TimelineSegment = {
  kind: 'tool', id: 'r', toolCallId: 'r1', toolName: 'read',
  args: { path: 'a.txt' }, result: { content: [{ type: 'text', text: 'one' }] }, status: 'done',
};
const failed: TimelineSegment = {
  kind: 'tool', id: 'f', toolCallId: 'f1', toolName: 'write',
  args: { path: 'b.txt', content: 'x' }, result: { content: [{ type: 'text', text: 'denied' }] }, status: 'error',
};
const present: TimelineSegment = {
  kind: 'tool', id: 'p', toolCallId: 'p1', toolName: 'present',
  args: { files: [{ path: 'a.txt', description: 'first' }] },
  result: { details: { files: [{ path: 'a.txt', description: 'final note' }] } },
  status: 'done',
};

describe('turnDeliverables', () => {
  it('is unsettled while a tool is running or text is streaming', () => {
    expect(turnSettled([write, { ...edit, status: 'running' }])).toBe(false);
    expect(turnSettled([{ kind: 'text', id: 't', content: 'hi', streaming: true }])).toBe(false);
    expect(turnSettled([write, { kind: 'text', id: 't', content: 'hi', streaming: false }])).toBe(true);
  });

  it('merges write+edit on the same path and ignores read/error', () => {
    const files = changesForTurn([write, read, failed, edit]);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('a.txt');
    expect(files[0]?.display).toBe('a.txt');
    expect(files[0]?.added).toBeGreaterThan(0);
    expect(files[0]?.deleted).toBeGreaterThan(0);
  });

  it('takes the last present description per path', () => {
    const second: TimelineSegment = {
      ...present,
      id: 'p2',
      toolCallId: 'p2',
      result: { details: { files: [{ path: 'a.txt', description: 'override' }, { path: 'b.txt' }] } },
    };
    expect(presentedForTurn([present, second])).toEqual([
      { path: 'a.txt', display: 'a.txt', description: 'override' },
      { path: 'b.txt', display: 'b.txt' },
    ]);
  });

  it('resolves workspace-relative files and rejects escapes', () => {
    expect(resolveWorkspaceFile('D:/ws', 'a.txt')?.replace(/\\/g, '/')).toMatch(/\/a\.txt$/);
    expect(resolveWorkspaceFile('D:/ws', '../secret.txt')).toBeNull();
    expect(resolveWorkspaceFile('D:/ws', 'D:/ws/a.txt')?.replace(/\\/g, '/')).toMatch(/\/a\.txt$/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/turnDeliverables.test.ts
```

预期：FAIL。

- [ ] **步骤 3：实现**

```ts
import { fileNameFromPath, getDetails } from '../tools/toolUtils';
import { fileDiffModel, isFileMutation, mutationPath } from '../tools/fileDiffModel';
import type { TimelineSegment } from './groupMessages';

export interface ChangeFile { path: string; display: string; added: number; deleted: number }
export interface PresentedFile { path: string; display: string; description?: string }

export function turnSettled(segments: TimelineSegment[]): boolean {
  return segments.every((segment) => {
    if (segment.kind === 'tool') return segment.status !== 'running';
    if (segment.kind === 'text' || segment.kind === 'thinking') return !segment.streaming;
    return true;
  });
}

export function changesForTurn(segments: TimelineSegment[]): ChangeFile[] {
  const files: ChangeFile[] = [];
  const index = new Map<string, number>();
  for (const segment of segments) {
    if (segment.kind !== 'tool' || segment.status !== 'done' || !isFileMutation(segment.toolName)) continue;
    const path = mutationPath(segment.args);
    const diff = fileDiffModel(segment.toolName, segment.args, segment.result, segment.status);
    if (!path || !diff) continue;
    const existing = index.get(path);
    if (existing === undefined) {
      index.set(path, files.length);
      files.push({ path, display: fileNameFromPath(path), added: diff.added, deleted: diff.deleted });
    } else {
      files[existing].added += diff.added;
      files[existing].deleted += diff.deleted;
    }
  }
  return files;
}

function asPresentFiles(value: unknown): Array<{ path: string; description?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const path = (item as { path?: unknown }).path;
    if (typeof path !== 'string' || !path.trim()) return [];
    const description = (item as { description?: unknown }).description;
    return [{ path, ...(typeof description === 'string' ? { description } : {}) }];
  });
}

export function presentedForTurn(segments: TimelineSegment[]): PresentedFile[] {
  const files: PresentedFile[] = [];
  const index = new Map<string, number>();
  for (const segment of segments) {
    if (segment.kind !== 'tool' || segment.toolName.toLowerCase() !== 'present' || segment.status !== 'done') continue;
    const details = getDetails(segment.result);
    for (const file of asPresentFiles(details?.files)) {
      const next = { path: file.path, display: fileNameFromPath(file.path), ...(file.description ? { description: file.description } : {}) };
      const existing = index.get(file.path);
      if (existing === undefined) {
        index.set(file.path, files.length);
        files.push(next);
      } else {
        files[existing] = { ...files[existing], ...next };
      }
    }
  }
  return files;
}

export function resolveWorkspaceFile(cwd: string, path: string): string | null {
  const raw = path.trim();
  if (!cwd.trim() || !raw) return null;
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const abs = /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(raw)
    ? raw.replace(/\\/g, '/')
    : `${root}/${raw.replace(/^[\\/]+/, '').replace(/\\/g, '/')}`;
  const normalized = abs.replace(/\/+/g, '/');
  const lower = normalized.toLowerCase();
  const rootLower = root.toLowerCase();
  if (lower !== rootLower && !lower.startsWith(`${rootLower}/`)) return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}
```

Windows 绝对路径测试用 `D:/ws`；`resolveWorkspaceFile` 不要调用 Node `path`（渲染进程测试在 jsdom）。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/turnDeliverables.test.ts
```

预期：PASS。若 write+edit 的 deleted 为 0，检查 `rowsFromTexts('two','TWO\nthree')` 是否产出 `-` 行；不过就修测试为 `deleted >= 0` **不行**，必须断言 `deleted === 1`（`two` 被换掉）。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

---

### 任务 6：TurnTail 挂到主对话

**文件：**
- 创建：`electron-agent/src/features/chat/TurnTail.tsx`
- 创建：`electron-agent/src/features/chat/TurnTail.test.tsx`
- 修改：`electron-agent/src/features/chat/TurnTimeline.tsx`
- 修改：`electron-agent/src/features/chat/TurnTimeline.test.tsx`
- 修改：`electron-agent/src/features/chat/ChatMessageItems.tsx`
- 修改：`electron-agent/src/features/chat/ChatListView.tsx`

- [ ] **步骤 1：编写失败的测试**

`TurnTail.test.tsx`：

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const openTurnReview = vi.fn();
const openPath = vi.fn();
const revealItemInDir = vi.fn();
vi.mock('../dock/openLauncherTab', () => ({ openTurnReview }));
vi.mock('../../platform/runtime', () => ({ openPath, revealItemInDir }));

import { TurnTail } from './TurnTail';

afterEach(() => {
  cleanup();
  openTurnReview.mockReset();
  openPath.mockReset();
  revealItemInDir.mockReset();
});

const changes = [
  { path: 'a.txt', display: 'a.txt', added: 6, deleted: 0 },
  { path: 'b.txt', display: 'b.txt', added: 1, deleted: 1 },
  { path: 'c.txt', display: 'c.txt', added: 0, deleted: 2 },
  { path: 'd.txt', display: 'd.txt', added: 1, deleted: 0 },
];

describe('TurnTail', () => {
  it('opens review with the original file index', () => {
    render(
      <TurnTail
        turnId="turn-1"
        workspace="D:/ws"
        changes={changes}
        presented={[{ path: 'a.txt', display: 'a.txt', description: '文件读写测试' }]}
      />,
    );
    expect(screen.getByText('已编辑 4 个文件')).toBeTruthy();
    expect(screen.queryByText('d.txt')).toBeNull();
    fireEvent.click(screen.getByText('全部 4 个文件'));
    fireEvent.click(screen.getByText('c.txt'));
    expect(openTurnReview).toHaveBeenCalledWith({ turnId: 'turn-1', fileIndex: 2, workspace: 'D:/ws' });
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(openPath).toHaveBeenCalled();
  });
});
```

`TurnTimeline.test.tsx` 追加：`showDeliverables` + 成功 write 的 settled turn 出现「已编辑」；默认不传时不出现。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/TurnTail.test.tsx src/features/chat/TurnTimeline.test.tsx
```

预期：FAIL。

- [ ] **步骤 3：实现**

`TurnTail.tsx`：

- 已编辑：超过 3 行折叠。点标题 `fileIndex: 0`，点行用**原始**下标。`data-testid="turn-changes"`。
- 产物：超过 4 张折叠。卡片 `data-testid="presented-file"`。描述没有则用扩展名大写或「文件」。
- 「打开」调用 `openPath(resolveWorkspaceFile(workspace, path) ?? '')`；解析失败不调用，描述改「没有可用的主机路径」。
- 下拉一项：Windows「在文件资源管理器中显示」，`darwin`「在 Finder 中显示」，其它「打开所在文件夹」。用 `navigator.userAgent` 判断即可。
- 点卡片空白 = 打开。下拉 `stopPropagation`。
- `openPath` / `revealItemInDir` reject 时把该卡描述换成「打开失败，点击重试」。

`TurnTimeline`：

```ts
interface TurnTimelineProps {
  segments: TimelineSegment[];
  timestamp?: number;
  showDeliverables?: boolean;
}
```

`renderTurn` 增加 `showDeliverables` 和 `turnId`（用 `segments` 所属 turn 的 id）。`TurnTimeline` 自己没有 turn id。把 `turnId` 也做成 prop：`ChatMessageItems` 里 `msg.kind==='turn'` 时传 `turnId={msg.id}`。

```tsx
{showDeliverables && turnId && turnSettled(segments) ? (
  <TurnTail
    turnId={turnId}
    workspace={workspaceFromContext}
    changes={changesForTurn(segments)}
    presented={presentedForTurn(segments)}
  />
) : null}
```

`TurnTail` 在 changes/presented 都空时返回 null。workspace 用 `useOptionalAgentStoreContext()?.workspace ?? ''`。

`ChatMessageItems`：加 `showDeliverables?: boolean`，`renderMessageBody(..., showDeliverables)`，turn 分支：

```tsx
<TurnTimeline
  segments={msg.segments}
  timestamp={msg.timestamp}
  turnId={msg.id}
  showDeliverables={showDeliverables}
/>
```

`ChatListView`：`<ChatMessageItems ... showDeliverables />`。子代理那两处不传。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/TurnTail.test.tsx src/features/chat/TurnTimeline.test.tsx src/features/chat/ChatMessageItems.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

---

### 任务 7：openTurnReview

**文件：**
- 修改：`electron-agent/src/stores/dockStore.ts`（只改 `ReviewPayload` 类型）
- 修改：`electron-agent/src/features/dock/openLauncherTab.ts`
- 修改：`electron-agent/src/features/dock/openLauncherTab.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `openLauncherTab.test.ts` 追加：

```ts
import { openTurnReview } from './openLauncherTab';

  it('openTurnReview reuses the right review tab and writes the turn', () => {
    openLauncherTab({ region: 'right', kind: 'review', workspace: '/repo' });
    openTurnReview({ turnId: 'turn-1', fileIndex: 2, workspace: '/repo' });
    const tabs = useDockStore.getState().tabs.filter((t) => t.kind === 'review');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.region).toBe('right');
    expect(tabs[0]?.payload).toMatchObject({ turnId: 'turn-1', fileIndex: 2, workspace: '/repo' });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('openTurnReview creates a right review tab when none exists', () => {
    openTurnReview({ turnId: 't', fileIndex: 0, workspace: '/ws' });
    expect(useDockStore.getState().tabs.map((t) => t.kind)).toEqual(['review']);
    expect(useDockStore.getState().tabs[0]?.region).toBe('right');
  });
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/openLauncherTab.test.ts
```

预期：FAIL，`openTurnReview` 未导出。

- [ ] **步骤 3：实现**

`ReviewPayload`：

```ts
export interface ReviewPayload {
  workspace?: string;
  turnId?: string;
  fileIndex?: number;
}
```

`openTurnReview`：

```ts
export function openTurnReview(input: { turnId: string; fileIndex: number; workspace?: string }): void {
  const region = 'right';
  const payload: ReviewPayload = {
    workspace: input.workspace,
    turnId: input.turnId,
    fileIndex: input.fileIndex,
  };
  const existing = useDockStore.getState().tabs.find((t) => t.region === region && t.kind === 'review');
  if (existing) {
    useDockStore.getState().updateTab(existing.id, { payload });
    useDockStore.getState().setActive(region, existing.id);
    useLayoutStore.getState().setRightPanelOpen(true);
    return;
  }
  useDockStore.getState().addTab({
    id: uniqueId(reviewTabId(region)),
    kind: 'review',
    region,
    title: '审查',
    closable: true,
    payload,
  });
}
```

`addTab` 已经会 `revealRegion`。不要调用 `canOpenLauncherKind`。通路空开审查仍走现有 `openLauncherTab`，不写 turnId。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/openLauncherTab.test.ts src/stores/dockStore.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

---

### 任务 8：TurnReviewBody 替换占位

**文件：**
- 创建：`electron-agent/src/features/chat/reviewView.ts`
- 创建：`electron-agent/src/features/chat/reviewView.test.ts`
- 创建：`electron-agent/src/features/dock/TurnReviewBody.tsx`
- 创建：`electron-agent/src/features/dock/TurnReviewBody.test.tsx`
- 修改：`electron-agent/src/features/dock/TabBodyRenderer.tsx`
- 删除：`electron-agent/src/features/dock/ReviewPlaceholderBody.tsx`
- 删除：`electron-agent/src/features/dock/ReviewPlaceholderBody.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`reviewView.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/agentReducer';
import { reviewView } from './reviewView';

const messages: ChatMessage[] = [
  { kind: 'assistant', id: 'turn-1', text: 'done', thinking: '', streaming: false },
  {
    kind: 'tool', id: 'w', toolCallId: 'w1', toolName: 'write',
    args: { path: 'a.txt', content: 'hello' }, result: { content: [] }, status: 'done',
  },
];

describe('reviewView', () => {
  it('returns empty without turnId', () => {
    expect(reviewView(messages, {}).kind).toBe('empty');
  });
  it('returns missing when the turn is gone', () => {
    expect(reviewView(messages, { turnId: 'nope' }).kind).toBe('missing');
  });
  it('returns ready hunks for the selected file', () => {
    const view = reviewView(messages, { turnId: 'turn-1', fileIndex: 0 });
    expect(view.kind).toBe('ready');
    if (view.kind !== 'ready') return;
    expect(view.files[0]?.display).toBe('a.txt');
    expect(view.hunks[0]?.rows.some((row) => row.text === 'hello')).toBe(true);
  });
});
```

`TurnReviewBody.test.tsx`：mock `useAgentStoreContext` 给出带上面 messages 的 store；空 payload 显示「从对话里的已编辑进来，查看本轮改动。」；带 turnId 列出文件。点第二行后 `file-diff-block` 换成该文件（造两条 write）。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/reviewView.test.ts src/features/dock/TurnReviewBody.test.tsx
```

预期：FAIL。

- [ ] **步骤 3：实现**

`reviewView.ts`：

```ts
export type ReviewKind = 'empty' | 'missing' | 'none' | 'unavailable' | 'ready';
export type ReviewView =
  | { kind: 'empty' }
  | { kind: 'missing' }
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; files: ChangeFile[]; selected: number; hunks: FileDiff[] };

export function reviewView(messages: ChatMessage[], payload: ReviewPayload): ReviewView {
  if (!payload.turnId) return { kind: 'empty' };
  const grouped = groupMessages(messages);
  const turn = grouped.find((item) => item.kind === 'turn' && item.id === payload.turnId);
  if (!turn || turn.kind !== 'turn') return { kind: 'missing' };
  const files = changesForTurn(turn.segments);
  if (files.length === 0) return { kind: 'none' };
  const selected = Math.min(Math.max(payload.fileIndex ?? 0, 0), files.length - 1);
  const path = files[selected].path;
  const hunks = turn.segments.flatMap((segment) => {
    if (segment.kind !== 'tool' || segment.status !== 'done') return [];
    const diff = fileDiffModel(segment.toolName, segment.args, segment.result, segment.status);
    return diff && mutationPath(segment.args) === path ? [diff] : [];
  });
  if (hunks.length === 0) return { kind: 'unavailable' };
  return { kind: 'ready', files, selected, hunks };
}
```

`TurnReviewBody`：

- 读 `tab.payload` + `useAgentStoreContext().store.useStore(s => s.messages)`。没有 AgentStore（preview）当 `empty`。
- empty：「从对话里的已编辑进来，查看本轮改动。」`data-testid="review-empty"`。
- missing / none / unavailable：规格第 7 节三句话。
- ready：工具条「本轮改动 · n 个文件」+「打开文件」（`openPath(resolveWorkspaceFile(workspace, files[selected].path))`）。列表点第 i 行：`updateTab(tab.id, { payload: { ...payload, fileIndex: i } })`。下方每一块 hunk 一个 `FileDiffBlock`。
- `data-testid="turn-review"`。

`TabBodyRenderer`：`review: TurnReviewBody`。删占位组件和测试。搜 `ReviewPlaceholderBody` / `review-placeholder`，测试改到新 testid。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/reviewView.test.ts src/features/dock/TurnReviewBody.test.tsx src/features/dock/ReviewPlaceholderBody.test.tsx src/features/tools/ToolExecution.test.tsx src/features/chat/turnDeliverables.test.ts src/features/dock/openLauncherTab.test.ts
```

预期：占位测试文件已删，不被收集；其余 PASS。再跑：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit -p tsconfig.json
```

预期：无 error。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

---

## 自检

**规格覆盖**

| 规格章节 | 任务 |
| --- | --- |
| §4 派生 / totals / 失败 null | 任务 1 |
| §4 FileDiffBlock、无文件名、折叠、复制 | 任务 2 |
| §4 标题动词、流式写入、读取等结果、删 EditPreview | 任务 3 |
| §5 present 工具与挂载 | 任务 4 |
| §6 changes / presented / settled / 路径 | 任务 5 |
| §6 TurnTail、主对话开关、折叠与点击 | 任务 6 |
| §7 openTurnReview / ReviewPayload | 任务 7 |
| §7 审查面板与占位替换 | 任务 8 |
| §8 错误表 | 1（identical/error）、3（无 body）、4（整次失败）、6（打开失败）、8（空态文案） |
| §9 测试清单 | 各任务步骤 1 |

**占位符：** 无 TODO /「适当处理」。`rowsFromTexts` 在任务 1 已写明 edit 传 string、write 传 null。

**类型一致：** `ChangeFile` / `PresentedFile` / `FileDiff` / `ReviewPayload.turnId` / `openTurnReview({ turnId, fileIndex, workspace })` / `showDeliverables` 前后任务同名。
