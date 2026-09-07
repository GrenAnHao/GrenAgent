# Agent 数据工作台第一阶段：公共框架实施计划

> 执行者：使用 subagent-driven-development 或 executing-plans，逐任务红灯、实现、绿灯、审查。未获执行指令前只维护计划，不运行迁移或改生产代码。

**目标：** 六面板切换和刷新不丢状态，资源页能跟踪任务，后续面板有一致的布局和刷新入口。

**架构：** 保留已有模块外壳，对 AgentDataCenter 做首次访问后保活；面板首次进入后保留实例。一个局部任务 Provider 负责请求去重、可见性和终态通知，表单内容仍留在各自面板。

**技术栈：** React、TypeScript、现有 Ant Design/Lobe token、Vitest、Testing Library。

## 前提与文件职责

根目录为 `D:/OneDrive/Project Files/Pi`，下列路径相对此目录。当前是普通 checkout、分支 `codex/agentdata-extension-integration`，并非隔离 worktree；大量代码和文档已有未提交修改。执行前记录 `git status --short` 与基线，不 reset、stash 或全量 git add。是否创建 worktree 留给执行阶段确认，不能从干净 HEAD 开始而漏掉当前已实现的 AgentData 功能。

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/features/workspace/ModuleContainer.tsx` | Agent 数据模块保活，传 visible |
| `electron-agent/src/features/agentData/AgentDataCenter.tsx` | 六面板导航、visited、局部刷新状态 |
| `electron-agent/src/features/agentData/AgentDataTaskProvider.tsx`，新建 | 单一任务轮询与上下文 |
| `electron-agent/src/features/agentData/OverviewPanel.tsx`，新建 | 概览内容，不再内嵌在总容器 |
| `electron-agent/src/features/agentData/agentDataStyles.ts` | 页头、标签、内容滚动区域和尺寸 |
| `electron-agent/src/features/agentData/useProjectOptions.ts` | 真实项目选择与显示名，保留已有临时根过滤 |
| 对应 `.test.tsx` / `.test.ts` | 生命周期、可见性、局部失败和刷新回归 |

不在本阶段添加具名知识库、Memory 编辑或系统任务管理。默认浏览的实际数据接口由第二、三阶段完成，不画不可用的创建按钮。

## 公共接口

`agentDataViewTypes.ts` 导出标签类型，避免 Provider 反向导入总容器：

```ts
export type AgentDataTab = 'overview' | 'memory' | 'wiki' | 'code' | 'jobs' | 'audit';
```

其余类型在 `AgentDataTaskProvider.tsx` 定义：

```ts
import type { ReactNode } from 'react';
import type { AgentJob } from '../../lib/agentData';
import type { AgentDataTab } from './agentDataViewTypes';

export interface AgentDataTaskMonitor {
  jobs: AgentJob[];
  error?: string;
  loading: boolean;
  loaded: boolean;
  refresh(): Promise<void>;
  track(id: string): void;
  watchedTaskVersion: number;
}
export interface AgentDataTaskProviderProps {
  visible: boolean;
  activeView: AgentDataTab;
  children: ReactNode;
}
```

Provider 同文件导出无参 `useAgentDataTaskMonitor()`。`track` 使用依赖 activeView 的回调闭包，资源操作开始时捕获该回调，创建请求返回后仍归属原资源面板，而不是此时的新标签。track 立即安排刷新；首次观察到被跟踪任务的终态时，`watchedTaskVersion` 递增一次。第二、三阶段资源页在 visible 且版本变化时重查资源状态，不覆盖编辑草稿。第四阶段扩展 TaskRef，但 `track(string)` 继续表示用户任务。

## F1：模块与面板状态保留

修改：`ModuleContainer.tsx`、`ModuleContainer.test.tsx`、`AgentDataCenter.tsx`、`AgentDataCenter.test.tsx`、`agentDataStyles.ts`；新建 `agentDataViewTypes.ts`。

- [x] 在现有 AgentDataCenter 测试夹具内添加以下用例，并补齐现有 beforeEach 中的任务 API mocks：

```tsx
it('retains a panel search across tab switches and background refresh', async () => {
  render(<AgentDataCenter userId="u" />);
  await screen.findByText('248');
  fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
  fireEvent.change(screen.getByLabelText('搜索记忆'), { target: { value: 'dark' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Wiki' }));
  fireEvent.click(screen.getByRole('button', { name: '刷新 Agent 数据' }));
  await waitFor(() => expect(agentDataApi.status).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
  expect((screen.getByLabelText('搜索记忆') as HTMLInputElement).value).toBe('dark');
});
```

- [x] 运行 `npm test -- src/features/agentData/AgentDataCenter.test.tsx src/features/workspace/ModuleContainer.test.tsx`（cwd 为 `electron-agent`）。预期旧导航缺 tab 语义，或刷新/切页后输入丢失。
- [x] ModuleContainer 给 AgentData 单独的保活区域，首次选择前不挂载，选择后只隐藏；从 ActivePanel 中移除重复的 agentData 分支，其他模块和常驻 chat 不改。AgentDataCenter 新增 `visible?: boolean`，默认 true。
- [x] AgentDataCenter 使用以下 visited 更新与渲染规则，六面板各有独立滚动容器，不能再用统一 loading 条件卸载子面板：

```tsx
const [tab, setTab] = useState<AgentDataTab>('overview');
const [visited, setVisited] = useState<Set<AgentDataTab>>(() => new Set(['overview']));
function selectTab(next: AgentDataTab): void {
  setVisited((current) => new Set([...current, next]));
  setTab(next);
}
// 在现有 tabs.map 内使用：content 是该 tab 对应的真实子面板 JSX。
function renderPanel(id: AgentDataTab, content: ReactNode): ReactNode {
  if (!visited.has(id)) return null;
  return <section key={id} role="tabpanel" id={`agent-data-${id}`} aria-labelledby={`agent-data-tab-${id}`} hidden={tab !== id} className={styles.panel}>{content}</section>;
}
```

标签使用 role=tab、aria-selected、aria-controls；`styles.panel` 不以 display 覆盖 native hidden。各子面板逐步接收 visible，隐藏时暂停新的请求，现有本地筛选 state 不重置。

- [x] 模块测试使用一个带输入框的 AgentDataCenter mock，验证 agentData→chat→agentData 后输入仍在；增加滚动位置保留测试和首次未访问不挂载测试。
- [x] 重跑红灯命令，确认原有聊天保活测试仍通过；提交仅包含本任务文件，且仅在用户授权提交时执行。

## F2：局部刷新与真实运行状态

修改：`AgentDataCenter.tsx/.test.tsx`；新建 `OverviewPanel.tsx/.test.tsx`。

- [x] 添加失败测试：Memory 请求失败，Wiki 已加载内容仍显示；刷新失败不清空先前数据；首次 status 未返回不能显示绿色“就绪”；旧请求晚返回不能覆盖新请求结果。
- [x] 运行 `npm test -- src/features/agentData/AgentDataCenter.test.tsx`，确认旧 Promise.all 与全局 error/卸载分支不能满足要求。
- [x] 给 status、memory overview、wiki overview 分别保留 data/error/loading；使用一轮请求序号处理过期结果。结果处理必须区分 fulfilled 与 rejected：

```ts
type ResourceState<T> = { data?: T; loading: boolean; error?: string };
function applyResult<T>(previous: ResourceState<T>, result: PromiseSettledResult<T>): ResourceState<T> {
  if (result.status === 'fulfilled') return { data: result.value, loading: false };
  return { ...previous, loading: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}
```

refresh 使用 `Promise.allSettled`，闭包记录 epoch；只有 epoch 仍为最新才能分别 setState。初次无 data 展示骨架，已有 data 只显示局部刷新状态。抽出 OverviewPanel 接受已有统计，不新增健康分或伪零值。

- [x] 更新 label 为“概览 / Memory / Wiki / 代码索引 / 任务 / 审计诊断”；状态未知、断连、失败使用非绿色状态和文字原因。
- [x] 重跑目标测试。后续阶段接入新统计时更新 OverviewPanel，不再改总容器的请求/挂载机制。

## F3：单一任务跟踪 Provider

新建：`AgentDataTaskProvider.tsx/.test.tsx`。修改：`AgentDataCenter.tsx`、`JobsPanel.tsx/.test.tsx`。

- [x] 使用 fake timers 和真实 Provider 新增回归：两个消费者只发一组轮询；track 后立即刷新；活动用户任务每 2 秒刷新；未跟踪且只有历史记录不轮询；失焦/模块隐藏暂停；终态只触发一次版本递增；新任务创建碰到在途旧刷新不会被丢弃；延迟创建期间切换标签，返回的任务仍归属原资源面板。
- [x] 运行 `npm test -- src/features/agentData/AgentDataTaskProvider.test.tsx`，预期 Provider 尚不存在。
- [x] 实现 Context 和单一递归 timeout。状态至少含 jobs、error、inflight、refreshAgain、tracked（id→ownerView）、已通知终态 ID；不要每个面板各起 interval。

轮询判定作为纯函数测试：

```ts
import type { AgentJob } from '../../lib/agentData';
import type { AgentDataTab } from './agentDataViewTypes';

export function shouldPollTasks(visible: boolean, focused: boolean, view: AgentDataTab, jobs: AgentJob[], tracked: ReadonlyMap<string, AgentDataTab>): boolean {
  if (!visible || !focused) return false;
  const active = new Set(jobs.filter((job) => job.state === 'pending' || job.state === 'running').map((job) => job.id));
  if (view === 'jobs' || view === 'overview') return active.size > 0;
  return [...tracked].some(([id, owner]) => owner === view && (active.has(id) || !jobs.some((job) => job.id === id)));
}
```

`refresh()` 有在途请求时设置 refreshAgain，不并行发第二个请求；在途结束后补一轮。track 缺失的 ID 通过 jobs.get 确認是否已删除，不能永久空轮询。绑定 visibilitychange、focus、blur；卸载清 timer 和 listener。

- [x] Provider 放在 AgentDataCenter 内、各面板共同父级；JobsPanel 通过现有 props 消费同一份 jobs，不重复自身 list。保留 JobsPanel 独立使用时的原自加载路径。
- [x] 重跑 Provider、AgentDataCenter 和 JobsPanel 测试。第二、三阶段使用无参 hook，不再自建任务轮询。

## F4：资源页原地跟踪任务

修改：`WikiPanel.tsx/.test.tsx`、`CodeRetrievalPanel.tsx/.test.tsx`、`AgentDataCenter.tsx`。

- [x] 用现有组件测试添加：同步创建后仍在原面板；提示“已加入任务”；点击查看才打开任务；终态版本变化后重查状态但不清搜索；隐藏资源页不发新查询。
- [x] 运行 `npm test -- src/features/agentData/WikiPanel.test.tsx src/features/agentData/CodeRetrievalPanel.test.tsx`，确认旧 onJobCreated 强制切换不符合要求。
- [x] 将创建成功处理改成以下完整步骤，具体参数保持现有 kind/workspace：

```ts
const monitor = useAgentDataTaskMonitor();
const [createdJobId, setCreatedJobId] = useState<string>();
async function startSync(workspace: string, kind: string): Promise<void> {
  const trackCreated = monitor.track;
  const job = await agentDataApi.jobs.create({ workspace, kind });
  setCreatedJobId(job.id);
  trackCreated(job.id);
}
```

页面本地错误仍由 try/catch 呈现；当前面板的新任务提示提供显式 onOpenTask(id) 回调。总容器收到回调才切任务标签并传选中 ID，不从 create 自动切换。数据请求携带 visible 与请求序号；watchedTaskVersion 变化只刷新资源数据，不重置输入。

- [x] 重跑组件与 Provider 测试，补“任务提交失败留在原页且不 track”的分支。

## F5：公共视觉尺度与项目信息

修改：`agentDataStyles.ts`、`useProjectOptions.ts/.test.ts`、`OverviewPanel.tsx/.test.tsx`、`AgentDataCenter.tsx`。

- [x] 先测显示语义：未知统计显示“未获取”；真实零值显示 0；相同 basename 项目仍可通过完整路径区分；临时会话不进入代码项目选项。
- [x] 按设计 §3.3 实施 token 与尺度，不增加颜色主题或依赖。列表面板用满宽度，文档阅读宽度由第二阶段详情组件控制。
- [x] 项目路径只用于详情/tooltip/复制，列表主文案使用 useProjectOptions 的 name；缺少匹配项时显示可读 basename，提供完整路径补充，不把 UUID 标记成正常项目。
- [x] 在 `electron-agent` 运行 `npm test -- src/features/agentData/useProjectOptions.test.ts src/features/agentData/OverviewPanel.test.tsx`；以 1200×800 和 1440×900 人工检查导航、长路径和 keyboard focus，窄内容区按设计折叠，不以縮小字體解决拥挤。

## F6：第一阶段验收

- [x] 运行 `npm test -- src/features/agentData src/features/workspace/ModuleContainer.test.tsx src/lib/agentData.test.ts`。
- [x] 运行 `npm run build`；另跑 `npm exec tsc -- -p tsconfig.node.json --noEmit --composite false --incremental false` 并与执行前基线比较，不能把现有全量类型错误算成本阶段通过。
- [x] 浏览器/桌面验收：连续切换六面板、聊天模块、修改筛选、刷新、制造局部错误、创建测试任务，确认内容和选择不丢失。只使用测试项目与临时数据。
- [x] 输出代码差异、测试证据和已知限制，停止并审查第一阶段。此时没有迁移具名 Wiki，也没有承诺 Memory 人工编辑已存在。

## 自检

覆盖设计 §3 的状态/布局、§4 的基础概览和 §8 的任务追踪入口。Wiki 具名库、Memory 列表编辑和聚合任务详情由各阶段明确承接。公共接口只定义一套，后续资源面板不复制造成重复轮询。

## 第一阶段交付记录（2026-09-05）

- F1–F6 已执行，生产改动仅在渲染层：首次访问后保活、每面板独立滚动、局部加载错误、同一任务 Provider、Wiki/Code 原地跟踪与显式定位、主题尺度和同名项目区分。
- 任务 Provider 增加 `loading`（请求在途）与 `loaded`（已成功获取，含空集）两个不同标记，避免未知显示伪零或已知零值在刷新时消失。
- 显式查看任务使用选择请求序号，等筛选清空和目标行出现后单次滚动；重复打开同一任务和迟到结果均有回归，普通轮询不反复滚动。
- 基线 53 项；最终 `npm test -- --maxWorkers 4 src/features/agentData src/features/workspace/ModuleContainer.test.tsx src/lib/agentData.test.ts`：11 文件、139 项通过。
- Electron `npm run build` 通过。显式 renderer 类型检查与原始源码快照对比均为 5 处既有错误，无新增（NativeSkillsPanel 与 agentData typed API）；主进程全量检查仍有既有错误，本轮未改后端。
- 浏览器验收使用真实 React 组件、隔离 Chrome 和内存 API 替身：1200×800、1440×900、760×800，深浅主题；切页/隐藏保输入、隐藏无请求、任务原页到终态、查看定位、键盘标签、局部失败和无横向溢出均已验证。
- 修复了浏览器实测的错误提示/标题重叠；截图保留在 `output/playwright/foundation/`。临时验收 HTML/TSX、源码对比 JSON 与测试进程已清理；隔离 Chrome profile 的删除被环境策略阻止，保留在相同验收目录。
- 不连接真实 AgentData 数据库、不调用模型、不迁移知识库。第二阶段具名 Wiki、Memory 默认列表/人工编辑及统一系统任务仍未实现。
- 保留当前分支与全部未提交修改，未提交、未推送或合并。
