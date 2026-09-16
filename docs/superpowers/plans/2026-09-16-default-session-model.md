# 新会话默认模型 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 「通用与模型」增加新会话默认模型；进入空白草稿时输入栏用它（留空走上次选过的，不可用走列表第一项）；首发落盘前把输入栏模型写入新会话。

**架构：** 设置项 `defaultSessionModel`（`provider/id`）进现有 `SETTINGS_SCHEMA`。`settingsModelToKey` 转成输入栏 NUL 键。草稿时 `ModelThinkingAction` 不读 `getState().model`、不 `setModel`；`peekComposerModel` 读 workspace cache。`ChatView.ensureSessionForSend` 在 `newSession` 之后、`prompt` 之前 `setModel`。

**技术栈：** TypeScript、vitest、现有 `ModelSelectField` / `pickFallbackModelKey` / `scrubLinkedModelSettings`。

**上游规格：** `docs/superpowers/specs/2026-09-16-default-session-model-design.md`。§3.2 以规格里「设了但不可用 → 列表第一项、不要并上 lastGlobalModelKey」为准。

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- **按编号顺序执行，不要跳序。**
- Windows 提交用 PowerShell here-string。禁止 emoji。
- **用户未明确要求提交时，跳过每个任务的 Commit 步骤。**
- **不要改** 官方 `SettingsManager` 默认模型、思考档策略、子代理模型、`titleModel` 语义、MCP / 扩展。
- `modelKey` 是 NUL 分隔；设置盘上是 `"provider/id"`。草稿回退必须先 `settingsModelToKey`。
- 草稿判定：`draftConversationCwd` 与 `workspace` 走 `pathsEquivalent`（与 `ChatView` 相同）。
- 设置页手动保存：草稿只读 `pi.getSettings()` 落盘值。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试>
```

**提交（仅当用户要求时）：**

```powershell
git add <本任务文件>
git commit -m @"
feat(settings): <本任务一句话>

"@
```

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/features/chat/input/sessionModel.ts` | 新增 `settingsModelToKey` |
| `electron-agent/src/features/chat/input/sessionModel.test.ts` | 转换用例 |
| `electron-agent/src/features/settings/settingsSchema.ts` | `general` 最前插入 `defaultSessionModel` |
| `electron-agent/src/features/settings/settingsSchema.test.ts` | 字段顺序与文案 |
| `electron-agent/src/features/settings/scrubLinkedModelSettings.test.ts` | 删供应商清掉 `defaultSessionModel` |
| `electron-agent/src/features/chat/input/actions/ModelThinkingAction.tsx` | 草稿回退、`peekComposerModel`、草稿不 `setModel` |
| `electron-agent/src/features/chat/input/actions/ModelThinkingAction.test.tsx` | 草稿用默认 / 留空跟上次 / 不 setModel |
| `electron-agent/src/features/chat/ChatView.tsx` | 首发 `newSession` 后 `setModel` |
| `electron-agent/src/features/chat/ChatView.test.tsx` | 调用顺序 |

---

### 任务 1：`settingsModelToKey`

**文件：**
- 修改：`electron-agent/src/features/chat/input/sessionModel.ts`
- 测试：`electron-agent/src/features/chat/input/sessionModel.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `sessionModel.test.ts` 的 `pickFallbackModelKey` describe 之后追加：

```ts
describe('settingsModelToKey', () => {
  it('converts provider/id settings values into composer keys', () => {
    expect(settingsModelToKey('openai/g')).toBe(modelKey('openai', 'g'));
    expect(settingsModelToKey('  anthropic/claude-sonnet  ')).toBe(modelKey('anthropic', 'claude-sonnet'));
  });

  it('treats empty or malformed values as unset', () => {
    expect(settingsModelToKey('')).toBe('');
    expect(settingsModelToKey('   ')).toBe('');
    expect(settingsModelToKey('openai')).toBe('');
    expect(settingsModelToKey('/g')).toBe('');
    expect(settingsModelToKey('openai/')).toBe('');
    expect(settingsModelToKey('/')).toBe('');
  });
});
```

并把 import 改成：

```ts
import { pickFallbackModelKey, selectedModelLabel, sessionModelKey, settingsModelToKey } from './sessionModel';
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/sessionModel.test.ts
```

预期：FAIL，`settingsModelToKey` is not exported。

- [ ] **步骤 3：实现**

在 `sessionModel.ts` 的 `sessionModelKey` 之后加入（必须用 `modelKey`，不要手拼 NUL）：

```ts
/** 设置盘上的 "provider/id"（第一个 '/' 切开）→ 输入栏 modelKey；非法当留空。 */
export function settingsModelToKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const idx = trimmed.indexOf('/');
  if (idx <= 0 || idx === trimmed.length - 1) return '';
  return modelKey(trimmed.slice(0, idx), trimmed.slice(idx + 1));
}
```

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/sessionModel.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/features/chat/input/sessionModel.ts electron-agent/src/features/chat/input/sessionModel.test.ts
git commit -m @"
feat(settings): convert stored provider/id defaults into composer model keys

"@
```

---

### 任务 2：设置 schema 与供应商删除清理

**文件：**
- 修改：`electron-agent/src/features/settings/settingsSchema.ts`
- 测试：`electron-agent/src/features/settings/settingsSchema.test.ts`
- 测试：`electron-agent/src/features/settings/scrubLinkedModelSettings.test.ts`

- [ ] **步骤 1：改失败测试**

`settingsSchema.test.ts` 里 `expect(fields.map((field) => field.key)).toEqual([...])` 改成：

```ts
    expect(fields.map((field) => field.key)).toEqual([
      'defaultSessionModel',
      'titleModel',
      'AUTO_TITLE',
      'COMPACTION_PREVIEW',
      'goal.autoContinueOnOpen',
    ]);
```

同文件 `describe('SETTINGS_SCHEMA general')` 再加：

```ts
  it('把新会话默认模型放在通用与模型的第一项', () => {
    const fields = SETTINGS_SCHEMA.find((category) => category.id === 'general')?.fields ?? [];
    expect(fields[0]).toMatchObject({
      key: 'defaultSessionModel',
      label: '新会话默认模型',
      type: 'model',
      placeholder: '如 anthropic/claude-sonnet',
      description: '进入空白草稿时使用；留空＝上次选过的，没有再用列表第一项',
      effect: 'instant',
    });
  });
```

`scrubLinkedModelSettings.test.ts` 追加：

```ts
  it('clears defaultSessionModel when it points at the deleted provider', () => {
    const { next, changed, clearedKeys } = scrubLinkedModelSettings(
      { defaultSessionModel: 'gone/flash', titleModel: 'openai/gpt-4o' },
      ['gone'],
    );
    expect(changed).toBe(true);
    expect(next.defaultSessionModel).toBe('');
    expect(next.titleModel).toBe('openai/gpt-4o');
    expect(clearedKeys).toContain('defaultSessionModel');
    expect(clearedKeys).not.toContain('titleModel');
  });
```

不要改 `scrubLinkedModelSettings.ts` 实现。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/settings/settingsSchema.test.ts src/features/settings/scrubLinkedModelSettings.test.ts
```

预期：FAIL，字段表没有 `defaultSessionModel`；清理用例 `clearedKeys` 不含该项。

- [ ] **步骤 3：改 schema**

在 `settingsSchema.ts` 的 `id: 'general'` 的 `fields` 数组**最前面**插入（`titleModel` 那一项保持不动，只是后移）：

```ts
      {
        key: 'defaultSessionModel',
        label: '新会话默认模型',
        type: 'model',
        placeholder: '如 anthropic/claude-sonnet',
        description: '进入空白草稿时使用；留空＝上次选过的，没有再用列表第一项',
        effect: 'instant',
      },
```

UI 不用手写：`SettingFieldInput` 对 `type: 'model'` 已经渲染 `ModelSelectField`，testid 为 `set-field-defaultSessionModel`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/settings/settingsSchema.test.ts src/features/settings/scrubLinkedModelSettings.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/features/settings/settingsSchema.ts electron-agent/src/features/settings/settingsSchema.test.ts electron-agent/src/features/settings/scrubLinkedModelSettings.test.ts
git commit -m @"
feat(settings): add default session model to general settings

"@
```

---

### 任务 3：草稿输入栏用默认模型

**文件：**
- 修改：`electron-agent/src/features/chat/input/actions/ModelThinkingAction.tsx`
- 测试：`electron-agent/src/features/chat/input/actions/ModelThinkingAction.test.tsx`

- [ ] **步骤 1：改测试夹具并追加失败用例**

在现有 `piMock` 增加 `getSettings`。在 `vi.mock('../../../../lib/pi')` **之前**把 hoisted mock 改成：

```ts
const { piMock, sessionState } = vi.hoisted(() => ({
  piMock: {
    getState: vi.fn(() =>
      Promise.resolve({
        thinkingLevel: 'off',
        model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      }),
    ),
    setModel: vi.fn(() => Promise.resolve()),
    setThinkingLevel: vi.fn(() => Promise.resolve()),
    getSettings: vi.fn(() => Promise.resolve({} as Record<string, string>)),
  },
  sessionState: { draftConversationCwd: null as string | null },
}));
```

在 `vi.mock('../../../../stores/AgentStoreContext'...)` 旁增加：

```ts
vi.mock('../../../../store/session', () => {
  const useSessionStore = (sel: (s: { draftConversationCwd: string | null }) => unknown) =>
    sel({ draftConversationCwd: sessionState.draftConversationCwd });
  useSessionStore.getState = () => ({ draftConversationCwd: sessionState.draftConversationCwd });
  return { useSessionStore };
});
```

`beforeEach` 里加：

```ts
  sessionState.draftConversationCwd = null;
  piMock.getSettings.mockResolvedValue({});
```

import 改成：

```ts
import ModelThinkingAction, { peekComposerModel, resetModelThinkingCacheForTests } from './ModelThinkingAction';
```

在 `describe('ModelThinkingAction')` 末尾追加：

```ts
  it('草稿会话使用设置里的默认模型，忽略 getState.model，且不 setModel', async () => {
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'openai/g' });
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(piMock.setModel).not.toHaveBeenCalled();
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
  });

  it('草稿且设置为空时沿用上次选过的模型', async () => {
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.getState).toHaveBeenCalled();
    });
    fireEvent.click(await screen.findByText('GPT'));
    expect(piMock.setModel).toHaveBeenCalledWith('/ws', 'openai', 'g');
    piMock.setModel.mockClear();
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({});
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getAllByTestId('model-trigger').pop()?.textContent).toContain('GPT');
    });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('草稿默认模型不在目录时回退列表第一项，不跟上次选过的', async () => {
    render(<ModelThinkingAction />);
    await waitFor(() => expect(piMock.getState).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('GPT'));
    piMock.setModel.mockClear();
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'gone/flash' });
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getAllByTestId('model-trigger').pop()?.textContent).toContain('My Model');
    });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });
```

第二、三例用第二次 `render` 会在文档里留下两个 trigger。用 `cleanup()` 再 render 更干净。把后两例改成：

```ts
  it('草稿且设置为空时沿用上次选过的模型', async () => {
    const first = render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.getState).toHaveBeenCalled();
    });
    fireEvent.click(await screen.findByText('GPT'));
    expect(piMock.setModel).toHaveBeenCalledWith('/ws', 'openai', 'g');
    piMock.setModel.mockClear();
    first.unmount();
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({});
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('草稿默认模型不在目录时回退列表第一项，不跟上次选过的', async () => {
    const first = render(<ModelThinkingAction />);
    await waitFor(() => expect(piMock.getState).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('GPT'));
    piMock.setModel.mockClear();
    first.unmount();
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'gone/flash' });
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });
```

`resetModelThinkingCacheForTests` 会清掉 `lastGlobalModelKey`。因此「留空沿用上次」那例 **unmount 之后不要调用** `resetModelThinkingCacheForTests`（`beforeEach` 只在用例开始时跑，unmount 中间不会清）。`lastGlobalModelKey` 在第一次点 GPT 时已写入模块变量，第二次 render 草稿读得到。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/actions/ModelThinkingAction.test.tsx
```

预期：FAIL，草稿仍显示 getState 的 My Model，或 `peekComposerModel` 未导出。

- [ ] **步骤 3：实现**

`ModelThinkingAction.tsx`：

1. 增加 import：

```ts
import { useSessionStore } from '../../../../store/session';
import { pathsEquivalent } from '../../../../lib/pathUtils';
import { pickFallbackModelKey, selectedModelLabel, sessionModelKey, settingsModelToKey } from '../sessionModel';
```

（`pickFallbackModelKey` 那行已存在，合并进现有 import。）

2. 在 `resetModelThinkingCacheForTests` 旁导出：

```ts
export function peekComposerModel(workspace: string): { provider: string; id: string } | null {
  const key = cacheByWorkspace.get(workspace)?.modelKey;
  if (!key) return null;
  const parsed = parseModelKey(key);
  if (!parsed.provider || !parsed.id) return null;
  return parsed;
}
```

3. 组件内：

```ts
  const draftConversationCwd = useSessionStore((s) => s.draftConversationCwd);
  const isDraftConversation = Boolean(
    draftConversationCwd && pathsEquivalent(draftConversationCwd, workspace),
  );
```

4. 把 `applyFallback` 改成可传入 preferred（默认仍是 `lastGlobalModelKey`）：

```ts
  const applyFallback = useCallback((bind: boolean, preferred = lastGlobalModelKey): boolean => {
    const fallback = pickFallbackModelKey(modelsRef.current, preferred);
    if (!fallback) {
      setReady(true);
      return false;
    }
    const { provider, id } = parseModelKey(fallback);
    const info = modelsRef.current.find((item) => item.provider === provider && item.id === id);
    applySelection(fallback, mergeModelCatalog({ provider, id, name: info?.name, api: info?.api, reasoning: info?.reasoning, thinkingLevelMap: info?.thinkingLevelMap }, modelsRef.current));
    if (bind) void pi.setModel(workspace, provider, id);
    return true;
  }, [applySelection, workspace]);
```

5. `loadState` 在取完 `getState` 之前先处理草稿。完整替换 `loadState` 函数体开头到 `getState` 之前：

```ts
  const loadState = useCallback(async (): Promise<'ok' | 'empty' | 'error'> => {
    const seq = ++loadSeq.current;
    const draft = useSessionStore.getState().draftConversationCwd;
    const isDraft = Boolean(draft && pathsEquivalent(draft, workspace));
    if (isDraft) {
      canBindSession.current = false;
      try {
        const settings = await pi.getSettings();
        if (seq !== loadSeq.current) return 'ok';
        const fromSettings = settingsModelToKey(settings.defaultSessionModel ?? '');
        const inList = Boolean(
          fromSettings && modelsRef.current.some((item) => modelKey(item.provider, item.id) === fromSettings),
        );
        const preferred = inList ? fromSettings : fromSettings ? '' : lastGlobalModelKey;
        return applyFallback(false, preferred) ? 'ok' : 'empty';
      } catch {
        if (seq !== loadSeq.current) return 'ok';
        return applyFallback(false, lastGlobalModelKey) ? 'ok' : 'empty';
      }
    }
    try {
      const state = (await pi.getState(workspace)) as RpcSessionState;
      // ...existing non-draft body unchanged...
```

其余 `loadState` 的非草稿分支保持原样（有 model 就 `applySelection`，空则 `applyFallback(canBindSession.current)`）。

6. 触发 `loadState` 的 `useEffect` 依赖数组加上 `draftConversationCwd`（现有是 `[workspace, workspaceReady, loadState, switchSeq]`）。

7. `onChangeModel` 里 `await pi.setModel` / `setThinkingLevel` 仅在 **非草稿** 时执行。草稿仍 `applySelection`（更新 cache，供首发 `peekComposerModel`），但不要 `setModel`：

```ts
    applySelection(key, nextModel, target);
    if (isDraftConversation) return;
    void (async () => {
      try {
        await pi.setModel(workspace, provider, id);
        const state = (await pi.getState(workspace)) as RpcSessionState;
        if (target !== state.thinkingLevel) await pi.setThinkingLevel(workspace, target);
      } catch {
        /* 保持后端现状 */
      }
    })();
```

`isDraftConversation` 来自 render 闭包；点选时若已是草稿即可。把 `onChangeModel` 改成 `useCallback` 不是必须，保持现有函数声明、读取最新 `isDraftConversation` 即可。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/actions/ModelThinkingAction.test.tsx
```

预期：PASS（含原有 8 条 + 新 3 条）。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/features/chat/input/actions/ModelThinkingAction.tsx electron-agent/src/features/chat/input/actions/ModelThinkingAction.test.tsx
git commit -m @"
feat(chat): apply default session model only on blank draft composers

"@
```

---

### 任务 4：首发落盘前写入输入栏模型

**文件：**
- 修改：`electron-agent/src/features/chat/ChatView.tsx`
- 测试：`electron-agent/src/features/chat/ChatView.test.tsx`

- [ ] **步骤 1：扩展失败测试**

`ChatView.test.tsx` 的 hoisted `state` 增加：

```ts
  piSetModel: vi.fn(),
  composerModel: { provider: 'openai', id: 'g' } as { provider: string; id: string } | null,
```

`vi.mock('../../lib/pi')` 的 `pi` 对象增加：

```ts
    setModel: state.piSetModel,
```

`beforeEach` 若有清 mock，确保 `composerModel` 默认 `{ provider: 'openai', id: 'g' }`。文件里若没有 `beforeEach`，在「草稿对话首发」用例开头设：

```ts
    state.composerModel = { provider: 'openai', id: 'g' };
    state.piSetModel.mockClear();
    state.piSetModel.mockResolvedValue(undefined);
```

在 `vi.mock('./ChatInput'...)` 旁增加：

```ts
vi.mock('./input/actions/ModelThinkingAction', () => ({
  peekComposerModel: () => state.composerModel,
}));
```

把现有 `it('草稿对话首发时先懒初始化 workspace 和 session')` 的断言扩展为（保留原有 openWorkspace / newSession / setActiveSession / clearDraft 断言）：

```ts
    expect(state.piSetModel).toHaveBeenCalledWith('/home/.pi/agent/works/u1', 'openai', 'g');
    expect(state.piSetModel.mock.invocationCallOrder[0]).toBeLessThan(state.piPrompt.mock.invocationCallOrder[0]);
    expect(state.piNewSession.mock.invocationCallOrder[0]).toBeLessThan(state.piSetModel.mock.invocationCallOrder[0]);
```

再加一例：

```ts
  it('草稿首发没有输入栏模型时不调用 setModel', async () => {
    state.composerModel = null;
    state.sessionState.activeSessionPath = null;
    state.sessionState.draftConversationCwd = '/home/.pi/agent/works/u1';
    state.piOpenWorkspace.mockResolvedValue({ restoredSession: null, sessionFile: null });
    state.piGetState.mockResolvedValue({ sessionFile: '/home/.pi/agent/works/u1/created.jsonl' });
    state.piPrompt.mockResolvedValue(undefined);
    state.piSetModel.mockClear();

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.piNewSession).toHaveBeenCalled();
    expect(state.piSetModel).not.toHaveBeenCalled();
    expect(state.piPrompt).toHaveBeenCalled();
  });
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/ChatView.test.tsx
```

预期：FAIL，`setModel` 未被调用（或 mock 未定义导致别的错误）。若 mock 循环依赖导致 ChatView 加载失败，把 `peekComposerModel` 的 mock 放到 `vi.hoisted` 的 `state` 能访问到的位置（与现有 `ChatInput` mock 同一风格即可）。

- [ ] **步骤 3：接线**

`ChatView.tsx` 增加：

```ts
import { peekComposerModel } from './input/actions/ModelThinkingAction';
```

在 `ensureSessionForSend` 里，`st.clearDraftConversation(workspace);` **之后**、函数返回之前插入：

```ts
      const selected = peekComposerModel(workspace);
      if (selected) await pi.setModel(workspace, selected.provider, selected.id);
```

`markScratchUsed(workspace);` 可仍在其后或之前，顺序不重要。必须在随后的 `pi.prompt` 之前（`ensureSessionForSend` 本身在 `prompt` 前 await）。

非草稿、已有 `activeSessionPath` 的早期 `return` 不要走这段。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/ChatView.test.tsx src/features/chat/input/actions/ModelThinkingAction.test.tsx src/features/chat/input/sessionModel.test.ts src/features/settings/settingsSchema.test.ts src/features/settings/scrubLinkedModelSettings.test.ts
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/features/chat/ChatView.tsx electron-agent/src/features/chat/ChatView.test.tsx
git commit -m @"
feat(chat): bind composer model after creating a draft session

"@
```

---

## 规格对照

| 规格 | 任务 |
| --- | --- |
| §1 成功标准 1 设置项 | 2 |
| §1 成功标准 2 草稿显示且不 setModel | 3 |
| §1 成功标准 3 首发写回 | 4 |
| §1 成功标准 4 留空链 | 1, 3 |
| §1 成功标准 5 删供应商清理 | 2 |
| §2 `settingsModelToKey` | 1 |
| §3.1 草稿判定 | 3 |
| §3.2 preferred 规则（含不可用→第一项） | 3 |
| §3.3 `peekComposerModel` | 3, 4 |
| §4 未保存脏值 / 不写 SDK 默认 | 不实现 |
| §5 测试表 | 1–4 |
| §6 不改 architecture | 遵守 |
