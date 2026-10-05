# 代码卡片外壳 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 写入、编辑、读取、检索共用一张圆角 `CodeCard`：顶栏有文件或语言图标且不折叠，正文是直角 diff 或高亮，横向滚动条只在鼠标放进代码区时出现。

**架构：** `codeLanguage.ts` 提供语言显示名和代表文件名。`CodeCard` 画外壳、顶栏和唯一的横向滚动口。`FileDiffBlock`、`FileReadBlock`、`GrepCard`、`CodeSearchCard` 把 lobe 的 diff / 高亮当成直角正文塞进去。`LazyHighlighter` / `LazyCodeDiff` 在模块未就绪时渲染空，顶栏不依赖它们。

**技术栈：** React、vitest、`@testing-library/react`、antd-style `createStaticStyles`、现有 `FileIcon`、`@lobehub/ui` 的 `CodeDiff` 与 `Highlighter`。

**规格：** `docs/superpowers/specs/2026-09-24-code-card-shell-design.md`

---

## 文件结构

- 修改 `electron-agent/src/features/tools/codeLanguage.ts`：语言显示名和代表文件名。
- 创建 `electron-agent/src/features/tools/codeLanguage.test.ts`：覆盖显示名、代表文件名、未知语言。
- 创建 `electron-agent/src/features/tools/CodeCard.tsx`：圆角外壳、顶栏、悬停才出现的横向滚动。
- 创建 `electron-agent/src/features/tools/CodeCard.test.tsx`：顶栏、计数、滚动样式约定。
- 修改 `electron-agent/src/features/tools/LazyHighlighter.tsx`：未就绪时不渲染纯文本。
- 修改 `electron-agent/src/features/tools/FileDiffBlock.tsx`：改用 `CodeCard`。
- 修改 `electron-agent/src/features/tools/FileReadBlock.tsx`：改用 `CodeCard`。
- 修改 `electron-agent/src/features/tools/SearchCards.tsx`：检索和 grep 改用 `CodeCard`。glob 不动。
- 修改 `electron-agent/src/features/tools/FileDiffBlock.test.tsx`：顶栏断言改到 `CodeCard`，读取内容改为等待高亮。
- 修改 `electron-agent/src/features/tools/SearchCards.test.tsx`：等待命中正文，并断言没有折叠按钮。

不改 `ToolExecution.tsx` 的外层折叠，不给 glob、命令输出、通用 JSON 套 `CodeCard`。通用 JSON 只跟着懒加载一起改成未就绪时为空。

工作目录：`electron-agent`。下面的 vitest 命令都在这个目录执行。

---

### 任务 1：语言显示名和代表文件名

**文件：**
- 修改：`electron-agent/src/features/tools/codeLanguage.ts`
- 测试：`electron-agent/src/features/tools/codeLanguage.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/src/features/tools/codeLanguage.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { languageFileName, languageFromPath, languageLabel } from './codeLanguage';

describe('languageLabel', () => {
  it('uses a readable name for a known language', () => {
    expect(languageLabel('typescript')).toBe('TypeScript');
  });

  it('returns the raw id for an unknown language', () => {
    expect(languageLabel('brainfuck')).toBe('brainfuck');
  });

  it('names every language id that languageFromPath can return', () => {
    const samples = ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.py', 'a.go', 'a.rs', 'a.java', 'a.css', 'a.scss', 'a.html', 'a.json', 'a.md', 'a.sh', 'a.ps1', 'a.sql', 'a.yml', 'a.toml', 'a.xml', 'a.vue', 'a.svelte', 'a.c', 'a.cpp', 'a.cs', 'a.txt'];
    for (const sample of samples) {
      const id = languageFromPath(sample);
      expect(languageLabel(id).length).toBeGreaterThan(0);
      expect(languageFileName(id).length).toBeGreaterThan(0);
    }
  });
});

describe('languageFileName', () => {
  it('picks a representative file for the icon', () => {
    expect(languageFileName('typescript')).toBe('file.ts');
  });

  it('uses a bare name for an unknown language so the icon stays generic', () => {
    expect(languageFileName('brainfuck')).toBe('file');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/tools/codeLanguage.test.ts`

预期：FAIL，`languageLabel` 未导出。

- [ ] **步骤 3：编写最少实现代码**

在 `codeLanguage.ts` 末尾追加：

```ts
const LANGUAGE_META: Record<string, { label: string; fileName: string }> = {
  bash: { label: 'Shell', fileName: 'file.sh' },
  c: { label: 'C', fileName: 'file.c' },
  cpp: { label: 'C++', fileName: 'file.cpp' },
  csharp: { label: 'C#', fileName: 'file.cs' },
  css: { label: 'CSS', fileName: 'file.css' },
  go: { label: 'Go', fileName: 'file.go' },
  html: { label: 'HTML', fileName: 'file.html' },
  java: { label: 'Java', fileName: 'file.java' },
  javascript: { label: 'JavaScript', fileName: 'file.js' },
  json: { label: 'JSON', fileName: 'file.json' },
  jsx: { label: 'JSX', fileName: 'file.jsx' },
  markdown: { label: 'Markdown', fileName: 'file.md' },
  powershell: { label: 'PowerShell', fileName: 'file.ps1' },
  python: { label: 'Python', fileName: 'file.py' },
  rust: { label: 'Rust', fileName: 'file.rs' },
  scss: { label: 'SCSS', fileName: 'file.scss' },
  sql: { label: 'SQL', fileName: 'file.sql' },
  svelte: { label: 'Svelte', fileName: 'file.svelte' },
  text: { label: 'Text', fileName: 'file.txt' },
  toml: { label: 'TOML', fileName: 'file.toml' },
  tsx: { label: 'TSX', fileName: 'file.tsx' },
  typescript: { label: 'TypeScript', fileName: 'file.ts' },
  vue: { label: 'Vue', fileName: 'file.vue' },
  xml: { label: 'XML', fileName: 'file.xml' },
  yaml: { label: 'YAML', fileName: 'file.yaml' },
};

export function languageLabel(language: string): string {
  return LANGUAGE_META[language]?.label ?? language;
}

export function languageFileName(language: string): string {
  return LANGUAGE_META[language]?.fileName ?? 'file';
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/tools/codeLanguage.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/tools/codeLanguage.ts electron-agent/src/features/tools/codeLanguage.test.ts
git commit -m "feat: name code card languages"
```

---

### 任务 2：CodeCard 外壳

**文件：**
- 创建：`electron-agent/src/features/tools/CodeCard.tsx`
- 测试：`electron-agent/src/features/tools/CodeCard.test.tsx`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/src/features/tools/CodeCard.test.tsx`：

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CodeCard } from './CodeCard';

afterEach(cleanup);

describe('CodeCard', () => {
  it('shows the file name and no collapse button', () => {
    render(
      <CodeCard fileName="secret.txt">
        <pre>hello</pre>
      </CodeCard>,
    );
    const header = screen.getByTestId('code-card-header');
    expect(screen.getByTestId('code-card-name').textContent).toBe('secret.txt');
    expect(header.querySelector('button')).toBeNull();
  });

  it('shows the language label instead of the icon file name', () => {
    render(
      <CodeCard language="typescript">
        <pre>const x = 1</pre>
      </CodeCard>,
    );
    expect(screen.getByTestId('code-card-name').textContent).toBe('TypeScript');
    expect(screen.getByTestId('code-card-header').textContent).not.toContain('file.ts');
  });

  it('hides stats when both counts are zero', () => {
    render(
      <CodeCard added={0} deleted={0} fileName="a.ts">
        <pre>x</pre>
      </CodeCard>,
    );
    expect(screen.queryByTestId('code-card-stats')).toBeNull();
  });

  it('shows non-zero stats on the right', () => {
    render(
      <CodeCard added={6} deleted={1} fileName="a.ts">
        <pre>x</pre>
      </CodeCard>,
    );
    const stats = screen.getByTestId('code-card-stats');
    expect(stats.textContent).toContain('+6');
    expect(stats.textContent).toContain('-1');
  });

  it('does not reserve a horizontal scrollbar until hover', () => {
    render(
      <CodeCard fileName="a.ts">
        <pre>short</pre>
      </CodeCard>,
    );
    const body = screen.getByTestId('code-card-body');
    const css = [...document.querySelectorAll('style')].map((node) => node.textContent ?? '').join('\n');
    expect(body.className.length).toBeGreaterThan(0);
    expect(css).toContain('scrollbar-width: none');
    expect(css).toContain('scrollbar-width: thin');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/tools/CodeCard.test.tsx`

预期：FAIL，找不到 `./CodeCard`。

- [ ] **步骤 3：编写最少实现代码**

创建 `electron-agent/src/features/tools/CodeCard.tsx`：

```tsx
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode } from 'react';
import FileIcon from '../../components/FileIcon';
import { languageFileName, languageLabel } from './codeLanguage';

const styles = createStaticStyles(({ css }) => ({
  shell: css`
    overflow: hidden;
    width: 100%;
    min-width: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    padding: 4px;
    border-block-end: 1px solid ${cssVar.colorFillQuaternary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  title: css`
    display: flex;
    flex: 1;
    gap: 4px;
    align-items: center;
    min-width: 0;
    padding-inline: 8px;
  `,
  name: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  stats: css`
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;
    padding-inline-end: 8px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  `,
  add: css`
    color: ${cssVar.colorSuccess};
  `,
  del: css`
    color: ${cssVar.colorError};
  `,
  body: css`
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      height: 0;
    }

    &:hover {
      scrollbar-width: thin;
    }

    &:hover::-webkit-scrollbar {
      height: 6px;
    }
  `,
  core: css`
    width: max-content;
    min-width: 100%;

    &,
    & * {
      border-radius: 0 !important;
      overflow: visible !important;
    }
  `,
}));

export const CodeCard = memo(function CodeCard({
  fileName,
  language,
  added = 0,
  deleted = 0,
  children,
}: {
  fileName?: string;
  language?: string;
  added?: number;
  deleted?: number;
  children: ReactNode;
}) {
  const title = fileName || (language ? languageLabel(language) : '');
  const iconName = fileName || (language ? languageFileName(language) : 'file');
  const showStats = added > 0 || deleted > 0;

  return (
    <div className={styles.shell} data-testid="code-card">
      <div className={styles.header} data-testid="code-card-header">
        <div className={styles.title}>
          <FileIcon fileName={iconName} size={18} variant="raw" />
          <span className={styles.name} data-testid="code-card-name">
            {title}
          </span>
        </div>
        {showStats ? (
          <div className={styles.stats} data-testid="code-card-stats">
            {deleted > 0 ? <span className={styles.del}>-{deleted}</span> : null}
            {added > 0 ? <span className={styles.add}>+{added}</span> : null}
          </div>
        ) : null}
      </div>
      <div className={styles.body} data-testid="code-card-body">
        <div className={styles.core}>{children}</div>
      </div>
    </div>
  );
});
```

测试按注入样式里的 `scrollbar-width: none` 和 `scrollbar-width: thin` 查找，写法要和上面的 CSS 一致。正文区是唯一横向滚动口。`overflow-y: hidden` 配合内容把高度撑开，避免 `overflow-x: auto` 把另一轴也变成滚动口后空出一条纵向槽。`.core *` 去掉内层圆角和内层滚动，短行不再被内层滚动条撑出横向条。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/tools/CodeCard.test.tsx`

预期：PASS。若样式被压缩后带空格，把测试里的 `scrollbar-width:none` / `scrollbar-width:thin` 改成实际注入的文本，两边保持一致后再跑一次。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/tools/CodeCard.tsx electron-agent/src/features/tools/CodeCard.test.tsx
git commit -m "feat: add the shared code card shell"
```

---

### 任务 3：懒加载未就绪时留空

**文件：**
- 修改：`electron-agent/src/features/tools/LazyHighlighter.tsx`
- 测试：`electron-agent/src/features/tools/FileDiffBlock.test.tsx`（读取用例在步骤 4 之后仍要能找到正文；本任务只改懒加载，不改断言）

- [ ] **步骤 1：改掉纯文本回退**

删除 `PlainFallback`。三处未就绪分支改为 `return null`：

```tsx
export function LazyHighlighter(props: HighlighterProps) {
  const ui = useLobeUi();
  if (!ui) return null;
  return <ui.Highlighter {...props} />;
}

export function LazySyntaxHighlighter(props: SyntaxHighlighterProps) {
  const ui = useLobeUi();
  if (!ui) return null;
  return <ui.SyntaxHighlighter {...props} />;
}

export function LazyCodeDiff(props: CodeDiffProps) {
  const ui = useLobeUi();
  if (!ui) return null;
  return <ui.CodeDiff {...props} />;
}
```

同时删掉不再使用的 `ReactNode` 类型导入。

- [ ] **步骤 2：运行现有卡片测试**

运行：`npx vitest run src/features/tools/FileDiffBlock.test.tsx src/features/tools/SearchCards.test.tsx`

预期：`FileDiffBlock` 里检查 `data-new-content` 的用例 PASS。`FileReadBlock` 的「立刻读到 alpha」可能 FAIL，因为正文要等模块加载。检索用例若仍用文件名等待，而文件名要等 Highlighter 顶栏，也可能变慢或失败。失败留到任务 5、任务 6 改断言，本任务不在这里修读取和检索的等待。

- [ ] **步骤 3：Commit**

```bash
git add electron-agent/src/features/tools/LazyHighlighter.tsx
git commit -m "fix: keep code cards blank until the highlighter loads"
```

---

### 任务 4：写入和编辑改用 CodeCard

**文件：**
- 修改：`electron-agent/src/features/tools/FileDiffBlock.tsx`
- 测试：`electron-agent/src/features/tools/FileDiffBlock.test.tsx`

- [ ] **步骤 1：改测试里的顶栏查询**

把 `keeps the file header and drops the inner collapse control` 改成查 `CodeCard`：

```tsx
  it('keeps the file header and drops the inner collapse control', () => {
    render(<FileDiffBlock path="secret.txt" rows={[{ marker: '+', text: 'hello' }]} added={1} deleted={0} />);
    expect(screen.getByTestId('code-card-name').textContent).toBe('secret.txt');
    expect(screen.getByTestId('code-card-stats').textContent).toContain('+1');
    expect(screen.getByTestId('code-card-header').querySelector('button')).toBeNull();
  });
```

其余三个 `FileDiffBlock` 用例不动。它们只看 `data-new-content` / `data-old-content`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/tools/FileDiffBlock.test.tsx`

预期：FAIL，`code-card-name` 不存在（当前顶栏是 `file-diff-header`）。

- [ ] **步骤 3：编写最少实现代码**

用下面整文件替换 `FileDiffBlock.tsx`。换行辅助函数保持原样。删掉本地顶栏样式。

```tsx
import { memo, useMemo } from 'react';
import type { DiffRow } from './fileDiffModel';
import { languageFromPath } from './codeLanguage';
import { LazyCodeDiff } from './LazyHighlighter';
import { CodeCard } from './CodeCard';

function withTrailingNewline(text: string): string {
  if (!text || text.endsWith('\n')) return text;
  return `${text}\n`;
}

function textsFromRows(rows: DiffRow[]): { oldContent: string; newContent: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const row of rows) {
    if (row.marker !== '+') oldLines.push(row.text);
    if (row.marker !== '-') newLines.push(row.text);
  }
  return {
    oldContent: withTrailingNewline(oldLines.join('\n')),
    newContent: withTrailingNewline(newLines.join('\n')),
  };
}

export const FileDiffBlock = memo(function FileDiffBlock({
  path,
  rows,
  added,
  deleted,
}: {
  path: string;
  rows: DiffRow[];
  added: number;
  deleted: number;
}) {
  const { oldContent, newContent } = useMemo(() => textsFromRows(rows), [rows]);
  const fileName = path.split(/[/\\]/).pop() || path;

  return (
    <div
      data-new-content={newContent}
      data-old-content={oldContent}
      data-testid="file-diff-block"
      style={{
        width: '100%',
        minWidth: 0,
        ['--diffs-font-family' as string]: 'var(--pi-font-mono)',
        ['--diffs-header-font-family' as string]: 'var(--pi-font-sans)',
      }}
    >
      <CodeCard added={added} deleted={deleted} fileName={fileName}>
        <LazyCodeDiff
          fileName={fileName}
          fullFeatured={false}
          language={languageFromPath(path)}
          newContent={newContent}
          oldContent={oldContent}
          showHeader={false}
          style={{ width: '100%' }}
          variant="borderless"
          viewMode="unified"
        />
      </CodeCard>
    </div>
  );
});
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/tools/FileDiffBlock.test.tsx`

预期：四个 `FileDiffBlock` 用例 PASS。`FileReadBlock` 用例若仍 FAIL，留到任务 5。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/tools/FileDiffBlock.tsx electron-agent/src/features/tools/FileDiffBlock.test.tsx
git commit -m "feat: put write and edit diffs in the code card"
```

---

### 任务 5：读取改用 CodeCard

**文件：**
- 修改：`electron-agent/src/features/tools/FileReadBlock.tsx`
- 测试：`electron-agent/src/features/tools/FileDiffBlock.test.tsx`

- [ ] **步骤 1：改读取测试**

把 `FileReadBlock` 的两个用例改成：

```tsx
describe('FileReadBlock', () => {
  it('shows the file name and the file text', async () => {
    render(<FileReadBlock path="note.txt" text={'alpha\nbeta'} />);
    expect(screen.getByTestId('code-card-name').textContent).toBe('note.txt');
    expect(screen.getByTestId('code-card-header').querySelector('button')).toBeNull();
    expect(await screen.findByText(/alpha/)).toBeTruthy();
    expect(screen.getByTestId('file-read-block').textContent).toContain('beta');
  });

  it('renders nothing when text is empty', () => {
    render(<FileReadBlock path="note.txt" text="" />);
    expect(screen.queryByTestId('file-read-block')).toBeNull();
  });
});
```

文件顶部的 import 增加 `waitFor` 不需要；`findByText` 已在 `screen` 上。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/tools/FileDiffBlock.test.tsx`

预期：FAIL，读取块还没有 `code-card-name`。

- [ ] **步骤 3：编写最少实现代码**

用下面整文件替换 `FileReadBlock.tsx`：

```tsx
import { memo } from 'react';
import { languageFromPath } from './codeLanguage';
import { LazyHighlighter } from './LazyHighlighter';
import { CodeCard } from './CodeCard';

const codeStyle = { fontFamily: 'var(--pi-font-mono)', fontSize: 13 } as const;

export const FileReadBlock = memo(function FileReadBlock({
  path,
  text,
}: {
  path: string;
  text: string;
}) {
  if (!text) return null;
  const fileName = path.split(/[/\\]/).pop() || path;
  return (
    <div data-testid="file-read-block" style={{ width: '100%', minWidth: 0 }}>
      <CodeCard fileName={fileName}>
        <LazyHighlighter
          copyable={false}
          language={languageFromPath(path)}
          showLanguage={false}
          variant="borderless"
          style={{ width: '100%' }}
          styles={{ content: codeStyle }}
        >
          {text}
        </LazyHighlighter>
      </CodeCard>
    </div>
  );
});
```

不传 `fullFeatured`，不传 `fileName` 给 Highlighter，避免它再画一层顶栏。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/tools/FileDiffBlock.test.tsx`

预期：PASS。`findByText(/alpha/)` 若因为 shiki 把单词拆开而失败，改成：

```tsx
await screen.findByText((_, node) => node?.textContent === 'alpha' || (node?.textContent?.includes('alpha') ?? false));
```

只保留能稳定匹配正文的那一种。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/tools/FileReadBlock.tsx electron-agent/src/features/tools/FileDiffBlock.test.tsx
git commit -m "feat: put file reads in the code card"
```

---

### 任务 6：检索和 grep 改用 CodeCard

**文件：**
- 修改：`electron-agent/src/features/tools/SearchCards.tsx`
- 测试：`electron-agent/src/features/tools/SearchCards.test.tsx`

- [ ] **步骤 1：改检索测试的等待和折叠断言**

`SearchCards.test.tsx` 顶部 import 增加 `waitFor`：

```tsx
import { cleanup, render, screen, waitFor } from '@testing-library/react';
```

`GrepCard` 的命中用例在现有 `expect(screen.getByText('b.ts'))` 之后加上：

```tsx
    await waitFor(() => {
      expect(container.textContent).toContain('const foo = 1');
      expect(container.textContent).toContain('foo()');
    });
    expect(screen.getAllByTestId('code-card-header').every((header) => header.querySelector('button') == null)).toBe(true);
```

删掉原来紧跟在 `getByText('b.ts')` 后面的两行 `container.textContent` 断言，避免文件名同步出现时正文还没挂上。

`CodeSearchCard` 的命中用例同样把内容断言放进 `waitFor`，并加上同一句「顶栏没有按钮」：

```tsx
    await waitFor(() => {
      expect(container.textContent).toContain('export function PddWorkbench');
    });
    expect(screen.getByTestId('code-card-header').querySelector('button')).toBeNull();
```

「未找到匹配」和失败原因的用例不要改，它们不该出现 `code-card`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/tools/SearchCards.test.tsx`

预期：FAIL，命中用例找不到 `code-card-header`。

- [ ] **步骤 3：编写最少实现代码**

在 `SearchCards.tsx` 里：

- import 增加 `CodeCard`，来自 `./CodeCard`。
- 删除 `styles.card`（只给旧 Highlighter 顶栏用）。
- `GrepCard` 和 `CodeSearchCard` 里每个文件的 `LazyHighlighter` 换成：

```tsx
          <CodeCard fileName={name} key={f.path}>
            <LazyHighlighter
              copyable={false}
              language={languageFromPath(f.path)}
              showLanguage={false}
              variant="borderless"
              style={{ width: '100%' }}
              styles={{ content: { fontFamily: 'var(--pi-font-mono)', fontSize: 13 } }}
            >
              {f.matches.map((m) => m.text).join('\n')}
            </LazyHighlighter>
          </CodeCard>
```

`key` 放在 `CodeCard` 上。不要传 `fullFeatured`。`GlobCard` 保持逐行文件列表，不套 `CodeCard`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/tools/SearchCards.test.tsx src/features/tools/FileDiffBlock.test.tsx src/features/tools/CodeCard.test.tsx src/features/tools/codeLanguage.test.ts`

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/tools/SearchCards.tsx electron-agent/src/features/tools/SearchCards.test.tsx
git commit -m "feat: put search hits in the code card"
```
