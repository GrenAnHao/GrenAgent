# 右坞 Codex 式快捷通路 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 某一侧坞没有 tab 时整栏变成快捷通路（项目四入口、普通对话两入口）；点哪一侧就在哪一侧开 tab；快捷键一律开右坞；最后一张 tab 关掉或被拖走则收起该侧坞，不回到通路；顶栏原终端图标改成底坞展开/收起。

**架构：** 纯函数 `launcherItems` / `canOpenLauncherKind` 决定条目；`openLauncherTab(region, kind)` 负责 new vs reuse；`DockPanel` 在 `tabs.length === 0` 时渲染 `DockLauncher`（无 TabStrip、无「暂无内容」）。`closeTab` / `moveTabRegion` 在源侧清零后写 `rightPanelOpen` / `terminalOpen = false`。拆掉 `dockStore` 与 `planDrop` 里「终端钉死底坞」的两处钉子。新 kind：`file`、`review`。

**技术栈：** TypeScript、React、antd-style、@lobehub/ui `Icon` / `ActionIcon`、lucide-react、zustand、react-hotkeys-hook、vitest + testing-library。只改 `electron-agent`。

**上游规格：** `docs/superpowers/specs/2026-09-14-right-dock-launcher-design.md`

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- **按编号顺序执行，不要跳序。** 任务 4 把 `DockTabKind` 扩成 `'file' | 'review'` 的同一 commit 必须改 `TabBodyRenderer`，否则 `Record<DockTabKind, …>` 编不过。
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。图标用 `@lobehub/ui` 的 `Icon` / `ActionIcon` + `lucide-react`。
- **不要改** `resetWorkspaceTabs` 的「曾经有终端则底栏留一张 idle」分支。不要改 `VisualPanel` 占用右坞的替换逻辑（`App.tsx` 里 `visualMode === 'panel'` 那一支）。不要改 `useKeyboardShortcuts.ts`（死代码，未挂载）；快捷键走新文件 `useDockLauncherHotkeys.ts`，在 `Workspace` 里挂一次。
- **不要给** `layoutStore` 加新字段。继续用 `rightPanelOpen` / `terminalOpen`。
- 普通对话口径与侧栏一致：`!cwd` → 普通对话；`worksDir && isUnder(cwd, worksDir)` → 普通对话；其余有 cwd → 项目。`isUnder` 从 `electron-agent/src/lib/pathUtils.ts` 导入，不要自己写路径比较。
- 通路行文案只有名称和快捷键，**不要**在通路行写「占位」。占位说明只出现在审查 tab 的 body。
- 浏览器 / 终端：每次 `addTab` 新 id（`browser-${Date.now()}` / `terminal-${Date.now()}`）。文件 / 审查：`file:${region}:${workspace}` / `review:${region}`，同 id 则 `setActive` 并展开该侧坞。
- 快捷键目标 region **永远是 `right`**。通路点击用 launcher 所在 `region`。
- Globe「打开浏览器」只出现在**已有 tab** 的右坞 strip；空态不要 Globe。底坞 `+` 只在已有 tab 的 strip。空态右坞仍需折叠按钮（顶栏 Panel 钮在右坞打开时会消失）。
- UI 以 vitest 为准，不要求点 Electron 真窗。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试>
```

涉及 `DockTabKind` / `BODY_RENDERERS` 的任务再加：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit
```

**提交：**

```powershell
git add <本任务文件>
git commit -m @"
feat(dock): <本任务一句话>

"@
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/features/dock/launcherItems.ts` | 普通对话 vs 项目的条目、禁用、快捷键是否生效 |
| `electron-agent/src/features/dock/launcherItems.test.ts` | 上表纯函数 |
| `electron-agent/src/features/dock/openLauncherTab.ts` | 按 kind 在指定 region new / reuse |
| `electron-agent/src/features/dock/openLauncherTab.test.ts` | region、new vs reuse |
| `electron-agent/src/features/dock/ReviewPlaceholderBody.tsx` | 审查 tab 占位文案 |
| `electron-agent/src/features/dock/ReviewPlaceholderBody.test.tsx` | testid + 文案 |
| `electron-agent/src/features/dock/FileTreeBody.tsx` | `files.getTree` 文件树；目录展开；失败重试 |
| `electron-agent/src/features/dock/FileTreeBody.test.tsx` | 成功 / 失败不收栏 |
| `electron-agent/src/features/dock/DockLauncher.tsx` | 空态通路列表 |
| `electron-agent/src/features/dock/DockLauncher.test.tsx` | 条目、点击、禁用 |
| `electron-agent/src/features/dock/DockPanel.test.tsx` | 空态通路 / 有 tab 才有 strip 与 Globe |
| `electron-agent/src/features/dock/useDockLauncherHotkeys.ts` | 四条快捷键 → 右坞 |
| `electron-agent/src/features/dock/useDockLauncherHotkeys.test.ts` | 项目 Ctrl+T；普通对话 Ctrl+P 忽略 |

修改：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/stores/dockStore.ts` | `'file' \| 'review'`、payload、拆钉、关尽收栏 |
| `electron-agent/src/stores/dockStore.test.ts` | 终端可进右坞；关尽 / 拖尽收栏 |
| `electron-agent/src/features/dock/dockDnd.ts` | 拆掉 `planDrop` 的终端钉 |
| `electron-agent/src/features/dock/dockDnd.test.ts` | 终端拖到右坞是 move，不是 null |
| `electron-agent/src/features/dock/TabBodyRenderer.tsx` | 挂 file / review body |
| `electron-agent/src/features/dock/dockTabStyles.ts` | 通路行样式 |
| `electron-agent/src/features/dock/DockPanel.tsx` | 空态 `DockLauncher`；Globe/Plus 仅有 tab 时 |
| `electron-agent/src/features/layout/MainColumnHeader.tsx` | `PanelBottom` + title「底栏」 |
| `electron-agent/src/features/layout/MainColumnHeader.test.tsx` | 底栏按钮只切 `terminalOpen` |
| `electron-agent/src/App.tsx` | `Workspace` 内调用 `useDockLauncherHotkeys()` |
| `docs/superpowers/specs/2026-09-14-right-dock-launcher-design.md` | 状态改为已落地（最后一任务） |

不改：`resetWorkspaceTabs` 的终端 idle 分支、`VisualPanel` 分支、`useKeyboardShortcuts.ts`、`layoutStore` 字段、`TabBodyStack` 的 emptyHint 参数（空态不再走到它）。

---

### 任务 1：`launcherItems` 纯函数

**文件：**
- 创建：`electron-agent/src/features/dock/launcherItems.ts`
- 测试：`electron-agent/src/features/dock/launcherItems.test.ts`

- [ ] **步骤 1：写失败测试**

`launcherItems.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { canOpenLauncherKind, isCasualSession, launcherItems } from './launcherItems';

describe('isCasualSession', () => {
  it('treats missing cwd as casual', () => {
    expect(isCasualSession(null, '/home/.pi/agent/works')).toBe(true);
    expect(isCasualSession('', '/home/.pi/agent/works')).toBe(true);
    expect(isCasualSession(undefined, '/home/.pi/agent/works')).toBe(true);
  });

  it('treats cwd under worksDir as casual', () => {
    expect(isCasualSession('/home/.pi/agent/works/u1', '/home/.pi/agent/works')).toBe(true);
  });

  it('treats a real project cwd as not casual', () => {
    expect(isCasualSession('/repo', '/home/.pi/agent/works')).toBe(false);
  });

  it('treats cwd with unknown worksDir as a project', () => {
    expect(isCasualSession('/repo', '')).toBe(false);
    expect(isCasualSession('/repo', null)).toBe(false);
  });
});

describe('launcherItems', () => {
  it('returns browser then terminal for a casual session', () => {
    const items = launcherItems({
      cwd: '/home/.pi/agent/works/u1',
      worksDir: '/home/.pi/agent/works',
      workspace: '/home/.pi/agent/works/u1',
    });
    expect(items.map((i) => i.kind)).toEqual(['browser', 'terminal']);
    expect(items.map((i) => i.label)).toEqual(['浏览器', '终端']);
    expect(items.map((i) => i.shortcut)).toEqual(['Ctrl+T', 'Ctrl+`']);
  });

  it('returns review, terminal, browser, file for a project session', () => {
    const items = launcherItems({
      cwd: '/repo',
      worksDir: '/home/.pi/agent/works',
      workspace: '/repo',
    });
    expect(items.map((i) => i.kind)).toEqual(['review', 'terminal', 'browser', 'file']);
    expect(items.map((i) => i.label)).toEqual(['审查', '终端', '浏览器', '文件']);
    expect(items.map((i) => i.shortcut)).toEqual(['Ctrl+Shift+G', 'Ctrl+`', 'Ctrl+T', 'Ctrl+P']);
    expect(items.find((i) => i.kind === 'file')?.disabled).toBe(false);
  });

  it('disables file when a project has no workspace', () => {
    const items = launcherItems({ cwd: '/repo', worksDir: '/home/.pi/agent/works', workspace: '' });
    expect(items.map((i) => i.kind)).toEqual(['review', 'terminal', 'browser', 'file']);
    expect(items.find((i) => i.kind === 'file')?.disabled).toBe(true);
  });
});

describe('canOpenLauncherKind', () => {
  const project = { cwd: '/repo', worksDir: '/home/.pi/agent/works', workspace: '/repo' };
  const casual = {
    cwd: '/home/.pi/agent/works/u1',
    worksDir: '/home/.pi/agent/works',
    workspace: '/home/.pi/agent/works/u1',
  };

  it('allows all four kinds in a project with workspace', () => {
    expect(canOpenLauncherKind('review', project)).toBe(true);
    expect(canOpenLauncherKind('file', project)).toBe(true);
    expect(canOpenLauncherKind('browser', project)).toBe(true);
    expect(canOpenLauncherKind('terminal', project)).toBe(true);
  });

  it('ignores review and file in a casual session', () => {
    expect(canOpenLauncherKind('review', casual)).toBe(false);
    expect(canOpenLauncherKind('file', casual)).toBe(false);
    expect(canOpenLauncherKind('browser', casual)).toBe(true);
    expect(canOpenLauncherKind('terminal', casual)).toBe(true);
  });

  it('ignores file when workspace is missing', () => {
    expect(canOpenLauncherKind('file', { ...project, workspace: '' })).toBe(false);
    expect(canOpenLauncherKind('review', { ...project, workspace: '' })).toBe(true);
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/launcherItems.test.ts
```

预期：FAIL，无法解析 `./launcherItems`。

- [ ] **步骤 3：写最少实现**

`launcherItems.ts`：

```ts
import { isUnder } from '../../lib/pathUtils';

export type LauncherKind = 'review' | 'terminal' | 'browser' | 'file';

export interface LauncherContext {
  cwd?: string | null;
  worksDir?: string | null;
  workspace?: string | null;
}

export interface LauncherItem {
  kind: LauncherKind;
  label: string;
  shortcut: string;
  disabled?: boolean;
}

export function isCasualSession(cwd: string | null | undefined, worksDir: string | null | undefined): boolean {
  if (!cwd) return true;
  return Boolean(worksDir && isUnder(cwd, worksDir));
}

export function launcherItems(ctx: LauncherContext): LauncherItem[] {
  if (isCasualSession(ctx.cwd, ctx.worksDir)) {
    return [
      { kind: 'browser', label: '浏览器', shortcut: 'Ctrl+T' },
      { kind: 'terminal', label: '终端', shortcut: 'Ctrl+`' },
    ];
  }
  return [
    { kind: 'review', label: '审查', shortcut: 'Ctrl+Shift+G' },
    { kind: 'terminal', label: '终端', shortcut: 'Ctrl+`' },
    { kind: 'browser', label: '浏览器', shortcut: 'Ctrl+T' },
    { kind: 'file', label: '文件', shortcut: 'Ctrl+P', disabled: !ctx.workspace },
  ];
}

export function canOpenLauncherKind(kind: LauncherKind, ctx: LauncherContext): boolean {
  if (isCasualSession(ctx.cwd, ctx.worksDir) && (kind === 'file' || kind === 'review')) return false;
  if (kind === 'file' && !ctx.workspace) return false;
  return true;
}
```

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/launcherItems.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/dock/launcherItems.ts" "electron-agent/src/features/dock/launcherItems.test.ts"
git commit -m @"
feat(dock): 按会话类型列出坞快捷通路条目

"@
```

---

### 任务 2：审查占位 body

**文件：**
- 创建：`electron-agent/src/features/dock/ReviewPlaceholderBody.tsx`
- 测试：`electron-agent/src/features/dock/ReviewPlaceholderBody.test.tsx`

- [ ] **步骤 1：写失败测试**

`ReviewPlaceholderBody.test.tsx`：

```ts
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewPlaceholderBody } from './ReviewPlaceholderBody';

afterEach(cleanup);

const tab = {
  id: 'review:right',
  kind: 'review' as const,
  region: 'right' as const,
  title: '审查',
  closable: true,
  order: 0,
  payload: { workspace: '/repo' },
};

describe('ReviewPlaceholderBody', () => {
  it('shows a placeholder, not a diff', () => {
    render(<ReviewPlaceholderBody tab={tab} active />);
    expect(screen.getByTestId('review-placeholder').textContent).toContain('审查尚未接入');
  });
});
```

这一步 `kind: 'review'` 还不是 `DockTabKind` 的成员。`ReviewPlaceholderBody` 的 props 先用 `DockBodyProps` 会在任务 4 之前编不过。本任务的组件 props 写成：

```ts
interface ReviewPlaceholderBodyProps {
  tab?: unknown;
  active?: boolean;
}
```

测试里照样传 `tab` / `active`。任务 4 再改成 `DockBodyProps`。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/ReviewPlaceholderBody.test.tsx
```

预期：FAIL，无法解析模块。

- [ ] **步骤 3：写最少实现**

`ReviewPlaceholderBody.tsx`：

```tsx
import { dockTabStyles } from './dockTabStyles';

export function ReviewPlaceholderBody(_props?: { tab?: unknown; active?: boolean }) {
  return (
    <div className={dockTabStyles.empty} data-testid="review-placeholder">
      审查尚未接入。本期仅占位。
    </div>
  );
}
```

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/ReviewPlaceholderBody.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/dock/ReviewPlaceholderBody.tsx" "electron-agent/src/features/dock/ReviewPlaceholderBody.test.tsx"
git commit -m @"
feat(dock): 审查 tab 先用占位 body

"@
```

---

### 任务 3：文件树 body

**文件：**
- 创建：`electron-agent/src/features/dock/FileTreeBody.tsx`
- 测试：`electron-agent/src/features/dock/FileTreeBody.test.tsx`

本任务仍不要改 `DockTabKind`。payload 按 `{ workspace: string }` 读取。

- [ ] **步骤 1：写失败测试**

`FileTreeBody.test.tsx`：

```ts
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutStore } from '../../stores/layoutStore';

const { getTree } = vi.hoisted(() => ({ getTree: vi.fn() }));
vi.mock('../../lib/files', () => ({ files: { getTree } }));

import { FileTreeBody } from './FileTreeBody';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const tab = {
  id: 'file:right:/repo',
  kind: 'file' as const,
  region: 'right' as const,
  title: '文件',
  closable: true,
  order: 0,
  payload: { workspace: '/repo' },
};

const tree = {
  name: 'repo',
  path: '/repo',
  kind: 'directory' as const,
  children: [
    { name: 'a.ts', path: '/repo/a.ts', kind: 'file' as const },
    {
      name: 'src',
      path: '/repo/src',
      kind: 'directory' as const,
      children: [{ name: 'b.ts', path: '/repo/src/b.ts', kind: 'file' as const }],
    },
  ],
};

describe('FileTreeBody', () => {
  beforeEach(() => {
    useLayoutStore.setState({ rightPanelOpen: true, terminalOpen: true });
  });

  it('lists files and expands a folder', async () => {
    getTree.mockResolvedValue(tree);
    render(<FileTreeBody tab={tab} active />);
    await waitFor(() => expect(screen.getByTestId('file-tree')).toBeTruthy());
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.queryByText('b.ts')).toBeNull();
    await userEvent.click(screen.getByTestId('file-tree-dir-/repo/src'));
    expect(screen.getByText('b.ts')).toBeTruthy();
    expect(getTree).toHaveBeenCalledWith('/repo');
  });

  it('shows retry on failure and does not collapse the dock', async () => {
    getTree.mockRejectedValue(new Error('boom'));
    render(<FileTreeBody tab={tab} active />);
    await waitFor(() => expect(screen.getByTestId('file-tree-error')).toBeTruthy());
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    getTree.mockResolvedValue(tree);
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByTestId('file-tree')).toBeTruthy());
  });
});
```

若项目没有 `@testing-library/user-event`，改用 `fireEvent.click`。先在 `electron-agent/package.json` 的 dependencies / devDependencies 里确认；有就用 user-event，没有就 `fireEvent`。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/FileTreeBody.test.tsx
```

预期：FAIL，无法解析模块。

- [ ] **步骤 3：写最少实现**

`FileTreeBody.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@lobehub/ui';
import { ChevronDown, ChevronRight, File, Folder } from 'lucide-react';
import { files, type FileNode } from '../../lib/files';
import { dockTabStyles } from './dockTabStyles';

interface FileTreeBodyProps {
  tab: { payload: { workspace?: string } };
  active?: boolean;
}

export function FileTreeBody({ tab }: FileTreeBodyProps) {
  const workspace = tab.payload.workspace ?? '';
  const [root, setRoot] = useState<FileNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const load = useCallback(() => {
    if (!workspace) {
      setError('没有工作区');
      setRoot(null);
      return;
    }
    setError(null);
    files
      .getTree(workspace)
      .then((node) => {
        setRoot(node);
        setExpanded(new Set([node.path]));
      })
      .catch((err: unknown) => {
        setRoot(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [workspace]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className={dockTabStyles.empty} data-testid="file-tree-error">
        <span>无法加载文件树。{error}</span>
        <button type="button" onClick={load}>
          重试
        </button>
      </div>
    );
  }

  if (!root) {
    return (
      <div className={dockTabStyles.empty} data-testid="file-tree-loading">
        加载中
      </div>
    );
  }

  return (
    <div data-testid="file-tree" style={{ overflow: 'auto', height: '100%', padding: 8 }}>
      <FileTreeNode node={root} expanded={expanded} onToggle={(path) => {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      }} />
    </div>
  );
}

function FileTreeNode({
  node,
  expanded,
  onToggle,
}: {
  node: FileNode;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isDir = node.kind === 'directory';
  const open = isDir && expanded.has(node.path);
  const kids = open ? node.children ?? [] : [];

  if (isDir) {
    return (
      <div>
        <button
          type="button"
          data-testid={`file-tree-dir-${node.path}`}
          onClick={() => onToggle(node.path)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            border: 0,
            background: 'transparent',
            color: 'inherit',
            textAlign: 'left',
            padding: '2px 4px',
            cursor: 'pointer',
          }}
        >
          <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
          <Icon icon={Folder} size={14} />
          <span>{node.name}</span>
        </button>
        {kids.length > 0 ? (
          <div style={{ paddingLeft: 16 }}>
            {kids.map((child) => (
              <FileTreeNode key={child.path} node={child} expanded={expanded} onToggle={onToggle} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-testid={`file-tree-file-${node.path}`}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px 2px 24px' }}
    >
      <Icon icon={File} size={14} />
      <span>{node.name}</span>
    </div>
  );
}
```

文件行不要绑 `onClick` 去读文件或开编辑器。失败路径不要 import / 调用 `useLayoutStore`。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/FileTreeBody.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/dock/FileTreeBody.tsx" "electron-agent/src/features/dock/FileTreeBody.test.tsx"
git commit -m @"
feat(dock): 工作区文件树 tab body

"@
```

---

### 任务 4：`DockTabKind` 增加 `file` / `review` 并挂 body

**文件：**
- 修改：`electron-agent/src/stores/dockStore.ts`
- 修改：`electron-agent/src/stores/dockStore.test.ts`
- 修改：`electron-agent/src/features/dock/TabBodyRenderer.tsx`
- 修改：`electron-agent/src/features/dock/ReviewPlaceholderBody.tsx`（props 改为 `DockBodyProps`）
- 修改：`electron-agent/src/features/dock/FileTreeBody.tsx`（props 改为 `DockBodyProps`，payload 用 `FilePayload`）

- [ ] **步骤 1：写失败测试**

在 `dockStore.test.ts` 末尾追加：

```ts
  it('accepts file and review tabs with stable ids', () => {
    const s = useDockStore.getState();
    s.addTab({
      id: 'file:right:/repo',
      kind: 'file',
      region: 'right',
      title: '文件',
      closable: true,
      payload: { workspace: '/repo' },
    });
    s.addTab({
      id: 'review:right',
      kind: 'review',
      region: 'right',
      title: '审查',
      closable: true,
      payload: { workspace: '/repo' },
    });
    const tabs = useDockStore.getState().tabs;
    expect(tabs.map((t) => t.kind)).toEqual(['file', 'review']);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });
```

这一步先跑会在 `kind: 'file'` 上报 TypeScript / 运行期都还没这个 kind（vitest 不拦多余字符串，所以测试可能**直接绿**——那也没关系，本任务以 `tsc --noEmit` 为红：先改测试与 renderer，再改类型）。

同时把 `ReviewPlaceholderBody.tsx` / `FileTreeBody.tsx` 的 props 改成从 `./TabBodyRenderer` 引入的 `DockBodyProps`（步骤 3 一起做）。测试文件里的 `kind: 'review' as const` 在类型扩完后合法。

- [ ] **步骤 2：跑测试 + tsc 看现状**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/stores/dockStore.test.ts src/features/dock/ReviewPlaceholderBody.test.tsx src/features/dock/FileTreeBody.test.tsx
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit
```

在改 `TabBodyRenderer` 之前，`tsc` 应仍通过。改完 `BODY_RENDERERS` 但没扩 union 会报错；扩了 union 没挂 renderer 也会报错。两边必须同一 commit。

- [ ] **步骤 3：改 store 类型并挂 renderer**

`dockStore.ts` 顶部替换 kind 与 payload：

```ts
export type DockTabKind =
  | 'terminal'
  | 'browser'
  | 'page'
  | 'subagent'
  | 'subagentLog'
  | 'projectContext'
  | 'file'
  | 'review';
```

删掉 `// 后续阶段：| 'file' | 'diff' | 'sidechat'`。

在 `ProjectContextPayload` 后追加：

```ts
export interface FilePayload {
  workspace: string;
}

export interface ReviewPayload {
  workspace?: string;
}
```

把 `DockTabPayload` 并上 `| FilePayload | ReviewPayload`。

`TabBodyRenderer.tsx`：

```tsx
import type { ComponentType } from 'react';
import type { DockTab, DockTabKind } from '../../stores/dockStore';
import { PageBody } from './PageBody';
import { BrowserBody } from './BrowserBody';
import { ProjectContextBody } from './ProjectContextBody';
import { SubAgentBody } from './SubAgentBody';
import { SubAgentLogBody } from './SubAgentLogBody';
import { TerminalBody } from './TerminalBody';
import { FileTreeBody } from './FileTreeBody';
import { ReviewPlaceholderBody } from './ReviewPlaceholderBody';

export interface DockBodyProps {
  tab: DockTab;
  active: boolean;
}

const BODY_RENDERERS: Record<DockTabKind, ComponentType<DockBodyProps>> = {
  terminal: TerminalBody,
  browser: BrowserBody,
  page: PageBody,
  subagent: SubAgentBody,
  subagentLog: SubAgentLogBody,
  projectContext: ProjectContextBody,
  file: FileTreeBody,
  review: ReviewPlaceholderBody,
};

export function TabBodyRenderer({ tab, active }: DockBodyProps) {
  const Body = BODY_RENDERERS[tab.kind];
  return <Body tab={tab} active={active} />;
}
```

`ReviewPlaceholderBody` 改成 `export function ReviewPlaceholderBody(_props: DockBodyProps)`。

`FileTreeBody`：`import type { FilePayload } from '../../stores/dockStore'`，`import type { DockBodyProps } from './TabBodyRenderer'`，`const workspace = (tab.payload as FilePayload).workspace`。

`resolveTone` 不必改：file / review 会落到最后的 `neutral`。

- [ ] **步骤 4：跑测试与 tsc**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/stores/dockStore.test.ts src/features/dock/ReviewPlaceholderBody.test.tsx src/features/dock/FileTreeBody.test.tsx
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit
```

预期：测试 PASS，tsc 无错误。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/stores/dockStore.ts" "electron-agent/src/stores/dockStore.test.ts" "electron-agent/src/features/dock/TabBodyRenderer.tsx" "electron-agent/src/features/dock/ReviewPlaceholderBody.tsx" "electron-agent/src/features/dock/FileTreeBody.tsx"
git commit -m @"
feat(dock): 接入 file 与 review 两种 tab

"@
```

---

### 任务 5：`openLauncherTab`

**文件：**
- 创建：`electron-agent/src/features/dock/openLauncherTab.ts`
- 测试：`electron-agent/src/features/dock/openLauncherTab.test.ts`

- [ ] **步骤 1：写失败测试**

`openLauncherTab.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useDockStore, defaultTerminalTitle } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { fileTabId, openLauncherTab, reviewTabId } from './openLauncherTab';

function reset() {
  localStorage.clear();
  useDockStore.setState({ tabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
}

describe('openLauncherTab', () => {
  beforeEach(reset);

  it('opens browser and terminal as new tabs in the launcher region', () => {
    openLauncherTab({ region: 'bottom', kind: 'browser' });
    openLauncherTab({ region: 'bottom', kind: 'browser' });
    openLauncherTab({ region: 'bottom', kind: 'terminal' });
    const tabs = useDockStore.getState().tabs;
    expect(tabs.filter((t) => t.kind === 'browser')).toHaveLength(2);
    expect(tabs.filter((t) => t.kind === 'terminal')).toHaveLength(1);
    expect(tabs.every((t) => t.region === 'bottom')).toBe(true);
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    expect(tabs.find((t) => t.kind === 'terminal')?.title).toBe(defaultTerminalTitle());
  });

  it('reuses file and review tabs in the same region', () => {
    openLauncherTab({ region: 'right', kind: 'file', workspace: '/repo' });
    openLauncherTab({ region: 'right', kind: 'file', workspace: '/repo' });
    openLauncherTab({ region: 'right', kind: 'review', workspace: '/repo' });
    openLauncherTab({ region: 'right', kind: 'review', workspace: '/repo' });
    const tabs = useDockStore.getState().tabs;
    expect(tabs.filter((t) => t.kind === 'file')).toHaveLength(1);
    expect(tabs.filter((t) => t.kind === 'review')).toHaveLength(1);
    expect(tabs[0].id).toBe(fileTabId('right', '/repo'));
    expect(tabs[1].id).toBe(reviewTabId('right'));
    expect(useDockStore.getState().activeByRegion.right).toBe(reviewTabId('right'));
  });

  it('keeps a separate file tab per region', () => {
    openLauncherTab({ region: 'right', kind: 'file', workspace: '/repo' });
    openLauncherTab({ region: 'bottom', kind: 'file', workspace: '/repo' });
    expect(useDockStore.getState().tabs.map((t) => t.id)).toEqual([
      fileTabId('right', '/repo'),
      fileTabId('bottom', '/repo'),
    ]);
  });

  it('does not add a file tab without workspace', () => {
    openLauncherTab({ region: 'right', kind: 'file' });
    expect(useDockStore.getState().tabs).toHaveLength(0);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/openLauncherTab.test.ts
```

预期：FAIL，无法解析模块。

- [ ] **步骤 3：写最少实现**

`openLauncherTab.ts`：

```ts
import {
  defaultTerminalTitle,
  useDockStore,
  type DockRegion,
  type FilePayload,
  type ReviewPayload,
} from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import type { LauncherKind } from './launcherItems';

export function fileTabId(region: DockRegion, workspace: string): string {
  return `file:${region}:${workspace}`;
}

export function reviewTabId(region: DockRegion): string {
  return `review:${region}`;
}

function revealRegion(region: DockRegion): void {
  if (region === 'right') useLayoutStore.getState().setRightPanelOpen(true);
  else useLayoutStore.getState().setTerminalOpen(true);
}

export function openLauncherTab(input: {
  region: DockRegion;
  kind: LauncherKind;
  workspace?: string | null;
}): void {
  const { region, kind, workspace } = input;
  const store = useDockStore.getState();

  if (kind === 'browser') {
    store.addTab({
      id: `browser-${Date.now()}`,
      kind: 'browser',
      region,
      title: '浏览器',
      closable: true,
      payload: { url: 'https://example.com', title: '浏览器' },
    });
    return;
  }

  if (kind === 'terminal') {
    store.addTab({
      id: `terminal-${Date.now()}`,
      kind: 'terminal',
      region,
      title: defaultTerminalTitle(),
      closable: true,
      payload: { status: 'idle' },
    });
    return;
  }

  if (kind === 'file') {
    if (!workspace) return;
    const id = fileTabId(region, workspace);
    if (store.tabs.some((t) => t.id === id)) {
      store.setActive(region, id);
      revealRegion(region);
      return;
    }
    const payload: FilePayload = { workspace };
    store.addTab({ id, kind: 'file', region, title: '文件', closable: true, payload });
    return;
  }

  const id = reviewTabId(region);
  if (store.tabs.some((t) => t.id === id)) {
    store.setActive(region, id);
    revealRegion(region);
    return;
  }
  const payload: ReviewPayload = { workspace: workspace ?? undefined };
  store.addTab({ id, kind: 'review', region, title: '审查', closable: true, payload });
}
```

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/openLauncherTab.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/dock/openLauncherTab.ts" "electron-agent/src/features/dock/openLauncherTab.test.ts"
git commit -m @"
feat(dock): 通路按侧开 tab，文件和审查复用

"@
```

---

### 任务 6：拆掉终端钉死底坞

**文件：**
- 修改：`electron-agent/src/stores/dockStore.ts`（`moveTabRegion` 里删终端拒绝右坞）
- 修改：`electron-agent/src/stores/dockStore.test.ts`
- 修改：`electron-agent/src/features/dock/dockDnd.ts`
- 修改：`electron-agent/src/features/dock/dockDnd.test.ts`

本任务**只拆钉**，不收栏。收栏是任务 7。

- [ ] **步骤 1：改失败测试**

把 `dockStore.test.ts` 里 `'moveTabRegion moves a page to bottom and rejects moving a terminal to right'` 整段换成：

```ts
  it('moveTabRegion moves a page to bottom and allows moving a terminal to right', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://p', content: '' });
    s.moveTabRegion('page:https://p', 'bottom');
    let tab = useDockStore.getState().tabs.find((t) => t.id === 'page:https://p')!;
    expect(tab.region).toBe('bottom');
    expect(useDockStore.getState().activeByRegion.bottom).toBe('page:https://p');
    expect(useLayoutStore.getState().terminalOpen).toBe(true);

    s.addTab({ id: 'term-1', kind: 'terminal', region: 'bottom', title: 'T', closable: true, payload: { status: 'idle' } });
    s.moveTabRegion('term-1', 'right');
    tab = useDockStore.getState().tabs.find((t) => t.id === 'term-1')!;
    expect(tab.region).toBe('right');
    expect(useDockStore.getState().activeByRegion.right).toBe('term-1');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });
```

把 `dockDnd.test.ts` 里 `'rejects dragging a terminal to the right region'` 换成：

```ts
  it('moves a terminal to the right region', () => {
    expect(planDrop(tabs, 'term1', 'dock:right')).toEqual({
      type: 'move',
      id: 'term1',
      region: 'right',
      insertIndex: 2,
    });
    expect(planDrop(tabs, 'term1', 'p1')).toEqual({
      type: 'move',
      id: 'term1',
      region: 'right',
      insertIndex: 0,
    });
  });
```

`insertIndex: 2` 来自右坞已有 p1、p2 两张，丢到 `dock:right` 空白处插到末尾。丢到 `p1` 则插在 index 0。若跑红了，以 `planDrop` 实际返回为准改断言，不要改公式含义。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/stores/dockStore.test.ts src/features/dock/dockDnd.test.ts
```

预期：FAIL。store 用例终端仍在 `bottom`；dnd 用例仍是 `null`。

- [ ] **步骤 3：拆钉**

`dockStore.ts` 的 `moveTabRegion` 里删除这两行：

```ts
          // 终端钉在底坞：拒绝移入右坞。
          if (tab.kind === 'terminal' && targetRegion === 'right') return s;
```

`dockDnd.ts` 删除这两行：

```ts
  // 终端钉底坞：不可移入其它坞。
  if (activeTab.kind === 'terminal' && targetRegion !== 'bottom') return null;
```

把 `planDrop` 注释里的「终端拖出底坞」删掉，改成：`返回 null 表示忽略（无效落点 / 同位）`。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/stores/dockStore.test.ts src/features/dock/dockDnd.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/stores/dockStore.ts" "electron-agent/src/stores/dockStore.test.ts" "electron-agent/src/features/dock/dockDnd.ts" "electron-agent/src/features/dock/dockDnd.test.ts"
git commit -m @"
fix(dock): 允许终端拖进右坞

"@
```

---

### 任务 7：最后一张 tab 关掉或拖走则收栏

**文件：**
- 修改：`electron-agent/src/stores/dockStore.ts`（`closeTab`、`moveTabRegion`）
- 修改：`electron-agent/src/stores/dockStore.test.ts`

- [ ] **步骤 1：写失败测试**

在 `dockStore.test.ts` 追加：

```ts
  it('collapses the right dock when its last tab is closed', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://only', content: '' });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    s.closeTab('page:https://only');
    expect(useDockStore.getState().tabs).toHaveLength(0);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
  });

  it('does not collapse a dock that still has tabs', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://1', content: '' });
    s.openPage({ url: 'https://2', content: '' });
    s.closeTab('page:https://2');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    expect(useDockStore.getState().activeByRegion.right).toBe('page:https://1');
  });

  it('collapses the source dock after moving its last tab away', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://p', content: '' });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    s.moveTabRegion('page:https://p', 'bottom');
    expect(useDockStore.getState().tabs.filter((t) => t.region === 'right')).toHaveLength(0);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
  });

  it('collapses the bottom dock when its last tab is closed', () => {
    const s = useDockStore.getState();
    s.addTab({
      id: 'term-1',
      kind: 'terminal',
      region: 'bottom',
      title: 'T',
      closable: true,
      payload: { status: 'idle' },
    });
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    s.closeTab('term-1');
    expect(useLayoutStore.getState().terminalOpen).toBe(false);
  });
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/stores/dockStore.test.ts
```

预期：FAIL。`closeTab` 后 `rightPanelOpen` 仍为 true；`moveTabRegion` 后源侧仍开着。

- [ ] **步骤 3：实现关尽收栏**

在 `dockStore.ts` 的 `nextOrder` 附近加：

```ts
function collapseEmptyRegion(region: DockRegion, tabs: DockTab[]): void {
  if (tabs.some((t) => t.region === region)) return;
  if (region === 'right') useLayoutStore.getState().setRightPanelOpen(false);
  else useLayoutStore.getState().setTerminalOpen(false);
}
```

把 `closeTab` 从「只 `set`」改成先记下 region、`set` 完再 collapse。`create` 回调里现在是 `(set) =>`，这里要读最新 tabs，改成 `(set, get) =>`：

`export const useDockStore = create<DockState>()(persist((set, get) => ({`

`closeTab` 替换为：

```ts
      closeTab: (id) => {
        const target = get().tabs.find((t) => t.id === id);
        if (!target) return;
        const region = target.region;
        set((s) => {
          const regionTabs = s.tabs.filter((t) => t.region === region).sort((a, b) => a.order - b.order);
          const index = regionTabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          const activeByRegion = { ...s.activeByRegion };
          if (activeByRegion[region] === id) {
            const remaining = regionTabs.filter((t) => t.id !== id);
            const fallback = remaining[Math.max(0, index - 1)] ?? remaining[0] ?? null;
            activeByRegion[region] = fallback ? fallback.id : null;
          }
          return { tabs, activeByRegion };
        });
        collapseEmptyRegion(region, get().tabs);
      },
```

`moveTabRegion` 在现有 `if (!moved) return;` 与展开目标侧之后追加源侧收栏。先在 `set` 里记下 `sourceRegion`：

```ts
      moveTabRegion: (id, targetRegion, insertIndex) => {
        let moved = false;
        let sourceRegion: DockRegion | null = null;
        set((s) => {
          const tab = s.tabs.find((t) => t.id === id);
          if (!tab) return s;
          if (tab.region === targetRegion) return s;
          sourceRegion = tab.region;
          const targetTabs = s.tabs.filter((t) => t.region === targetRegion).sort((a, b) => a.order - b.order);
          const at = insertIndex == null ? targetTabs.length : Math.max(0, Math.min(insertIndex, targetTabs.length));
          const movedTab: DockTab = { ...tab, region: targetRegion };
          const nextTarget = [...targetTabs.slice(0, at), movedTab, ...targetTabs.slice(at)].map((t, i) => ({ ...t, order: i }));
          moved = true;
          return {
            tabs: patchTabs(s.tabs, nextTarget),
            activeByRegion: { ...s.activeByRegion, [targetRegion]: id },
          };
        });
        if (!moved) return;
        if (targetRegion === 'right') useLayoutStore.getState().setRightPanelOpen(true);
        else useLayoutStore.getState().setTerminalOpen(true);
        if (sourceRegion) collapseEmptyRegion(sourceRegion, get().tabs);
      },
```

不要改 `resetWorkspaceTabs`。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/stores/dockStore.test.ts
```

预期：PASS。顺手确认任务 6 的「终端可进右坞」仍绿：从底坞把**不是最后一张**的终端拖到右坞时，底坞若还剩别的 tab 则 `terminalOpen` 仍为 true。上面「allows moving a terminal to right」在 `openPage` 挪到底坞之后又 `addTab` 终端，底坞此时有 page + terminal，移走 terminal 后底坞还剩 page，不应收底坞。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/stores/dockStore.ts" "electron-agent/src/stores/dockStore.test.ts"
git commit -m @"
feat(dock): 某一侧 tab 清尽则收起该坞

"@
```

---

### 任务 8：`DockLauncher` 通路 UI

**文件：**
- 创建：`electron-agent/src/features/dock/DockLauncher.tsx`
- 测试：`electron-agent/src/features/dock/DockLauncher.test.tsx`
- 修改：`electron-agent/src/features/dock/dockTabStyles.ts`（加 `launcher` / `launcherRow` / `launcherShortcut`）

- [ ] **步骤 1：写失败测试**

`DockLauncher.test.tsx`：

```ts
import { cleanup, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../store/session';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';

const ctx = { workspace: '/repo' };
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ctx,
}));

import { DockLauncher } from './DockLauncher';

function renderLauncher(region: 'right' | 'bottom' = 'right') {
  return render(
    <DndContext>
      <DockLauncher region={region} />
    </DndContext>,
  );
}

describe('DockLauncher', () => {
  beforeEach(() => {
    localStorage.clear();
    useDockStore.setState({ tabs: [], activeByRegion: { right: null, bottom: null } });
    useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
    useSessionStore.setState({ worksDir: '/home/.pi/agent/works' });
    ctx.workspace = '/repo';
  });
  afterEach(cleanup);

  it('shows four project rows and opens a tab in its region', () => {
    renderLauncher('bottom');
    expect(screen.getByTestId('dock-launcher-bottom')).toBeTruthy();
    expect(screen.getByTestId('dock-launcher-review').textContent).toContain('审查');
    expect(screen.getByTestId('dock-launcher-review').textContent).toContain('Ctrl+Shift+G');
    expect(screen.getByTestId('dock-launcher-file')).toBeTruthy();
    screen.getByTestId('dock-launcher-browser').click();
    const tabs = useDockStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: 'browser', region: 'bottom' });
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
  });

  it('hides review and file for a casual session', () => {
    ctx.workspace = '/home/.pi/agent/works/u1';
    renderLauncher('right');
    expect(screen.getByTestId('dock-launcher-browser')).toBeTruthy();
    expect(screen.getByTestId('dock-launcher-terminal')).toBeTruthy();
    expect(screen.queryByTestId('dock-launcher-review')).toBeNull();
    expect(screen.queryByTestId('dock-launcher-file')).toBeNull();
  });

  it('does not activate a disabled file row', () => {
    ctx.workspace = '';
    useSessionStore.setState({ worksDir: '/home/.pi/agent/works' });
    // workspace 为空会被 isCasualSession 当成普通对话，本用例改测 launcherItems 已覆盖 disabled。
    // 这里断言空工作区只有浏览器和终端。
    renderLauncher('right');
    expect(screen.queryByTestId('dock-launcher-file')).toBeNull();
    expect(screen.getByTestId('dock-launcher-browser')).toBeTruthy();
  });
});
```

`vi.mock` 必须写在 `import { DockLauncher }` **之前**。把 `import { DockLauncher }` 放到 mock 之后；其余 import 可留在文件顶。上面示例里 `const ctx` 与 `vi.mock` 要能被 hoisting 看到：把 `ctx` 放进 `vi.hoisted`：

```ts
const { ctx } = vi.hoisted(() => ({ ctx: { workspace: '/repo' } }));
```

并补 `import { vi } from 'vitest'`。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/DockLauncher.test.tsx
```

预期：FAIL，无法解析 `DockLauncher`。

- [ ] **步骤 3：实现通路 UI**

在 `dockTabStyles.ts` 的 `createStaticStyles` 返回对象里、`empty` 旁边加：

```ts
  launcher: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: 2px;
    min-height: 0;
    padding: 8px;
    overflow: auto;
  `,
  launcherRow: css`
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 36px;
    padding: 0 12px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: ${cssVar.colorText};
    font-size: 13px;
    text-align: left;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: ${cssVar.colorFillTertiary};
    }

    &:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  `,
  launcherShortcut: css`
    margin-inline-start: auto;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
```

`DockLauncher.tsx`：

```tsx
import { Icon } from '@lobehub/ui';
import { useDroppable } from '@dnd-kit/core';
import { FolderTree, GitPullRequest, Globe, SquareTerminal, type LucideIcon } from 'lucide-react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store/session';
import type { DockRegion } from '../../stores/dockStore';
import { dockTabStyles } from './dockTabStyles';
import { launcherItems, type LauncherKind } from './launcherItems';
import { openLauncherTab } from './openLauncherTab';

const ICONS: Record<LauncherKind, LucideIcon> = {
  review: GitPullRequest,
  terminal: SquareTerminal,
  browser: Globe,
  file: FolderTree,
};

interface DockLauncherProps {
  region: DockRegion;
}

export function DockLauncher({ region }: DockLauncherProps) {
  const { workspace } = useAgentStoreContext();
  const worksDir = useSessionStore((s) => s.worksDir);
  const items = launcherItems({ cwd: workspace, worksDir, workspace });
  const { setNodeRef } = useDroppable({ id: `dock:${region}` });

  return (
    <div ref={setNodeRef} className={dockTabStyles.launcher} data-testid={`dock-launcher-${region}`}>
      {items.map((item) => (
        <button
          key={item.kind}
          type="button"
          className={dockTabStyles.launcherRow}
          data-testid={`dock-launcher-${item.kind}`}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            openLauncherTab({ region, kind: item.kind, workspace });
          }}
        >
          <Icon icon={ICONS[item.kind]} size={16} />
          <span>{item.label}</span>
          <span className={dockTabStyles.launcherShortcut}>{item.shortcut}</span>
        </button>
      ))}
    </div>
  );
}
```

空态也注册 `dock:${region}` droppable，这样底坞 tab 仍能拖进空右坞（与 `TabStrip` 的 id 相同，同一时刻只有一个挂载）。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/DockLauncher.test.tsx src/features/dock/launcherItems.test.ts src/features/dock/openLauncherTab.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/dock/DockLauncher.tsx" "electron-agent/src/features/dock/DockLauncher.test.tsx" "electron-agent/src/features/dock/dockTabStyles.ts"
git commit -m @"
feat(dock): 空坞渲染 Codex 式快捷通路

"@
```

---

### 任务 9：`DockPanel` 空态换通路

**文件：**
- 修改：`electron-agent/src/features/dock/DockPanel.tsx`
- 创建：`electron-agent/src/features/dock/DockPanel.test.tsx`

规格缺口（实现时按此补，不要再问）：空态**没有 tab 条**，但右坞打开时顶栏 Panel 钮会消失，所以空态右坞顶部仍要一条与 `TabStrip` 同高的 header，**只放折叠按钮**（有 `onCollapse` 才渲染）。底坞空态不传 `onCollapse`，整栏就是通路，用户用顶栏「底栏」钮关。有 tab 时行为与现在一致：右坞 Globe + 折叠，底坞 `+`。

- [ ] **步骤 1：写失败测试**

`DockPanel.test.tsx`：

```ts
import { cleanup, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../store/session';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';

const { ctx } = vi.hoisted(() => ({ ctx: { workspace: '/repo' } }));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ctx,
  useAgentStore: () => ({
    useStore: (selector: (s: { messages: unknown[] }) => unknown) => selector({ messages: [] }),
  }),
}));

import { DockPanel } from './DockPanel';

function renderPanel(region: 'right' | 'bottom' = 'right', onCollapse?: () => void) {
  return render(
    <DndContext>
      <DockPanel region={region} onCollapse={onCollapse} />
    </DndContext>,
  );
}

describe('DockPanel empty launcher', () => {
  beforeEach(() => {
    localStorage.clear();
    useDockStore.setState({ tabs: [], activeByRegion: { right: null, bottom: null } });
    useLayoutStore.setState({ rightPanelOpen: true, terminalOpen: true });
    useSessionStore.setState({ worksDir: '/home/.pi/agent/works' });
    ctx.workspace = '/repo';
  });
  afterEach(cleanup);

  it('renders the launcher and no tab strip or empty hint when there are no tabs', () => {
    renderPanel('right', () => undefined);
    expect(screen.getByTestId('dock-launcher-right')).toBeTruthy();
    expect(screen.queryByTestId('dock-strip-right')).toBeNull();
    expect(screen.queryByText(/暂无内容/)).toBeNull();
    expect(screen.queryByTitle('打开浏览器')).toBeNull();
    expect(screen.getByTitle('Collapse panel')).toBeTruthy();
  });

  it('shows the tab strip and globe once a tab exists', () => {
    useDockStore.getState().addTab({
      id: 'browser-1',
      kind: 'browser',
      region: 'right',
      title: '浏览器',
      closable: true,
      payload: { url: 'https://example.com', title: '浏览器' },
    });
    renderPanel('right', () => undefined);
    expect(screen.queryByTestId('dock-launcher-right')).toBeNull();
    expect(screen.getByTestId('dock-strip-right')).toBeTruthy();
    expect(screen.getByTitle('打开浏览器')).toBeTruthy();
  });

  it('hides the plus button on an empty bottom dock', () => {
    renderPanel('bottom');
    expect(screen.getByTestId('dock-launcher-bottom')).toBeTruthy();
    expect(screen.queryByTitle('新建终端')).toBeNull();
    expect(screen.queryByTestId('dock-strip-bottom')).toBeNull();
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/DockPanel.test.tsx
```

预期：FAIL。空坞仍渲染 `dock-strip-right` 和「暂无内容」。

- [ ] **步骤 3：改 `DockPanel`**

用 `openLauncherTab` 替换本地 `addBrowser` / `addTerminal`，并且空态走 launcher。完整替换 `DockPanel.tsx`：

```tsx
import { useCallback, useMemo } from 'react';
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { cx } from 'antd-style';
import { Globe, PanelRightClose, Plus } from 'lucide-react';
import { useAgentStore } from '../../stores/AgentStoreContext';
import { useDockStore, type DockRegion, type DockTab, type SubAgentPayload } from '../../stores/dockStore';
import { dockTabStyles, resolveTone } from './dockTabStyles';
import { TabStrip } from './TabStrip';
import { TabBodyStack } from './TabBodyStack';
import { DockLauncher } from './DockLauncher';
import { openLauncherTab } from './openLauncherTab';

interface DockPanelProps {
  region: DockRegion;
  onCollapse?: () => void;
}

export function DockPanel({ region, onCollapse }: DockPanelProps) {
  const store = useAgentStore();
  const messages = store.useStore((s) => s.messages);
  const allTabs = useDockStore((s) => s.tabs);
  const activeByRegion = useDockStore((s) => s.activeByRegion);
  const setActive = useDockStore((s) => s.setActive);
  const closeTab = useDockStore((s) => s.closeTab);

  const subAgentStatus = useMemo(() => {
    const map: Record<string, 'running' | 'done' | 'error'> = {};
    for (const m of messages) {
      if (m.kind === 'tool' && m.toolName === 'spawn_agent') map[m.id] = m.status;
    }
    return map;
  }, [messages]);

  const tabs = useMemo(
    () => allTabs.filter((t) => t.region === region).sort((a, b) => a.order - b.order),
    [allTabs, region],
  );
  const activeId = activeByRegion[region] ?? tabs.at(-1)?.id ?? null;

  const toneOf = useCallback(
    (tab: DockTab) =>
      resolveTone(
        tab,
        tab.kind === 'subagent' ? subAgentStatus[(tab.payload as SubAgentPayload).messageId] : undefined,
      ),
    [subAgentStatus],
  );

  const actions = (
    <>
      {region === 'bottom' ? (
        <ActionIcon
          icon={Plus}
          size="small"
          title="新建终端"
          onClick={() => openLauncherTab({ region, kind: 'terminal' })}
        />
      ) : (
        <ActionIcon
          icon={Globe}
          size="small"
          title="打开浏览器"
          onClick={() => openLauncherTab({ region, kind: 'browser' })}
        />
      )}
      {onCollapse ? (
        <ActionIcon icon={PanelRightClose} size="small" title="Collapse panel" onClick={onCollapse} />
      ) : null}
    </>
  );

  if (tabs.length === 0) {
    return (
      <Flexbox className={cx('dock-panel', dockTabStyles.container)}>
        {onCollapse ? (
          <div className={dockTabStyles.header}>
            <div className={dockTabStyles.tabs} />
            <div className={dockTabStyles.actions}>
              <ActionIcon icon={PanelRightClose} size="small" title="Collapse panel" onClick={onCollapse} />
            </div>
          </div>
        ) : null}
        <DockLauncher region={region} />
      </Flexbox>
    );
  }

  return (
    <Flexbox className={cx('dock-panel', dockTabStyles.container)}>
      <TabStrip
        region={region}
        tabs={tabs}
        activeId={activeId}
        toneOf={toneOf}
        onActivate={(id) => setActive(region, id)}
        onClose={closeTab}
        actions={actions}
      />
      <TabBodyStack tabs={tabs} activeId={activeId} emptyHint="" />
    </Flexbox>
  );
}
```

有 tab 时 `emptyHint` 传空字符串即可（`TabBodyStack` 在 `tabs.length > 0` 时不渲染 hint）。不要改 `TabBodyStack` 的函数签名。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/DockPanel.test.tsx src/features/dock/DockLauncher.test.tsx src/features/dock/TabStrip.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/dock/DockPanel.tsx" "electron-agent/src/features/dock/DockPanel.test.tsx"
git commit -m @"
feat(dock): 空坞去掉提示条改为快捷通路

"@
```

---

### 任务 10：顶栏终端钮改为底坞开关

**文件：**
- 修改：`electron-agent/src/features/layout/MainColumnHeader.tsx`
- 修改：`electron-agent/src/features/layout/MainColumnHeader.test.tsx`

- [ ] **步骤 1：写失败测试**

在 `MainColumnHeader.test.tsx` 追加：

```ts
describe('MainHeaderActions bottom dock', () => {
  it('toggles terminalOpen and is labeled 底栏', () => {
    useLayoutStore.setState({ terminalOpen: false });
    render(<MainColumnHeader />);
    expect(screen.queryByTitle('Terminal')).toBeNull();
    const btn = screen.getByTitle('底栏');
    btn.click();
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    btn.click();
    expect(useLayoutStore.getState().terminalOpen).toBe(false);
  });
});
```

`beforeEach` 里现有 `useLayoutStore.setState({ rightPanelOpen: false })` 不够，改成同时带上 `terminalOpen: false`（不要丢掉其它字段以外的默认值；zustand `setState` 是 merge）。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/layout/MainColumnHeader.test.tsx
```

预期：FAIL，找不到 `title="底栏"`，仍是 `Terminal`。

- [ ] **步骤 3：改按钮**

`MainColumnHeader.tsx` 的 import：

```ts
import { PanelBottom, PanelRightOpen } from 'lucide-react';
```

删掉 `SquareTerminal`。`MainHeaderActions` 里那个 `ActionIcon` 换成：

```tsx
      <ActionIcon
        icon={PanelBottom}
        active={terminalOpen}
        size="small"
        title="底栏"
        onClick={toggleTerminal}
      />
```

`onClick` 仍是现有的 `toggleTerminal`。不要改成 `openLauncherTab`。不要改右侧 Panel 钮。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/layout/MainColumnHeader.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/layout/MainColumnHeader.tsx" "electron-agent/src/features/layout/MainColumnHeader.test.tsx"
git commit -m @"
feat(layout): 顶栏终端钮改为底坞展开收起

"@
```

---

### 任务 11：四条快捷键（只开右坞）

**文件：**
- 创建：`electron-agent/src/features/dock/useDockLauncherHotkeys.ts`
- 测试：`electron-agent/src/features/dock/useDockLauncherHotkeys.test.ts`
- 修改：`electron-agent/src/App.tsx`（`Workspace` 内调用 hook）

快捷键逻辑抽成可单测的 `runDockLauncherHotkey`，hook 只做按键绑定。不要把 hook 挂到两个 `DockPanel` 上。

- [ ] **步骤 1：写失败测试**

`useDockLauncherHotkeys.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { runDockLauncherHotkey } from './useDockLauncherHotkeys';

function reset() {
  localStorage.clear();
  useDockStore.setState({ tabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
}

describe('runDockLauncherHotkey', () => {
  beforeEach(reset);

  it('opens a right browser tab for a project session', () => {
    runDockLauncherHotkey('browser', {
      cwd: '/repo',
      worksDir: '/home/.pi/agent/works',
      workspace: '/repo',
    });
    const tabs = useDockStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: 'browser', region: 'right' });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('ignores Ctrl+P in a casual session', () => {
    runDockLauncherHotkey('file', {
      cwd: '/home/.pi/agent/works/u1',
      worksDir: '/home/.pi/agent/works',
      workspace: '/home/.pi/agent/works/u1',
    });
    expect(useDockStore.getState().tabs).toHaveLength(0);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
  });

  it('ignores review in a casual session', () => {
    runDockLauncherHotkey('review', {
      cwd: '/home/.pi/agent/works/u1',
      worksDir: '/home/.pi/agent/works',
      workspace: '/home/.pi/agent/works/u1',
    });
    expect(useDockStore.getState().tabs).toHaveLength(0);
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/useDockLauncherHotkeys.test.ts
```

预期：FAIL，无法解析模块。

- [ ] **步骤 3：实现并挂载**

`useDockLauncherHotkeys.ts`：

```ts
import { useHotkeys } from 'react-hotkeys-hook';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store/session';
import { canOpenLauncherKind, type LauncherContext, type LauncherKind } from './launcherItems';
import { openLauncherTab } from './openLauncherTab';

export function runDockLauncherHotkey(kind: LauncherKind, ctx: LauncherContext): void {
  if (!canOpenLauncherKind(kind, ctx)) return;
  openLauncherTab({ region: 'right', kind, workspace: ctx.workspace });
}

const HOTKEY_OPTS = { enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true };

export function useDockLauncherHotkeys(): void {
  const { workspace } = useAgentStoreContext();
  const worksDir = useSessionStore((s) => s.worksDir);
  const ctx: LauncherContext = { cwd: workspace, worksDir, workspace };

  useHotkeys('ctrl+t,cmd+t', (e) => {
    e.preventDefault();
    runDockLauncherHotkey('browser', ctx);
  }, HOTKEY_OPTS, [workspace, worksDir]);

  useHotkeys('ctrl+backquote,cmd+backquote', (e) => {
    e.preventDefault();
    runDockLauncherHotkey('terminal', ctx);
  }, HOTKEY_OPTS, [workspace, worksDir]);

  useHotkeys('ctrl+p,cmd+p', (e) => {
    e.preventDefault();
    runDockLauncherHotkey('file', ctx);
  }, HOTKEY_OPTS, [workspace, worksDir]);

  useHotkeys('ctrl+shift+g,cmd+shift+g', (e) => {
    e.preventDefault();
    runDockLauncherHotkey('review', ctx);
  }, HOTKEY_OPTS, [workspace, worksDir]);
}
```

`App.tsx`：在现有 dock import 旁增加：

```ts
import { useDockLauncherHotkeys } from './features/dock/useDockLauncherHotkeys';
```

在 `Workspace` 函数体顶部、`useAgentStoreContext()` 之后调用：

```ts
  useDockLauncherHotkeys();
```

只调用一次。不要在 `RightPanelColumn` 或 `DockPanel` 里再调。不要改 `visualMode === 'panel'` 那一支。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/useDockLauncherHotkeys.test.ts src/features/dock/openLauncherTab.test.ts src/features/dock/launcherItems.test.ts
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit
```

预期：测试 PASS，tsc 无错误。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/dock/useDockLauncherHotkeys.ts" "electron-agent/src/features/dock/useDockLauncherHotkeys.test.ts" "electron-agent/src/App.tsx"
git commit -m @"
feat(dock): 快捷键在右坞打开通路对应 tab

"@
```

---

### 任务 12：规格标已落地 + 回归

**文件：**
- 修改：`docs/superpowers/specs/2026-09-14-right-dock-launcher-design.md`

- [ ] **步骤 1：跑相关测试回归**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock src/stores/dockStore.test.ts src/features/layout/MainColumnHeader.test.tsx
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit
```

预期：全部 PASS。若红，停在本任务修，不要标已落地。

- [ ] **步骤 2：改规格状态**

把规格头部：

```
- 状态：已对齐（头脑风暴 2026-09-14）
```

改成：

```
- 状态：已落地（2026-09-14）
```

- [ ] **步骤 3：Commit**

```powershell
git add "docs/superpowers/specs/2026-09-14-right-dock-launcher-design.md"
git commit -m @"
docs(specs): 右坞快捷通路规格标为已落地

"@
```

---

## 规格覆盖对照

| 规格 | 任务 |
| --- | --- |
| §2 空态整栏通路、无空 tab 条、无「暂无内容」 | 9 |
| §2 / §5.1 项目四入口、普通对话两入口 | 1, 8 |
| §2 点通路在当前侧开 tab | 5, 8 |
| §2 快捷键开右坞 | 11 |
| §2 / §6.2 关尽或拖尽收栏、不回通路 | 7 |
| §2 / §5.3 顶栏原终端图标 → 底坞 | 10 |
| §2 文件树；审查占位 | 3, 2 |
| §4 普通对话 = worksDir + isUnder；无 cwd 当普通对话 | 1 |
| §5.1 通路行不写「占位」；快捷键画在行右 | 8 |
| §5.1 无工作区文件禁用 / 快捷键无效 | 1, 5, 11 |
| §5.2 有 tab 才有 TabStrip；Globe 仅有 tab | 9 |
| §5.3 顶栏 Panel 钮行为不变 | 10（不改那颗钮） |
| §6.1 `addTab` 展开对应坞 | 已有 store；5 复用 |
| §6.3 拆终端钉 | 6 |
| §7 两坞同一套 `DockLauncher` | 8, 9 |
| §8 id / payload | 4, 5 |
| §9 文件树失败不关坞 | 3 |
| §10 测试清单 | 1, 5, 7, 3, 10, 11 |
| §11 不改 `resetWorkspaceTabs` 终端 idle | 全程禁止改该分支 |
| 非目标 VisualPanel | 不改 `App.tsx` 的 visual 分支 |
| 空态右坞仍能折叠（规格未写死、实现必需） | 9 |

未列入本期、不要做：坞内编辑器、Git diff、给 `layoutStore` 加字段、把 `useKeyboardShortcuts` 救活、底坞专用另一套文案。
