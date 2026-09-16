# 代码智能内置 · Phase 3（管理 UI）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 在 `ExtensionsPanel` 增加第三个 tab「代码智能」，让用户可视化管理：引擎选择（CodeGraph/GitNexus/Off）+ 让位徽标、当前 workspace 索引状态（状态文本 + 初始化/同步/重建）+ 自动 init 开关、探索子代理开关 + 模型选择。

**架构：** 纯前端 tab，复用 Phase 1 的 Rust 命令（`code_intel_status/init/sync/reindex`）经 `lib/codeIntelIo.ts`，复用 `useSettingsForm` 读写配置键（`CODE_INTEL`/`CODE_INTEL_AUTO_INIT`/`CODE_INTEL_EXPLORER`/`CODE_INTEL_EXPLORER_MODEL`）、`ModelSelectField` 选模型、`createStaticStyles`+`cssVar` 样式、lucide 图标（无 emoji）。让位徽标由纯函数 `codeIntelYield` 从 `MCP_SERVERS` + tools cache 推断。`workspace` 取自 `useAgentStoreContext()`。

**技术栈：** React 19 + TypeScript、antd（Select/Switch/Button/Popconfirm）、@lobehub/ui（Flexbox/Button/ThemeProvider）、antd-style（createStaticStyles/cssVar）、Vitest + @testing-library/react。

**对应规格：** `docs/superpowers/specs/2026-06-17-code-intelligence-builtin-design.md`（Spec 3）。依赖 Phase 1（Rust 命令 + codeIntelIo，已完成）与 Phase 2（explore_context + 配置键，已完成）。

---

## 调研纪要（针对真实接口，避免推测性代码）

- **ExtensionsPanel（`src/features/extensions/ExtensionsPanel.tsx`）：** `type ExtTab = 'mcp' | 'skills'`，`useState<ExtTab>('mcp')`，tabBar 两个 `<button>`（`styles.tab`/`styles.tabActive`）。本计划加 `'code-intel'`。已用 `const { values, setValue, persist, save, saving, loading, error } = useSettingsForm()`。自动存盘 useEffect 依赖 `[values.MCP_SERVERS, values.MCP_SERVERS_DISABLED, values.SKILLS_DISABLED, loading]`——**需把 code-intel 键并入依赖**。`markChanged()` 设 `touchedRef=true` + `needsRestart=true`；`restart()` = `save()`（close+open sidecar）。
- **useSettingsForm（`src/features/settings/useSettingsForm.ts`）：** `values: Record<string,string>`；`setValue(key,value)` 仅改本地 + dirty；`persist()` 写 settings（扩展 fs.watch 热更新，不重启）；`save()` 写 + close/open sidecar（重启生效）；`workspace` 取自 `useAgentStoreContext()`。
- **codeIntelIo（`src/lib/codeIntelIo.ts`，Phase 1）：** `codeIntelStatus(ws)`、`codeIntelInit(ws)`、`codeIntelSync(ws)`、`codeIntelReindex(ws)`、`codeIntelIsInitialized(ws)`，均 `Promise<string|boolean>`。
- **workspace：** `useAgentStoreContext().workspace`（字符串）。
- **ModelSelectField（`src/features/settings/ModelSelectField.tsx`）：** `<ModelSelectField value onChange placeholder? testId? />`，两步式 provider→model，复用 `useProviderModelData`。
- **tools cache（`src/lib/mcpPolicyIo.ts` → `readMcpToolsCache()`；`src/features/extensions/mcpToolsCache.ts` → `parseToolsCache`）：** 返回 `{ [server]: CacheEntry{ toolNames, ok, error } }`。
- **测试（`ExtensionsPanel.test.tsx`）：** `vi.hoisted` + `vi.mock('../../lib/pi', ...)` + `vi.mock('../../stores/AgentStoreContext', () => ({ useAgentStoreContext: () => ({ workspace: '/ws' }) }))`；渲染包 `ThemeProvider`。本计划的组件测试 mock `../../lib/codeIntelIo` 与 `useAgentStoreContext`。

**生效语义（写入计划，决定是否提示重启）：**

- `CODE_INTEL`（引擎）→ MCP manager config-watch 热切换（persist 即生效）。
- `CODE_INTEL_AUTO_INIT` → 下次 `open_workspace` 读取（persist 即可）。
- `CODE_INTEL_EXPLORER`（注册/注销 explore_context 工具）→ 扩展 `default` 时读，**需重启 sidecar**。
- `CODE_INTEL_EXPLORER_MODEL` → `explore_context` execute 时实时 `getConfig`（persist 即生效）。
- 索引 `init/sync/reindex` → Rust 运行时命令，立即执行（不经 settings）。

为简单与一致：改任一配置键都走现有「自动存盘 + 重启生效」机制（与 mcp/skills tab 一致）；hot 类 persist 后已生效，restart 类需用户点「重启生效」。

**Spec 3 范围裁剪：** Spec 3 第 4 分区「工具」（per-tool 权限，复用 mcpPolicy）较复杂且 codegraph 工具权限可经现有 mcp-policy 机制覆盖；本计划聚焦「引擎 / 索引 / 探索」三分区（核心价值），工具权限分区留作后续增强（在计划末「后续」注明），不阻塞 Phase 3 交付。

---

## 文件结构

- 创建 `tauri-agent/src/features/extensions/codeIntelYield.ts` — 纯函数 `userConfiguredCodegraph(mcpServersJson, toolNames)`：判断用户是否已自配 codegraph（同名 server 或暴露 `codegraph_*` 工具），用于让位徽标。无 I/O，纯可测。
- 创建 `tauri-agent/src/features/extensions/codeIntelYield.test.ts` — 纯函数单测。
- 创建 `tauri-agent/src/features/extensions/CodeIntelTab.tsx` — 代码智能 tab：引擎选择 + 让位徽标 + 索引状态/操作 + 探索开关/模型。
- 创建 `tauri-agent/src/features/extensions/CodeIntelTab.test.tsx` — 组件测试（mock codeIntelIo + useAgentStoreContext）。
- 修改 `tauri-agent/src/features/extensions/ExtensionsPanel.tsx` — 第三 tab `'code-intel'` + 自动存盘依赖并入 code-intel 键。

---

## 任务 1：让位推断纯函数 `codeIntelYield`

**文件：**
- 创建：`tauri-agent/src/features/extensions/codeIntelYield.ts`
- 测试：`tauri-agent/src/features/extensions/codeIntelYield.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// tauri-agent/src/features/extensions/codeIntelYield.test.ts
import { describe, expect, it } from 'vitest';
import { userConfiguredCodegraph } from './codeIntelYield';

describe('userConfiguredCodegraph', () => {
  it('detects a user-configured server named codegraph', () => {
    const json = '{"mcpServers":{"codegraph":{"command":"codegraph","args":["serve","--mcp"]}}}';
    expect(userConfiguredCodegraph(json, [])).toBe(true);
  });

  it('detects a differently-named server exposing codegraph_* tools', () => {
    expect(userConfiguredCodegraph('{"mcpServers":{"my-cg":{"command":"x"}}}', ['codegraph_explore'])).toBe(true);
  });

  it('returns false when neither name nor tool signature matches', () => {
    expect(userConfiguredCodegraph('{"mcpServers":{"fs":{"command":"npx"}}}', ['read_file'])).toBe(false);
  });

  it('tolerates empty / invalid JSON', () => {
    expect(userConfiguredCodegraph('', [])).toBe(false);
    expect(userConfiguredCodegraph('not json', [])).toBe(false);
    expect(userConfiguredCodegraph('{}', [])).toBe(false);
  });

  it('accepts a bare map without the mcpServers wrapper', () => {
    expect(userConfiguredCodegraph('{"codegraph":{"command":"x"}}', [])).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/extensions/codeIntelYield.test.ts`
预期：FAIL，`Cannot find module './codeIntelYield'`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// tauri-agent/src/features/extensions/codeIntelYield.ts
// 让位推断（纯函数，无 I/O）：用户是否已自配 codegraph —— 同名 server，或别名 server
// 暴露 codegraph_* 工具。命中则内置引擎「让位」，UI 显示对应徽标。
// 与 sidecar 侧 injectDefaultServers 的让位策略对齐（此处是前端只读复刻，用于展示）。
const CODEGRAPH_SERVER_NAME = 'codegraph';
const CODEGRAPH_TOOL_PREFIX = 'codegraph_';

export function userConfiguredCodegraph(mcpServersJson: string, toolNames: string[]): boolean {
  if (toolNames.some((t) => t.startsWith(CODEGRAPH_TOOL_PREFIX))) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(mcpServersJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const root = parsed as Record<string, unknown>;
  const servers =
    'mcpServers' in root && root.mcpServers && typeof root.mcpServers === 'object'
      ? (root.mcpServers as Record<string, unknown>)
      : root;
  return Object.prototype.hasOwnProperty.call(servers, CODEGRAPH_SERVER_NAME);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/extensions/codeIntelYield.test.ts`
预期：PASS（5 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/extensions/codeIntelYield.ts tauri-agent/src/features/extensions/codeIntelYield.test.ts
git commit -m "feat(code-intel-ui): yield-badge inference helper"
```

注：此仓库常有大量预先 staged 文件，commit 用 `git add <精确文件>` 后 `git commit -- <精确文件>`，避免裸 `git commit` 连带提交无关的 staged 改动。

---

## 任务 2：`CodeIntelTab` 组件（引擎 / 索引 / 探索三分区）

**文件：**
- 创建：`tauri-agent/src/features/extensions/CodeIntelTab.tsx`

依赖任务 1 的 `userConfiguredCodegraph`。组件接收表单切片为 props（与 ExtensionsPanel 共享同一 `useSettingsForm` 实例，避免两份状态）。

- [ ] **步骤 1：编写组件**

```tsx
// tauri-agent/src/features/extensions/CodeIntelTab.tsx
import { Button, Flexbox } from '@lobehub/ui';
import { Select, Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Brain, FolderSync, Hammer, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  codeIntelInit,
  codeIntelReindex,
  codeIntelStatus,
  codeIntelSync,
} from '../../lib/codeIntelIo';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { ModelSelectField } from '../settings/ModelSelectField';
import { userConfiguredCodegraph } from './codeIntelYield';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const styles = createStaticStyles(({ css }) => ({
  section: css`
    margin-block-end: 22px;
  `,
  secTitle: css`
    margin-block-end: 10px;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  row: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    margin-block-end: 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
  `,
  rowLabel: css`
    font-size: 13px;
    color: ${cssVar.colorText};
  `,
  rowDesc: css`
    margin-block-start: 2px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  badge: css`
    padding: 1px 8px;
    border-radius: 999px;
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorTextSecondary};
    font-size: 11px;
  `,
  badgeYield: css`
    background: ${cssVar.colorWarningBg};
    color: ${cssVar.colorWarning};
  `,
  status: css`
    padding: 10px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorFillQuaternary};
    font-family: ${mono};
    font-size: 11px;
    white-space: pre-wrap;
    color: ${cssVar.colorTextSecondary};
    max-height: 220px;
    overflow: auto;
  `,
}));

interface CodeIntelTabProps {
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  /** 标记有改动（触发自动存盘 + 重启生效提示）。 */
  onChange: () => void;
  /** 当前已连 MCP 工具名（用于让位徽标，来自 tools cache 汇总）。 */
  knownToolNames: string[];
}

const ENGINE_OPTIONS = [
  { value: 'codegraph', label: 'CodeGraph（内置，默认）' },
  { value: 'gitnexus', label: 'GitNexus（opt-in，Phase 4）' },
  { value: 'off', label: '关闭' },
];

export function CodeIntelTab({ values, setValue, onChange, knownToolNames }: CodeIntelTabProps) {
  const { workspace } = useAgentStoreContext();
  const engine = values.CODE_INTEL ?? 'codegraph';
  const autoInit = (values.CODE_INTEL_AUTO_INIT ?? '1') !== '0';
  const explorerOn = (values.CODE_INTEL_EXPLORER ?? '1') !== '0';
  const yielded = userConfiguredCodegraph(values.MCP_SERVERS ?? '', knownToolNames);

  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);

  const refreshStatus = async () => {
    setBusy('status');
    try {
      setStatus(await codeIntelStatus(workspace));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  const run = async (kind: 'init' | 'sync' | 'reindex') => {
    setBusy(kind);
    try {
      const fn = kind === 'init' ? codeIntelInit : kind === 'sync' ? codeIntelSync : codeIntelReindex;
      setStatus(await fn(workspace));
      await refreshStatus();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const setEngine = (v: string) => {
    setValue('CODE_INTEL', v);
    onChange();
  };
  const toggleAutoInit = (on: boolean) => {
    setValue('CODE_INTEL_AUTO_INIT', on ? '1' : '0');
    onChange();
  };
  const toggleExplorer = (on: boolean) => {
    setValue('CODE_INTEL_EXPLORER', on ? '1' : '0');
    onChange();
  };
  const setExplorerModel = (v: string) => {
    setValue('CODE_INTEL_EXPLORER_MODEL', v);
    onChange();
  };

  return (
    <div data-testid="code-intel-tab">
      <div className={styles.section}>
        <div className={styles.secTitle}>引擎</div>
        <div className={styles.row}>
          <div>
            <div className={styles.rowLabel}>代码图谱引擎</div>
            <div className={styles.rowDesc}>CodeGraph 为内置离线引擎；切换经热更新生效</div>
          </div>
          <Flexbox horizontal align="center" gap={8}>
            <span className={`${styles.badge} ${yielded ? styles.badgeYield : ''}`} data-testid="code-intel-badge">
              {yielded ? '已检测到自配 codegraph，内置让位' : '内置 (bundled)'}
            </span>
            <Select
              data-testid="code-intel-engine"
              size="small"
              value={engine}
              options={ENGINE_OPTIONS}
              style={{ minWidth: 200 }}
              onChange={setEngine}
            />
          </Flexbox>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.secTitle}>索引（当前 workspace）</div>
        <div className={styles.row}>
          <div>
            <div className={styles.rowLabel}>打开 workspace 时自动初始化</div>
            <div className={styles.rowDesc}>无 .codegraph 时后台自动 init（CODE_INTEL_AUTO_INIT）</div>
          </div>
          <Switch
            size="small"
            checked={autoInit}
            data-testid="code-intel-autoinit"
            onChange={toggleAutoInit}
          />
        </div>
        <Flexbox horizontal align="center" gap={8} style={{ marginBlockEnd: 10 }}>
          <Button size="small" icon={<Play size={14} />} loading={busy === 'init'} data-testid="code-intel-init" onClick={() => void run('init')}>
            初始化
          </Button>
          <Button size="small" icon={<FolderSync size={14} />} loading={busy === 'sync'} data-testid="code-intel-sync" onClick={() => void run('sync')}>
            手动同步
          </Button>
          <Button size="small" icon={<Hammer size={14} />} loading={busy === 'reindex'} data-testid="code-intel-reindex" onClick={() => void run('reindex')}>
            重建
          </Button>
          <Button size="small" loading={busy === 'status'} data-testid="code-intel-refresh" onClick={() => void refreshStatus()}>
            刷新状态
          </Button>
        </Flexbox>
        <div className={styles.status} data-testid="code-intel-status">{status || '（点「刷新状态」查看索引统计）'}</div>
      </div>

      <div className={styles.section}>
        <div className={styles.secTitle}>探索子代理</div>
        <div className={styles.row}>
          <div>
            <div className={styles.rowLabel}>启用 explore_context</div>
            <div className={styles.rowDesc}>只读探索子代理；关闭后该工具不再注册（需重启生效）</div>
          </div>
          <Switch size="small" checked={explorerOn} data-testid="code-intel-explorer" onChange={toggleExplorer} />
        </div>
        <div className={styles.row}>
          <div>
            <div className={styles.rowLabel}>探索模型</div>
            <div className={styles.rowDesc}>留空＝子代理便宜模型（SUBAGENT_MODEL_CHEAP）</div>
          </div>
          <ModelSelectField
            value={values.CODE_INTEL_EXPLORER_MODEL ?? ''}
            placeholder="如 deepseek/deepseek-chat"
            testId="code-intel-explorer-model"
            onChange={setExplorerModel}
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **步骤 2：类型检查**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：`CodeIntelTab.tsx` 无新增类型错误（既有 `App.tsx(640,88)` 等与本任务无关）。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/extensions/CodeIntelTab.tsx
git commit -m "feat(code-intel-ui): CodeIntelTab (engine / index / explorer sections)"
```

---

## 任务 3：接入 ExtensionsPanel 第三 tab + 自动存盘

**文件：**
- 修改：`tauri-agent/src/features/extensions/ExtensionsPanel.tsx`

- [ ] **步骤 1：import 与 tab 类型**

在 import 段加入：

```tsx
import { Boxes, Plus, RotateCw, ScrollText, Sparkles, Trash2, Brain } from 'lucide-react';
import { CodeIntelTab } from './CodeIntelTab';
```

把 `type ExtTab = 'mcp' | 'skills';` 改为：

```tsx
type ExtTab = 'mcp' | 'skills' | 'code-intel';
```

- [ ] **步骤 2：自动存盘依赖并入 code-intel 键**

把现有自动存盘 useEffect 的依赖数组：

```tsx
  }, [values.MCP_SERVERS, values.MCP_SERVERS_DISABLED, values.SKILLS_DISABLED, loading]);
```

改为（加入 4 个 code-intel 键，使其改动也触发防抖自动存盘）：

```tsx
  }, [
    values.MCP_SERVERS,
    values.MCP_SERVERS_DISABLED,
    values.SKILLS_DISABLED,
    values.CODE_INTEL,
    values.CODE_INTEL_AUTO_INIT,
    values.CODE_INTEL_EXPLORER,
    values.CODE_INTEL_EXPLORER_MODEL,
    loading,
  ]);
```

- [ ] **步骤 3：tabBar 加第三个按钮**

在 `ext-tab-skills` 按钮之后插入：

```tsx
          <button
            type="button"
            data-testid="ext-tab-code-intel"
            className={`${styles.tab} ${tab === 'code-intel' ? styles.tabActive : ''}`}
            onClick={() => setTab('code-intel')}
          >
            <Brain size={15} />
            代码智能
          </button>
```

- [ ] **步骤 4：body 渲染分支**

当前 body 是 `{tab === 'mcp' ? (...) : (...)}`（二元）。改为在最外层用 code-intel 优先分支包裹，保持 mcp/skills 原有三元不变：

把：

```tsx
        <div className={styles.inner}>
          {tab === 'mcp' ? (
```

改为：

```tsx
        <div className={styles.inner}>
          {tab === 'code-intel' ? (
            <CodeIntelTab
              values={values}
              setValue={setValue}
              onChange={markChanged}
              knownToolNames={Object.values(toolsCache).flatMap((e) => e.toolNames ?? [])}
            />
          ) : tab === 'mcp' ? (
```

（结尾 `) : (` …skills… `)}` 结构不变——`code-intel` 为新增的最外层条件，原 `mcp ? skills` 退为其 else 分支。）

注：`toolsCache` 的条目形状见 `mcpToolsCache.ts` 的 `CacheEntry`（含 `toolNames?: string[]`）；`markChanged` 已在组件内定义（设 touched + needsRestart）。

- [ ] **步骤 5：类型检查 + 构建**

运行：`cd tauri-agent && npx tsc --noEmit && npm run build`
预期：通过（CodeIntelTab 正确接入，无新增类型错误）。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/extensions/ExtensionsPanel.tsx
git commit -m "feat(code-intel-ui): wire code-intel tab into ExtensionsPanel"
```

---

## 任务 4：组件测试 `CodeIntelTab.test.tsx`

**文件：**
- 创建：`tauri-agent/src/features/extensions/CodeIntelTab.test.tsx`

- [ ] **步骤 1：编写测试**

```tsx
// tauri-agent/src/features/extensions/CodeIntelTab.test.tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { codeIntelStatus, codeIntelInit, codeIntelSync, codeIntelReindex } = vi.hoisted(() => ({
  codeIntelStatus: vi.fn(() => Promise.resolve('Files: 10\nNodes: 99')),
  codeIntelInit: vi.fn(() => Promise.resolve('initialized')),
  codeIntelSync: vi.fn(() => Promise.resolve('synced')),
  codeIntelReindex: vi.fn(() => Promise.resolve('rebuilt')),
}));
vi.mock('../../lib/codeIntelIo', () => ({
  codeIntelStatus,
  codeIntelInit,
  codeIntelSync,
  codeIntelReindex,
  codeIntelIsInitialized: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
// ModelSelectField 依赖 provider 数据；mock 成一个最小输入桩，聚焦本组件逻辑。
vi.mock('../settings/ModelSelectField', () => ({
  ModelSelectField: ({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId?: string }) => (
    <input data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { ThemeProvider } from '@lobehub/ui';
import { CodeIntelTab } from './CodeIntelTab';

vi.setConfig({ testTimeout: 20000 });
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderTab(values: Record<string, string> = {}) {
  const setValue = vi.fn();
  const onChange = vi.fn();
  render(
    <ThemeProvider>
      <CodeIntelTab values={values} setValue={setValue} onChange={onChange} knownToolNames={[]} />
    </ThemeProvider>,
  );
  return { setValue, onChange };
}

describe('CodeIntelTab', () => {
  it('loads index status on mount', async () => {
    renderTab();
    await waitFor(() => expect(codeIntelStatus).toHaveBeenCalledWith('/ws'));
    await waitFor(() => expect(screen.getByTestId('code-intel-status').textContent).toContain('Nodes: 99'));
  });

  it('runs init and refreshes status', async () => {
    renderTab();
    await waitFor(() => expect(codeIntelStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('code-intel-init'));
    await waitFor(() => expect(codeIntelInit).toHaveBeenCalledWith('/ws'));
  });

  it('changing engine writes CODE_INTEL and marks changed', async () => {
    const { setValue, onChange } = renderTab({ CODE_INTEL: 'codegraph' });
    await waitFor(() => expect(codeIntelStatus).toHaveBeenCalled());
    // antd Select：打开后选 Off
    fireEvent.mouseDown(screen.getByTestId('code-intel-engine').querySelector('.ant-select-selector')!);
    await waitFor(() => expect(screen.getByText('关闭')).toBeTruthy());
    fireEvent.click(screen.getByText('关闭'));
    expect(setValue).toHaveBeenCalledWith('CODE_INTEL', 'off');
    expect(onChange).toHaveBeenCalled();
  });

  it('shows the yield badge when a user codegraph tool is present', async () => {
    render(
      <ThemeProvider>
        <CodeIntelTab values={{}} setValue={vi.fn()} onChange={vi.fn()} knownToolNames={['codegraph_explore']} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(codeIntelStatus).toHaveBeenCalled());
    expect(screen.getByTestId('code-intel-badge').textContent).toContain('让位');
  });

  it('toggles the explorer switch (writes CODE_INTEL_EXPLORER)', async () => {
    const { setValue } = renderTab({ CODE_INTEL_EXPLORER: '1' });
    await waitFor(() => expect(codeIntelStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('code-intel-explorer'));
    expect(setValue).toHaveBeenCalledWith('CODE_INTEL_EXPLORER', '0');
  });
});
```

- [ ] **步骤 2：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/extensions/CodeIntelTab.test.ts src/features/extensions/CodeIntelTab.test.tsx`
预期：PASS（5 passed）。若 antd Select 交互在 jsdom 下不稳定，改用 `data-testid` 上的 `fireEvent.change` 或断言 `setValue` 调用即可——核心是验证回调写键，不强依赖具体下拉渲染。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/extensions/CodeIntelTab.test.tsx
git commit -m "test(code-intel-ui): CodeIntelTab behavior tests"
```

---

## 任务 5：整体验证

**文件：** 无（验证步骤）。

- [ ] **步骤 1：相关单测全绿**

运行：`cd tauri-agent && npx vitest run src/features/extensions/`
预期：`ExtensionsPanel`/`CodeIntelTab`/`codeIntelYield` 全部 PASS。

- [ ] **步骤 2：类型 + 构建**

运行：`cd tauri-agent && npx tsc --noEmit && npm run build`
预期：通过（既有无关报错除外）。

- [ ] **步骤 3：手动验证（可运行环境）**

`npm run tauri dev`，打开扩展面板 →「代码智能」tab：
- 引擎下拉切换写入 `CODE_INTEL`，徽标按是否自配 codegraph 显示；
- 「刷新状态」展示 `codegraph status` 文本；「初始化/同步/重建」触发对应命令并刷新；
- 「自动初始化」「启用 explore_context」开关写键；改后出现「重启生效」，点后 sidecar 重启。

---

## 自检（规格覆盖 / 占位符 / 类型一致性）

- **规格覆盖（Spec 3）：** 第三 tab（任务 3）；引擎选择器 + 让位徽标（任务 1+2）；索引状态 + init/同步/重建 + AUTO_INIT 开关（任务 2，复用 Phase 1 命令）；探索子代理开关 + 模型（任务 2，复用 ModelSelectField）；后端命令/前端 io 复用 Phase 1；重启语义（任务 3 自动存盘 + 现有 needsRestart）。**裁剪：** 第 4 分区「工具权限」留作后续（见下），不阻塞核心交付。
- **占位符扫描：** 无 TODO；每步含完整代码与命令。`ModelSelectField`/`codeIntelIo`/`useAgentStoreContext` 均为已存在的真实导出。
- **类型一致性：** `CodeIntelTabProps` 在任务 2 定义、任务 3 使用一致；`userConfiguredCodegraph(mcpServersJson, toolNames)` 任务 1 定义、任务 2 使用一致；`codeIntel{Status,Init,Sync,Reindex}` 与 `lib/codeIntelIo.ts` 签名一致；`ExtTab` 联合类型扩展后三个 tab 分支齐全。

## 风险与执行注意

- **antd Select 在 jsdom 的交互测试**：下拉渲染在 portal，断言可能不稳；测试以「回调写对键」为准（任务 4 步骤 2 已给降级断言策略）。
- **共享表单实例**：CodeIntelTab 必须接收 ExtensionsPanel 的 `useSettingsForm` 切片（props），切勿在组件内再次 `useSettingsForm`（会产生第二份不同步状态）。
- **status 文本含 ANSI**：`codegraph status` 输出带颜色码，本期按纯文本 `white-space: pre-wrap` 展示；如需去色可后续加 strip-ANSI（非阻塞）。

## 后续（不在本计划）

- **工具权限分区（Spec 3 第 4 分区）：** 列出 codegraph 注入工具并复用 mcp-policy 的 per-tool 权限 UI（`CODEGRAPH_MCP_TOOLS` 透传）。
- **status 结构化：** 把 `codegraph status` 文本解析为节点/文件/边数的结构化展示。
- **Phase 4 · GitNexus opt-in：** 引擎选 GitNexus 时的「准备/下载」流程 + 与 CodeGraph 互斥。
