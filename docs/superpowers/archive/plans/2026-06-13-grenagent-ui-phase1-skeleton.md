# GrenAgent UI 第 1 期：模块导航骨架 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给 GrenAgent 加左侧模块导航栏（7 模块：对话/知识库/记忆/审查/创作/连接/设置），切换中央主视图；对话模块保留现有完整界面，其余模块先占位。

**架构：** 新增 `moduleStore`（zustand + persist）记当前激活模块；`ModuleRail`（lucide 图标栏）负责切换；`ModuleContainer` 按当前模块渲染（chat 渲染现有界面，其余渲染 `PlaceholderPanel`）；`App.tsx` 的 `Workspace` 在最左插入 `ModuleRail`，中央用 `ModuleContainer` 包住现有布局。

**技术栈：** React 19、zustand（含 `persist` 中间件）、lucide-react、`@lobehub/ui` 的 `Flexbox`、vitest + @testing-library/react。

---

## 范围

仅第 1 期（骨架）。后续期（对话工具卡片增强、知识库+记忆面板、审查+创作面板、连接+设置）各自单独成计划。本期完成后：左侧能切 7 个模块、对话模块功能不变、其余模块显示占位页——可独立运行与测试。

## 文件结构

- 创建 `tauri-agent/src/stores/moduleStore.ts` — 当前激活模块状态（zustand persist）
- 创建 `tauri-agent/src/stores/moduleStore.test.ts` — store 单测
- 创建 `tauri-agent/src/features/workspace/PlaceholderPanel.tsx` — 未实现模块占位
- 创建 `tauri-agent/src/features/workspace/ModuleContainer.tsx` — 按模块渲染中央主视图
- 创建 `tauri-agent/src/features/workspace/ModuleContainer.test.tsx`
- 创建 `tauri-agent/src/features/layout/ModuleRail.tsx` — 左侧模块图标栏
- 创建 `tauri-agent/src/features/layout/ModuleRail.test.tsx`
- 修改 `tauri-agent/src/App.tsx` — `Workspace` 布局插入 `ModuleRail` + `ModuleContainer`

测试命令：`cd tauri-agent && npx vitest run <file>`；类型检查：`cd tauri-agent && npx tsc --noEmit`。

---

## 任务 1：moduleStore

**文件：**
- 创建：`tauri-agent/src/stores/moduleStore.ts`
- 测试：`tauri-agent/src/stores/moduleStore.test.ts`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/stores/moduleStore.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useModuleStore } from './moduleStore';

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
});

describe('moduleStore', () => {
  it('defaults to chat module', () => {
    expect(useModuleStore.getState().activeModule).toBe('chat');
  });

  it('setActiveModule switches the active module', () => {
    useModuleStore.getState().setActiveModule('knowledge');
    expect(useModuleStore.getState().activeModule).toBe('knowledge');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/stores/moduleStore.test.ts`
预期：FAIL，报错 "Cannot find module './moduleStore'"。

- [ ] **步骤 3：编写最少实现代码**

`tauri-agent/src/stores/moduleStore.ts`：

```ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ModuleId =
  | 'chat'
  | 'knowledge'
  | 'memory'
  | 'review'
  | 'create'
  | 'connections'
  | 'settings';

interface ModuleState {
  activeModule: ModuleId;
  setActiveModule: (module: ModuleId) => void;
}

export const useModuleStore = create<ModuleState>()(
  persist(
    (set) => ({
      activeModule: 'chat',
      setActiveModule: (module) => set({ activeModule: module }),
    }),
    {
      name: 'grenagent-module',
      partialize: (state) => ({ activeModule: state.activeModule }),
    },
  ),
);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/stores/moduleStore.test.ts`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/stores/moduleStore.ts tauri-agent/src/stores/moduleStore.test.ts
git commit -m "feat(grenagent): add moduleStore for module navigation"
```

---

## 任务 2：ModuleRail（左侧模块图标栏）

**文件：**
- 创建：`tauri-agent/src/features/layout/ModuleRail.tsx`
- 测试：`tauri-agent/src/features/layout/ModuleRail.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/layout/ModuleRail.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ModuleRail } from './ModuleRail';
import { useModuleStore } from '../../stores/moduleStore';

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
});

describe('ModuleRail', () => {
  it('renders all 7 module buttons', () => {
    render(<ModuleRail />);
    for (const id of ['chat', 'knowledge', 'memory', 'review', 'create', 'connections', 'settings']) {
      expect(screen.getByTestId(`module-${id}`)).toBeTruthy();
    }
  });

  it('switches active module on click', () => {
    render(<ModuleRail />);
    fireEvent.click(screen.getByTestId('module-memory'));
    expect(useModuleStore.getState().activeModule).toBe('memory');
  });

  it('marks the active module with aria-pressed', () => {
    useModuleStore.setState({ activeModule: 'review' });
    render(<ModuleRail />);
    expect(screen.getByTestId('module-review').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('module-chat').getAttribute('aria-pressed')).toBe('false');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/layout/ModuleRail.test.tsx`
预期：FAIL，"Cannot find module './ModuleRail'"。

- [ ] **步骤 3：编写最少实现代码**

`tauri-agent/src/features/layout/ModuleRail.tsx`：

```tsx
import { Brain, FileSearch, type LucideIcon, Image, Library, MessageSquare, Plug, Settings } from 'lucide-react';
import { type ModuleId, useModuleStore } from '../../stores/moduleStore';

interface ModuleDef {
  id: ModuleId;
  label: string;
  Icon: LucideIcon;
  footer?: boolean;
}

const MODULES: ModuleDef[] = [
  { id: 'chat', label: '对话', Icon: MessageSquare },
  { id: 'knowledge', label: '知识库', Icon: Library },
  { id: 'memory', label: '记忆', Icon: Brain },
  { id: 'review', label: '审查', Icon: FileSearch },
  { id: 'create', label: '创作', Icon: Image },
  { id: 'connections', label: '连接', Icon: Plug },
  { id: 'settings', label: '设置', Icon: Settings, footer: true },
];

export function ModuleRail() {
  const activeModule = useModuleStore((s) => s.activeModule);
  const setActiveModule = useModuleStore((s) => s.setActiveModule);

  const renderButton = ({ id, label, Icon }: ModuleDef) => {
    const active = activeModule === id;
    return (
      <button
        key={id}
        data-testid={`module-${id}`}
        title={label}
        aria-label={label}
        aria-pressed={active}
        onClick={() => setActiveModule(id)}
        style={{
          width: 42,
          height: 42,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: 10,
          cursor: 'pointer',
          background: active ? 'var(--gren-rail-active, rgba(255,255,255,0.08))' : 'transparent',
          color: active ? 'var(--gren-fg, inherit)' : 'var(--gren-fg-muted, #9aa1ac)',
        }}
      >
        <Icon size={20} />
      </button>
    );
  };

  return (
    <div
      data-testid="module-rail"
      style={{
        width: 56,
        flex: '0 0 auto',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '10px 0',
        borderRight: '1px solid var(--gren-border, rgba(255,255,255,0.08))',
      }}
    >
      {MODULES.filter((m) => !m.footer).map(renderButton)}
      <div style={{ flex: 1 }} />
      {MODULES.filter((m) => m.footer).map(renderButton)}
    </div>
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/layout/ModuleRail.test.tsx`
预期：PASS（3 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/layout/ModuleRail.tsx tauri-agent/src/features/layout/ModuleRail.test.tsx
git commit -m "feat(grenagent): add ModuleRail module navigation"
```

---

## 任务 3：PlaceholderPanel + ModuleContainer

**文件：**
- 创建：`tauri-agent/src/features/workspace/PlaceholderPanel.tsx`
- 创建：`tauri-agent/src/features/workspace/ModuleContainer.tsx`
- 测试：`tauri-agent/src/features/workspace/ModuleContainer.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/workspace/ModuleContainer.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ModuleContainer } from './ModuleContainer';
import { useModuleStore } from '../../stores/moduleStore';

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
});

describe('ModuleContainer', () => {
  it('renders chat content when chat module is active', () => {
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('CHAT_CONTENT')).toBeTruthy();
  });

  it('renders placeholder with module title for non-chat modules', () => {
    useModuleStore.setState({ activeModule: 'knowledge' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    const panel = screen.getByTestId('placeholder-panel');
    expect(panel.textContent).toContain('知识库');
    expect(screen.queryByText('CHAT_CONTENT')).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/workspace/ModuleContainer.test.tsx`
预期：FAIL，"Cannot find module './ModuleContainer'"。

- [ ] **步骤 3：编写最少实现代码**

`tauri-agent/src/features/workspace/PlaceholderPanel.tsx`：

```tsx
export function PlaceholderPanel({ title }: { title: string }) {
  return (
    <div
      data-testid="placeholder-panel"
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--gren-fg-muted, #9aa1ac)',
        fontSize: 14,
      }}
    >
      {title} · 即将上线
    </div>
  );
}
```

`tauri-agent/src/features/workspace/ModuleContainer.tsx`：

```tsx
import type { ReactNode } from 'react';
import { type ModuleId, useModuleStore } from '../../stores/moduleStore';
import { PlaceholderPanel } from './PlaceholderPanel';

const MODULE_TITLES: Record<Exclude<ModuleId, 'chat'>, string> = {
  knowledge: '知识库',
  memory: '记忆',
  review: '审查',
  create: '创作',
  connections: '连接',
  settings: '设置',
};

export function ModuleContainer({ chat }: { chat: ReactNode }) {
  const activeModule = useModuleStore((s) => s.activeModule);
  if (activeModule === 'chat') return <>{chat}</>;
  return <PlaceholderPanel title={MODULE_TITLES[activeModule]} />;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/workspace/ModuleContainer.test.tsx`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/workspace/PlaceholderPanel.tsx tauri-agent/src/features/workspace/ModuleContainer.tsx tauri-agent/src/features/workspace/ModuleContainer.test.tsx
git commit -m "feat(grenagent): add ModuleContainer + PlaceholderPanel"
```

---

## 任务 4：在 App 中集成 ModuleRail + ModuleContainer

**文件：**
- 修改：`tauri-agent/src/App.tsx`（`Workspace` 组件的 return，约 282–303 行）

- [ ] **步骤 1：加 import**

在 `tauri-agent/src/App.tsx` 顶部 import 区（现有 `import { MainColumnHeader } ...` 附近）加：

```tsx
import { ModuleRail } from './features/layout/ModuleRail';
import { ModuleContainer } from './features/workspace/ModuleContainer';
```

- [ ] **步骤 2：改写 Workspace 的 return**

把 `Workspace` 组件现有的 return（从 `<Flexbox style={{ width: '100vw', height: '100vh', ...`）整体替换为：

```tsx
  return (
    <Flexbox style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <Titlebar />
      <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
        <ModuleRail />
        <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
          <ModuleContainer
            chat={
              <Flexbox horizontal flex={1} style={{ minHeight: 0, height: '100%' }}>
                <SidebarPanel
                  runningSessionPath={runningSessionPath}
                  onNewSession={handleNewSession}
                  onOpenSession={handleOpenSession}
                  onDeleteSession={handleDeleteSession}
                  onSubmitRename={handleSubmitRename}
                />
                <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
                  <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
                    <MainChatColumn />
                    <RightPanelColumn />
                  </Flexbox>
                  <TerminalColumn />
                </Flexbox>
              </Flexbox>
            }
          />
        </Flexbox>
      </Flexbox>
    </Flexbox>
  );
```

- [ ] **步骤 3：类型检查**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 4：跑全部测试**

运行：`cd tauri-agent && npx vitest run`
预期：新增测试全部 PASS，无回归。

- [ ] **步骤 5：手动验证**

运行：`cd tauri-agent && npm run dev`，打开应用。预期：最左出现模块图标栏；默认在「对话」=现有完整界面（会话列表/聊天/终端不变）；点「知识库/记忆/…」中央切到「XX · 即将上线」占位；点回「对话」恢复。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/App.tsx
git commit -m "feat(grenagent): wire ModuleRail + ModuleContainer into App"
```

---

## 自检

**1. 规格覆盖度（对应设计 §3、§7 第 1 期「骨架」）：**
- 模块导航栏（7 模块）→ 任务 2 ModuleRail ✓
- 当前模块状态 → 任务 1 moduleStore ✓
- 按模块切换中央视图 → 任务 3 ModuleContainer ✓
- 其余模块占位 → 任务 3 PlaceholderPanel ✓
- App 布局插入 → 任务 4 ✓
- lucide SVG 图标（§9.1）→ 任务 2 用 lucide-react，无 emoji ✓
- 其余 6 模块的实体视图、对话工具卡片、自动注入 → **不在本期**（后续期计划），符合范围。

**2. 占位符扫描：** 无 TODO/待定；所有步骤含真实代码、命令、预期输出。`PlaceholderPanel` 是有意的产品占位（非计划占位）。

**3. 类型一致性：** `ModuleId`（任务 1 定义）在任务 2/3 一致引用；`useModuleStore` 的 `activeModule`/`setActiveModule` 跨任务一致；`ModuleContainer` 的 `chat: ReactNode` prop 与任务 4 传入一致；`MODULE_TITLES` 用 `Exclude<ModuleId,'chat'>` 与 `activeModule==='chat'` 早返回一致。

## 备注

- CSS 变量名（`--gren-*`）为占位回退值，实现时可对接 `themeStore` 注入的真实变量（参考现有组件的取色方式）；不影响功能与测试。
- vitest 若需要 jsdom 环境，`tauri-agent` 已配置（现有 `*.test.tsx` 同样依赖）。
