# 会话列表折叠迁到标题栏 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把会话列表开合钮钉在标题栏最左（替换 π），去掉侧栏空顶栏和主列里会跳位的展开钮；空会话标题左侧放 23px 裁切 π。

**架构：** 开合仍走现有 `useLayoutStore.toggleSidebar` / `selectSidebarVisible`，不改折叠规则。`Titlebar` 成为唯一入口（仅 `activeModule === 'chat'` 可点）。`GrenAgentBrand` 只留字样。`PiBrandLogo` 增加 `tight` viewBox，供 `EmptyChatPrompt` 使用。electron-agent 与 tauri-agent 镜像同一组改动。

**技术栈：** React、antd-style、@lobehub/ui `ActionIcon`、lucide-react、zustand、vitest + testing-library。

**上游规格：** `docs/superpowers/specs/2026-09-12-sidebar-titlebar-toggle-design.md`

---

## 动工前必读

- **不要改** `layoutStore`、`ModuleRail`、`ResizeHandle`、`FullscreenLoading`、窗口最小化 / 最大化 / 关闭。
- 标题栏按钮热区是 28×28，空状态 π 笔画高是 23px。两套数字不要混用。
- `tight` viewBox 必须是 `40 56 160 134`。默认 viewBox 必须仍是 `0 0 240 220`，否则启动页动画会坏。
- `tight` 不得落到 SVG DOM 属性上（要从 props 里解构掉）。
- electron 与 tauri 各改各的文件，不要做跨包 import。
- tauri 的 `Titlebar` 从 `@tauri-apps/api/window` 取窗口；单测必须 `vi.mock` 该模块。electron 的 `getCurrentWindow()` 在 jsdom 里会落到 `browserPreviewBridge`，一般不用 mock。
- 每个任务在 **electron 和 tauri 都改完、测过** 后再 commit。
- 不要加折叠快捷键。

**测试命令：**

```powershell
cd electron-agent; npx vitest run src/components/FullscreenLoading.test.tsx src/components/Titlebar.test.tsx src/features/chat/EmptyChatPrompt.test.tsx src/features/layout/MainColumnHeader.test.tsx
cd tauri-agent; npx vitest run src/components/FullscreenLoading.test.tsx src/components/Titlebar.test.tsx src/features/chat/EmptyChatPrompt.test.tsx src/features/layout/MainColumnHeader.test.tsx
```

（任务 1 只跑 `FullscreenLoading.test.tsx`；任务 2 加上 `EmptyChatPrompt.test.tsx`，以此类推。）

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/components/PiBrandLogo.tsx` | 增加 `tight`，裁切 viewBox |
| `tauri-agent/src/components/PiBrandLogo.tsx` | 同上 |
| `electron-agent/src/components/FullscreenLoading.test.tsx` | 补 `tight` / 默认 viewBox 用例 |
| `tauri-agent/src/components/FullscreenLoading.test.tsx` | 同上 |
| `electron-agent/src/features/chat/EmptyChatPrompt.tsx` | 标题左侧 lockup |
| `tauri-agent/src/features/chat/EmptyChatPrompt.tsx` | 同上 |
| `electron-agent/src/features/chat/EmptyChatPrompt.test.tsx` | 新建 |
| `tauri-agent/src/features/chat/EmptyChatPrompt.test.tsx` | 新建 |
| `electron-agent/src/components/GrenAgentBrand.tsx` | 只渲染字样 |
| `tauri-agent/src/components/GrenAgentBrand.tsx` | 同上 |
| `electron-agent/src/components/Titlebar.tsx` | 折叠钮 + 字样 |
| `tauri-agent/src/components/Titlebar.tsx` | 同上 |
| `electron-agent/src/components/Titlebar.test.tsx` | 新建 |
| `tauri-agent/src/components/Titlebar.test.tsx` | 新建 |
| `electron-agent/src/features/sessions/Sidebar.tsx` | 去掉空顶栏和 `onToggleSidebar` |
| `tauri-agent/src/features/sessions/Sidebar.tsx` | 同上 |
| `electron-agent/src/App.tsx` | 不再传 `onToggleSidebar` |
| `tauri-agent/src/App.tsx` | 同上 |
| `electron-agent/src/features/layout/MainColumnHeader.tsx` | 删除 `SidebarToggleButton` |
| `tauri-agent/src/features/layout/MainColumnHeader.tsx` | 同上 |
| `electron-agent/src/features/layout/MainColumnHeader.test.tsx` | 回归：主列没有折叠钮 |
| `tauri-agent/src/features/layout/MainColumnHeader.test.tsx` | 同上 |

---

### 任务 1：PiBrandLogo `tight`

**文件：**
- 修改：`electron-agent/src/components/PiBrandLogo.tsx`
- 修改：`tauri-agent/src/components/PiBrandLogo.tsx`
- 测试：`electron-agent/src/components/FullscreenLoading.test.tsx`
- 测试：`tauri-agent/src/components/FullscreenLoading.test.tsx`

- [ ] **步骤 1：编写失败的测试（electron）**

在 `FullscreenLoading.test.tsx` 的 `describe('PiBrandLogo')` 末尾追加：

```ts
  it('uses the full viewBox by default', () => {
    const { container } = render(<PiBrandLogo />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 240 220');
  });

  it('crops to the glyph when tight', () => {
    const { container } = render(<PiBrandLogo size={23} tight />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('40 56 160 134');
    expect(svg?.getAttribute('height')).toBe('23');
    expect(svg?.hasAttribute('tight')).toBe(false);
  });
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd electron-agent; npx vitest run src/components/FullscreenLoading.test.tsx
```

预期：FAIL，`tight` 不是合法 prop 或 viewBox 仍是 `0 0 240 220`。

- [ ] **步骤 3：实现 `tight`（electron）**

把 `PiBrandLogo.tsx` 换成：

```tsx
import type { FC, SVGProps } from 'react';

interface PiBrandLogoProps extends Omit<SVGProps<SVGSVGElement>, 'size'> {
  size?: number | string;
  /** 按路径真实轮廓裁切，去掉 240×220 上下留白。启动页动画必须保持默认 viewBox。 */
  tight?: boolean;
}

export const PiBrandLogo: FC<PiBrandLogoProps> = ({ size = '1em', style, tight = false, ...rest }) => (
  <svg
    fill="currentColor"
    fillRule="evenodd"
    height={size}
    style={{ flex: 'none', lineHeight: 1, ...style }}
    viewBox={tight ? '40 56 160 134' : '0 0 240 220'}
    xmlns="http://www.w3.org/2000/svg"
    {...rest}
  >
    <title>GrenAgent</title>
    <path d="M40 56 H200 V84 H40 Z M74 84 H102 V190 H74 Z M150 84 H178 V190 H150 Z" />
  </svg>
);
```

- [ ] **步骤 4：运行测试验证通过（electron）**

```powershell
cd electron-agent; npx vitest run src/components/FullscreenLoading.test.tsx
```

预期：PASS。

- [ ] **步骤 5：tauri 做同样的测试追加和实现**

`tauri-agent` 两个文件与 electron 对应文件同步。跑：

```powershell
cd tauri-agent; npx vitest run src/components/FullscreenLoading.test.tsx
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/src/components/PiBrandLogo.tsx electron-agent/src/components/FullscreenLoading.test.tsx tauri-agent/src/components/PiBrandLogo.tsx tauri-agent/src/components/FullscreenLoading.test.tsx
git commit -m "feat(品牌): PiBrandLogo 支持 tight 裁切字标"
```

---

### 任务 2：EmptyChatPrompt lockup

**文件：**
- 修改：`electron-agent/src/features/chat/EmptyChatPrompt.tsx`
- 修改：`tauri-agent/src/features/chat/EmptyChatPrompt.tsx`
- 创建：`electron-agent/src/features/chat/EmptyChatPrompt.test.tsx`
- 创建：`tauri-agent/src/features/chat/EmptyChatPrompt.test.tsx`

- [ ] **步骤 1：编写失败的测试（electron）**

创建 `electron-agent/src/features/chat/EmptyChatPrompt.test.tsx`：

```tsx
// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmptyChatPrompt } from './EmptyChatPrompt';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';

beforeEach(() => {
  useSidebarPrefsStore.setState({ aliases: {} });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('EmptyChatPrompt', () => {
  it('puts a tight 23px pi to the left of the conversation title', () => {
    render(<EmptyChatPrompt workspace="/works/demo" isConversation />);
    expect(screen.getByRole('heading', { name: '我们该做什么？' })).toBeTruthy();
    const logo = screen.getByTestId('empty-chat-brand');
    expect(logo.getAttribute('viewBox')).toBe('40 56 160 134');
    expect(logo.getAttribute('height')).toBe('23');
    expect(screen.getByTestId('empty-chat-lockup')).toHaveStyle({ gap: '9px' });
  });

  it('uses the same lockup for a project empty state', () => {
    render(<EmptyChatPrompt workspace="D:\\repo\\JSReverser-MCP" isConversation={false} />);
    expect(screen.getByRole('heading', { name: '我们应该在 JSReverser-MCP 中构建什么？' })).toBeTruthy();
    expect(screen.getByTestId('empty-chat-brand')).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd electron-agent; npx vitest run src/features/chat/EmptyChatPrompt.test.tsx
```

预期：FAIL，找不到 `empty-chat-brand`。

- [ ] **步骤 3：实现 lockup（electron）**

把 `EmptyChatPrompt.tsx` 换成：

```tsx
import { createStaticStyles, cssVar } from 'antd-style';
import { PiBrandLogo } from '../../components/PiBrandLogo';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';

export const EMPTY_CHAT_BRAND_SIZE = 23;
export const EMPTY_CHAT_BRAND_GAP = 9;

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    padding: 0 32px 16px;
    text-align: center;
  `,
  lockup: css`
    display: flex;
    align-items: center;
    justify-content: center;
    gap: ${EMPTY_CHAT_BRAND_GAP}px;
  `,
  logo: css`
    flex: 0 0 auto;
    color: ${cssVar.colorText};
    line-height: 1;
  `,
  title: css`
    margin: 0;
    max-width: 520px;
    color: ${cssVar.colorText};
    font-size: 28px;
    font-weight: 500;
    line-height: 1.35;
    letter-spacing: -0.02em;
  `,
}));

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

export interface EmptyChatPromptProps {
  workspace: string;
  /** true = works 目录下的「对话」模式 */
  isConversation: boolean;
}

export function EmptyChatPrompt({ workspace, isConversation }: EmptyChatPromptProps) {
  const alias = useSidebarPrefsStore((s) => s.aliases[workspace]);
  const projectName = alias || basename(workspace);

  const title = isConversation
    ? '我们该做什么？'
    : `我们应该在 ${projectName} 中构建什么？`;

  return (
    <div className={styles.wrap} data-testid="empty-chat-prompt">
      <div className={styles.lockup} data-testid="empty-chat-lockup" style={{ gap: EMPTY_CHAT_BRAND_GAP }}>
        <span className={styles.logo}>
          <PiBrandLogo size={EMPTY_CHAT_BRAND_SIZE} tight data-testid="empty-chat-brand" />
        </span>
        <h1 className={styles.title}>{title}</h1>
      </div>
    </div>
  );
}
```

`style={{ gap: EMPTY_CHAT_BRAND_GAP }}` 是为了 jsdom 能读到 `9px`。css 里的 gap 保留，两处都是 9。

- [ ] **步骤 4：运行测试验证通过（electron）**

```powershell
cd electron-agent; npx vitest run src/features/chat/EmptyChatPrompt.test.tsx
```

预期：PASS。若 `toHaveStyle({ gap: '9px' })` 因数字/字符串失败，改断言 `expect(screen.getByTestId('empty-chat-lockup').style.gap).toBe('9px')`。

- [ ] **步骤 5：tauri 做同样的测试文件和实现**

- [ ] **步骤 6：跑 tauri 测试**

```powershell
cd tauri-agent; npx vitest run src/features/chat/EmptyChatPrompt.test.tsx
```

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add electron-agent/src/features/chat/EmptyChatPrompt.tsx electron-agent/src/features/chat/EmptyChatPrompt.test.tsx tauri-agent/src/features/chat/EmptyChatPrompt.tsx tauri-agent/src/features/chat/EmptyChatPrompt.test.tsx
git commit -m "feat(对话): 空状态标题左侧放 23px π"
```

---

### 任务 3：GrenAgentBrand 去掉 π

**文件：**
- 修改：`electron-agent/src/components/GrenAgentBrand.tsx`
- 修改：`tauri-agent/src/components/GrenAgentBrand.tsx`

此任务没有独立单测：标题栏任务会断言「标题栏没有 π SVG」。这里先改组件，让 Titlebar 仍能编译。

- [ ] **步骤 1：改 electron `GrenAgentBrand`**

```tsx
import { Flexbox } from '@lobehub/ui';

/**
 * 标题栏字样。π 已迁到空会话标题，不再和折叠开关挤在品牌组件里。
 */
export function GrenAgentBrand() {
  return (
    <Flexbox horizontal align="center" gap={8}>
      <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: 1, color: 'var(--gren-fg-muted, #9aa1ac)' }}>
        Gren<span style={{ color: 'var(--gren-fg, #e6e8ec)' }}>Agent</span>
      </span>
    </Flexbox>
  );
}
```

- [ ] **步骤 2：改 electron `Titlebar.tsx` 的调用**

把 `<GrenAgentBrand size={16} />` 改成 `<GrenAgentBrand />`。这一步只删 size，还不加折叠钮。

- [ ] **步骤 3：tauri 做同样两处修改**

- [ ] **步骤 4：Commit**

```bash
git add electron-agent/src/components/GrenAgentBrand.tsx electron-agent/src/components/Titlebar.tsx tauri-agent/src/components/GrenAgentBrand.tsx tauri-agent/src/components/Titlebar.tsx
git commit -m "refactor(标题栏): 品牌组件只保留 GrenAgent 字样"
```

---

### 任务 4：Titlebar 折叠钮

**文件：**
- 修改：`electron-agent/src/components/Titlebar.tsx`
- 修改：`tauri-agent/src/components/Titlebar.tsx`
- 创建：`electron-agent/src/components/Titlebar.test.tsx`
- 创建：`tauri-agent/src/components/Titlebar.test.tsx`

- [ ] **步骤 1：编写失败的测试（electron）**

创建 `electron-agent/src/components/Titlebar.test.tsx`：

```tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Titlebar } from './Titlebar';
import { useLayoutStore } from '../stores/layoutStore';
import { useModuleStore } from '../stores/moduleStore';

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
  useLayoutStore.setState({
    sidebarOpen: true,
    rightPanelOpen: false,
    availableWidth: 0,
    liveSidebarWidth: null,
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Titlebar sidebar toggle', () => {
  it('collapses the sidebar from the titlebar and stays there', () => {
    render(<Titlebar />);
    const toggle = screen.getByTestId('sidebar-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('收起会话列表');
    expect(toggle.getAttribute('data-app-region')).toBe('no-drag');
    fireEvent.click(toggle);
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-label')).toBe('展开会话列表');
    fireEvent.click(screen.getByTestId('sidebar-toggle'));
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });

  it('disables the toggle outside the chat module', () => {
    useModuleStore.setState({ activeModule: 'settings' });
    render(<Titlebar />);
    const toggle = screen.getByTestId('sidebar-toggle');
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });

  it('does not render the pi mark in the titlebar', () => {
    const { container } = render(<Titlebar />);
    expect(container.querySelector('svg[viewBox="0 0 240 220"]')).toBeNull();
    expect(container.querySelector('svg[viewBox="40 56 160 134"]')).toBeNull();
    expect(screen.getByText('Gren')).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd electron-agent; npx vitest run src/components/Titlebar.test.tsx
```

预期：FAIL，找不到 `sidebar-toggle`。

- [ ] **步骤 3：实现 electron Titlebar**

在现有 `styles` 里增加：

```ts
  brandRow: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  `,
  toggle: css`
    -webkit-app-region: no-drag;
  `,
```

增加 import：

```ts
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useLayoutStore, selectSidebarVisible } from '../stores/layoutStore';
import { useModuleStore } from '../stores/moduleStore';
```

`Titlebar` 函数里、`return` 之前增加：

```ts
  const sidebarVisible = useLayoutStore(selectSidebarVisible);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const activeModule = useModuleStore((s) => s.activeModule);
  const chatModule = activeModule === 'chat';
```

把左边品牌那段：

```tsx
      <span data-tauri-drag-region className={styles.title}>
        <GrenAgentBrand size={16} />
      </span>
```

换成：

```tsx
      <div className={styles.brandRow}>
        <ActionIcon
          icon={sidebarVisible ? PanelLeftClose : PanelLeftOpen}
          size={{ blockSize: 28, size: 14 }}
          title={sidebarVisible ? '收起会话列表' : '展开会话列表'}
          className={styles.toggle}
          data-testid="sidebar-toggle"
          data-app-region="no-drag"
          aria-label={sidebarVisible ? '收起会话列表' : '展开会话列表'}
          aria-expanded={sidebarVisible}
          disabled={!chatModule}
          onClick={() => {
            if (!chatModule) return;
            toggleSidebar();
          }}
        />
        <span data-tauri-drag-region className={styles.title}>
          <GrenAgentBrand />
        </span>
      </div>
```

若 `ActionIcon` 不把 `data-testid` / `disabled` / `aria-*` 透传到按钮上，改成外面包一层：

```tsx
        <span
          className={styles.toggle}
          data-testid="sidebar-toggle"
          data-app-region="no-drag"
          aria-expanded={sidebarVisible}
        >
          <ActionIcon
            icon={sidebarVisible ? PanelLeftClose : PanelLeftOpen}
            size={{ blockSize: 28, size: 14 }}
            title={sidebarVisible ? '收起会话列表' : '展开会话列表'}
            aria-label={sidebarVisible ? '收起会话列表' : '展开会话列表'}
            disabled={!chatModule}
            onClick={() => {
              if (!chatModule) return;
              toggleSidebar();
            }}
          />
        </span>
```

此时「禁用」断言改成：外层可点但 `onClick` 因 `!chatModule` 直接 return，`sidebarOpen` 不变；并把 `toBeDisabled()` 改成点外层后状态不变。优先走透传方案。

- [ ] **步骤 4：运行测试验证通过（electron）**

```powershell
cd electron-agent; npx vitest run src/components/Titlebar.test.tsx
```

预期：PASS。

- [ ] **步骤 5：写 tauri `Titlebar.test.tsx`**

文件内容与 electron 相同，但在 import `Titlebar` **之前**加上：

```ts
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
  }),
}));
```

并把 `import { afterEach, beforeEach, describe, expect, it } from 'vitest'` 改成包含 `vi`。

store 的 import 路径与 tauri 目录结构一致（`../stores/layoutStore`、`../stores/moduleStore`，与 electron 相对位置相同）。

- [ ] **步骤 6：改 tauri `Titlebar.tsx`**

与步骤 3 相同。import 窗口 API 仍用 `@tauri-apps/api/window`，不要改成 electron 的 `platform/runtime`。

- [ ] **步骤 7：跑 tauri 测试**

```powershell
cd tauri-agent; npx vitest run src/components/Titlebar.test.tsx
```

预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add electron-agent/src/components/Titlebar.tsx electron-agent/src/components/Titlebar.test.tsx tauri-agent/src/components/Titlebar.tsx tauri-agent/src/components/Titlebar.test.tsx
git commit -m "feat(标题栏): 用折叠图标替换 π 并固定开合位置"
```

---

### 任务 5：去掉侧栏空顶栏

**文件：**
- 修改：`electron-agent/src/features/sessions/Sidebar.tsx`
- 修改：`tauri-agent/src/features/sessions/Sidebar.tsx`
- 修改：`electron-agent/src/App.tsx`
- 修改：`tauri-agent/src/App.tsx`

没有单独的 Sidebar 单测文件。本任务用 TypeScript 编译和「不再出现收起钮」的手工核对（主列回归在任务 6）。

- [ ] **步骤 1：改 electron `Sidebar.tsx`**

1. 删除 `PanelHeader`、`PanelLeftClose` 的 import（`ActionIcon` 仍被分区新建按钮使用，保留）。
2. 从 `SidebarProps` 删除 `onToggleSidebar: () => void;`。
3. 把

```tsx
      <PanelHeader
        actions={<ActionIcon icon={PanelLeftClose} size="small" title="收起" onClick={props.onToggleSidebar} />}
      />
      <SidebarActions />
```

换成：

```tsx
      <SidebarActions />
```

- [ ] **步骤 2：改 electron `App.tsx` 的 `SidebarPanel`**

删除

```ts
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
```

以及传给 `Sidebar` 的 `onToggleSidebar={toggleSidebar}`。若本函数不再使用 `useLayoutStore`，删掉该 import（文件其它地方若仍用则保留）。

- [ ] **步骤 3：确认 electron 能编过**

```powershell
cd electron-agent; npx tsc --noEmit --pretty false
```

预期：无 `onToggleSidebar` 相关报错。若项目 tsc 本来就有无关错误，至少保证 `Sidebar` / `App` 这两处不再报缺失/多余 prop。

- [ ] **步骤 4：tauri 做步骤 1–3**

`tauri-agent/src/features/sessions/Sidebar.tsx` 与 `tauri-agent/src/App.tsx` 同样删法。

```powershell
cd tauri-agent; npx tsc --noEmit --pretty false
```

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/sessions/Sidebar.tsx electron-agent/src/App.tsx tauri-agent/src/features/sessions/Sidebar.tsx tauri-agent/src/App.tsx
git commit -m "fix(侧栏): 去掉空顶栏上的折叠按钮"
```

---

### 任务 6：去掉主列里会跳位的展开钮

**文件：**
- 修改：`electron-agent/src/features/layout/MainColumnHeader.tsx`
- 修改：`tauri-agent/src/features/layout/MainColumnHeader.tsx`
- 测试：`electron-agent/src/features/layout/MainColumnHeader.test.tsx`
- 测试：`tauri-agent/src/features/layout/MainColumnHeader.test.tsx`

- [ ] **步骤 1：编写失败的回归测试（electron）**

在 `MainColumnHeader.test.tsx` 追加：

```ts
  it('does not host the sidebar toggle after collapse', () => {
    useLayoutStore.setState({ sidebarOpen: false, availableWidth: 0 });
    render(<MainColumnHeader />);
    expect(screen.queryByTestId('sidebar-toggle')).toBeNull();
    expect(screen.queryByTitle('Sidebar')).toBeNull();
    expect(screen.queryByTitle('收起会话列表')).toBeNull();
    expect(screen.queryByTitle('展开会话列表')).toBeNull();
  });
```

先跑一次：若当前实现在 `sidebarOpen: false` 时仍渲染 `title="Sidebar"` 的钮，此测试应 FAIL（还能找到 Sidebar）。这就是我们要删的行为。

```powershell
cd electron-agent; npx vitest run src/features/layout/MainColumnHeader.test.tsx
```

- [ ] **步骤 2：删 electron `SidebarToggleButton`**

1. 删除整个 `SidebarToggleButton` 组件。
2. 删除 `MainColumnHeader` 里的 `<SidebarToggleButton />`。
3. 若 `selectSidebarVisible` 不再被本文件使用，从 import 中去掉。
4. 若 `PanelLeftOpen` 不再使用，从 lucide import 中去掉（`PanelRightOpen` 仍给右面板用）。

改完后的 `left` 只剩：

```tsx
        <>
          <WorkspaceTabs />
          <PlanModeBadge />
        </>
```

- [ ] **步骤 3：运行测试验证通过（electron）**

```powershell
cd electron-agent; npx vitest run src/features/layout/MainColumnHeader.test.tsx src/components/Titlebar.test.tsx src/features/chat/EmptyChatPrompt.test.tsx src/components/FullscreenLoading.test.tsx
```

预期：PASS。

- [ ] **步骤 4：tauri 做同样的测试追加和删除**

```powershell
cd tauri-agent; npx vitest run src/features/layout/MainColumnHeader.test.tsx src/components/Titlebar.test.tsx src/features/chat/EmptyChatPrompt.test.tsx src/components/FullscreenLoading.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/layout/MainColumnHeader.tsx electron-agent/src/features/layout/MainColumnHeader.test.tsx tauri-agent/src/features/layout/MainColumnHeader.tsx tauri-agent/src/features/layout/MainColumnHeader.test.tsx
git commit -m "fix(布局): 主列顶栏不再承接跳位的展开钮"
```

---

## 计划自检

**规格覆盖：**

| 规格 | 任务 |
| --- | --- |
| §2.1 标题栏折叠钮、aria、no-drag、仅 chat 可点 | 任务 4 |
| §2.2 去掉侧栏空顶栏和 `onToggleSidebar` | 任务 5 |
| §2.2 去掉主列 `SidebarToggleButton` | 任务 6 |
| §2.3 空状态 23px / 9px / tight viewBox / 同色 | 任务 2 |
| §3 `GrenAgentBrand` 只留字样 | 任务 3 |
| §3 `PiBrandLogo.tight` | 任务 1 |
| §3 electron + tauri 镜像 | 每个任务都有对应步骤 |
| §4 自动收起仍走 `selectSidebarVisible` | 任务 4 用选择器，不改 store |
| §4 非对话模块禁用 | 任务 4 测试 |
| §5 标题栏 / 空状态 / 主列回归 | 任务 1、2、4、6 |
| §6 非目标 | 文件清单未包含那些路径 |

**占位符：** 无 TODO /「适当处理」。`ActionIcon` 若不透传 `data-testid`，任务 4 已写明备用包一层和断言怎么改。

**类型名：** `tight`、`EMPTY_CHAT_BRAND_SIZE`、`EMPTY_CHAT_BRAND_GAP`、`data-testid="sidebar-toggle"`、`data-testid="empty-chat-brand"`、`data-app-region="no-drag"` 前后任务一致。
