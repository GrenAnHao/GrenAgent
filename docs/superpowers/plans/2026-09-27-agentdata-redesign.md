# Agent 数据工作台改版 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按已批准的 `docs/superpowers/specs/2026-09-27-agentdata-redesign-design.md` 改版 Agent 数据工作台六个页面。

**架构：** 先抽共用组件（页头、横幅、更多菜单、列表-详情、状态标签）和统一刷新令牌，再逐页替换版式。数据接口只补三个字段（`recentMemories[].scope/sourceProjectId`、`WikiAssetDetail.sourceCount`、渲染层 `CodeGraphStatus.lastIndexedAt`），不新增 RPC，不改任务调度、Wiki 抽取和 CodeGraph 调用。

**技术栈：** React 19、antd 6（`Tabs`、`Segmented`、`Radio.Group`、`Dropdown`、`Modal`、`Drawer`、`Table`）、antd-style `createStaticStyles`、vitest 4 + Testing Library（jsdom）。

---

## 约定

- 所有命令在 `electron-agent/` 下运行。单测命令：`pnpm test -- <文件>`。
- 工作树里已有未提交改动（`MemoryPanel`、`MemoryEditor`、`JobsPanel`、`useProjectOptions` 及其测试等）。每个任务开始前先 `read` 目标文件的当前内容，在其上修改，不回退别人的改动。
- 每个任务末尾的 commit 步骤：只有用户明确授权提交时才执行；否则跳过，并在汇报里说明“未提交”。提交时只 `git add` 本任务列出的文件。
- 两个汉字的纯文字按钮一律 `autoInsertSpace={false}`。按钮可见文字必须包含在可访问名称中。
- 颜色只用 `cssVar.*`，不写十六进制色值。

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/lib/relativeTime.ts` | 创建 | `formatRelative(ms, now)`，从 `SubAgentCard.tsx` 迁出 |
| `src/lib/relativeTime.test.ts` | 创建 | 相对时间单测 |
| `src/features/subagents/SubAgentCard.tsx` | 修改 | 改为从 `lib/relativeTime` 导入并再导出 |
| `src/features/agentData/workbench/workbenchStyles.ts` | 创建 | 页头、面板、工具条、列表-详情栅格样式 |
| `src/features/agentData/workbench/PageHeader.tsx` | 创建 | 标题 + 副标题 + 右侧操作 |
| `src/features/agentData/workbench/PageBanner.tsx` | 创建 | 合并多条错误/警告/信息为一条横幅 |
| `src/features/agentData/workbench/MoreMenu.tsx` | 创建 | “⋯”下拉菜单，危险项置底 |
| `src/features/agentData/workbench/SplitPane.tsx` | 创建 | 280px 列表 + 详情，<800px 单栏 |
| `src/features/agentData/workbench/StatusTag.tsx` | 创建 | 各域状态到 Tag 颜色的映射 |
| `src/features/agentData/workbench/workbench.test.tsx` | 创建 | 共用组件单测 |
| `src/features/agentData/AgentDataTaskProvider.tsx` | 修改 | 暴露 `activeCount` |
| `src/features/agentData/AgentDataCenter.tsx` | 修改 | 单行顶栏、徽标、`refreshToken` 下发 |
| `src/features/agentData/agentDataStyles.ts` | 修改 | 顶栏样式，删除旧标题区样式 |
| `electron/agentData/operationsContracts.ts` | 修改 | `recentMemories[]` 增加 `scope`、`sourceProjectId` |
| `electron/agentData/runtime.ts` | 修改 | `workbenchOverview()` 填充新字段 |
| `electron/agentData/wikiEngine/service.ts` | 修改 | `WikiAssetDetail.sourceCount` |
| `src/lib/agentData.ts` | 修改 | `CodeGraphStatus.lastIndexedAt` |
| `src/features/agentData/OverviewPanel.tsx` | 重写 | KPI 条 + 三列 |
| `src/features/agentData/MemoryPanel.tsx` / `MemoryList.tsx` / `MemoryDetail.tsx` / `MemoryEditor.tsx` | 修改 | 等级分组、详情头、新增 Modal |
| `src/features/agentData/WikiPanel.tsx` / `wiki/*` | 修改 | 卡片网格、面包屑页头、分段、只读页面 |
| `src/features/agentData/codeIndexPresentation.ts` | 创建 | 索引状态映射纯函数 |
| `src/features/agentData/CodeRetrievalPanel.tsx` / `CodeProjectList.tsx` / `CodeRelations.tsx` / `CodeSourceDetail.tsx` | 修改 | 页头、横幅、单行工具条 |
| `src/features/agentData/JobsPanel.tsx` / `TaskDetailDrawer.tsx` | 修改 | 分段、行点击、抽屉取消 |
| `src/features/agentData/AuditDiagnosticsPanel.tsx` | 修改 | 默认诊断、三格计数、分类分段 |

## 统一刷新契约

`AgentDataCenter` 持有 `refreshToken: number`，顶栏刷新按钮执行 `setRefreshToken((v) => v + 1)`、`refreshResources()`、`monitor.refresh()`。每个面板新增可选 prop `refreshToken?: number`（默认 `0`），并把它加进“读取数据”的 effect 依赖数组，位置与现有 `monitor.watchedTaskVersion` 并列。各任务中删除的面板内刷新按钮，其原来的 `refreshVersion` 计数改由 `refreshToken` 驱动。

---

### 任务 1：相对时间工具迁移

**文件：**
- 创建：`src/lib/relativeTime.ts`
- 创建：`src/lib/relativeTime.test.ts`
- 修改：`src/features/subagents/SubAgentCard.tsx:113-124`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/lib/relativeTime.test.ts
import { describe, expect, it } from 'vitest';
import { formatRelative } from './relativeTime';

describe('formatRelative', () => {
  const now = 1_000_000_000;
  it.each([
    [now - 5_000, '刚刚'],
    [now - 3 * 60_000, '3分钟前'],
    [now - 2 * 3_600_000, '2小时前'],
    [now - 3 * 86_400_000, '3天前'],
    [now + 60_000, '刚刚'],
  ])('formats %d', (ms, expected) => {
    expect(formatRelative(ms, now)).toBe(expected);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- src/lib/relativeTime.test.ts`
预期：FAIL，报错找不到模块 `./relativeTime`。

- [ ] **步骤 3：实现并迁移**

```ts
// src/lib/relativeTime.ts
/** 时间戳 → 中文相对时间（刚刚 / N分钟前 / N小时前 / N天前）。未来时间按“刚刚”处理。 */
export function formatRelative(ms: number, now: number = Date.now()): string {
  const sec = Math.floor(Math.max(0, now - ms) / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  return `${Math.floor(hr / 24)}天前`;
}
```

在 `SubAgentCard.tsx` 中删除第 113–124 行的函数体，在文件顶部 import 区加入：

```ts
import { formatRelative } from '../../lib/relativeTime';
export { formatRelative };
```

保留再导出，是因为其他模块可能从 `SubAgentCard` 导入这个函数。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- src/lib/relativeTime.test.ts src/features/subagents`
预期：PASS。

- [ ] **步骤 5：Commit（需用户授权）**

```bash
git add src/lib/relativeTime.ts src/lib/relativeTime.test.ts src/features/subagents/SubAgentCard.tsx
git commit -m "refactor: move formatRelative into lib"
```

---

### 任务 2：共用工作台组件

**文件：**
- 创建：`src/features/agentData/workbench/workbenchStyles.ts`
- 创建：`src/features/agentData/workbench/PageHeader.tsx`
- 创建：`src/features/agentData/workbench/PageBanner.tsx`
- 创建：`src/features/agentData/workbench/MoreMenu.tsx`
- 创建：`src/features/agentData/workbench/SplitPane.tsx`
- 创建：`src/features/agentData/workbench/StatusTag.tsx`
- 测试：`src/features/agentData/workbench/workbench.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
// src/features/agentData/workbench/workbench.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageHeader } from './PageHeader';
import { PageBanner } from './PageBanner';
import { MoreMenu } from './MoreMenu';
import { SplitPane } from './SplitPane';
import { StatusTag } from './StatusTag';

afterEach(cleanup);

describe('workbench components', () => {
  it('renders a page title, subtitle and actions', () => {
    render(<PageHeader title="任务" subtitle="2 个进行中" actions={<button>清理</button>} />);
    expect(screen.getByRole('heading', { name: '任务' })).toBeInTheDocument();
    expect(screen.getByText('2 个进行中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清理' })).toBeInTheDocument();
  });

  it('merges several messages into one alert and hides when empty', () => {
    const { rerender, container } = render(<PageBanner type="error" items={[{ source: '知识库', message: 'a' }, { source: '页面', message: 'b' }]} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('知识库：a');
    expect(alert).toHaveTextContent('页面：b');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    rerender(<PageBanner type="error" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens a labelled more menu and puts danger items after a divider', async () => {
    const onSelect = vi.fn();
    render(<MoreMenu label="知识库更多操作" items={[{ key: 'del', label: '删除知识库', danger: true }, { key: 'open', label: '打开存储位置' }]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库更多操作' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['打开存储位置', '删除知识库']);
    fireEvent.click(items[1]);
    expect(onSelect).toHaveBeenCalledWith('del');
  });

  it('marks detail visibility for the narrow layout', () => {
    render(<SplitPane detailOpen side={<p>list</p>} main={<p>detail</p>} />);
    expect(screen.getByText('list').closest('[data-detail]')).toHaveAttribute('data-detail', 'true');
  });

  it('maps a domain status to a label', () => {
    render(<StatusTag domain="wiki" status="processing" />);
    expect(screen.getByText('处理中')).toBeInTheDocument();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- src/features/agentData/workbench/workbench.test.tsx`
预期：FAIL，找不到模块 `./PageHeader`。

- [ ] **步骤 3：编写实现**

```ts
// src/features/agentData/workbench/workbenchStyles.ts
import { createStaticStyles, cssVar } from 'antd-style';

export const workbenchStyles = createStaticStyles(({ css }) => ({
  header: css`
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    min-height: 40px; margin-block-end: 12px;
    h2 { margin: 0; font-size: 16px; font-weight: 600; }
  `,
  subtitle: css`color: ${cssVar.colorTextTertiary}; font-size: 13px;`,
  actions: css`display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-inline-start: auto;`,
  banner: css`margin-block-end: 12px;`,
  panel: css`
    display: flex; flex-direction: column; min-width: 0; min-height: 0;
    border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 10px;
    background: ${cssVar.colorBgContainer};
  `,
  panelToolbar: css`
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    min-height: 46px; padding: 8px 12px; border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  split: css`
    container: workbench-split / inline-size;
    display: grid; grid-template-columns: 280px minmax(0, 1fr); flex: 1; min-height: 440px; min-width: 0;
    > [data-split-side] { overflow: auto; padding: 6px; border-inline-end: 1px solid ${cssVar.colorBorderSecondary}; min-width: 0; }
    > [data-split-main] { overflow: auto; padding: 16px 24px; min-width: 0; }
    @container workbench-split (max-width: 799px) {
      grid-template-columns: minmax(0, 1fr);
      &[data-detail='true'] > [data-split-side] { display: none; }
      &[data-detail='false'] > [data-split-main] { display: none; }
    }
  `,
  empty: css`
    display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; min-height: 260px; color: ${cssVar.colorTextQuaternary}; text-align: center;
  `,
  detailHeader: css`
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-block-end: 12px;
    h3 { margin: 0; font-size: 16px; }
  `,
  meta: css`display: flex; flex-wrap: wrap; gap: 6px 14px; margin-block-end: 14px; color: ${cssVar.colorTextTertiary}; font-size: 12px;`,
  spacer: css`margin-inline-start: auto;`,
}));
```

```tsx
// src/features/agentData/workbench/PageHeader.tsx
import type { ReactNode } from 'react';
import { workbenchStyles as s } from './workbenchStyles';

interface Props { title: ReactNode; subtitle?: ReactNode; extra?: ReactNode; actions?: ReactNode }
/** 页头：标题、计数或说明、紧随标题的标签（extra）、右侧操作。 */
export function PageHeader({ title, subtitle, extra, actions }: Props) {
  return <header className={s.header}>
    <h2>{title}</h2>
    {extra}
    {subtitle ? <span className={s.subtitle}>{subtitle}</span> : null}
    {actions ? <div className={s.actions}>{actions}</div> : null}
  </header>;
}
```

```tsx
// src/features/agentData/workbench/PageBanner.tsx
import type { ReactNode } from 'react';
import { Alert } from 'antd';
import { workbenchStyles as s } from './workbenchStyles';

export interface BannerItem { source?: string; message: ReactNode }
interface Props { type: 'error' | 'warning' | 'info'; items: BannerItem[]; action?: ReactNode }
/** 同一类型的多条消息合成一条横幅；每个来源一行。没有消息时不渲染。 */
export function PageBanner({ type, items, action }: Props) {
  if (!items.length) return null;
  const content = items.length === 1 && !items[0].source
    ? items[0].message
    : <div>{items.map((item, index) => <div key={`${item.source ?? ''}:${index}`}>{item.source ? `${item.source}：` : ''}{item.message}</div>)}</div>;
  return <Alert className={s.banner} type={type} showIcon title={content} action={action} role={type === 'info' ? 'status' : 'alert'} />;
}
```

```tsx
// src/features/agentData/workbench/MoreMenu.tsx
import { Button, Dropdown, type MenuProps } from 'antd';
import { Ellipsis } from 'lucide-react';

export interface MoreMenuItem { key: string; label: string; danger?: boolean; disabled?: boolean; title?: string }
interface Props { label: string; items: MoreMenuItem[]; onSelect(key: string): void; disabled?: boolean }
/** “⋯”菜单：普通项在前，危险项在分隔线后。 */
export function MoreMenu({ label, items, onSelect, disabled }: Props) {
  const normal = items.filter((item) => !item.danger);
  const danger = items.filter((item) => item.danger);
  const toEntry = (item: MoreMenuItem) => ({ key: item.key, label: <span title={item.title}>{item.label}</span>, danger: item.danger, disabled: item.disabled });
  const menuItems: MenuProps['items'] = [
    ...normal.map(toEntry),
    ...(normal.length && danger.length ? [{ type: 'divider' as const }] : []),
    ...danger.map(toEntry),
  ];
  return <Dropdown trigger={['click']} disabled={disabled} menu={{ items: menuItems, onClick: ({ key, domEvent }) => { domEvent.stopPropagation(); onSelect(key); } }}>
    <Button aria-label={label} title={label} icon={<Ellipsis size={16} />} onClick={(event) => event.stopPropagation()} />
  </Dropdown>;
}
```

```tsx
// src/features/agentData/workbench/SplitPane.tsx
import type { ReactNode } from 'react';
import { workbenchStyles as s } from './workbenchStyles';

interface Props { detailOpen: boolean; side: ReactNode; main: ReactNode; className?: string }
/** 左列表右详情；容器窄于 800px 时由 data-detail 决定显示哪一栏。 */
export function SplitPane({ detailOpen, side, main, className }: Props) {
  return <div className={`${s.split} ${className ?? ''}`} data-detail={detailOpen}>
    <div data-split-side>{side}</div>
    <div data-split-main>{main}</div>
  </div>;
}
```

```tsx
// src/features/agentData/workbench/StatusTag.tsx
import { Tag } from 'antd';

type Entry = readonly [label: string, color: string];
const maps: Record<string, Record<string, Entry>> = {
  wiki: { draft: ['草稿', 'default'], pending: ['待抽取', 'warning'], processing: ['处理中', 'processing'], ready: ['可用', 'success'], failed: ['失败', 'error'] },
  diagnostic: { action_required: ['需要处理', 'error'], unchecked: ['未检查', 'default'], ok: ['正常', 'success'] },
};
/** 域状态 → 中文标签与 antd 预设色；未知值原样显示为默认色。 */
export function StatusTag({ domain, status }: { domain: keyof typeof maps; status: string }) {
  const [label, color] = maps[domain][status] ?? [status, 'default'];
  return <Tag color={color}>{label}</Tag>;
}
export function statusLabel(domain: keyof typeof maps, status: string): string {
  return maps[domain][status]?.[0] ?? status;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- src/features/agentData/workbench/workbench.test.tsx`
预期：PASS。如果 antd `Dropdown` 在 jsdom 中找不到 `menuitem`，先在测试 `beforeEach` 里调用 `mockWikiBrowser()`（`wiki/wikiTestSupport.ts`，它会补 `ResizeObserver` 和 `matchMedia`）。

- [ ] **步骤 5：Commit（需用户授权）**

```bash
git add src/features/agentData/workbench
git commit -m "feat(agentData): add shared workbench layout components"
```

---

### 任务 3：任务监视器暴露 activeCount

**文件：**
- 修改：`src/features/agentData/AgentDataTaskProvider.tsx:5-17,51-58,133-141,216`
- 测试：`src/features/agentData/AgentDataTaskProvider.test.tsx`（追加用例）

- [ ] **步骤 1：编写失败的测试**

在 `AgentDataTaskProvider.test.tsx` 的 `Consumer` 组件里加一行 `<data value={String(value.activeCount ?? '')} data-testid={`${name}-active`} />`，并追加：

```tsx
it('exposes the server active count including background tasks', async () => {
  vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [asTask(job())], activeCount: 3 });
  render(tree('overview'));
  await flush();
  expect(screen.getByTestId('first-active').getAttribute('value')).toBe('3');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- src/features/agentData/AgentDataTaskProvider.test.tsx -t "active count"`
预期：FAIL，`value` 为空字符串。

- [ ] **步骤 3：实现**

接口 `AgentDataTaskMonitor` 增加字段：

```ts
  /** 服务端活动任务计数（含系统任务）；未获取时为 undefined。 */
  activeCount?: number;
```

组件内增加状态，并在成功刷新处写入：

```ts
const [activeCount, setActiveCount] = useState<number>();
// ……在 `setTasks(unique); setNextCursor(cursor);` 这一行后面加：
setActiveCount(activeCount !== undefined && Number.isSafeInteger(activeCount) && activeCount >= 0 ? activeCount : undefined);
```

Provider value 加入 `activeCount`：

```tsx
return <Context.Provider value={{ jobs, tasks, nextCursor, loadingMore, loadMore, error, loading, loaded, refresh, track, watchedTaskVersion, activeCount }}>{children}</Context.Provider>;
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- src/features/agentData/AgentDataTaskProvider.test.tsx`
预期：PASS，原有用例不回归。

- [ ] **步骤 5：Commit（需用户授权）**

```bash
git add src/features/agentData/AgentDataTaskProvider.tsx src/features/agentData/AgentDataTaskProvider.test.tsx
git commit -m "feat(agentData): expose active task count from the monitor"
```

---

### 任务 4：单行顶栏、徽标与统一刷新

**文件：**
- 修改：`src/features/agentData/AgentDataCenter.tsx`
- 修改：`src/features/agentData/agentDataStyles.ts:15-61`
- 测试：`src/features/agentData/AgentDataCenter.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `AgentDataCenter.test.tsx` 末尾追加：

```tsx
it('shows task and diagnostic badges on their tabs', async () => {
  vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [], activeCount: 2 });
  vi.mocked(agentDataApi.overview).mockResolvedValue({ recentPages: [], recentMemories: [], errors: [], diagnostics: { actionRequired: 1, unchecked: 0 } });
  render(<AgentDataCenter userId="u" />);
  await waitFor(() => expect(within(screen.getByRole('tab', { name: /任务/ })).getByText('2')).toBeTruthy());
  expect(within(screen.getByRole('tab', { name: /审计诊断/ })).getByText('1')).toBeTruthy();
  expect(screen.queryByText(/已加载 \d+ 个任务/)).toBeNull();
});

it('broadcasts one refresh token to every visited panel', async () => {
  render(<AgentDataCenter userId="u" />);
  await screen.findByText('248');
  fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
  await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenCalled());
  const before = vi.mocked(agentDataApi.memory.list).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: '刷新 Agent 数据' }));
  await waitFor(() => expect(vi.mocked(agentDataApi.memory.list).mock.calls.length).toBeGreaterThan(before));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- src/features/agentData/AgentDataCenter.test.tsx`
预期：两个新用例 FAIL（没有徽标；Memory 面板不跟随顶栏刷新）。

- [ ] **步骤 3：实现**

`agentDataStyles.ts`：删除 `header`、`identity`、`icon`、`title`、`subtitle`、`headerActions`，新增：

```ts
  brand: css`
    display: flex; align-items: center; gap: 8px; margin-inline: 20px 16px; white-space: nowrap; font-weight: 600;
    > i { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; font-style: normal;
      background: ${cssVar.colorPrimaryBg}; color: ${cssVar.colorPrimary}; }
    @container agent-data (max-width: 759px) { > span { display: none; } }
  `,
  runtime: css`display: flex; align-items: center; gap: 8px; margin-inline-end: 20px; white-space: nowrap; color: ${cssVar.colorTextTertiary}; font-size: 12px;`,
  tabLabel: css`
    display: inline-flex; align-items: center; gap: 6px;
    @container agent-data (max-width: 759px) {
      [data-tab-text] { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    }
  `,
```

`root` 样式加 `container: agent-data / inline-size;`。`bodyTabs` 追加 `& > .ant-tabs-nav { margin: 0; min-height: 48px; background: ${cssVar.colorBgContainer}; }`。

`AgentDataCenter.tsx`：

```tsx
// AgentDataContent 内新增
const [refreshToken, setRefreshToken] = useState(0);
const activeTasks = monitor.activeCount;
const actionRequired = workbench.data?.diagnostics?.actionRequired;
const refreshAll = () => { setRefreshToken((value) => value + 1); void refreshResources(); void monitor.refresh(); };
const badge = (id: AgentDataTab) => {
  if (id === 'jobs' && activeTasks) return <Badge count={activeTasks} size="small" title="进行中任务（含后台）" />;
  if (id === 'audit' && actionRequired) return <Badge count={actionRequired} size="small" color="red" title="需要处理的诊断" />;
  return null;
};
```

每个 `panelContent` 分支给面板加 `refreshToken={refreshToken}`（`OverviewPanel` 不需要；它的数据来自 `refreshResources`）。

替换 `return` 中的 `<header>…</header>` 与 `<Tabs>`：

```tsx
return <section className={styles.root} data-testid="agent-data-center">
  <Tabs
    id="agent-data"
    activeKey={tab}
    onChange={(key) => selectTab(key as AgentDataTab)}
    className={styles.bodyTabs}
    tabBarExtraContent={{
      left: <div className={styles.brand}><i aria-hidden="true"><BrainCircuit size={14} /></i><span>Agent 数据</span></div>,
      right: <div className={styles.runtime}>
        <Badge status={runtimeState === 'ready' ? 'success' : runtimeState === 'closed' || runtimeState === 'error' ? 'warning' : 'default'} text={runtimeLabel} data-testid="agent-data-runtime" data-state={runtimeState} />
        <Button type="text" aria-label="刷新 Agent 数据" title="刷新 Agent 数据" icon={<RefreshCw size={15} />} disabled={!visible || refreshing} onClick={refreshAll} />
      </div>,
    }}
    items={tabs.map(({ id, label, Icon }) => ({
      key: id,
      label: <span className={styles.tabLabel} title={label}><Icon size={14} aria-hidden="true" /><span data-tab-text>{label}</span>{badge(id)}</span>,
      forceRender: visited.has(id),
      children: <div className={styles.panel}>
        {id === tab && status.error ? <PageBanner type="error" items={[{ source: '运行时', message: status.error }]} /> : null}
        {visited.has(id) ? panelContent(id) : null}
      </div>,
    }))}
  />
</section>;
```

`import { PageBanner } from './workbench/PageBanner';`，并删除不再使用的 `Alert`、`Typography` 导入（`jobs` 分支的 `monitor.error` 改用 `PageBanner`）。

注意：`AgentDataCenter.test.tsx` 里 `getByRole('tab', { name: 'Memory' })` 使用精确名称。徽标只出现在任务和审计页签上，所以 Memory 的名称不受影响。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- src/features/agentData/AgentDataCenter.test.tsx src/features/agentData/AgentDataCenter.navigation.test.tsx src/features/agentData/AgentDataCenter.session.test.tsx`
预期：新用例在后续面板接入 `refreshToken` 前，“broadcasts one refresh token”仍然 FAIL。这个用例保留为红灯，任务 7 完成后必须变绿。其余用例 PASS。

- [ ] **步骤 5：Commit（需用户授权）**

```bash
git add src/features/agentData/AgentDataCenter.tsx src/features/agentData/agentDataStyles.ts src/features/agentData/AgentDataCenter.test.tsx
git commit -m "feat(agentData): single-row shell with task and diagnostic badges"
```

---

### 任务 5：主进程与类型补字段

**文件：**
- 修改：`electron/agentData/operationsContracts.ts:56`
- 修改：`electron/agentData/runtime.ts:255`
- 修改：`electron/agentData/wikiEngine/service.ts:108-117,478-490`
- 修改：`src/lib/agentData.ts:17`
- 修改：`src/features/agentData/wiki/wikiTestData.ts`
- 测试：`electron/agentData/wikiEngine/raw.test.ts`（追加）、`electron/agentData/runtime.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

`raw.test.ts` 追加：

```ts
it('reports the raw source count on the asset detail', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-raw-'));
  const service = new WikiService({ root, db: new DatabaseSync(':memory:'), complete: async () => '' });
  const wiki = service.create({ name: '计数' });
  expect(service.read(wiki.wikiId).sourceCount).toBe(0);
  service.writeRaw(wiki.wikiId, 'a.md', 'a');
  service.writeRaw(wiki.wikiId, 'b.txt', 'b');
  expect(service.read(wiki.wikiId).sourceCount).toBe(2);
  expect(service.list()[0].sourceCount).toBe(2);
});
```

`runtime.test.ts` 追加：

```ts
it('includes ownership on recent overview memories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-recent-'));
  const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
  const client = new AgentDataClient(await runtime.start());
  await client.request('memory.upsert', { userId: 'u', workspace: '/repo-a', level: 2, content: 'scoped fact' });
  const overview = await runtime.requestAdmin<WorkbenchOverview>('admin.overview', { userId: 'u' });
  expect(overview.recentMemories[0]).toMatchObject({ content: 'scoped fact', level: 2, scope: 'project', sourceProjectId: '/repo-a' });
  await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
});
```

在 `runtime.test.ts` 顶部加入 `import type { WorkbenchOverview } from './operationsContracts';`（已有则跳过）。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- electron/agentData/wikiEngine/raw.test.ts electron/agentData/runtime.test.ts`
预期：FAIL，`sourceCount` 为 `undefined`，`scope` 缺失。

- [ ] **步骤 3：实现**

`operationsContracts.ts` 第 56 行改为：

```ts
  recentMemories: Array<{ id: string; content: string; level: number; updatedAt: number; scope?: 'global' | 'project'; sourceProjectId?: string }>;
```

`runtime.ts` 第 255 行的 map 改为：

```ts
.items.map(({ id, content, level, updatedAt, scope, sourceProjectId }) => ({ id, content: content.slice(0, 240), level, updatedAt, scope, ...(sourceProjectId ? { sourceProjectId } : {}) }))
```

`service.ts`：`WikiAssetDetail` 增加 `sourceCount: number | null;`；`rowToDetail` 返回对象增加 `sourceCount: this.countSources(row.wiki_id),`；新增私有方法（`existsSync`、`readdirSync`、`statSync`、`join` 已在本文件导入）：

```ts
  /** raw/sources 下 .md / .txt 文件数；读目录失败时返回 null，不抛错。 */
  private countSources(wikiId: string): number | null {
    const dir = join(this.root, wikiId, 'raw', 'sources');
    try {
      if (!existsSync(dir)) return 0;
      return readdirSync(dir).filter((name) => (name.endsWith('.md') || name.endsWith('.txt')) && statSync(join(dir, name)).isFile()).length;
    } catch { return null; }
  }
```

`src/lib/agentData.ts` 第 17 行 `CodeGraphStatus` 增加 `lastIndexedAt?: number | null;`。

`wiki/wikiTestData.ts` 的 `wikiAsset` 增加 `sourceCount: 1,`，保证类型检查通过。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- electron/agentData/wikiEngine electron/agentData/runtime.test.ts electron/agentData/runtime.operations.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit（需用户授权）**

```bash
git add electron/agentData/operationsContracts.ts electron/agentData/runtime.ts electron/agentData/wikiEngine/service.ts electron/agentData/wikiEngine/raw.test.ts electron/agentData/runtime.test.ts src/lib/agentData.ts src/features/agentData/wiki/wikiTestData.ts
git commit -m "feat(agentData): expose source counts, memory ownership and index time"
```

---

### 任务 6：概览页

**文件：**
- 重写：`src/features/agentData/OverviewPanel.tsx`
- 修改：`src/features/agentData/AgentDataCenter.tsx`（`refreshResources` 与 `overview` 分支）
- 重写：`src/features/agentData/OverviewPanel.test.tsx`

新 props（旧的 `wiki`、`jobs`、`jobsLoading`、`onOpenTask` 删除）：

```ts
export interface ResourceState<T> { data?: T; loading: boolean; error?: string }
interface OverviewPanelProps {
  memory: ResourceState<MemoryOverview>;
  workbench: ResourceState<WorkbenchOverview>;
  libraries: ResourceState<WikiAssetDetail[]>;
  codeProjects: ResourceState<CodeGraphProject[]>;
  tasks: TaskView[];
  tasksLoaded: boolean;
  tasksError?: string;
  onNavigate(tab: AgentDataTab): void;
  onOpenResource(navigation: ResourceNavigation): void;
}
```

- [ ] **步骤 1：重写测试**

```tsx
// src/features/agentData/OverviewPanel.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewPanel } from './OverviewPanel';
import { task } from './operationsTestData';
import { wikiAsset } from './wiki/wikiTestData';
import type { WorkbenchOverview } from '../../lib/agentData';

afterEach(cleanup);
const workbench: WorkbenchOverview = { libraries: { total: 2, pendingSources: 0, pages: 4 }, recentPages: [], recentMemories: [{ id: 'm1', content: '偏好中文', level: 2, updatedAt: Date.now(), scope: 'project', sourceProjectId: 'D:/proj/alpha' }], activeTasks: 1, failedTasks: 2, diagnostics: { actionRequired: 1, unchecked: 0 }, errors: [] };
const base = {
  memory: { loading: false, data: { total: 5, byLevel: { L0: 1, L1: 2, L2: 1, L3: 1 } } },
  workbench: { loading: false, data: workbench },
  libraries: { loading: false, data: [wikiAsset] },
  codeProjects: { loading: false, data: [{ workspace: 'D:/a', indexed: true }, { workspace: 'D:/b', indexed: false }] },
  tasks: [task], tasksLoaded: true,
};

describe('OverviewPanel', () => {
  it('shows the four KPI cells from real sources', () => {
    render(<OverviewPanel {...base} onNavigate={vi.fn()} onOpenResource={vi.fn()} />);
    expect(within(screen.getByRole('button', { name: /条记忆/ })).getByText('5')).toBeInTheDocument();
    expect(screen.getByText('L0 1 · L1 2 · L2 1 · L3 1')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /个知识页面/ })).getByText('4')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /个项目已索引/ })).getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByText('2 个失败')).toBeInTheDocument();
  });
  it('shows the diagnostics banner and navigates to audit', () => {
    const onNavigate = vi.fn();
    render(<OverviewPanel {...base} onNavigate={onNavigate} onOpenResource={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('有 1 项诊断需要处理');
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(onNavigate).toHaveBeenCalledWith('audit');
  });
  it('opens a recent task, library and memory', () => {
    const onOpenResource = vi.fn();
    render(<OverviewPanel {...base} onNavigate={vi.fn()} onOpenResource={onOpenResource} />);
    fireEvent.click(screen.getByRole('button', { name: /查看任务 生成知识页面/ }));
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'jobs', task: task.ref });
    fireEvent.click(screen.getByRole('button', { name: /打开知识库 产品/ }));
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'wiki', kbId: 'k' });
    const memory = screen.getByRole('button', { name: /打开记忆 偏好中文/ });
    expect(memory).toHaveTextContent('L2 · alpha');
    fireEvent.click(memory);
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'memory', id: 'm1' });
    fireEvent.click(screen.getByRole('button', { name: '新建知识库' }));
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'wiki', mode: 'create' });
  });
  it('says 未获取 instead of zero when a source failed', () => {
    render(<OverviewPanel {...base} memory={{ loading: false, error: 'memory unavailable' }} codeProjects={{ loading: false, error: 'x' }} tasksLoaded={false} onNavigate={vi.fn()} onOpenResource={vi.fn()} />);
    expect(within(screen.getByRole('button', { name: /条记忆/ })).getByText('未获取')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /个项目已索引/ })).getByText('未获取')).toBeInTheDocument();
    expect(screen.getByText(/memory unavailable/)).toBeInTheDocument();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- src/features/agentData/OverviewPanel.test.tsx`
预期：FAIL，找不到新的 KPI 文案。

- [ ] **步骤 3：实现 OverviewPanel**

```tsx
// src/features/agentData/OverviewPanel.tsx
import { Button, Empty, Tag } from 'antd';
import type { CodeGraphProject, MemoryOverview, ResourceNavigation, TaskView, WikiAssetDetail, WorkbenchOverview } from '../../lib/agentData';
import type { AgentDataTab } from './agentDataViewTypes';
import { formatRelative } from '../../lib/relativeTime';
import { taskStatusColors, taskStatusLabels } from './operationsPresentation';
import { PageHeader } from './workbench/PageHeader';
import { PageBanner, type BannerItem } from './workbench/PageBanner';
import { StatusTag } from './workbench/StatusTag';
import { overviewStyles as s } from './overviewStyles';

// 此处粘贴本任务开头给出的 ResourceState 与 OverviewPanelProps 两个接口定义（原样）。

const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

export function OverviewPanel({ memory, workbench, libraries, codeProjects, tasks, tasksLoaded, tasksError, onNavigate, onOpenResource }: OverviewPanelProps) {
  const data = workbench.data;
  const levels = memory.data?.byLevel;
  const projects = codeProjects.data;
  const errors: BannerItem[] = [
    memory.error ? { source: '记忆', message: memory.error } : null,
    workbench.error ? { source: '概览', message: workbench.error } : null,
    libraries.error ? { source: '知识库', message: libraries.error } : null,
    codeProjects.error ? { source: '代码索引', message: codeProjects.error } : null,
    tasksError ? { source: '任务', message: tasksError } : null,
    ...(data?.errors ?? []).map((error) => ({ source: error.domain, message: error.message })),
  ].filter(Boolean) as BannerItem[];
  const recentLibraries = [...(libraries.data ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 4);
  const kpis = [
    { tab: 'memory' as const, value: memory.data?.total, label: '条记忆', meta: levels ? `L0 ${levels.L0} · L1 ${levels.L1} · L2 ${levels.L2} · L3 ${levels.L3}` : memory.error ?? '正在加载' },
    { tab: 'wiki' as const, value: data?.libraries?.pages, label: '个知识页面', meta: data?.libraries ? `${data.libraries.total} 个知识库` : '知识库统计未获取' },
    { tab: 'code' as const, value: projects ? `${projects.filter((p) => p.indexed).length} / ${projects.length}` : undefined, label: '个项目已索引', meta: '按已知项目统计' },
    { tab: 'jobs' as const, value: data?.activeTasks, label: '个进行中', meta: data?.failedTasks ? <span className={s.danger}>{data.failedTasks} 个失败</span> : '含后台任务' },
  ];
  return <>
    <PageHeader title="概览" subtitle="全部项目" actions={<>
      <Button onClick={() => onOpenResource({ view: 'memory', mode: 'create' })}>新增记忆</Button>
      <Button type="primary" onClick={() => onOpenResource({ view: 'wiki', mode: 'create' })}>新建知识库</Button>
    </>} />
    <PageBanner type="error" items={errors} />
    {data?.diagnostics?.actionRequired ? <PageBanner type="error" items={[{ message: `有 ${data.diagnostics.actionRequired} 项诊断需要处理` }]} action={<Button size="small" onClick={() => onNavigate('audit')}>查看</Button>} /> : null}
    <div className={s.kpis}>{kpis.map((kpi) => <button key={kpi.tab} type="button" className={s.kpi} aria-label={`${kpi.value ?? '未获取'} ${kpi.label}`} onClick={() => onNavigate(kpi.tab)}>
      <span className={s.kpiValue}>{kpi.value ?? '未获取'}</span>
      <span className={s.kpiLabel}>{kpi.label}</span>
      <span className={s.kpiMeta}>{kpi.meta}</span>
    </button>)}</div>
    <div className={s.columns}>
      <section className={s.list} aria-label="最近任务">
        <div className={s.listHeader}>最近任务<Button type="link" size="small" onClick={() => onNavigate('jobs')}>全部</Button></div>
        {!tasksLoaded ? <Empty description="任务未获取" /> : !tasks.length ? <Empty description="暂无任务" /> : tasks.slice(0, 4).map((item) => <button key={item.key} type="button" className={s.row} aria-label={`查看任务 ${item.label}`} onClick={() => onOpenResource({ view: 'jobs', task: item.ref })}>
          <span className={s.rowMain}>{item.label}<small>{item.stage ?? item.error ?? formatRelative(item.updatedAt)}</small></span>
          <Tag color={taskStatusColors[item.status]}>{item.cancellationRequested ? '正在取消' : taskStatusLabels[item.status]}</Tag>
        </button>)}
      </section>
      <section className={s.list} aria-label="知识库">
        <div className={s.listHeader}>知识库<Button type="link" size="small" onClick={() => onNavigate('wiki')}>全部</Button></div>
        {libraries.data && !recentLibraries.length ? <Empty description="还没有知识库" /> : recentLibraries.map((library) => <button key={library.wikiId} type="button" className={s.row} aria-label={`打开知识库 ${library.name}`} onClick={() => onOpenResource({ view: 'wiki', kbId: library.wikiId })}>
          <span className={s.rowMain}>{library.name}<small>{library.pageCount ?? 0} 页</small></span>
          <StatusTag domain="wiki" status={library.status} />
        </button>)}
      </section>
      <section className={s.list} aria-label="最近记忆">
        <div className={s.listHeader}>最近记忆<Button type="link" size="small" onClick={() => onNavigate('memory')}>全部</Button></div>
        {data && !data.recentMemories.length ? <Empty description="暂无最近记忆" /> : data?.recentMemories.slice(0, 3).map((record) => <button key={record.id} type="button" className={s.row} title={record.content} aria-label={`打开记忆 ${record.content}`} onClick={() => onOpenResource({ view: 'memory', id: record.id })}>
          <span className={s.rowMain}><span className={s.clamp}>{record.content}</span><small>L{record.level} · {record.scope === 'global' ? '全局' : record.sourceProjectId ? basename(record.sourceProjectId) : '未知归属'} · {formatRelative(record.updatedAt)}</small></span>
        </button>)}
      </section>
    </div>
  </>;
}
```

新建 `src/features/agentData/overviewStyles.ts`：

```ts
import { createStaticStyles, cssVar } from 'antd-style';

export const overviewStyles = createStaticStyles(({ css }) => ({
  kpis: css`
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1px; margin-block-end: 16px;
    overflow: hidden; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 10px; background: ${cssVar.colorBorderSecondary};
  `,
  kpi: css`
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 14px 16px; border: 0; text-align: start; cursor: pointer;
    background: ${cssVar.colorBgContainer}; color: ${cssVar.colorText}; font: inherit;
    &:hover { background: ${cssVar.colorFillQuaternary}; }
    &:focus-visible { outline: 2px solid ${cssVar.colorPrimary}; outline-offset: -2px; }
  `,
  kpiValue: css`font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums;`,
  kpiLabel: css`color: ${cssVar.colorTextTertiary}; font-size: 12px;`,
  kpiMeta: css`color: ${cssVar.colorTextTertiary}; font-size: 12px; margin-block-start: 4px;`,
  danger: css`color: ${cssVar.colorError};`,
  columns: css`display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; align-items: start;`,
  list: css`overflow: hidden; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 10px; background: ${cssVar.colorBgContainer};`,
  listHeader: css`display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; font-weight: 500; border-block-end: 1px solid ${cssVar.colorBorderSecondary};`,
  row: css`
    display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 14px; border: 0; text-align: start; cursor: pointer;
    background: none; color: ${cssVar.colorText}; font: inherit;
    & + & { border-block-start: 1px solid ${cssVar.colorFillQuaternary}; }
    &:hover { background: ${cssVar.colorFillQuaternary}; }
    &:focus-visible { outline: 2px solid ${cssVar.colorPrimary}; outline-offset: -2px; }
    small { display: block; margin-block-start: 2px; color: ${cssVar.colorTextTertiary}; font-size: 11px; }
  `,
  rowMain: css`flex: 1; min-width: 0; overflow-wrap: anywhere;`,
  clamp: css`display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;`,
}));
```

`AgentDataCenter.tsx`：增加 `libraries`、`codeProjects` 两个 `ResourceState`。`refreshResources` 改用下面的 `settle` 包装，避免测试替身缺方法时同步抛错打断 `Promise.allSettled`：

```ts
const settle = <T,>(run: () => Promise<T> | undefined) => { try { return Promise.resolve(run()); } catch (cause) { return Promise.reject(cause); } };
const [statusResult, memoryResult, librariesResult, aggregateResult, codeResult] = await Promise.allSettled([
  settle(() => agentDataApi.status()),
  settle(() => userId ? agentDataApi.memory.overview({ userId, includeOtherProjects: true }) : undefined),
  settle(() => agentDataApi.wiki.list()),
  settle(() => agentDataApi.overview({ userId: userId ?? 'local' })),
  settle(() => agentDataApi.code.projects()),
]);
```

删除 `wiki` 状态与 `agentDataApi.wiki.overview()` 调用（概览不再显示最新更新时间）。`overview` 分支改为：

```tsx
return <OverviewPanel memory={memory} workbench={workbench} libraries={libraries} codeProjects={codeProjects} tasks={monitor.tasks} tasksLoaded={monitor.loaded} tasksError={monitor.error} onNavigate={selectTab} onOpenResource={navigate} />;
```

`AgentDataCenter.test.tsx` 的调整：
- 第 71 行 `expect(agentDataApi.wiki.overview).toHaveBeenCalled()` 改成 `expect(agentDataApi.wiki.list).toHaveBeenCalled()`。
- 第 119、131 行等待 `'12'` 的地方改为等 KPI 页面数：在 `beforeEach` 里让 `agentDataApi.overview` 返回 `libraries: { total: 1, pendingSources: 0, pages: 12 }`，断言文本不变。
- 第 121 行 `getByRole('button', { name: /^Memory/ })` 改成 `getByRole('button', { name: /条记忆/ })`。
- `AgentDataCenter.navigation.test.tsx` 与 `.session.test.tsx` 的 mock 已替换 `OverviewPanel`；它们的 `agentDataApi` mock 缺 `wiki.list`、`code.projects`，靠 `settle` 兜底，不需要改。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- src/features/agentData/OverviewPanel.test.tsx src/features/agentData/AgentDataCenter`
预期：PASS（任务 4 中“broadcasts one refresh token”那个用例仍可能是红灯，任务 7 完成后必须通过）。

- [ ] **步骤 5：Commit（需用户授权）**

```bash
git add src/features/agentData/OverviewPanel.tsx src/features/agentData/overviewStyles.ts src/features/agentData/OverviewPanel.test.tsx src/features/agentData/AgentDataCenter.tsx src/features/agentData/AgentDataCenter.test.tsx
git commit -m "feat(agentData): rebuild the overview as a KPI strip and three lists"
```

---

### 任务 7：Memory 页

**文件：**
- 修改：`src/features/agentData/MemoryPanel.tsx`
- 修改：`src/features/agentData/MemoryList.tsx`
- 修改：`src/features/agentData/MemoryDetail.tsx:61-72`
- 修改：`src/features/agentData/MemoryEditor.tsx:8,12,112-118`
- 修改：`src/features/agentData/memoryStyles.ts`
- 测试：`src/features/agentData/MemoryPanel.test.tsx`、`MemoryEditor.test.tsx`、`MemoryDetail.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `MemoryPanel.test.tsx` 末尾（`describe` 内）追加：

```tsx
it('groups by level with totals and requests the chosen level from the server', async () => {
  vi.mocked(agentDataApi.memory.overview).mockResolvedValue({ total: 7, byLevel: { L0: 1, L1: 2, L2: 3, L3: 1 } });
  render(<MemoryPanel userId="u" />);
  expect(await screen.findByText('7 条记忆')).toBeTruthy();
  expect(screen.getByRole('radio', { name: /L2.*3/ })).toBeChecked();
  await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'u', filter: { scope: 'all' }, level: 2, limit: 50 }));
  fireEvent.click(screen.getByRole('radio', { name: /L3/ }));
  await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'u', filter: { scope: 'all' }, level: 3, limit: 50 }));
  expect(screen.queryByRole('radio', { name: '全部' })).toBeNull();
});
it('moves to the saved level and says so', async () => {
  vi.mocked(agentDataApi.memory.list).mockResolvedValue({ items: [{ ...memoryRecord, level: 2 }] });
  vi.mocked(agentDataApi.memory.read).mockResolvedValue({ ...memoryRecord, level: 2 });
  vi.mocked(agentDataApi.memory.update).mockResolvedValue({ ...memoryRecord, level: 3, revision: 2 });
  render(<MemoryPanel userId="u" />); await openRecord();
  fireEvent.click(screen.getByRole('button', { name: '编辑记忆' }));
  await pickSelectOption('编辑记忆层级', /L3/);
  fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
  expect(await screen.findByText('已保存，已移到 L3')).toBeTruthy();
  expect(screen.getByRole('radio', { name: /L3/ })).toBeChecked();
});
it('creates in a modal defaulting to the current group level', async () => {
  render(<MemoryPanel userId="u" />); await screen.findByText('2 条记忆');
  fireEvent.click(screen.getByRole('radio', { name: /L3/ }));
  fireEvent.click(screen.getByRole('button', { name: '新增记忆' }));
  const dialog = await screen.findByRole('dialog', { name: '新增记忆' });
  expectSelectDisplay('编辑记忆层级', /L3/);
  fireEvent.change(within(dialog).getByLabelText('记忆正文'), { target: { value: '新条目' } });
  await pickSelectOption('归属范围', '全局');
  fireEvent.click(within(dialog).getByRole('button', { name: '保存记忆' }));
  await waitFor(() => expect(agentDataApi.memory.create).toHaveBeenCalledWith({ userId: 'u', draft: { content: '新条目', level: 3, owner: { scope: 'global' } } }));
});
it('reloads its list when the shared refresh token changes', async () => {
  const { rerender } = render(<MemoryPanel userId="u" refreshToken={0} />);
  await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenCalledTimes(1));
  rerender(<MemoryPanel userId="u" refreshToken={1} />);
  await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenCalledTimes(2));
});
```

文件顶部加一个菜单点击工具，给改动后的删除用例使用：

```tsx
async function chooseMenu(label: string, item: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}
```

现有用例按下列规则调整：
- `memoryRecord.level` 为 1，默认分组是 L2，会让列表查询带 `level: 2`。`beforeEach` 中 `memory.list` 的 mock 忽略参数，所以行仍然出现，不必改数据；但所有 `toHaveBeenCalledWith`/`toHaveBeenLastCalledWith({ userId, filter, limit: 50 })` 的断言要在对象里加 `level: 2`（第 106、109、120 行）。对话记录那条（第 141 行）不加 `level`。
- `本用户记忆总数：2` → `2 条记忆`（第 107、114、123、138、211、216、219、250、279 行）。
- `getByRole('tab', { name: '对话记录' })` → `getByRole('radio', { name: '对话记录' })`（第 124、139 行）。
- `fireEvent.click(screen.getByRole('button', { name: '删除记忆' }))` → `await chooseMenu('记忆更多操作', '删除记忆')`（第 187、225、229 行）。
- 第 161 行 `fireEvent.click(screen.getByRole('button', { name: '刷新 Memory' }))` → `rerender(<MemoryPanel userId="u" refreshToken={1} />)`。
- 第 298 行新建草稿的期望 `level: 1` → `level: 2`（在默认 L2 分组下新建）。
- 第 231、246 行“返回记忆列表”按钮保留（窄屏返回按钮，宽屏用 CSS 隐藏，jsdom 中仍可点）。

`MemoryDetail.test.tsx`：第 17 行保持；第 34–35 行保持（对话记录不渲染编辑与更多菜单）。追加：

```tsx
it('offers delete and open-session in the more menu', async () => {
  const onDelete = vi.fn();
  render(<MemoryDetail value={{ kind: 'memory', record: memoryRecord }} onEdit={vi.fn()} onDelete={onDelete} onOpenSession={vi.fn()} />);
  await screen.findByText('已有来源会话');
  fireEvent.click(screen.getByRole('button', { name: '记忆更多操作' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除记忆' }));
  expect(onDelete).toHaveBeenCalledOnce();
});
```

`MemoryDetail.test.tsx` 顶部需要 `import { mockWikiBrowser } from './wiki/wikiTestSupport';` 并在 `beforeEach` 中调用，给 antd Dropdown 提供 `matchMedia`。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- src/features/agentData/MemoryPanel.test.tsx src/features/agentData/MemoryDetail.test.tsx`
预期：新增用例 FAIL（没有分组单选、没有更多菜单）。

- [ ] **步骤 3：实现**

`MemoryEditor.tsx`：

```ts
interface Props { userId: string; record?: ManagedMemoryRecord; initialLevel?: 1 | 2 | 3; projects: Array<{ cwd: string; name: string }>; unavailable?: boolean; onUnavailable?(): void; onSaved(record: ManagedMemoryRecord): void; onCancel(): void }
const newDraft = (userId: string, targetKey: string, base?: ManagedMemoryRecord, initialLevel: MemoryLevel = 1): DraftState => ({ userId, targetKey, base, content: base?.content ?? '', level: base?.level ?? initialLevel, owner: ownerValue(base), source: base?.source ?? '' });
```

组件内 `useState(() => newDraft(userId, targetKey, record, initialLevel))`；`apply` 中调用 `newDraft(nextUser, targetKey, next, initialLevel)`。`dirty` 的等级基准改成 `draft.base?.level ?? initialLevel ?? 1`。工具栏按钮顺序改为 `关闭编辑`、`保存记忆`，文字不变，放在 `m.toolbar` 右侧（加 `style={{ marginInlineStart: 'auto' }}` 的容器）。

`MemoryDetail.tsx`：把第 62–66 行 toolbar 替换为详情头：

```tsx
<div className={m.toolbar}>
  {value.kind === 'memory' ? <Tag color="processing">L{value.record.level}</Tag> : <Tag>对话记录</Tag>}
  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{value.kind === 'memory' ? memoryLevelLabels[value.record.level] : '只读'}</Typography.Text>
  <span style={{ marginInlineStart: 'auto' }} />
  {value.kind === 'memory' && onEdit ? <Button data-memory-edit onClick={onEdit}>编辑记忆</Button> : null}
  {value.kind === 'memory' && (onDelete || onOpenSession) ? <MoreMenu label="记忆更多操作" items={[
    ...(onOpenSession ? [{ key: 'open', label: '打开来源会话', disabled: !status.session, title: !id ? '未记录来源' : status.state === 'error' ? '来源状态未获取' : status.session ? undefined : '会话已移除' }] : []),
    ...(onDelete ? [{ key: 'delete', label: '删除记忆', danger: true }] : []),
  ]} onSelect={(key) => { if (key === 'open') void open(); if (key === 'delete') onDelete?.(); }} /> : null}
</div>
```

导入 `Tag` 与 `MoreMenu`。来源一节和它自己的“打开来源会话”按钮保留，现有断言依赖它。

`MemoryList.tsx`：行下方元信息去掉等级前缀（分组已表达等级），改为 `{scope} · {formatRelative(updatedAt)}`；`scope` 对项目路径取目录名，`title` 保留完整路径。对话记录行保持 `对话记录 · {workspace 目录名} · 时间`。

`MemoryPanel.tsx`：

```ts
type Group = '0' | '1' | '2' | '3' | 'conversation';
const [group, setGroup] = useState<Group>('2');
const kind: MemoryItem['kind'] = group === 'conversation' ? 'conversation' : 'memory';
const level = group === 'conversation' ? undefined : Number(group) as MemoryLevel;
```

删除原来的 `kind`、`level` 两个 state 和 `setKind`、`setLevel` 调用：导航分支中原来的 `setKind('memory')` 与 `setLevel('all')` 改为在读到记录后执行 `setGroup(String(record.level) as Group)`（在详情 effect 的成功回调里，如果 `target.kind === 'memory'` 且来源是导航，就切组；用 `navigationVersion` 对应的 ref 标记）。`useMemoryBrowser` 调用改为 `level`（不再有 `'all'`）。`saved` 回调：

```ts
const moved = record.level !== level && group !== 'conversation';
if (moved) setGroup(String(record.level) as Group);
setNotice(moved ? `已保存，已移到 L${record.level}` : matches ? '记忆已保存。' : '已保存，但当前筛选不包含这条记忆。');
```

新增 props `refreshToken?: number`，并入 `reloadVersion`：`const reloadVersion = monitor.watchedTaskVersion + refreshVersion + refreshToken;`。删除“刷新 Memory”按钮。

版式：

```tsx
<PageHeader title="Memory" subtitle={`${overviewValue?.value?.total ?? '—'} 条记忆`} actions={<Button type="primary" data-memory-new disabled={locked} onClick={openCreate}>新增记忆</Button>} />
<Radio.Group aria-label="记忆分组" optionType="button" value={group} disabled={locked} onChange={(event) => { setGroup(event.target.value); clearSelection(); }} className={m.groups}
  options={[
    ...(['0', '1', '2', '3'] as const).map((value) => ({ value, label: <span title="全部项目的总数">L{value}<span className={m.count}>{overviewValue?.value?.byLevel[`L${value}`] ?? '—'}</span></span> })),
    { value: 'conversation', label: '对话记录', className: m.gap },
  ]} />
<PageBanner type="error" items={[
  ...(monitor.error ? [{ message: `任务状态读取失败：${monitor.error}` }] : []),
  ...(overviewValue?.error ? [{ source: '记忆总数', message: overviewValue.error }] : []),
  ...(browser.error ? [{ message: `${browser.loaded ? '刷新失败，已保留当前列表：' : '读取失败：'}${browser.error}` }] : []),
]} />
<div className={w.panel}>
  <div className={w.panelToolbar}>
    <Typography.Text type="secondary">{group === 'conversation' ? '对话记录只读。对话捕获没有全局层，按原始项目保存；此处仅查看，不支持编辑或删除。' : memoryLevelLabels[Number(group) as MemoryLevel]}</Typography.Text>
    <span className={w.spacer} />
    <Input aria-label="搜索记忆" placeholder="搜索内容" …原有 props… style={{ width: 200 }} />
    <Select aria-label="项目范围" …原有 props… />
  </div>
  <SplitPane detailOpen={!!activeSelection} side={…列表区原内容…} main={…详情区原内容（不含新建编辑器）…} />
</div>
<Modal open={editor?.trigger === 'new'} title="新增记忆" footer={null} destroyOnHidden onCancel={() => void (editorHandle.current?.confirmLeave() ?? Promise.resolve(true)).then((ok) => { if (ok) setEditor(undefined); })}>
  {editor?.trigger === 'new' ? <MemoryEditor ref={editorHandle} key={`new:${editorVersion}`} userId={userId} initialLevel={group === '1' || group === '3' ? Number(group) as 1 | 3 : 2} projects={projects} onSaved={saved} onCancel={() => setEditor(undefined)} /> : null}
</Modal>
```

其中 `openCreate = () => { setEditor({ userId, trigger: 'new' }); setNotice(undefined); }`。编辑已有记录（`trigger === 'edit'`）仍在 `main` 里渲染 `MemoryEditor`。

注意：`MemoryPanel.test.tsx` 第 38 行 “opens an initial navigation request under StrictMode” 与第 71 行依赖导航 `mode: 'create'` 打开编辑器；Modal 渲染在 portal 中，`findByLabelText('记忆正文')` 仍能找到，不需要改。

`memoryStyles.ts` 追加：

```ts
  groups: css`margin-block-end: 12px;`,
  count: css`margin-inline-start: 6px; color: ${cssVar.colorTextQuaternary}; font-size: 12px; .ant-radio-button-wrapper-checked & { color: inherit; opacity: .75; }`,
  gap: css`margin-inline-start: 12px; border-radius: 6px !important;`,
```

`layout` 与 `detail` 样式改由 `SplitPane` 承担后删除；`[data-memory-back]` 按钮加类 `backButton: css\`@container workbench-split (min-width: 800px) { display: none; }\``。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- src/features/agentData/MemoryPanel.test.tsx src/features/agentData/MemoryEditor.test.tsx src/features/agentData/MemoryDetail.test.tsx src/features/agentData/useMemoryBrowser.test.tsx src/features/agentData/AgentDataCenter.test.tsx`
预期：全部 PASS，包括任务 4 留下的 “broadcasts one refresh token”。

- [ ] **步骤 5：Commit（需用户授权）**

```bash
git add src/features/agentData/MemoryPanel.tsx src/features/agentData/MemoryList.tsx src/features/agentData/MemoryDetail.tsx src/features/agentData/MemoryEditor.tsx src/features/agentData/memoryStyles.ts src/features/agentData/MemoryPanel.test.tsx src/features/agentData/MemoryDetail.test.tsx src/features/agentData/MemoryEditor.test.tsx
git commit -m "feat(agentData): browse memory by level with an in-place editor"
```

---

### 任务 8：Wiki 列表与工作区

**文件：**
- 修改：`src/features/agentData/WikiPanel.tsx`
- 修改：`src/features/agentData/wiki/WikiLibraryList.tsx`
- 修改：`src/features/agentData/wiki/WikiLibraryWorkspace.tsx`
- 修改：`src/features/agentData/wiki/WikiPageEditor.tsx`
- 修改：`src/features/agentData/wiki/wikiStyles.ts`
- 测试：`wiki/WikiLibraryList.test.tsx`、`wiki/WikiLibraryWorkspace.test.tsx`、`wiki/WikiPageEditor.test.tsx`

- [ ] **步骤 1：调整并新增测试**

`WikiLibraryList.test.tsx`：
- 第 19、31 行点击“刷新知识库”改为 `rerender(<WikiLibraryList visible onOpen={onOpen} refreshVersion={0} refreshToken={1} />)`（第 13 行的 `render` 需要解构 `rerender`）。
- 第 66 行改为：

```tsx
fireEvent.click(screen.getByRole('button', { name: '知识库 产品 更多操作' }));
fireEvent.click(await screen.findByRole('menuitem', { name: '删除知识库' }));
```

追加：

```tsx
it('shows source and page counts on the card', async () => {
  vi.mocked(agentDataApi.wiki.list).mockResolvedValue([{ ...wikiAsset, pageCount: 3, sourceCount: 2 }]);
  render(<WikiLibraryList visible onOpen={vi.fn()} refreshVersion={0} />);
  expect(await screen.findByText('3 页 · 2 份资料')).toBeVisible();
  expect(screen.queryByLabelText('知识库排序')).toBeNull();
});
```

`WikiLibraryWorkspace.test.tsx`：
- 第 27、35、38 行 `getByRole('tab', …)` 改为 `getByRole('radio', …)`（antd `Segmented` 的选项是 radio）；`'检索与图谱'` 改为 `'检索'`。
- 第 45–46 行菜单改为 `fireEvent.click(await screen.findByRole('menuitem', { name: '删除知识库' }))`。
- 第 55 行 `wiki-busy-tag` 改为 `expect(await screen.findByText(/正在抽取，完成前内容只读/)).toBeVisible()`。
- 第 57、62、63 行“重置状态”改为从更多菜单点“重置为草稿”，并先断言菜单项可用：

```tsx
fireEvent.click(screen.getByRole('button', { name: '知识库更多操作' }));
expect(await screen.findByRole('menuitem', { name: '重置为草稿' })).not.toHaveAttribute('aria-disabled', 'true');
```

- 第 61、90 行点击“刷新当前知识库”改为 `rerender(<WikiLibraryWorkspace {...props} visible refreshToken={1} />)`。
- 第 72 行 `wiki-ingest-notice` 保留。

追加：

```tsx
it('polls while processing and stops afterwards', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(agentDataApi.wiki.read).mockResolvedValue({ ...wikiAsset, status: 'processing', internalStatus: 'ingesting' });
  render(<WikiLibraryWorkspace {...props} visible />);
  expect(await screen.findByText(/抽取页面/)).toBeVisible();
  const calls = vi.mocked(agentDataApi.wiki.read).mock.calls.length;
  vi.mocked(agentDataApi.wiki.read).mockResolvedValue({ ...wikiAsset, status: 'ready' });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  await waitFor(() => expect(agentDataApi.wiki.read.mock.calls.length).toBeGreaterThan(calls));
  const settled = vi.mocked(agentDataApi.wiki.read).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(agentDataApi.wiki.read).toHaveBeenCalledTimes(settled);
  vi.useRealTimers();
});
it('shows pages read-only until edit, and confirms deletion', async () => {
  vi.mocked(agentDataApi.wiki.read).mockResolvedValue({ ...wikiAsset, status: 'ready' });
  render(<WikiLibraryWorkspace {...props} visible />);
  fireEvent.click(await screen.findByRole('radio', { name: /知识页面/ }));
  fireEvent.click(await screen.findByRole('button', { name: '查看页面 说明' }));
  expect(await screen.findByText('# 页面正文')).toBeVisible();
  expect(screen.queryByLabelText('Markdown 正文')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '编辑页面' }));
  expect(screen.getByLabelText('Markdown 正文')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '页面更多操作' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除页面' }));
  fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(agentDataApi.wiki.pageRemove).toHaveBeenCalledWith('k', 'concepts/auth'));
});
```

`WikiPageEditor.test.tsx` 第 26 行删除用例：编辑器不再自带删除按钮，删除改由工作区菜单触发，所以删掉这个用例（上面的工作区用例已覆盖删除）。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- src/features/agentData/wiki`
预期：FAIL。

- [ ] **步骤 3：实现**

`WikiLibraryList.tsx`：
- 删除排序 `Select` 与刷新按钮。`sorted` 固定按 `updatedAt` 倒序。Props 增加 `refreshToken?: number` 并入读取 effect 依赖。
- 页头换成 `<PageHeader title="知识库" subtitle={`${rows.length} 个`} actions={<><Input aria-label="搜索知识库" … style={{ width: 200 }} /><Button type="primary" onClick={() => setDialog({})}>新建知识库</Button></>} />`。
- 卡片：

```tsx
<Card key={row.wikiId} hoverable tabIndex={0} aria-label={`知识库 ${row.name}`} onClick={() => onOpen(row.wikiId)} onKeyDown={…原有…}>
  <div className={w.libraryHeader}>
    <Button type="link" aria-label={`打开知识库 ${row.name}`} onClick={(event) => { event.stopPropagation(); onOpen(row.wikiId); }}>{row.name}</Button>
    <MoreMenu label={`知识库 ${row.name} 更多操作`} items={[{ key: 'props', label: '属性' }, { key: 'open', label: '打开存储位置' }, { key: 'delete', label: '删除知识库', danger: true }]}
      onSelect={async (key) => {
        if (key === 'props') setDialog({ library: row });
        if (key === 'open') void openPath(row.dir).catch((cause) => setError(String(cause)));
        if (key === 'delete' && (!onBeforeDelete || await onBeforeDelete(row.wikiId))) { setConfirmName(''); setDeleteError(undefined); setDeleteTarget(row); }
      }} />
  </div>
  <Typography.Text type="secondary">{row.summary || '未填写用途'}</Typography.Text>
  <div className={w.libraryMeta}><StatusTag domain="wiki" status={row.status} /><span>{row.pageCount ?? 0} 页 · {row.sourceCount ?? '未知'} 份资料</span></div>
  {row.status === 'failed' && row.syncError ? <Typography.Text type="danger">{row.syncError}</Typography.Text> : null}
</Card>
```

导入 `openPath` 自 `../../../platform/runtime`。列表容器样式 `w.list` 改为 `display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px;`。

`WikiLibraryWorkspace.tsx`：
- Props 增加 `refreshToken?: number`，`reload` 的依赖加入它（在 `useEffect(() => { void reload(); … }, [reload, refreshToken])`）。
- 删除刷新按钮、属性按钮、属性抽屉（`properties` 状态与 `Drawer`）、独立“重置状态”按钮。
- 页头：

```tsx
<PageHeader
  title={<nav aria-label="面包屑"><Button type="link" className={w.crumb} aria-label="返回知识库列表" onClick={() => onBack()}>知识库</Button> / {library?.name ?? '知识库'}</nav>}
  extra={library ? <StatusTag domain="wiki" status={library.status} /> : null}
  subtitle={`${sourcesLoaded ? sources.length : '未获取'} 份资料 · ${library?.pageCount ?? pages.length} 页`}
  actions={<>
    <Button type="primary" disabled={readOnly || !sources.length || ingesting} onClick={() => void startIngest()}>{busy ? '抽取中…' : '开始抽取'}</Button>
    <MoreMenu label="知识库更多操作" items={[
      { key: 'props', label: '编辑属性' },
      { key: 'open', label: '打开存储位置', disabled: !library?.dir },
      { key: 'reset', label: '重置为草稿', disabled: !canReset || resetting },
      { key: 'delete', label: '删除知识库', danger: true, disabled: !library || unavailable },
    ]} onSelect={(key) => {
      if (key === 'props') setLibraryDialog(true);
      if (key === 'open' && library?.dir) void openPath(library.dir).catch(reportPathError);
      if (key === 'reset') void resetDraft();
      if (key === 'delete') { setConfirmName(''); setDeleteOpen(true); }
    }} />
  </>} />
```

- 横幅：

```tsx
const stageLabels: Record<string, string> = { scanning: '扫描原文', ingesting: '抽取页面', 'rebuilding-index': '重建索引' };
// …
{library?.status === 'processing' ? <PageBanner type="info" items={[{ message: `正在抽取，完成前内容只读${library.internalStatus ? ` · ${stageLabels[library.internalStatus] ?? library.internalStatus}` : ''}` }]} /> : null}
{library?.status === 'failed' && library.syncError ? <PageBanner type="error" items={[{ source: '抽取失败', message: library.syncError }]} /> : null}
<PageBanner type="error" items={Object.entries(errors).map(([source, message]) => ({ source, message }))} />
```

`ingestNotice` 的 `Alert`（`data-testid="wiki-ingest-notice"`）保留，放在横幅下方。

- 轮询：

```ts
useEffect(() => {
  if (!visible || library?.status !== 'processing' || ingesting) return;
  const timer = setTimeout(() => { void reload(); }, 2000);
  return () => clearTimeout(timer);
}, [visible, library?.status, library?.version, library?.updatedAt, ingesting, reload]);
```

每次 `reload` 返回新对象都会触发下一轮；状态离开 `processing` 后停止。

- 分段控件替换 `role="tablist"` 按钮组：

```tsx
<Segmented value={tab} onChange={(value) => setTab(value as typeof tab)} options={[
  { value: 'sources', label: `原始资料 (${sourcesLoaded ? sources.length : '未获取'})` },
  { value: 'pages', label: `知识页面 (${pagesLoaded ? pages.length : '未获取'})` },
  { value: 'templates', label: '抽取模板' },
  { value: 'search', label: '检索' },
]} />
```

放进 `w.panelToolbar`（来自 `workbenchStyles`），右侧放筛选框（资料和页面分段共用一个 `Input`，`aria-label` 分别保持“搜索原始资料”“搜索知识页面”）与“上传原文”（仅资料分段）。

- 资料与页面用 `SplitPane`。资料详情头增加确认：

```tsx
<Button danger disabled={readOnly} onClick={async () => { if (await ask({ title: `删除资料 ${selectedSource}？`, content: '删除后需要重新上传。', danger: true })) void agentDataApi.wiki.rawRemove(kbId, selectedSource).then(() => { setSelectedSource(undefined); void reload(); }).catch((cause) => setErrors((current) => ({ ...current, 删除资料: String(cause) }))); }}>删除资料</Button>
```

`ask` 来自 `useAskConfirm()`。测试环境：`WikiLibraryWorkspace.test.tsx` 顶部加 `vi.mock('../../../components/askConfirm', () => ({ useAskConfirm: () => async () => true }));`。

- 页面详情：新增状态 `editingPage: boolean`（切换页面时设为 `false`）。只读视图：

```tsx
<div className={w.detailHeader}>
  <Button className={w.back} aria-label="关闭页面详情" onClick={closePage}>←</Button>
  <h3>{pageTitle}</h3><Tag>{pageType}</Tag><span className={w.spacer} />
  <Button disabled={readOnly} onClick={() => setEditingPage(true)}>编辑页面</Button>
  <MoreMenu label="页面更多操作" items={[{ key: 'delete', label: '删除页面', danger: true, disabled: readOnly }]} onSelect={() => setPageDeleteOpen(true)} />
</div>
<div className={w.document}><LazyMarkdown prose={false}>{selectedPageContent ?? '正在读取页面…'}</LazyMarkdown></div>
<Modal open={pageDeleteOpen} title="确认删除页面" okText="确认删除" cancelText="取消" okButtonProps={{ danger: true, autoInsertSpace: false }}
  onCancel={() => setPageDeleteOpen(false)}
  onOk={() => void agentDataApi.wiki.pageRemove(kbId, selectedPageId!).then(() => { setPageDeleteOpen(false); closePage(); void reload(); }).catch((cause) => setErrors((current) => ({ ...current, 删除页面: String(cause) })))}>
  <p>删除后不可恢复。</p>
</Modal>
```

编辑视图：`<WikiPageEditor … onClose={() => setEditingPage(false)} onSaved={() => { setEditingPage(false); void reload(); }} />`。`closePage` 在编辑中先调 `editor.current?.confirmDiscard()`。

- 模板分段：两个编辑器并排（`display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px`），各自标题行放文件名、说明（“这个库用来做什么” / “抽取出哪些页面类型”）和保存按钮；按钮名称保持“保存 purpose.md”“保存 schema.md”。
- 检索分段：结果为空时显示 `图谱共 ${graphEdges.length} 条边`。

`WikiPageEditor.tsx`：删除“删除页面”按钮、`onDeleted` prop 与 `remove` 函数；把“← 返回页面列表”改成“取消”（`aria-label` 保持“关闭页面详情”），“保存页面”保留，两者放在工具条右侧。

`WikiPanel.tsx`：`refreshToken` 透传给 `WikiLibraryList` 与 `WikiLibraryWorkspace`。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- src/features/agentData/wiki src/features/agentData/AgentDataCenter.test.tsx`
预期：PASS。`AgentDataCenter.test.tsx` 中 “starts wiki ingest” 用例依赖“打开知识库 产品”和“开始抽取”，名称未变。

- [ ] **步骤 5：Commit（需用户授权）**

```bash
git add src/features/agentData/WikiPanel.tsx src/features/agentData/wiki
git commit -m "feat(agentData): wiki card grid, breadcrumb header and read-only pages"
```

---

### 任务 9：代码索引页

**文件：**
- 创建：`src/features/agentData/codeIndexPresentation.ts`
- 创建：`src/features/agentData/codeIndexPresentation.test.ts`
- 修改：`src/features/agentData/CodeRetrievalPanel.tsx`
- 修改：`src/features/agentData/CodeProjectList.tsx`
- 修改：`src/features/agentData/CodeRelations.tsx:42-49`
- 修改：`src/features/agentData/CodeSourceDetail.tsx:87-97`
- 测试：`CodeRetrievalPanel*.test.tsx`、`CodeRelations.test.tsx`、`CodeSourceDetail.test.tsx`

- [ ] **步骤 1：编写状态映射的失败测试**

```ts
// src/features/agentData/codeIndexPresentation.test.ts
import { describe, expect, it } from 'vitest';
import { codeIndexPresentation } from './codeIndexPresentation';

const ws = 'D:/a';
describe('codeIndexPresentation', () => {
  it.each([
    [{ workspace: ws, connected: true, indexed: true, state: 'indexed' }, '已索引', undefined, true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'stale' }, '索引过期', 'warning', true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'partial' }, '索引不完整', 'warning', true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'failed', message: 'boom' }, '索引失败', 'error', true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'indexing' }, '索引中', 'info', false, 'none'],
    [{ workspace: ws, connected: false, indexed: false, state: 'unavailable' }, '未索引', undefined, false, 'build'],
    [{ workspace: ws, connected: false, indexed: false, sdkAvailable: false, state: 'sdk_unavailable' }, 'SDK 不可用', 'error', false, 'none'],
  ] as const)('maps %o', (status, label, banner, canQuery, primary) => {
    const view = codeIndexPresentation({ status, checking: false });
    expect(view.label).toBe(label);
    expect(view.banner?.type).toBe(banner);
    expect(view.canQuery).toBe(canQuery);
    expect(view.primary).toBe(primary);
  });
  it('reports checking and read errors', () => {
    expect(codeIndexPresentation({ checking: true })).toMatchObject({ label: '检查中', canQuery: false, primary: 'none' });
    expect(codeIndexPresentation({ checking: false, error: '断开' })).toMatchObject({ label: '未获取', banner: { type: 'error' }, primary: 'none' });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- src/features/agentData/codeIndexPresentation.test.ts`
预期：FAIL，找不到模块。

- [ ] **步骤 3：实现映射**

```ts
// src/features/agentData/codeIndexPresentation.ts
import type { CodeGraphStatus } from '../../lib/agentData';

export interface CodeIndexView {
  label: string;
  color: 'default' | 'success' | 'warning' | 'error' | 'processing';
  banner?: { type: 'info' | 'warning' | 'error'; message: string; sync: boolean };
  canQuery: boolean;
  /** 页头主按钮：同步索引 / 建立索引 / 不显示可用按钮。 */
  primary: 'sync' | 'build' | 'none';
}

/** 把 CodeGraph 状态映射成页面呈现；检查中与读取失败优先。 */
export function codeIndexPresentation({ status, checking, error }: { status?: CodeGraphStatus; checking: boolean; error?: string }): CodeIndexView {
  if (error) return { label: '未获取', color: 'default', banner: { type: 'error', message: `${error}${status ? ' 当前保留上次成功读取的索引状态。' : ''}`, sync: false }, canQuery: false, primary: 'none' };
  if (checking || !status) return { label: '检查中', color: 'default', canQuery: false, primary: 'none' };
  const state = status.state?.toLowerCase().replace(/-/g, '_');
  if (status.sdkAvailable === false || state === 'sdk_unavailable') return { label: 'SDK 不可用', color: 'error', banner: { type: 'error', message: `内置 CodeGraph SDK 不可用，请检查安装包${status.message ? `：${status.message}` : ''}`, sync: false }, canQuery: false, primary: 'none' };
  if (state === 'indexing') return { label: '索引中', color: 'processing', banner: { type: 'info', message: '正在更新索引', sync: false }, canQuery: false, primary: 'none' };
  if (!status.indexed || state === 'unavailable') return { label: '未索引', color: 'default', canQuery: false, primary: 'build' };
  if (state === 'stale') return { label: '索引过期', color: 'warning', banner: { type: 'warning', message: '索引已过期，结果可能不准', sync: true }, canQuery: true, primary: 'sync' };
  if (state === 'partial') return { label: '索引不完整', color: 'warning', banner: { type: 'warning', message: '上次索引未完成，下次同步会全量重建', sync: true }, canQuery: true, primary: 'sync' };
  if (state === 'failed') return { label: '索引失败', color: 'error', banner: { type: 'error', message: status.message ?? '上次索引失败', sync: true }, canQuery: true, primary: 'sync' };
  return { label: '已索引', color: 'success', canQuery: true, primary: 'sync' };
}
```

运行：`pnpm test -- src/features/agentData/codeIndexPresentation.test.ts`，预期 PASS。

- [ ] **步骤 4：调整面板测试**

- `CodeRetrievalPanel.test.tsx` 第 52 行、`CodeRetrievalPanel.navigation.test.tsx` 第 70 行：`'该项目尚未建立 CodeGraph 索引'` → `'这个项目还没有索引'`。
- `CodeRetrievalPanel.test.tsx` 第 82 行、`.workbench.test.tsx` 第 223 行的 `queryByText` 同样替换。
- `CodeRetrievalPanel.test.tsx` 第 84、85、91 行与 `.workbench.test.tsx` 第 151、210、222 行的统计断言，从 `'A / B / C'` 改为分别断言 `'12 文件'`、`'未提供 节点'` 这种格式：
  - `'未提供 / 未提供 / 未提供'` → `expect(screen.getByText('未提供 文件')).toBeTruthy()`
  - `'0 / 0 / 0'` → `expect(await screen.findByText('0 文件')).toBeTruthy()`
  - `'12 / 未提供 / 未提供'` → `expect(await screen.findByText('12 文件')).toBeTruthy(); expect(screen.getByText('未提供 节点')).toBeTruthy();`
  - `/99 \/ /` → `/^99 文件/`
- 项目下拉选项文字从 `alpha · D:/proj/alpha（未检查）` 改为主行 `alpha`、第二行路径与状态。`pickSelectOption('项目', /^alpha ·/)` 这类正则改为 `/^alpha/`；`expectSelectDisplay('项目', /^B ·/)` 改为 `/^B/`；`getByRole('option', { name: /alpha.*未检查/ })` 保持（选项的 `title` 保留 `alpha · D:/proj/alpha（未检查）`）。
- `.workbench.test.tsx` 第 122 行 `'符号搜索'` → `'符号'`，按钮改为 `Segmented` 后用 `getByRole('radio', { name: '符号' })`；第 83 行 `'相关上下文'` 同样改用 `radio`。
- 删除依赖“刷新代码工作区”的点击，改为 `rerender(<CodeRetrievalPanel … refreshToken={1} />)`。
- `CodeRelations.test.tsx` 第 105 行：删除按钮点击，改为 `rerender(<CodeRelations workspace="D:/repo" symbol="parse" visible reloadVersion={1} />)`（第 102 行 `render` 解构出 `rerender`）。第 48、50、58 行的 `tab` 改为 `radio`（关系分段改为 `Segmented`）。
- `CodeSourceDetail.test.tsx` 第 43、86、136 行点击“重新读取源码”：组件新增 `reloadVersion?: number` prop，改为 `rerender(<CodeSourceDetail … reloadVersion={1} />)`（136 行在隐藏态下用 `visible={false} reloadVersion={1}`，再 `visible reloadVersion={1}`）。

- [ ] **步骤 5：实现面板**

`CodeRetrievalPanel.tsx`：
- Props 增加 `refreshToken?: number`；把 `refreshVersion` state 替换为 `refreshToken` 与“刷新状态”菜单的本地计数之和：`const [statusVersion, setStatusVersion] = useState(0); const reload = refreshToken + statusVersion;`，原来依赖 `refreshVersion` 的 effect 改依赖 `reload`（导航 effect 中 `setRefreshVersion` 改为 `setStatusVersion`）。
- `const view = codeIndexPresentation({ status: currentStatus, checking, error: statusError });`，`canQuery` 改为 `Boolean(project) && view.canQuery`。
- 页头：

```tsx
<PageHeader title="代码索引"
  extra={<><CodeProjectList options={options} project={project} indexState={indexState} status={statusError ? undefined : currentStatus} onSelect={selectProject} />{project ? <Tag color={view.color}>{view.label}</Tag> : null}
    {project && currentStatus?.indexed ? <span className={styles.stats}>
      <span>{currentStatus.files ?? '未提供'} 文件</span><span>{currentStatus.nodes ?? '未提供'} 节点</span><span>{currentStatus.edges ?? '未提供'} 边</span>
      {currentStatus.lastIndexedAt ? <span title={new Date(currentStatus.lastIndexedAt).toLocaleString()}>同步于 {formatRelative(currentStatus.lastIndexedAt)}</span> : null}
    </span> : null}</>}
  actions={project ? <>
    {view.primary !== 'none' ? <Button type={view.primary === 'build' ? 'primary' : 'default'} disabled={!visible || syncing} onClick={() => void sync()}>{view.primary === 'build' ? '建立索引' : '同步索引'}</Button> : null}
    <MoreMenu label="代码索引更多操作" items={[{ key: 'status', label: '刷新状态' }, { key: 'open', label: '打开项目目录' }]}
      onSelect={(key) => { if (key === 'status') setStatusVersion((v) => v + 1); if (key === 'open') void openPath(project).catch((cause) => setTaskError(errorText(cause))); }} />
  </> : null} />
```

- `sync()` 的前置条件由 `!currentStatus || checking || statusError` 改为 `view.primary === 'none'`。
- 横幅区：`view.banner` 渲染为 `PageBanner`（`sync: true` 时 `action={<Button size="small" onClick={() => void sync()}>同步</Button>}`）；`createdTask` 卡片改为 `PageBanner type="info"`，文案 `已加入任务 · {nameOf(workspace)} · {workspace} · {taskSummary ?? '任务状态未获取'}`，`action` 为“查看任务”按钮；`taskError`、`indexError`、`monitor.error` 合并进一条 `PageBanner type="error"`（`monitor.error` 的文案保持 `任务状态刷新失败：…；显示的旧状态不是最新结果。`）。`currentStatus.message` 只在 `view.banner` 未包含时追加。
- 删除“Code Retrieval”标题、统计卡片、“刷新代码工作区”、`statusLabel` 文本、未索引的 warning Alert。
- 未索引时内容区：`<div className={w.empty}>这个项目还没有索引<Typography.Text type="secondary">{project}</Typography.Text><Button type="primary" onClick={() => void sync()}>建立索引</Button></div>`。注意页头也有“建立索引”；`CodeRetrievalPanel.tasks.test.tsx` 第 33 行 `findByRole('button', { name: '建立索引' })` 会匹配到两个，改为 `(await screen.findAllByRole('button', { name: '建立索引' }))[0]`。
- 查询面板：

```tsx
<div className={w.panel}>
  <div className={w.panelToolbar}>
    <Input ref={queryInput} aria-label="搜索代码" placeholder={mode === 'search' ? '搜索符号或文件名；留空浏览文件' : '描述要找的功能'} value={query} onChange={(event) => changeQuery(event.target.value)} disabled={!canQuery} style={{ flex: 1 }} />
    <Segmented value={mode} disabled={!canQuery} onChange={(value) => changeMode(value as 'search' | 'explore')} options={[{ value: 'search', label: '符号' }, { value: 'explore', label: '相关上下文', disabled: !query.trim() }]} />
  </div>
  <SplitPane detailOpen={Boolean(selected)} side={…结果区…} main={selected ? …详情区… : <div className={w.empty}>搜索符号或文件，选择结果查看源码与调用关系</div>} />
</div>
```

结果区顶部加 `{currentResult?.result ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{currentResult.result.rows.length} 个结果</Typography.Text> : null}`；查询错误保留为结果区内的 `Alert`（它说明“当前显示上次成功读取的结果”，属于局部状态）。详情区“返回结果列表”按钮保留名称，加窄屏类。`CodeSourceDetail` 与 `CodeRelations` 传 `reloadVersion={reload + monitor.watchedTaskVersion}`。

`CodeProjectList.tsx`：去掉说明段；`Select` 宽度 `max-width: 360px`；选项：

```tsx
options={[{ value: '', label: '请选择项目' }, ...options.map((option) => ({ value: option.cwd, title: `${option.name} · ${option.cwd}（${stateLabel(option.cwd)}）`, label: <span>{option.name}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{option.cwd} · {stateLabel(option.cwd)}</Typography.Text></span> }))]}
optionLabelProp="title"
```

`optionLabelProp` 让选中后的显示值是一行的 `title`，`expectSelectDisplay('项目', /^B/)` 可以命中。

`CodeRelations.tsx`：删除“刷新关系”按钮；`Tabs` 换成 `Segmented`（选项“调用者”“被调用者”“影响”）；外层去掉 `styles.card` 的边框卡片，只留 `section aria-label="代码关系"`。

`CodeSourceDetail.tsx`：Props 增加 `reloadVersion?: number`，读取 effect 依赖由 `refreshVersion` 改为 `reloadVersion`，删除“重新读取源码”按钮和 `refreshVersion` state。“复制相对路径”“使用系统打开文件”名称不变。

`codeStyles.ts` 追加 `stats: css\`display: flex; flex-wrap: wrap; gap: 12px; color: ${cssVar.colorTextTertiary}; font-size: 12px;\``，删除不再使用的 `card`、`heading`、`layout`。

- [ ] **步骤 6：运行测试验证通过**

运行：`pnpm test -- src/features/agentData/codeIndexPresentation.test.ts src/features/agentData/CodeRetrievalPanel src/features/agentData/CodeRelations.test.tsx src/features/agentData/CodeSourceDetail.test.tsx src/features/agentData/codeResult.test.ts`
预期：PASS。

- [ ] **步骤 7：Commit（需用户授权）**

```bash
git add src/features/agentData/codeIndexPresentation.ts src/features/agentData/codeIndexPresentation.test.ts src/features/agentData/CodeRetrievalPanel.tsx src/features/agentData/CodeProjectList.tsx src/features/agentData/CodeRelations.tsx src/features/agentData/CodeSourceDetail.tsx src/features/agentData/codeStyles.ts src/features/agentData/CodeRetrievalPanel.test.tsx src/features/agentData/CodeRetrievalPanel.navigation.test.tsx src/features/agentData/CodeRetrievalPanel.tasks.test.tsx src/features/agentData/CodeRetrievalPanel.workbench.test.tsx src/features/agentData/CodeRelations.test.tsx src/features/agentData/CodeSourceDetail.test.tsx
git commit -m "feat(agentData): code index header with mapped index states"
```

---

### 任务 10：任务页与详情抽屉

**文件：**
- 修改：`src/features/agentData/JobsPanel.tsx`
- 修改：`src/features/agentData/TaskDetailDrawer.tsx:100-142`
- 修改：`src/features/agentData/operationsStyles.ts`
- 测试：`JobsPanel.test.tsx`、`JobsPanel.operations.test.tsx`、`TaskDetailDrawer.test.tsx`

- [ ] **步骤 1：调整并新增测试**

`JobsPanel.test.tsx`：
- “filters by state”（第 99–104 行）改为：

```tsx
it('groups active and history tasks', async () => {
  render(<JobsPanel jobs={jobs} />);
  expect(screen.getByText('wiki.sync')).toBeTruthy();
  expect(screen.queryByText('codegraph.sync')).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: /历史/ }));
  expect(screen.queryByText('wiki.sync')).toBeNull();
  expect(screen.getByText('codegraph.sync')).toBeTruthy();
});
```

- 默认分组是“进行中”，所以只含终态任务的用例要先切到“历史”：第 111 行 `it.each(terminalJobs)`、第 134、189、244、256、279 行的用例，在 `render` 之后加 `fireEvent.click(screen.getByRole('radio', { name: /历史/ }))`。第 83 行“lists jobs…”、第 146、172、213、222、266 行混有终态与活动任务的用例，改为先点 `radio` “全部”。
- 第 146–170 行：`pickSelectOption('任务状态', '失败')` 改为点“历史”；最后恢复时 `pickSelectOption('任务状态', '全部状态')` 改为点“全部”。第 213–220 行同理：“运行中”改为点“进行中”，“全部状态”改为点“全部”。
- 第 235 行“所有按钮禁用”的断言会匹配到分段 radio（它们不是 button，不受影响），保持。
- 旧的 `jobs` prop 分支（`legacyTaskView`）保留，不删。

`JobsPanel.operations.test.tsx`：
- 第 110、137 行点击“详情”按钮，改为点击整行：`fireEvent.click(screen.getByRole('row', { name: /第二任务/ }))`、`fireEvent.click(screen.getByRole('row', { name: /生成知识页面/ }))`。
- `task` 状态是 `failed`，默认“进行中”看不到它。在 `beforeEach` 之后，所有 `render(<JobsPanel tasks={…} />)` 的用例要么先点“全部”，要么让测试直接传 `initialGroup="all"`。采用后者：`JobsPanel` 新增 prop `initialGroup?: 'active' | 'history' | 'all'`（默认 `'active'`），本文件所有 `render(<JobsPanel` 加 `initialGroup="all"`。`JobsPanel.test.tsx` 也可以用这种方式代替上面的点击，二选一，保持一致即可。
- 追加：

```tsx
it('opens detail from the row with Enter but not from row actions', async () => {
  render(<JobsPanel tasks={[task]} initialGroup="all" />);
  const row = screen.getByRole('row', { name: /生成知识页面/ });
  fireEvent.click(within(row).getByRole('button', { name: '删除' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  row.focus();
  fireEvent.keyDown(row, { key: 'Enter' });
  await waitFor(() => expect(agentDataApi.tasks.read).toHaveBeenCalledWith(task.ref));
});
it('shows an empty active group with a way to history', () => {
  render(<JobsPanel tasks={[task]} />);
  expect(screen.getByText('没有进行中的任务')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查看历史' }));
  expect(screen.getByText('生成知识页面')).toBeInTheDocument();
});
```

第一个用例中删除按钮会触发 `ask`；本文件没有 mock `useAskConfirm`，在顶部加 `vi.mock('../../components/askConfirm', () => ({ useAskConfirm: () => async () => false }));`，让确认直接返回 false，不走删除请求。

`TaskDetailDrawer.test.tsx` 追加：

```tsx
it('cancels from the drawer after rechecking capability', async () => {
  const running = { ...taskDetail, status: 'running' as const, capabilities: { cancel: true, retry: false, remove: false } };
  vi.mocked(agentDataApi.tasks.read).mockResolvedValue(running);
  vi.mocked(agentDataApi.jobs.cancel).mockResolvedValue(undefined);
  const onRefresh = vi.fn();
  render(<TaskDetailDrawer taskRef={task.ref} onClose={vi.fn()} onRefresh={onRefresh} />);
  fireEvent.click(await screen.findByRole('button', { name: '取消任务' }));
  await waitFor(() => expect(agentDataApi.jobs.cancel).toHaveBeenCalledWith(task.ref.id));
  expect(agentDataApi.tasks.read).toHaveBeenCalledTimes(2);
  expect(onRefresh).toHaveBeenCalled();
});
```

如果 `TaskDetailDrawer.test.tsx` 的 `agentDataApi` mock 没有 `jobs.cancel`，在 mock 里加上 `jobs: { cancel: vi.fn() }`。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- src/features/agentData/JobsPanel.test.tsx src/features/agentData/JobsPanel.operations.test.tsx src/features/agentData/TaskDetailDrawer.test.tsx`
预期：FAIL。

- [ ] **步骤 3：实现**

`JobsPanel.tsx`：
- 删除 `status` state 与“任务状态”`Select`；`group` 类型改为 `'active' | 'history' | 'all'`，初值 `initialGroup ?? 'active'`；筛选条件 `(group === 'all' || (group === 'history') === isTerminalTask(task.status))`。外部选中任务时 `setGroup('all')`。
- 分组计数只算用户任务：`const counts = { active: userAll.filter((t) => !isTerminalTask(t.status)).length, history: userAll.filter((t) => isTerminalTask(t.status)).length }`，其中 `userAll = tasks.filter((t) => t.ref.source === 'user')`。
- 页头：`<PageHeader title="任务" subtitle={`${counts.active} 个进行中`} actions={<Button danger icon={<Trash2 size={12} aria-hidden="true" />} onClick={() => void clear()} disabled={busy || !removable.length}>清理已结束 ({removable.length})</Button>} />`。清理按钮名称变为“清理已结束 (N)”，测试里所有 `{ name: '清理已结束' }` 改为 `{ name: /^清理已结束/ }`（`JobsPanel.test.tsx` 第 44、57、64、67、153、182、193、206、216、219、231、248、271、284 行；`JobsPanel.operations.test.tsx` 第 44、57、64、67 行）。
- 工具条：`Segmented`（选项 `进行中 {n}`、`历史 {n}`、`全部`）、搜索、类型、工作区；下方保留说明文字。
- 列：删除“详情”按钮；新增“时间”列 `render: (_, task) => <span title={new Date(task.updatedAt).toLocaleString()}>{formatRelative(task.updatedAt)}</span>`；“工作区 / 资源”列显示目录名（`workspaceFilterLabel(task.workspace, allPaths)`），`title` 为完整路径（保证 `getByTitle(workspace)` 仍能命中，且 `toHaveTextContent(workspace)` 断言需改为 `toHaveTextContent('a-very-long-workspace-name')`，见 `JobsPanel.operations.test.tsx` 第 159 行）。
- 操作列按钮包在 `<span className={ops.rowActions} onClick={(event) => event.stopPropagation()}>…</span>`。
- `onRow`：

```tsx
onRow={(task) => ({
  'aria-selected': taskKey(task.ref) === selectionKey,
  className: taskKey(task.ref) === selectionKey ? styles.selectedRow : undefined,
  tabIndex: 0,
  onClick: (event) => openTask(task, event.currentTarget as HTMLElement),
  onKeyDown: (event) => { if (event.key === 'Enter' && event.target === event.currentTarget) openTask(task, event.currentTarget as HTMLElement); },
})}
```

旧的非 modern 分支（`jobs` prop）没有抽屉，`onClick` 只在 `modern` 时绑定。
- 空态：`group === 'active' && !userTasks.length` 时显示 `<Empty description="没有进行中的任务"><Button onClick={() => setGroup('history')}>查看历史</Button></Empty>`；否则 `暂无匹配任务`。
- 系统区按钮文字改为 `系统后台任务（{n}）· 只读{systemOpen ? ' · 收起' : ' · 展开'}`。

`operationsStyles.ts` 追加：

```ts
  rowActions: css`
    display: inline-flex; gap: 4px; opacity: 0;
    tr:hover &, tr:focus-within & { opacity: 1; }
    @media (hover: none) { opacity: 1; }
  `,
```

`TaskDetailDrawer.tsx`：`Drawer` 的 `title` 换成 `extra`，放“取消任务”和“重试任务”：

```tsx
const cancel = async () => {
  if (!selected || busyRef.current || !visible) return;
  const stable = selected; const request = epoch.current;
  busyRef.current = true; setBusy(true); setMutationError(undefined);
  try {
    const latest = await agentDataApi.tasks.read(stable);
    if (!valid(request)) return;
    if (!latest || latest.ref.source !== 'user' || !latest.capabilities.cancel) throw new Error('当前不允许取消此任务，请刷新后重试');
    await agentDataApi.jobs.cancel(stable.id);
    await onRefresh?.();
    if (valid(request)) setLoadRequest((value) => value + 1);
  } catch (cause) { if (valid(request)) setMutationError(message(cause)); }
  finally { if (valid(request)) { busyRef.current = false; setBusy(false); } }
};
```

`extra={detail?.ref.source === 'user' ? <Space size={8}>{detail.capabilities.cancel && !detail.cancellationRequested ? <Button disabled={busy} onClick={() => void cancel()}>取消任务</Button> : null}<Button disabled={busy || !detail.capabilities.retry} onClick={() => void prepareRetry()}>重试任务</Button></Space> : null}`。删除执行摘要区里的“重试任务”按钮（避免重名）。`detail.error` 从执行摘要移到信息区上方的 `PageBanner type="error"`，`action` 为“查看关联资源”（有 `resource` 时）。资源区原有“查看关联资源”按钮在有错误横幅时不再重复渲染；`TaskDetailDrawer.test.tsx` 第 93 行 `findByRole('button', { name: '查看关联资源' })` 仍只命中一个。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- src/features/agentData/JobsPanel.test.tsx src/features/agentData/JobsPanel.operations.test.tsx src/features/agentData/TaskDetailDrawer.test.tsx src/features/agentData/AgentDataCenter.navigation.test.tsx`
预期：PASS。

- [ ] **步骤 5：Commit（需用户授权）**

```bash
git add src/features/agentData/JobsPanel.tsx src/features/agentData/TaskDetailDrawer.tsx src/features/agentData/operationsStyles.ts src/features/agentData/JobsPanel.test.tsx src/features/agentData/JobsPanel.operations.test.tsx src/features/agentData/TaskDetailDrawer.test.tsx
git commit -m "feat(agentData): task groups, row detail and drawer cancel"
```

---

### 任务 11：审计诊断页

**文件：**
- 修改：`src/features/agentData/AuditDiagnosticsPanel.tsx`
- 测试：`src/features/agentData/AuditDiagnosticsPanel.test.tsx`

- [ ] **步骤 1：调整并新增测试**

- 所有 `getByRole('tab', { name: '运行诊断' | '操作记录' })` 改为 `getByRole('radio', …)`。
- 默认页变为“运行诊断”。“操作记录”describe 里的用例（第 44–193 行）在 `render` 后先 `fireEvent.click(screen.getByRole('radio', { name: '操作记录' }))`；传了 `resourceFilter` 或 `selectionRequest` 的用例会自动进入操作记录，不需要点。第 47 行 `expect(agentDataApi.checks.check).not.toHaveBeenCalled()` 删除（默认页现在是诊断）。
- “运行诊断”describe（第 196 行起）里的 `fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }))` 全部删除；第 197–199 行改为 `render(<AuditDiagnosticsPanel />);` 后直接 `await screen.findByText('CodeGraph CLI 尚未配置')`，并断言 `expect(agentDataApi.audits.query).not.toHaveBeenCalled()`。
- 第 204 行 `/检查时间/` → `/检查于/`。第 202、203 行文本仍存在（计数格标题）；为避免 `getByText` 命中多个，改为 `getAllByText('未检查').length > 0`。
- 第 122、125 行“刷新记录”改为 `rerender(<AuditDiagnosticsPanel refreshToken={1} />)` 与 `refreshToken={2}`（第 119 行 `render` 解构 `rerender`；第 119 行之前先切到“操作记录”）。
- 第 249 行 `'前往代码配置'` → `'前往代码索引'`。
- 追加：

```tsx
it('counts states and lists only present categories', async () => {
  render(<AuditDiagnosticsPanel />);
  await screen.findByText('知识库状态需要人工确认');
  expect(within(screen.getByRole('group', { name: '诊断计数' })).getByText('1', { selector: '[data-count="action_required"]' })).toBeInTheDocument();
  const categories = screen.getByRole('radiogroup', { name: '诊断分类' });
  expect(within(categories).getAllByRole('radio').map((node) => node.closest('label')?.textContent)).toEqual(['全部', '知识库', '代码索引']);
  expect(screen.queryByLabelText('诊断资源')).toBeNull();
});
```

`report` 测试数据有一个 `wiki:` 前缀项和一个 `codegraph:` 前缀项，对应“知识库”“代码索引”。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- src/features/agentData/AuditDiagnosticsPanel.test.tsx`
预期：FAIL。

- [ ] **步骤 3：实现**

- 外层 Props 增加 `refreshToken?: number`；`AuditRecords` 的读取 effect 依赖加入它（与 `refreshRequest` 相加），`Diagnostics` 在 `refreshToken` 变化且可见时重新 `check()`。
- 外层：`const [tab, setTab] = useState<'audit' | 'diagnostics'>('diagnostics');`，有 `resource` 或 `request` 时切 `'audit'`（现有 effect 已这样做）。去掉内层 `Tabs`，改为：

```tsx
<PageHeader title="审计诊断" actions={<Segmented value={tab} onChange={(value) => setTab(value as typeof tab)} options={[{ value: 'diagnostics', label: '运行诊断' }, { value: 'audit', label: '操作记录' }]} />} />
<div hidden={tab !== 'diagnostics'}><Diagnostics visible={visible && tab === 'diagnostics'} … /></div>
<div hidden={tab !== 'audit'}><AuditRecords visible={visible && tab === 'audit'} … /></div>
```

两个子区都保持挂载，保证切换时保留分页和筛选（“retains loaded pages…” 用例依赖这一点）。
- `AuditRecords`：筛选控件放进一个 `w.panel` 的 `w.panelToolbar`，删除“刷新记录”按钮，“导出当前筛选”保留在工具条右侧；错误用 `PageBanner`（保持“（保留上次结果）”后缀）。表格放进同一面板。
- `Diagnostics`：

```tsx
const categoryOf = (item: DiagnosticItem) => item.resource?.type === 'project' ? 'codegraph' : item.resource?.type ?? item.id.split(':')[0];
const categoryLabels: Record<string, string> = { codegraph: '代码索引', code: '代码索引', wiki: '知识库', memory: '记忆', runtime: '运行服务' };
const order = { action_required: 0, unchecked: 1, ok: 2 } as const;
const present = [...new Set((report?.items ?? []).map((item) => categoryLabels[categoryOf(item)] ? categoryOf(item) : 'other'))];
const items = (report?.items ?? []).filter((item) => !category || categoryOf(item) === category).sort((a, b) => order[a.state] - order[b.state]);
```

版式：

```tsx
<Typography.Text type="secondary">{report ? `检查于 ${new Date(report.checkedAt).toLocaleTimeString()}${error ? ' · 上次结果，可能已过期' : ''} · ` : ''}只读取状态，不会自动调用模型、重建索引或安装工具。</Typography.Text>
<Button disabled={!visible || loading} onClick={() => void check()}>{loading ? '正在检查…' : '重新检查'}</Button>
<div role="group" aria-label="诊断计数" className={o.kpis}>{(['action_required', 'unchecked', 'ok'] as const).map((state) => <div key={state} className={o.kpi}>
  <span className={o.kpiValue} data-count={state}>{report?.items.filter((item) => item.state === state).length ?? '—'}</span>
  <span className={o.kpiLabel}>{statusLabel('diagnostic', state)}</span>
</div>)}</div>
{present.length > 1 ? <Segmented aria-label="诊断分类" value={category} onChange={(value) => setCategory(String(value))} options={[{ value: '', label: '全部' }, ...present.map((key) => ({ value: key, label: categoryLabels[key] ?? '其他' }))]} /> : null}
```

`o` 为 `overviewStyles`（复用 KPI 样式）。antd `Segmented` 渲染 `role="radiogroup"`；如果当前 antd 版本不支持在 `Segmented` 上直接设 `aria-label`，就包一层 `<div role="radiogroup" aria-label="诊断分类">`，并把测试里的查询改为 `getByRole('radiogroup', { name: '诊断分类' })` 下查 `radio`。

每行：状态点（`span`，背景 `cssVar.colorError` / `colorTextQuaternary` / `colorSuccess`，`aria-hidden`）、`<StatusTag domain="diagnostic" status={item.state} />`、消息（`redact`）、下一行 `分类 · 资源名`（项目取目录名）。动作按钮：“前往 →”（`aria-label="查看关联资源"`，保持原名称）、“打开问题文件”、“配置说明”（`aria-label="查看配置说明"`）。配置说明改为 `Modal`：

```tsx
<Modal open={!!guide} title="CodeGraph 配置说明" onCancel={() => setGuide(undefined)} footer={[
  <Button key="close" autoInsertSpace={false} onClick={() => setGuide(undefined)}>关闭</Button>,
  onNavigate ? <Button key="go" type="primary" onClick={() => { const target = guide; setGuide(undefined); onNavigate({ view: 'code', ...(target?.resource?.type === 'project' ? { workspace: target.resource.id } : {}) }); }}>前往代码索引</Button> : null,
]}>
  <p>请先在本机配置 CodeGraph CLI，并在项目代码页检查连接与索引状态。这里不会自动安装或执行修复。</p>
</Modal>
```

删除“诊断资源”`Select`。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- src/features/agentData/AuditDiagnosticsPanel.test.tsx src/features/agentData/AgentDataCenter.test.tsx`
预期：PASS。

- [ ] **步骤 5：Commit（需用户授权）**

```bash
git add src/features/agentData/AuditDiagnosticsPanel.tsx src/features/agentData/AuditDiagnosticsPanel.test.tsx
git commit -m "feat(agentData): diagnostics-first audit page with state counts"
```

---

### 任务 12：收尾与全量验证

**文件：**
- 修改：`src/features/agentData/agentDataStyles.ts`、`listRowStyles.ts`、`memoryStyles.ts`、`codeStyles.ts`、`wiki/wikiStyles.ts`（删除未再引用的样式键）
- 修改：`docs/agent-data-operations.md`、`docs/agent-data-memory-code.md`、`docs/agent-data-wiki.md`（只改与界面入口相关的句子）

- [ ] **步骤 1：清理死样式和死代码**

对每个样式文件，用 `search` 工具查每个键名（例如 `styles.sectionHeading`、`w.propertyButton`）在 `src/features/agentData` 下是否还有引用，没有引用的删除。`OverviewPanel` 原来的 `Metric`、`Stat` 组件已在任务 6 删除，确认 `listRowStyles` 里的 `flush` 仍被 `MemoryList`、`CodeRelations` 使用后保留。

- [ ] **步骤 2：更新文档里的界面描述**

- `docs/agent-data-operations.md`：“点击‘详情’查看”改为“点击任务行查看”；“在‘审计诊断 → 操作记录’”保留；诊断段补一句“默认打开运行诊断，按需要处理、未检查、正常计数”。
- `docs/agent-data-memory-code.md`：Memory 段说明“顶部按 L0–L3 与对话记录分组，默认 L2；数量为全部项目总数”；Code 段把“建立索引/同步索引”的位置写成“页头”，删去“刷新代码工作区”。
- `docs/agent-data-wiki.md`：“管理工作台”段补充“知识页面默认只读，点‘编辑页面’后编辑；抽取中每 2 秒刷新一次状态”。

- [ ] **步骤 3：全量测试**

运行：`pnpm test -- src/features/agentData src/lib electron/agentData electron/ipc`
预期：PASS。失败时逐个修复，不跳过。

- [ ] **步骤 4：类型检查**

运行：`npx tsc -p tsconfig.json --noEmit`
预期：`src/features/agentData`、`electron/agentData`、`src/lib/relativeTime.ts` 下没有新错误。项目里如果已有无关错误，先在改动前的提交上跑一次记录基线，对比后只列出新增项。

- [ ] **步骤 5：浏览器验收**

运行 `pnpm dev`，打开 Agent 数据，按设计文档第 11 节检查：1200×800、1440×900、760px 宽，浅色与深色；窄于 800px 列表/详情切换；窄于 760px 顶栏只剩图标、页签名称仍可被读屏读出；关闭抽屉、Modal 后焦点回到触发元素。只读检查，不写入用户数据库。无法启动时在汇报里说明原因。

- [ ] **步骤 6：Commit（需用户授权）**

```bash
git add src/features/agentData docs/agent-data-operations.md docs/agent-data-memory-code.md docs/agent-data-wiki.md
git commit -m "chore(agentData): drop unused styles and update workbench docs"
```

---

## 规格覆盖对照

| 设计文档章节 | 任务 |
| --- | --- |
| 3.1 顶栏、徽标、窄屏图标 | 3、4 |
| 3.2 统一刷新 | 4，并在 7–11 各面板接入 |
| 3.3 共用组件、提示方式、按钮名称规则 | 2，贯穿 6–11 |
| 4 概览 | 5、6 |
| 5 Memory | 7 |
| 6 Wiki | 5、8 |
| 7 代码索引 | 5、9 |
| 8.1 任务 | 3、10 |
| 8.2 审计诊断 | 11 |
| 9 数据差异 | 5（字段），6–11（呈现） |
| 10 删除的控件 | 4、7–11 |
| 11 测试与验收 | 每个任务的测试步骤，12 |
