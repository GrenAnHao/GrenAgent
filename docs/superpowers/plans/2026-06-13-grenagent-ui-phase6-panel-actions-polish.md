# GrenAgent UI 第 6 期：面板写操作 + UI 打磨（经 extension 命令，不重建 sidecar）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给已落地的管理面板补「写操作」并打磨 UI，使其更贴原型：知识库（添加文档 / 清空）、记忆（删除 / 清空）、审查（生成报告 / 清空 / 让 agent 审查）、创作（生图）——都经 pi 的 extension 命令通道触发，操作后刷新；并统一空/加载态。

**架构（关键）：**
- **写操作 = extension 命令**：pi RPC 的 `prompt` 命令对 `/xxx` extension 命令**立即执行**（文档已确认）。新增 `pi.runCommand(workspace, cmd)`（薄封装 `agent_prompt`，不往聊天插入用户气泡），各面板按钮调它发 `/kb clear`、`/kb add <path>`、`/memory forget <id>`、`/memory clear`、`/review report`、`/review clear`，**await 后重新拉列表刷新**。`/kb add` 走 extension 自带 embedding，无需 Rust 做 embedding。**不改 sidecar、不重建**。
- **创作生图 / 让 agent 审查**：image-gen / code-review 的「生成」是工具（无命令），用 `pi.prompt` 发自然语言指令让 agent 调用（走 LLM）。
- **刷新**：面板把「加载数据」抽成可复用的 `reload()`，写操作成功后调用。
- **UI 打磨**：空态/加载态统一；占位 `--gren-*` 颜色改用 `@lobehub/ui` 的 `cssVar.*`（与 Titlebar/Sidebar 一致），对齐主题。

**技术栈：** React 19、`@lobehub/ui`（`ActionIcon`/`Flexbox`、`cssVar`）、`@tauri-apps/plugin-dialog`（文件选择，若未装则用 `prompt()` 输入路径——见任务 2 备注）、vitest + @testing-library/react（`vi.hoisted` mock）。

---

## 范围

第 6 期：管理面板写操作 + UI 打磨。完成后：四个管理面板有真实写操作（经 extension 命令/工具），统一空/加载态，配色对齐主题。

**本期不做（受底层限制，已确认）**：
- **记忆来源（手动/捕获/提取）/命中统计**：`memory` store schema 无这两个字段 → 需改 extension + 重建 sidecar，单列。
- **记忆 手动添加 / 提升为全局**：`/memory` 命令只有 list/forget/clear，无 add/promote（memory_save 是工具）→ 用 prompt 发自然语言（走 LLM），列为可选。
- **im-gateway 实时运行状态**：`/imgateway` 输出经 `ctx.ui.notify`，RPC 模式回传链路未确认 → 连接面板维持「配置态 + 重启生效」，实时状态单列。
- **审查 diff 片段**：`review_notes` 无 diff，需结合 `git_diff`（工具）→ 详情维持 message + file:line，diff 单列。

**前置事实（已核实）**
- pi RPC `prompt` 对 `/cmd` extension 命令立即执行（`binaries/docs/rpc.md`）。
- 命令清单：`/kb stats|add <path>|clear`、`/memory list|forget <id>|clear [project|global|all]`、`/review report|list|clear`、`/imgateway`。
- 前端 `pi.prompt(workspace, message, streamingBehavior?, images?)` 已存在（`lib/pi.ts`）；`agent_prompt` RPC 已注册。
- 面板已有数据加载（KnowledgePanel/MemoryPanel/ReviewPanel/CreatePanel 的 useEffect）；本期把加载逻辑抽出复用。
- 颜色：Titlebar/Sidebar 用 `cssVar.colorText/colorBorderSecondary/...`；面板目前用 `--gren-*` 回退值。

## 文件结构

- 修改 `tauri-agent/src/lib/pi.ts` — 加 `runCommand`
- 修改 `tauri-agent/src/features/knowledge/KnowledgePanel.tsx`（+ .test）— 添加文档 / 清空 + 刷新
- 修改 `tauri-agent/src/features/memory/MemoryPanel.tsx`（+ .test）— 删除 / 清空 + 刷新
- 修改 `tauri-agent/src/features/review/ReviewPanel.tsx`（+ .test）— 生成报告 / 清空 / 让 agent 审查 + 刷新
- 修改 `tauri-agent/src/features/create/CreatePanel.tsx`（+ .test）— 生图（prompt）
- 修改各面板的 `--gren-*` 配色为 `cssVar.*`（UI 打磨，随各任务顺手做）

命令：`cd tauri-agent && npx vitest run <file>` / `npx tsc --noEmit`。

---

## 任务 1：pi.runCommand 封装

**文件：** 修改 `tauri-agent/src/lib/pi.ts`

- [ ] **步骤 1：加 binding**

在 `tauri-agent/src/lib/pi.ts` 的 `pi` 对象里 `setSettings: ...,` 之后追加：

```ts
  /**
   * 执行一条 extension 命令（如 "/kb clear"）。
   * pi RPC 的 prompt 对 /cmd 立即执行；面板写操作走此通道，避免新增 RPC。
   */
  runCommand: (workspace: string, command: string) =>
    invoke<unknown>('agent_prompt', { workspace, message: command }),
```

- [ ] **步骤 2：类型检查**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/lib/pi.ts
git commit -m "feat(grenagent): add pi.runCommand for extension commands (phase6)"
```

---

## 任务 2：知识库写操作（清空 / 添加文档）

**文件：** 修改 `tauri-agent/src/features/knowledge/KnowledgePanel.tsx` + `KnowledgePanel.test.tsx`

> 添加文档用 `window.prompt` 取路径（避免引入 dialog 插件依赖；GUI 里弹原生输入框），再发 `/kb add <path>`。清空发 `/kb clear`。两者 await 后 `reload()`。

- [ ] **步骤 1：更新测试（先红）**

在 `KnowledgePanel.test.tsx` 顶部 mock 增加 `runCommand`，并把 `vi.mock('../../lib/pi' ...)` 改为含 `runCommand`；追加用例：

```tsx
// 在 vi.hoisted 里加 runCommand: vi.fn(() => Promise.resolve())
// 在 vi.mock('../../lib/pi') 的 pi 里加 runCommand
// 顶部加： const promptSpy = vi.spyOn(window, 'prompt');

it('clears the knowledge base via /kb clear and reloads', async () => {
  renderPanel();
  await waitFor(() => expect(screen.getByTestId('kb-source-a.md')).toBeTruthy());
  // 自动确认 window.confirm
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByTestId('kb-clear'));
  await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/kb clear'));
});

it('adds a document via /kb add <path>', async () => {
  renderPanel();
  await waitFor(() => expect(screen.getByTestId('kb-add')).toBeTruthy());
  vi.spyOn(window, 'prompt').mockReturnValue('docs/new.md');
  fireEvent.click(screen.getByTestId('kb-add'));
  await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/kb add docs/new.md'));
});
```

（完整测试文件：保留原有 2 个用例，按上方补 mock + 2 用例。原有 `vi.mock('../../lib/pi', () => ({ pi: { kbStats, kbSources, kbChunks } }))` 改为加 `runCommand`。）

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/knowledge/KnowledgePanel.test.tsx`
预期：FAIL（无 kb-clear/kb-add 按钮、runCommand 未调用）。

- [ ] **步骤 3：实现——抽 reload + 顶部操作按钮**

在 `KnowledgePanel.tsx`：把首个 useEffect 的加载逻辑抽成 `reload`（用 `useCallback`），useEffect 调用它；header 右侧加「添加文档 / 清空」按钮。

把 `import { Flexbox } from '@lobehub/ui';` 改为 `import { ActionIcon, Flexbox } from '@lobehub/ui';`，并 `import { BookPlus, Trash2 } from 'lucide-react';` `import { pi, ... } from '../../lib/pi';`（pi 已导入）。

把加载 useEffect 改为：

```tsx
  const reload = useCallback(() => {
    let alive = true;
    setError(null);
    void Promise.all([pi.kbStats(workspace), pi.kbSources(workspace)])
      .then(([s, src]) => {
        if (!alive) return;
        setStats(s);
        setSources(src);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [workspace]);

  useEffect(() => reload(), [reload]);

  const onClear = useCallback(async () => {
    if (!window.confirm('确定清空知识库？此操作不可撤销。')) return;
    await pi.runCommand(workspace, '/kb clear');
    setSelected(null);
    reload();
  }, [workspace, reload]);

  const onAdd = useCallback(async () => {
    const path = window.prompt('输入要索引的文件路径（相对项目根或绝对路径）：');
    if (!path?.trim()) return;
    await pi.runCommand(workspace, `/kb add ${path.trim()}`);
    reload();
  }, [workspace, reload]);
```

（需 `import { useCallback } from 'react'`，与现有 import 合并。）

把 header 改为带操作按钮：

```tsx
  const header = (
    <Flexbox horizontal align="center" gap={12} data-testid="kb-header" style={{ fontSize: 13, width: '100%' }}>
      <span>{stats ? `${stats.chunks} 块 · ${stats.sources} 文档` : '加载中…'}</span>
      <span style={{ color: muted }}>{stats?.model ? `embedding: ${stats.model}` : 'keyword 模式'}</span>
      <div style={{ flex: 1 }} />
      <ActionIcon data-testid="kb-add" icon={BookPlus} size="small" title="添加文档" onClick={() => void onAdd()} />
      <ActionIcon data-testid="kb-clear" icon={Trash2} size="small" title="清空知识库" onClick={() => void onClear()} />
    </Flexbox>
  );
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/knowledge/KnowledgePanel.test.tsx`
预期：PASS（4 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/knowledge/KnowledgePanel.tsx tauri-agent/src/features/knowledge/KnowledgePanel.test.tsx
git commit -m "feat(grenagent): knowledge add/clear via extension commands (phase6)"
```

---

## 任务 3：记忆写操作（删除 / 清空）

**文件：** 修改 `tauri-agent/src/features/memory/MemoryPanel.tsx` + `MemoryPanel.test.tsx`

> 选中记忆后可「删除」（`/memory forget <id>`）；顶部「清空」按当前 scope 筛选发 `/memory clear [project|global|all]`（filter='all'→all）。await 后 reload。

- [ ] **步骤 1：更新测试（先红）**

mock 加 `runCommand`；追加：

```tsx
it('deletes the selected memory via /memory forget', async () => {
  renderPanel();
  await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
  fireEvent.click(screen.getByTestId('mem-item-project-p1'));
  fireEvent.click(screen.getByTestId('mem-delete'));
  await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/memory forget p1'));
});

it('clears memories via /memory clear', async () => {
  renderPanel();
  await waitFor(() => expect(screen.getByTestId('mem-clear')).toBeTruthy());
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByTestId('mem-clear'));
  await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/memory clear all'));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/memory/MemoryPanel.test.tsx`
预期：FAIL。

- [ ] **步骤 3：实现**

抽 `reload`（同任务 2 模式，加载 memStats+memList）；header 加「清空」按钮（`/memory clear ${filter==='all'?'all':filter}`）；详情区 selected 时加「删除」按钮（`/memory forget ${selected.id}`）。import `ActionIcon` + `Trash2`、`useCallback`。

header 追加（在 FILTERS Flexbox 后）：

```tsx
      <div style={{ flex: 1 }} />
      <ActionIcon data-testid="mem-clear" icon={Trash2} size="small" title="清空（按当前筛选）" onClick={() => void onClear()} />
```

detail（selected 分支）追加删除按钮：

```tsx
      <ActionIcon data-testid="mem-delete" icon={Trash2} size="small" title="删除此记忆" onClick={() => void onDelete()} />
```

回调：

```tsx
  const onClear = useCallback(async () => {
    const scope = filter === 'all' ? 'all' : filter;
    if (!window.confirm(`确定清空${scope === 'all' ? '全部' : scope === 'project' ? '项目' : '全局'}记忆？`)) return;
    await pi.runCommand(workspace, `/memory clear ${scope}`);
    setSelectedKey(null);
    reload();
  }, [workspace, filter, reload]);

  const onDelete = useCallback(async () => {
    if (!selected) return;
    await pi.runCommand(workspace, `/memory forget ${selected.id}`);
    setSelectedKey(null);
    reload();
  }, [workspace, selected, reload]);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/memory/MemoryPanel.test.tsx`
预期：PASS（5 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/memory/MemoryPanel.tsx tauri-agent/src/features/memory/MemoryPanel.test.tsx
git commit -m "feat(grenagent): memory delete/clear via extension commands (phase6)"
```

---

## 任务 4：审查写操作（生成报告 / 清空 / 让 agent 审查）

**文件：** 修改 `tauri-agent/src/features/review/ReviewPanel.tsx` + `ReviewPanel.test.tsx`

> 「生成报告」`/review report`、「清空」`/review clear`、「让 agent 审查」用 `pi.prompt` 发自然语言（走 LLM，引导 agent 调 git_diff + review_note）。前两者 await 后 reload。

- [ ] **步骤 1：更新测试（先红）**

mock 加 `runCommand` 与 `prompt`（pi.prompt）：

```tsx
// vi.hoisted: rvList, runCommand: vi.fn(()=>Promise.resolve()), prompt: vi.fn(()=>Promise.resolve())
// vi.mock('../../lib/pi', () => ({ pi: { rvList, runCommand, prompt } }))

it('clears review notes via /review clear', async () => {
  renderPanel();
  await waitFor(() => expect(screen.getByTestId('rv-clear')).toBeTruthy());
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByTestId('rv-clear'));
  await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/review clear'));
});

it('triggers agent review via prompt', async () => {
  renderPanel();
  await waitFor(() => expect(screen.getByTestId('rv-agent')).toBeTruthy());
  fireEvent.click(screen.getByTestId('rv-agent'));
  await waitFor(() => expect(prompt).toHaveBeenCalled());
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/review/ReviewPanel.test.tsx`
预期：FAIL。

- [ ] **步骤 3：实现**

抽 `reload`；header 加按钮：「让 agent 审查」（`pi.prompt(workspace, '请审查当前工作区改动：用 git_diff 获取 diff，逐条用 review_note 记录发现（severity/file/line/message）。')`）、「生成报告」（`/review report`）、「清空」（`/review clear`）。import `ActionIcon` + `FileText`/`Bot`/`Trash2`、`useCallback`。

header（在 `{notes.length} 条发现` 后）：

```tsx
      <div style={{ flex: 1 }} />
      <ActionIcon data-testid="rv-agent" icon={Bot} size="small" title="让 agent 审查" onClick={() => void onAgentReview()} />
      <ActionIcon data-testid="rv-report" icon={FileText} size="small" title="生成报告" onClick={() => void onReport()} />
      <ActionIcon data-testid="rv-clear" icon={Trash2} size="small" title="清空发现" onClick={() => void onClear()} />
```

回调：

```tsx
  const onClear = useCallback(async () => {
    if (!window.confirm('确定清空审查发现？')) return;
    await pi.runCommand(workspace, '/review clear');
    setSelectedId(null);
    reload();
  }, [workspace, reload]);

  const onReport = useCallback(async () => {
    await pi.runCommand(workspace, '/review report');
  }, [workspace]);

  const onAgentReview = useCallback(() => {
    void pi.prompt(
      workspace,
      '请审查当前工作区改动：用 git_diff 获取 diff，逐条用 review_note 记录发现（severity/file/line/message），完成后我会刷新列表。',
    );
  }, [workspace]);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/review/ReviewPanel.test.tsx`
预期：PASS（4 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/review/ReviewPanel.tsx tauri-agent/src/features/review/ReviewPanel.test.tsx
git commit -m "feat(grenagent): review report/clear/agent-review actions (phase6)"
```

---

## 任务 5：创作生图 + 刷新

**文件：** 修改 `tauri-agent/src/features/create/CreatePanel.tsx` + `CreatePanel.test.tsx`

> image-gen 无命令，「生成」用 `pi.prompt` 发自然语言（走 LLM 调 generate_image）。底部加 prompt 输入条（贴原型 createbar）。生成后用户可手动刷新（加刷新按钮）。

- [ ] **步骤 1：更新测试（先红）**

mock 加 `prompt`；追加：

```tsx
it('submits a generate-image prompt', async () => {
  render(<CreatePanel />);
  await waitFor(() => expect(screen.getByTestId('cr-prompt')).toBeTruthy());
  fireEvent.change(screen.getByTestId('cr-prompt'), { target: { value: '一只猫' } });
  fireEvent.click(screen.getByTestId('cr-generate'));
  await waitFor(() => expect(prompt).toHaveBeenCalledWith('/ws', expect.stringContaining('一只猫')));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/create/CreatePanel.test.tsx`
预期：FAIL。

- [ ] **步骤 3：实现**

`CreatePanel` 加底部 createbar：输入框（`cr-prompt`）+「生成」按钮（`cr-generate`），点击 `pi.prompt(workspace, '请生成一张图片：' + text)` 并清空输入；顶部加刷新按钮（重新 createList）。`import { pi } from '../../lib/pi'` 已有；加 `useCallback`、`ActionIcon` + `RefreshCw`/`Sparkles`。把加载抽 `reload`。

底部条（在 grid 之后、create-panel Flexbox 内）：

```tsx
      <Flexbox horizontal align="center" gap={8} style={{ borderTop: border, padding: '9px 12px', flex: '0 0 auto' }}>
        <input
          data-testid="cr-prompt"
          value={promptText}
          placeholder="描述要生成的图…（也可在对话里 /生图）"
          onChange={(e) => setPromptText(e.target.value)}
          style={{ flex: 1, padding: '7px 10px', borderRadius: 8, border, background: 'transparent', color: 'inherit', fontSize: 12 }}
        />
        <ActionIcon data-testid="cr-generate" icon={Sparkles} size="small" title="生成" onClick={onGenerate} />
      </Flexbox>
```

状态/回调：

```tsx
  const [promptText, setPromptText] = useState('');
  const onGenerate = useCallback(() => {
    const t = promptText.trim();
    if (!t) return;
    void pi.prompt(workspace, `请生成一张图片：${t}`);
    setPromptText('');
  }, [workspace, promptText]);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/create/CreatePanel.test.tsx`
预期：PASS（4 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/create/CreatePanel.tsx tauri-agent/src/features/create/CreatePanel.test.tsx
git commit -m "feat(grenagent): create panel generate-image prompt bar (phase6)"
```

---

## 任务 6：UI 打磨 — 配色对齐主题变量

**文件：** 修改 `KnowledgePanel.tsx` / `MemoryPanel.tsx` / `ReviewPanel.tsx` / `CreatePanel.tsx` / `ManagerLayout.tsx` / `SettingField.tsx` / `SettingsPanel.tsx` / `ConnectionsPanel.tsx`

> 把散落的 `var(--gren-fg-muted, #9aa1ac)` / `var(--gren-border, ...)` / `var(--gren-rail-active, ...)` 统一替换为 `@lobehub/ui` 的 `cssVar.*`（与 Titlebar/Sidebar 一致），使浅/深色主题切换时面板配色正确。

- [ ] **步骤 1：建立映射并替换**

在每个面板顶部 `import { cssVar } from 'antd-style';`，把：
- `const muted = 'var(--gren-fg-muted, #9aa1ac)';` → `const muted = cssVar.colorTextSecondary;`
- `const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';` → `const border = \`1px solid \${cssVar.colorBorderSecondary}\`;`
- `'var(--gren-rail-active, rgba(255,255,255,0.08))'` → `cssVar.colorFillTertiary`
- `'var(--gren-fg, inherit)'` → `cssVar.colorText`
- 卡片背景 `'var(--gren-bg-1, #16181c)'` → `cssVar.colorBgContainer`；`'var(--gren-bg-2, #1e2127)'` / `'var(--gren-bg-3, ...)'` → `cssVar.colorFillSecondary` / `cssVar.colorFillTertiary`

> `cssVar.*` 是字符串常量（zero-runtime），可直接用于内联 `style`。逐文件替换上述常量定义与内联出现处。

- [ ] **步骤 2：类型检查 + 全量测试**

运行：`cd tauri-agent && npx tsc --noEmit`（无错误）
运行：`cd tauri-agent && npx vitest run`（全部 PASS，无回归——testid 未变，仅样式）

- [ ] **步骤 3：手动验证**

`npm run tauri dev`：切浅/深色主题（titlebar 按钮），确认各管理面板背景/边框/文字随主题正确切换，无突兀的硬编码深色。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/features/knowledge/KnowledgePanel.tsx tauri-agent/src/features/memory/MemoryPanel.tsx tauri-agent/src/features/review/ReviewPanel.tsx tauri-agent/src/features/create/CreatePanel.tsx tauri-agent/src/features/common/ManagerLayout.tsx tauri-agent/src/features/settings/SettingField.tsx tauri-agent/src/features/settings/SettingsPanel.tsx tauri-agent/src/features/connections/ConnectionsPanel.tsx
git commit -m "polish(grenagent): align panel colors to theme cssVar (phase6)"
```

---

## 任务 7：手动验证（Tauri GUI）

- [ ] `npm run tauri dev`，逐面板验证写操作：
  1. 知识库：「添加文档」输入真实文件路径 → 列表新增；「清空」→ 列表空。
  2. 记忆：选中条目「删除」→ 消失；「清空」→ 按 scope 清。
  3. 审查：「让 agent 审查」→ 切到对话看 agent 跑 git_diff+review_note；回审查刷新见发现；「生成报告」「清空」。
  4. 创作：底部输入 prompt「生成」→ 切对话看 generate_image；回创作刷新见新图。
  5. 主题切换：各面板配色随浅/深主题正确。

> 写操作经 extension 命令即时执行（除生图/让agent审查走 LLM）；命令执行的 notify 文本在 RPC 下可能不回显，但 db 已改、刷新即见，属预期。

---

## 自检

**1. 规格覆盖度（设计 §4.2-§4.6 操作 + §9 主题）：**
- 知识库 添加/清空（§4.2）→ 任务 2 ✓（重索引=再次 /kb add 覆盖）
- 记忆 删除/清空（§4.3）→ 任务 3 ✓（手动添加/提升全局：无命令，列受限）
- 审查 让agent审查/生成报告/清空（§4.4）→ 任务 4 ✓（diff 片段：受限）
- 创作 生成（§4.5）→ 任务 5 ✓
- 配色对齐主题（§9）→ 任务 6 ✓

**2. 占位符扫描：** 各任务给出按钮 testid、命令字符串、回调与预期；无 TODO。受限项在「范围」明确列出（非占位）。

**3. 类型一致性：**
- `pi.runCommand(workspace, cmd)`（任务 1）被任务 2/3/4 调用，签名一致；`pi.prompt`（既有）被任务 4/5 调用。
- 各面板 `reload`（useCallback）抽取后被 useEffect + 写操作回调复用，名称一致。
- 新增按钮 testid（kb-add/kb-clear/mem-clear/mem-delete/rv-clear/rv-report/rv-agent/cr-prompt/cr-generate）在实现与测试一致。
- 任务 6 仅改样式常量（`muted`/`border` 等），不动 testid/结构，不影响测试。

## 备注

- **写操作经 extension 命令**：复用 pi RPC `prompt` 对 `/cmd` 的即时执行，零新 RPC、零 sidecar 重建——这是本期可行的关键。
- **刷新策略**：命令 await 返回后 reload；`/kb add`（含 embedding）可能稍慢，await 期间可加 loading（可选增强）。
- **受限项（需后续 + 重建 sidecar）**：记忆来源/命中统计、手动添加/提升全局、im-gateway 实时状态、审查 diff 片段——均因 extension schema/命令缺失，单列「第 7 期：extension 增强」。
- **生图/让agent审查走 LLM**：非即时、不可控，但符合「agent 自动调用」语义；面板提供入口即可。
