# 简化 Goal 条与会话内容加宽 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 Goal 嵌进输入框 `surface` 顶行，补齐 CAS `edit` 与 `/goal` 命令平面（裸命令改为查询），会话正文加宽到 `min(100%, 1120px, max(760px, 86%))`。

**架构：** AgentData 只留一条改条件通道 `edit`（人权限）；废弃 `updateBlockedCondition` 与抽屉 pause/resume 两步 hack。扩展 `/goal` 按独占控制词解析。桌面把 `/goal` 标成执行性命令，对话列表追加本地 `command-input` 行（按 `sessionId` 索引，不写 JSONL）。Goal 条读现有 `useGoalStore` 投影，不改 coordinator。

**技术栈：** TypeScript、React、antd-style、@lobehub/ui、zustand、vitest + testing-library。只改 `electron-agent` 与 `extensions/goal`。

**上游规格：** `docs/superpowers/specs/2026-09-13-goal-bar-and-chat-width-design.md`

---

## 动工前必读

- **不要改** `tauri-agent`、`extensions/goal/tools.ts`（模型工具仍只有 `block` / `begin_judging`）、`goalCoordinator.ts` 的 dispatch 白名单、`layoutStore`、标题栏 / 空状态 π、`FullscreenLoading`。
- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。图标用 `@lobehub/ui` 的 `Icon` / `ActionIcon` + `lucide-react`。
- `CHAT_CONTENT_WIDTH` 必须逐字等于 `min(100%, 1120px, max(760px, 86%))`。不改消息 `paddingInline`。
- 条件长度：服务端 `create` / `edit` 在 **trim 之后** 校验 1..4000，超限 `INVALID_GOAL`。扩展前端预检仍抛 `INVALID_PARAMS`；`edit` 分支补同样预检。
- `edit` 可转换状态：`active` / `paused` / `disarmed` / `blocked` / `error` / `complete`。`judging` 与 `cleared` 拒绝。`complete` 只改文案，不重新激活。
- `clear` 前置状态扩为 `active` / `paused` / `blocked` / `disarmed` / `error` / `complete`。
- `action:'block'` 禁止再带 `payload.condition`（抛 `INVALID_TRANSITION`）。进度只认 `reason` / `fingerprint`。
- `edit` 加入 `goalStore.update` 的 human 白名单，与 `pause` / `resume` / `clear` 同列；`origin !== 'human-ui'` 抛 `HUMAN_AUTH_REQUIRED`。
- 桌面 IPC `readGoalUpdate` 仍盖章 `origin: 'human-ui'`。`readGoalAction`（`runtime.ts` 与 `ipc/register.ts`）必须认得 `'edit'`，否则条上保存会在 IPC 层被拒。
- **扩展 RPC 通道放行（已定案方向 A）**：`/goal` 的写动作走 `client.request("goal.update")` = AgentDataRuntime **project 通道**（`runtime.ts:699-718`）。现状 `:702` 只放行 `begin_judging` / `block`，`:705` 盖章 `human-agent` → `/goal pause/resume/clear` 是 FORBIDDEN 死分支。本次：project 通道动作白名单扩为 `begin_judging` / `block` / `edit` / `clear` / `pause` / `resume`（`disarm` / `judge_pass` / `judge_fail` 仍 FORBIDDEN）；human 动作（`edit` / `clear` / `pause` / `resume`）origin 盖 `human-ui`，agent 动作（`block` / `begin_judging`）保持 `human-agent`，`create` 盖章不变。`runtime.goal.test.ts:20` 的 FORBIDDEN 断言必须改写为成功断言。
- 扩展合约 `extensions/goal/contracts.ts` 的 `kind` 与 `action` 必须同步加 `'edit'`。
- 裸 `/goal` **不再清除**。`clear` / `reset` 才清除。`/goal pause after verify` 是创建该字面条件。
- 回执走扩展 `ctx.ui.notify`（成功 `info`、RPC 失败 `error`）。`ChatView` 的「已执行 /goal」toast **不要删、不要合并**。
- `command-input` 形态写死：`{ kind: 'command-input'; id: string; command: string; rest: string }`。不进 `groupMessages`，不写 JSONL，切会话 / 重载消失。
- 条上文案必须逐字：`执行中的目标` / `未运行的目标` / `已暂停的目标` / `正在验收的目标` / `受阻的目标` / `已停止的目标` / `已完成的目标`。
- 灯色写死：active `#3dd68c` + 光晕；complete `#3dd68c` 无光晕；disarmed `#8b919c`；paused `#f5a524`；judging `#4c8dff` + 光晕；blocked/error `#f53f3f`。
- `aria-label` 写死：暂停目标、恢复目标、编辑目标、清除目标、展开目标详情。
- 清除必须 `window.confirm('清除当前目标？')`。
- 完成态留下（与 DSH 藏掉不同）。无快照 / 未就绪 / `cleared` 不渲染顶行。
- `GoalCoordinator` 不用改：`status==='active' && kind ∈ {create, resume}` 已排除 `edit`。任务 7 只加回归测试。

**测试命令（按任务裁剪）：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试文件>
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/index.test.ts
```

UI 是 Electron 桌面，以 vitest 为准；本计划不要求点真窗。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/features/chat/chatStyles.ts` | 加宽常量与理据注释 |
| `electron-agent/src/features/chat/chatStyles.test.ts` | 断言常量逐字相等 |
| `electron-agent/electron/agentData/goalContracts.ts` | `GoalCasUpdate.action` 加 `edit` |
| `electron-agent/electron/agentData/goalStore.ts` | `edit`、clear 含 complete、删 `updateBlockedCondition`、条件 1..4000 |
| `electron-agent/electron/agentData/goalStore.test.ts` | CAS 新用例 |
| `electron-agent/electron/agentData/runtime.ts` | `readGoalAction` 认 `edit`；project 通道放行 human 动作并分派 origin 盖章 |
| `electron-agent/electron/agentData/runtime.goal.test.ts` | project 通道放行用例（替换 `:20` FORBIDDEN 断言） |
| `electron-agent/electron/ipc/register.ts` | IPC `readGoalAction` 认 `edit` |
| `electron-agent/electron/ipc/commandCoverage.test.ts` | `edit` 能进 `goalUpdate` |
| `extensions/goal/contracts.ts` | `kind` / `action` 加 `edit` |
| `extensions/goal/index.ts` | `/goal` 解析翻转、回执、`edit` 预检 |
| `extensions/goal/index.test.ts` | 解析表 |
| `electron-agent/src/features/chat/input/commandClassification.ts` | `goal` 入白名单，改注释 |
| `electron-agent/src/features/chat/input/commandClassification.test.ts` | `isExecutiveCommand('goal')` |
| `electron-agent/src/stores/commandInputStore.ts` | 按 `sessionId` 的本地 `command-input` |
| `electron-agent/src/stores/commandInputStore.test.ts` | 隔离 / 切会话 |
| `electron-agent/src/features/chat/groupMessages.ts` | `DisplayMessage` 新变体 |
| `electron-agent/src/features/chat/ChatMessageItems.tsx` | 渲染命令行 |
| `electron-agent/src/features/chat/ChatListView.tsx` | 把本地行接到 `groupMessages` 之后 |
| `electron-agent/src/features/chat/ChatListView.test.tsx` | 列表出现 `/goal` 行 |
| `electron-agent/src/features/chat/ChatView.tsx` | 发送 `/goal` 时写入 store，toast 保留 |
| `electron-agent/src/features/chat/input/goalElapsed.ts` | `Ns` / `Nm` / `Nh` |
| `electron-agent/src/features/chat/input/goalElapsed.test.ts` | 含不足 1s → `1s` |
| `electron-agent/src/features/chat/input/GoalPill.tsx` | Codex 式顶行 |
| `electron-agent/src/features/chat/input/GoalPill.test.tsx` | 规格第 5 节条用例 |
| `electron-agent/src/features/chat/input/editor/MessageEditor.tsx` | `GoalPill` 挪进 `surface` |
| `electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx` | 顶行在 `surface` 内 |
| `electron-agent/src/features/chat/input/SessionGoalDrawer.tsx` | 改条件单次 `edit`；complete 可清 |
| `electron-agent/src/features/chat/input/SessionGoalDrawer.test.tsx` | blocked 保存走 `edit` |
| `electron-agent/electron/app/goalCoordinator.test.ts` | `edit` 不 `enqueueGoalTurn` |

不改：`tauri-agent/**`、`extensions/goal/tools.ts`、`electron-agent/electron/app/goalCoordinator.ts`。

---

### 任务 1：加宽 `CHAT_CONTENT_WIDTH`

**文件：**
- 修改：`electron-agent/src/features/chat/chatStyles.ts`
- 创建：`electron-agent/src/features/chat/chatStyles.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/src/features/chat/chatStyles.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { CHAT_CONTENT_WIDTH } from './chatStyles';

describe('CHAT_CONTENT_WIDTH', () => {
  it('matches the Codex-aligned content column expression', () => {
    expect(CHAT_CONTENT_WIDTH).toBe('min(100%, 1120px, max(760px, 86%))');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/chatStyles.test.ts
```

预期：FAIL，得到 `min(100%, 960px, max(620px, 61.8%))`。

- [ ] **步骤 3：改常量与注释**

把 `chatStyles.ts` 文件头注释和常量改成：

```ts
/**
 * 对话内容列宽度：会话区是可调面板，宽度 ≠ 视口宽度，所以按容器百分比伸缩而不用 vw；
 * 纯 CSS 表达即可跟随容器，不必再上 ResizeObserver。三段取值的意图：
 *   - 86%：主体比例，会话区变宽时正文同步变宽，两侧留白收窄到接近 Codex；
 *   - 下限 760px：容器 ≤883px 时 86% 会小于 760，改走固定下限（窄于旧 61.8%/620 行为：
 *     ≤760px 的容器由下一则 100% 接管，子代理面板等窄场景不再左右留白）；
 *   - 上限 1120px：再宽只增加留白，行长停在接近 Codex 的舒适区间；
 *   - min 里的 100%：容器比 760px 还窄时退回铺满，不倒过来挤压正文。
 * 消息列与输入区共用同一表达式，两者左右边缘才能对齐成同一条内容列。
 */
export const CHAT_CONTENT_WIDTH = 'min(100%, 1120px, max(760px, 86%))';
```

不要改 `paddingInline`，不要改 `ChatView` / `VirtualizedMessageList` / `ChatListSkeleton` 的引用方式（它们已经读这个常量）。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/chatStyles.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/chat/chatStyles.ts" "electron-agent/src/features/chat/chatStyles.test.ts"
git commit -m @"
feat(chat): 加宽会话正文列

"@
```

---

### 任务 2：CAS `edit`，废弃改条件旁路

**文件：**
- 修改：`electron-agent/electron/agentData/goalContracts.ts`
- 修改：`electron-agent/electron/agentData/goalStore.ts`
- 修改：`electron-agent/electron/agentData/goalStore.test.ts`
- 修改：`electron-agent/electron/agentData/runtime.ts`
- 修改：`electron-agent/electron/agentData/runtime.goal.test.ts`
- 修改：`electron-agent/electron/ipc/register.ts`
- 修改：`electron-agent/electron/ipc/commandCoverage.test.ts`
- 修改：`extensions/goal/contracts.ts`

- [ ] **步骤 1：编写失败的测试**

在 `goalStore.test.ts` 末尾 `describe('GoalStore')` 内追加：

```ts
  it('edits condition without changing status and requires human-ui', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'old', origin: 'human-ui' });
    expect(() => store.update({
      sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'edit',
      payload: { condition: 'new' }, origin: 'system',
    })).toThrow('HUMAN_AUTH_REQUIRED');
    expect(() => store.update({
      sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'edit',
      payload: { condition: 'new' }, origin: 'human-agent',
    })).toThrow('HUMAN_AUTH_REQUIRED');
    const edited = store.update({
      sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'edit',
      payload: { condition: '  new  ' }, origin: 'human-ui',
    });
    expect(edited).toMatchObject({ status: 'active', condition: 'new', revision: goal.revision + 1 });
    expect(store.history('s').at(-1)).toMatchObject({ kind: 'edit', payload: { condition: '  new  ' } });
  });

  it('allows edit on complete and clear from complete', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'ship', origin: 'human-ui' });
    const judging = store.update({
      sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'begin_judging', origin: 'system',
    });
    const complete = store.recordJudge({
      sessionId: 's', goalId: goal.goalId, revision: judging.revision, verdict: 'pass', reason: 'ok',
    });
    expect(complete.status).toBe('complete');
    expect(() => store.update({
      sessionId: 's', goalId: goal.goalId, revision: complete.revision, action: 'edit',
      payload: { condition: 'rewritten' }, origin: 'human-ui',
    })).not.toThrow();
    const edited = store.get('s')!;
    expect(edited).toMatchObject({ status: 'complete', condition: 'rewritten' });
    expect(store.update({
      sessionId: 's', goalId: goal.goalId, revision: edited.revision, action: 'clear', origin: 'human-ui',
    }).status).toBe('cleared');
  });

  it('rejects edit while judging or cleared, and rejects condition on other actions', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(() => store.update({
      sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'pause',
      payload: { condition: 'side' }, origin: 'human-ui',
    })).toThrow('INVALID_TRANSITION');
    const judging = store.update({
      sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'begin_judging', origin: 'system',
    });
    expect(() => store.update({
      sessionId: 's', goalId: goal.goalId, revision: judging.revision, action: 'edit',
      payload: { condition: 'nope' }, origin: 'human-ui',
    })).toThrow('INVALID_TRANSITION');
    const failed = store.recordJudge({
      sessionId: 's', goalId: goal.goalId, revision: judging.revision, verdict: 'fail', reason: 'missing',
    });
    expect(() => store.update({
      sessionId: 's', goalId: failed.goalId, revision: failed.revision, action: 'edit',
      payload: { condition: 'after-fail' }, origin: 'human-ui',
    })).not.toThrow();
    const cleared = store.update({
      sessionId: 's', goalId: failed.goalId, revision: store.get('s')!.revision, action: 'clear', origin: 'human-ui',
    });
    expect(() => store.update({
      sessionId: 's', goalId: cleared.goalId, revision: cleared.revision, action: 'edit',
      payload: { condition: 'after-clear' }, origin: 'human-ui',
    })).toThrow('INVALID_TRANSITION');
  });

  it('rejects block+condition and validates trimmed condition length', () => {
    const { store } = fixture();
    expect(() => store.create({
      sessionId: 'long', workspace: '/w', condition: 'x'.repeat(4001), origin: 'human-ui',
    })).toThrow('INVALID_GOAL');
    expect(() => store.create({
      sessionId: 'blank', workspace: '/w', condition: '   ', origin: 'human-ui',
    })).toThrow('INVALID_GOAL');
    const goal = store.create({
      sessionId: 's', workspace: '/w', condition: '  ok  ', origin: 'human-ui',
    });
    expect(goal.condition).toBe('ok');
    expect(() => store.update({
      sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'block',
      payload: { condition: 'rewritten', reason: 'wait' }, origin: 'human-ui',
    })).toThrow('INVALID_TRANSITION');
    expect(() => store.update({
      sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'edit',
      payload: { condition: 'y'.repeat(4001) }, origin: 'human-ui',
    })).toThrow('INVALID_GOAL');
    expect(() => store.update({
      sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'edit',
      payload: { condition: '   ' }, origin: 'human-ui',
    })).toThrow('INVALID_GOAL');
  });
```

进入 `complete` 必须走 `store.recordJudge`（`update({ action: 'judge_pass' })` 会被 `update` 直接拒）。`begin_judging` 用 `origin: 'system'`，与 `goalStore.test.ts` 现有用例一致。`pause` + `condition` 用例故意放在 **active 态**（`pause` 本身是合法 transition）：状态合法时抛 `INVALID_TRANSITION` 才能证明是 `hasCondition` 检查生效；若放在 `paused` 态，`pause` 本身就非法，断言对漏实现不敏感。

在 `runtime.goal.test.ts` 的第一个用例里，把 `:20` 的 FORBIDDEN 断言替换为放行断言，并补拒绝分支：

```ts
      await expect(project.request('goal.update', { sessionId: 's1', goalId: goal.goalId, revision: goal.revision, action: 'pause' })).resolves.toMatchObject({ status: 'paused' });
      await expect(project.request('goal.update', { sessionId: 's1', goalId: goal.goalId, revision: goal.revision + 1, action: 'edit', payload: { condition: 'ship it v2' } })).resolves.toMatchObject({ condition: 'ship it v2' });
      await expect(project.request('goal.update', { sessionId: 's1', goalId: goal.goalId, revision: goal.revision + 2, action: 'clear' })).resolves.toMatchObject({ status: 'cleared' });
      await expect(project.request('goal.update', { sessionId: 's1', goalId: goal.goalId, revision: goal.revision + 3, action: 'disarm' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(project.request('goal.update', { sessionId: 's1', goalId: goal.goalId, revision: goal.revision + 3, action: 'judge_pass' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
```

注意：后续 `admin.goal.update` / `admin.goal.history` 断言（`:21-22`）的 revision / 长度依赖会因放行用例而变化，按放行后的实际快照调整数字，不要删这两条断言。

在 `commandCoverage.test.ts` 的 Goal 用例里、现有 `action: 'pause'` 成功调用之后追加：

```ts
    await invoke({}, { command: 'agentData_goal_update', args: { sessionId: 's', goalId: 'g', revision: 1, action: 'edit', payload: { condition: 'n' } } });
    expect(agentData.goalUpdate).toHaveBeenCalledWith({
      sessionId: 's', goalId: 'g', revision: 1, action: 'edit', payload: { condition: 'n' }, origin: 'human-ui',
    });
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/agentData/goalStore.test.ts electron/ipc/commandCoverage.test.ts
```

预期：FAIL（`action: 'edit'` 类型/分支不存在，或 `clear` 拒 `complete`，或 `block+condition` 仍走旧旁路）。

- [ ] **步骤 3：最少实现**

1. `goalContracts.ts` 的 `GoalCasUpdate.action` 联合类型追加 `'edit'`。

2. `extensions/goal/contracts.ts`：
   - `GoalEvent.kind` 追加 `"edit"`
   - `GoalCasUpdate.action` 追加 `"edit"`
   - **不要**再把 `condition_update` 加进联合类型。

3. `goalStore.ts`：
   - 抽出：

```ts
function validateGoalCondition(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_GOAL');
  const condition = value.trim();
  if (!condition || condition.length > 4000) throw new Error('INVALID_GOAL');
  return condition;
}
```

   - `create`：用 `validateGoalCondition(input.condition)`，快照写入 **trim 后** 的字符串。
   - 删除 `updateBlockedCondition` 整个方法。
   - `update` 改成：

```ts
  update(input: GoalCasUpdate): GoalSnapshot {
    if (input.action === 'block') {
      if (input.payload && Object.prototype.hasOwnProperty.call(input.payload, 'condition')) {
        throw new Error('INVALID_TRANSITION');
      }
      return this.recordProgress({
        sessionId: input.sessionId,
        goalId: input.goalId,
        revision: input.revision,
        summary: typeof input.payload?.reason === 'string' ? input.payload.reason : undefined,
        fingerprint: typeof input.payload?.fingerprint === 'string' ? input.payload.fingerprint : undefined,
      });
    }
    return this.tx(() => {
      const hasMaxRounds = Boolean(input.payload && Object.prototype.hasOwnProperty.call(input.payload, 'maxRounds'));
      const hasCondition = Boolean(input.payload && Object.prototype.hasOwnProperty.call(input.payload, 'condition'));
      if (input.action === 'judge_pass' || input.action === 'judge_fail') throw new Error('INVALID_TRANSITION');
      if ((['pause', 'resume', 'clear', 'edit'].includes(input.action) || hasMaxRounds || hasCondition) && input.origin !== 'human-ui') {
        throw new Error('HUMAN_AUTH_REQUIRED');
      }
      const current = this.require(input.sessionId, input.goalId);
      assertRevision(current, input.goalId, input.revision);
      if (input.action === 'edit') {
        if (current.status === 'cleared' || current.status === 'judging') throw new Error('INVALID_TRANSITION');
        const condition = validateGoalCondition(input.payload?.condition);
        const next: GoalSnapshot = {
          ...current,
          condition,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        this.persist(next);
        this.event(next, input.action, input.payload ?? {});
        return next;
      }
      if (hasCondition) throw new Error('INVALID_TRANSITION');
      const next = transition(current, input.action, input.payload);
      if (hasMaxRounds) {
        const maxRounds = validateMaxRounds(Number(input.payload?.maxRounds));
        if (maxRounds < current.roundsUsed) throw new Error('MAX_ROUNDS_BELOW_USAGE');
        next.maxRounds = maxRounds;
      }
      this.persist(next);
      this.event(next, input.action, input.payload ?? {});
      return next;
    });
  }
```

   - `transition` 的 clear 一行改成：

```ts
  else if (action === 'clear' && ['active','paused','blocked','disarmed','error','complete'].includes(current.status)) status = 'cleared';
```

   - `transition` **不要**加 `edit` 分支（`edit` 在 `update` 里提前返回）。其它 action 再走 `hasCondition` 一律 `INVALID_TRANSITION`。

4. `runtime.ts` 的 `readGoalAction` 与 `ipc/register.ts` 的 `readGoalAction` 都加上 `value === 'edit'`。

5. `runtime.ts` project 通道 `goal.update`（`:699-718`）：

   - `:702` 的动作白名单改为：

```ts
      const HUMAN_ACTIONS = new Set(['pause', 'resume', 'clear', 'edit']);
      if (project && action !== 'begin_judging' && action !== 'block' && !HUMAN_ACTIONS.has(action)) {
        throw new RpcError('FORBIDDEN', 'project agents may only report progress, request completion, or act as the human');
      }
```

   - `:705` 的 origin 盖章按动作分派：

```ts
        origin: project ? (HUMAN_ACTIONS.has(action) ? 'human-ui' : 'human-agent') : readGoalOrigin(p.origin ?? 'system'),
```

   `create` 盖章（`:693`）不变（`human-agent`）。`disarm` / `judge_pass` / `judge_fail` 不在两个集合里 → FORBIDDEN。

现有用例「`begin_judging` + `condition` + `system` → `HUMAN_AUTH_REQUIRED`」必须继续成立（`hasCondition` 仍进 human 检查）。不要改那条断言。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/agentData/goalStore.test.ts electron/ipc/commandCoverage.test.ts electron/agentData/runtime.goal.test.ts
```

预期：PASS（含全部旧 CAS 用例；`runtime.goal.test.ts` 的 `:21-22` admin 通道断言按新 revision 调整后仍过）。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/electron/agentData/goalContracts.ts" "electron-agent/electron/agentData/goalStore.ts" "electron-agent/electron/agentData/goalStore.test.ts" "electron-agent/electron/agentData/runtime.ts" "electron-agent/electron/agentData/runtime.goal.test.ts" "electron-agent/electron/ipc/register.ts" "electron-agent/electron/ipc/commandCoverage.test.ts" "extensions/goal/contracts.ts"
git commit -m @"
feat(goal): 增加 CAS edit 并放行扩展通道 human 动作

"@
```

---

### 任务 3：`/goal` 解析翻转

**文件：**
- 修改：`extensions/goal/index.ts`
- 修改：`extensions/goal/index.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `extensions/goal/index.test.ts` 追加（沿用现有 `setup` / `lastStatus`）：

```ts
  it("bare /goal reports the current snapshot and does not clear", async () => {
    const snapshot = {
      goalId: 'g', sessionId: 'session-a', workspace: 'C:/work', revision: 2,
      condition: '写完测试', status: 'active', roundsUsed: 3, maxRounds: 256,
    };
    const client = { request: async () => snapshot };
    const { handler, ctx, calls } = setup(client);
    await handler("", ctx);
    expect(String(calls.notify.at(-1)?.[0]).split("\n")).toEqual(["执行中的目标", "写完测试", "3/256"]);
    expect(calls.notify.at(-1)?.[1]).toBe("info");
    expect(JSON.parse(lastStatus(calls)[1] as string)).toMatchObject({ status: 'active', condition: '写完测试' });
  });

  it("bare /goal with no snapshot notifies and does not update", async () => {
    const { handler, ctx, calls } = setup();
    await handler("   ", ctx);
    expect(calls.notify.at(-1)).toEqual(["当前没有生效的目标。", "warning"]);
    expect(calls.notify.some((item) => item[0] === "已清除目标。")).toBe(false);
  });

  it("edit without a condition or without a snapshot errors", async () => {
    const { handler, ctx, calls } = setup();
    await handler("edit", ctx);
    expect(calls.notify.at(-1)?.[1]).toBe("error");
    expect(String(calls.notify.at(-1)?.[0])).toMatch(/条件/);
    await handler("edit 新条件", ctx);
    expect(calls.notify.at(-1)).toEqual(["当前没有生效的目标。", "warning"]);
  });

  it("edit updates the current condition", async () => {
    let snapshot: any = {
      goalId: 'g', sessionId: 'session-a', workspace: 'C:/work', revision: 1,
      condition: '旧', status: 'paused', roundsUsed: 1, maxRounds: 10,
    };
    const methods: string[] = [];
    const client = { request: async (method: string, params?: Record<string, unknown>) => {
      methods.push(method);
      if (method === 'goal.get') return snapshot;
      snapshot = { ...snapshot, revision: snapshot.revision + 1, condition: params?.payload && (params.payload as { condition?: string }).condition };
      return snapshot;
    } };
    const { handler, ctx, calls } = setup(client);
    await handler("edit 新条件", ctx);
    expect(methods).toEqual(['goal.get', 'goal.update']);
    expect(JSON.parse(lastStatus(calls)[1] as string)).toMatchObject({ condition: '新条件', status: 'paused' });
    expect(calls.notify.at(-1)?.[1]).toBe("info");
  });

  it("treats pause after verify as create, not pause", async () => {
    const methods: string[] = [];
    const client = { request: async (method: string, params?: Record<string, unknown>) => {
      methods.push(method);
      if (method === 'goal.get') return undefined;
      return {
        goalId: 'g', sessionId: params?.sessionId, workspace: params?.workspace,
        revision: 1, condition: params?.condition, status: 'active', roundsUsed: 0, maxRounds: 256,
      };
    } };
    const { handler, ctx } = setup(client);
    await handler("pause after verify", ctx);
    expect(methods).toEqual(['goal.get', 'goal.create']);
  });

  it("rejects a 4001-character edit condition before RPC", async () => {
    const snapshot = {
      goalId: 'g', sessionId: 'session-a', workspace: 'C:/work', revision: 1,
      condition: '旧', status: 'active', roundsUsed: 0, maxRounds: 256,
    };
    const methods: string[] = [];
    const client = { request: async (method: string) => { methods.push(method); return snapshot; } };
    const { handler, ctx, calls } = setup(client);
    await handler(`edit ${'z'.repeat(4001)}`, ctx);
    expect(methods).toEqual(['goal.get']);
    expect(String(calls.notify.at(-1)?.[0])).toContain("INVALID_PARAMS");
  });
```

现有 `clear removes the goal` 必须继续过。把工厂里命令 description 的断言也补上（若还没有）：

```ts
  it("describes query, edit, and exclusive control words", () => {
    const descriptions: string[] = [];
    factory({
      registerCommand: (_n: string, def: { description?: string; handler: Handler }) => {
        if (_n === "goal") descriptions.push(String(def.description ?? ""));
      },
      on: () => undefined,
      appendEntry: () => undefined,
    } as never, { request: async () => undefined } as never);
    expect(descriptions[0]).toMatch(/\/goal edit/);
    expect(descriptions[0]).not.toMatch(/\/goal <条件> \| \/goal pause \| \/goal resume \| \/goal clear$/);
  });
```

若 `registerCommand` 现有 `setup` 不好拿 description，就把 description 断言写进第一个已有注册用例，不要另起一套 factory 调用约定。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/index.test.ts
```

预期：FAIL（空参数仍走 clear）。

- [ ] **步骤 3：改 `extensions/goal/index.ts`**

命令 description 改为：

```ts
description: "查询或设定会话目标：/goal | /goal <条件> | /goal edit <条件> | /goal pause | /goal resume | /goal clear",
```

`notifyError` 的第二参从 `"warning"` 改为 `"error"`（规格：失败 `error`）。「当前没有生效的目标。」仍用 `"warning"`，与现有 pause 用例一致。

handler 解析顺序写死：

```ts
      const text = args.trim();
      try {
        const current = await read(ctx);
        if (text === "") {
          if (!current) { ctx.ui.notify("当前没有生效的目标。", "warning"); return; }
          ctx.ui.notify(formatGoalReceipt(current), "info");
          return;
        }
        if (text === "clear" || text === "reset") {
          if (!current) { ctx.ui.notify("当前没有生效的目标。", "warning"); return; }
          const requestScope = scope(ctx);
          cached = checkedSnapshot(await client.request<GoalSnapshot>("goal.update", {
            ...requestScope, goalId: current.goalId, revision: current.revision, action: "clear",
          }), requestScope, current);
          pushStatus(ctx);
          ctx.ui.notify("已清除目标。", "info");
          return;
        }
        if (text === "pause" || text === "resume") {
          // 保持现有 pause/resume 分支
        }
        if (text === "edit" || text.startsWith("edit ") || text.startsWith("edit\t")) {
          const condition = text.slice("edit".length).trim();
          if (!condition) { ctx.ui.notify("缺少新条件。", "error"); return; }
          if (!current) { ctx.ui.notify("当前没有生效的目标。", "warning"); return; }
          if (condition.length > 4000) throw new Error("INVALID_PARAMS");
          const requestScope = scope(ctx);
          cached = checkedSnapshot(await client.request<GoalSnapshot>("goal.update", {
            ...requestScope, goalId: current.goalId, revision: current.revision,
            action: "edit", payload: { condition },
          }), requestScope, current);
          pushStatus(ctx);
          ctx.ui.notify(formatGoalReceipt(cached), "info");
          return;
        }
        if (text.length > 4000) throw new Error("INVALID_PARAMS");
        // 现有 create 分支
```

回执函数（同文件即可，不要新开包）：

```ts
const GOAL_STATUS_SENTENCE: Record<GoalSnapshot["status"], string> = {
  active: "执行中的目标",
  disarmed: "未运行的目标",
  paused: "已暂停的目标",
  judging: "正在验收的目标",
  blocked: "受阻的目标",
  error: "已停止的目标",
  complete: "已完成的目标",
  cleared: "已清除的目标",
};

function formatGoalReceipt(snapshot: GoalSnapshot): string {
  const lines = [
    GOAL_STATUS_SENTENCE[snapshot.status],
    snapshot.condition,
    `${snapshot.roundsUsed}/${snapshot.maxRounds}`,
  ];
  if (snapshot.status === "blocked" && snapshot.blockage?.summary) {
    lines.push(snapshot.blockage.summary);
  }
  return lines.join("\n");
}
```

控制词必须整段相等（trim 后）。`pause after verify` 不得进 pause 分支。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/index.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "extensions/goal/index.ts" "extensions/goal/index.test.ts"
git commit -m @"
feat(goal): 裸 /goal 改为查询并支持 edit

"@
```

---

### 任务 4：执行性 `/goal` 与 `command-input` 行

**文件：**
- 修改：`electron-agent/src/features/chat/input/commandClassification.ts`
- 修改：`electron-agent/src/features/chat/input/commandClassification.test.ts`
- 创建：`electron-agent/src/stores/commandInputStore.ts`
- 创建：`electron-agent/src/stores/commandInputStore.test.ts`
- 修改：`electron-agent/src/features/chat/groupMessages.ts`
- 修改：`electron-agent/src/features/chat/ChatMessageItems.tsx`
- 修改：`electron-agent/src/features/chat/ChatListView.tsx`
- 修改：`electron-agent/src/features/chat/ChatListView.test.tsx`
- 修改：`electron-agent/src/features/chat/ChatView.tsx`

- [ ] **步骤 1：编写失败的测试**

`commandClassification.test.ts` 的「命中已知动作命令」里加：

```ts
    expect(isExecutiveCommand('goal')).toBe(true);
    expect(isExecutiveCommand('GOAL')).toBe(true);
```

`isExecutiveCommandMessage` 里加：

```ts
    expect(isExecutiveCommandMessage('/goal')).toBe(true);
    expect(isExecutiveCommandMessage('/goal 你好')).toBe(true);
    expect(isExecutiveCommandMessage('/skill:goal')).toBe(false);
```

创建 `commandInputStore.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useCommandInputStore } from './commandInputStore';

describe('commandInputStore', () => {
  beforeEach(() => {
    useCommandInputStore.setState({ bySession: {}, sessionByPath: {} });
  });

  it('indexes rows by sessionId and hides them after a path switch', () => {
    useCommandInputStore.getState().record({
      sessionId: 'session-a',
      sessionPath: '/sessions/a.jsonl',
      command: '/goal',
      rest: '你好',
    });
    expect(useCommandInputStore.getState().listForPath('/sessions/a.jsonl')).toEqual([
      expect.objectContaining({ kind: 'command-input', command: '/goal', rest: '你好' }),
    ]);
    expect(useCommandInputStore.getState().listForPath('/sessions/b.jsonl')).toEqual([]);
    expect(useCommandInputStore.getState().bySession['session-a']?.[0].kind).toBe('command-input');
  });
});
```

`ChatListView.test.tsx` 追加（文件已有 60s timeout；在 `afterEach` 里清 store）：

```ts
  it('appends a local command-input row after grouped messages', () => {
    useSessionStore.setState({ activeSessionPath: '/sessions/a.jsonl' });
    useCommandInputStore.getState().record({
      sessionId: 'session-a',
      sessionPath: '/sessions/a.jsonl',
      command: '/goal',
      rest: '你好',
    });
    setMessages(makeFixture());
    render(
      <ThemeProvider themeMode="dark">
        <ChatListView />
      </ThemeProvider>,
    );
    const row = document.querySelector('[data-testid="command-input"]');
    expect(row?.textContent).toContain('/goal');
    expect(row?.textContent).toContain('你好');
    expect(mockState.messages.some((m) => (m as { kind: string }).kind === 'command-input')).toBe(false);
  });
```

在该测试文件顶部增加真实 store 的 import（不要 mock `commandInputStore`）。`useSessionStore` 已是真实 zustand，测完在 `afterEach` 把 `activeSessionPath` 还原、`useCommandInputStore.setState({ bySession: {}, sessionByPath: {} })`。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/commandClassification.test.ts src/stores/commandInputStore.test.ts src/features/chat/ChatListView.test.tsx
```

预期：FAIL（`goal` 仍不在白名单，store / 行不存在）。

- [ ] **步骤 3：实现**

`commandClassification.ts`：

```ts
/**
 * 「执行性命令」白名单（保守）：发出后不产生对话轮次的纯动作命令。键统一小写。
 * 仅放确定项；不确定者（init/review/deep-research 等）不放 → 默认保留气泡。
 * `goal` 是桌面控制面：不进模型轮次，对话里只留本地 command-input 行。
 */
export const EXECUTIVE_COMMANDS = new Set<string>([
  'compact', 'newsession', 'new',
  'share', 'unshare', 'export', 'undo', 'redo',
  'model', 'models', 'theme', 'themes',
  'agent', 'agents', 'editor', 'mcp',
  'session', 'sessions', 'help', 'exit', 'quit',
  'goal',
]);
```

`skill:` 前缀规则不要动。

`groupMessages.ts` 的 `DisplayMessage` 追加：

```ts
  | { kind: 'command-input'; id: string; command: string; rest: string }
```

`groupMessages()` **不要**从 `ChatMessage` 产出这种行。

`commandInputStore.ts`：

```ts
import { create } from 'zustand';
import type { DisplayMessage } from '../features/chat/groupMessages';

export type CommandInputMessage = Extract<DisplayMessage, { kind: 'command-input' }>;

const EMPTY: CommandInputMessage[] = [];

interface CommandInputState {
  bySession: Record<string, CommandInputMessage[]>;
  sessionByPath: Record<string, string>;
  record: (input: { sessionId: string; sessionPath: string; command: string; rest: string }) => void;
  listForPath: (sessionPath: string | null) => CommandInputMessage[];
}

export const useCommandInputStore = create<CommandInputState>((set, get) => ({
  bySession: {},
  sessionByPath: {},
  record: ({ sessionId, sessionPath, command, rest }) => {
    if (!sessionId.trim() || !sessionPath.trim()) return;
    const row: CommandInputMessage = {
      kind: 'command-input',
      id: crypto.randomUUID(),
      command,
      rest,
    };
    set((state) => ({
      sessionByPath: { ...state.sessionByPath, [sessionPath]: sessionId },
      bySession: {
        ...state.bySession,
        [sessionId]: [...(state.bySession[sessionId] ?? []), row],
      },
    }));
  },
  listForPath: (sessionPath) => {
    if (!sessionPath) return EMPTY;
    const sessionId = get().sessionByPath[sessionPath];
    return sessionId ? get().bySession[sessionId] ?? EMPTY : EMPTY;
  },
}));
```

主键是 `sessionId`（规格）。`sessionByPath` 只是 ChatListView 已有 `activeSessionPath` 时的查找辅键，不持久化。进程重载 store 清空。`EMPTY` 常量必须有：`listForPath` 被 zustand selector 调用，无记录时若每次返回新建 `[]`，`useSyncExternalStore` 的 getSnapshot 引用不稳定，会触发 "getSnapshot should be cached" 警告乃至无限重渲染。

`ChatMessageItems.tsx` 的 `renderMessageBody` 增加：

```ts
    case 'command-input':
      return (
        <div data-testid="command-input">
          <span>{msg.command}</span>
          {msg.rest ? <span>{msg.rest}</span> : null}
        </div>
      );
```

不要复用 `UserMessage`。`ChatMiniMap` 只给 `kind === 'user'` 做刻度，不必改。

`ChatListView.tsx`：

```ts
  const extras = useCommandInputStore((s) => s.listForPath(sessionPath));
  const display = useMemo(
    () => (extras.length ? [...groupMessages(throttledMessages), ...extras] : groupMessages(throttledMessages)),
    [throttledMessages, extras],
  );
```

`ChatView.tsx` 的执行性命令分支（约 136-144 行）改成：**先**记下 `/goal` 行，**再** `pi.prompt`，**仍** `messageApi.info(\`已执行 ${cmd}\`)`：

```ts
    if (text && isExecutiveCommandMessage(text)) {
      const parsed = parseCommandToken(text);
      const cmd = text.split(/\s/, 1)[0];
      if (parsed && parsed.name.toLowerCase() === 'goal' && activeSessionPath) {
        try {
          const state = await pi.getState(workspace);
          const sessionId = readSessionId(state);
          if (sessionId) {
            useCommandInputStore.getState().record({
              sessionId,
              sessionPath: activeSessionPath,
              command: '/goal',
              rest: parsed.rest,
            });
          }
        } catch {
          // 本地行失败不阻断命令执行。
        }
      }
      try {
        await pi.prompt(workspace, text, undefined, images);
        messageApi.info(`已执行 ${cmd}`);
      } catch (e) {
        messageApi.error(`${cmd} 执行失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
```

`readSessionId` 与 `GoalPill` 里现有 4 行相同即可，复制到 `ChatView` 文件内，不要此时抽公共模块。`ChatView` 已有 `activeSessionPath`（`useSessionStore`）。从 `./input/editor/commandPaste` 引入 `parseCommandToken`。

其它执行性命令不要写 `command-input`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/commandClassification.test.ts src/stores/commandInputStore.test.ts src/features/chat/ChatListView.test.tsx src/features/chat/groupMessages.test.ts src/features/ChatMiniMap/index.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/chat/input/commandClassification.ts" "electron-agent/src/features/chat/input/commandClassification.test.ts" "electron-agent/src/stores/commandInputStore.ts" "electron-agent/src/stores/commandInputStore.test.ts" "electron-agent/src/features/chat/groupMessages.ts" "electron-agent/src/features/chat/ChatMessageItems.tsx" "electron-agent/src/features/chat/ChatListView.tsx" "electron-agent/src/features/chat/ChatListView.test.tsx" "electron-agent/src/features/chat/ChatView.tsx"
git commit -m @"
feat(chat): /goal 作为执行性命令并插入本地命令行

"@
```

---

### 任务 5：输入框顶行 Goal 条

**文件：**
- 创建：`electron-agent/src/features/chat/input/goalElapsed.ts`
- 创建：`electron-agent/src/features/chat/input/goalElapsed.test.ts`
- 修改：`electron-agent/src/features/chat/input/GoalPill.tsx`
- 修改：`electron-agent/src/features/chat/input/GoalPill.test.tsx`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.tsx`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`goalElapsed.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { formatGoalElapsed } from './goalElapsed';

describe('formatGoalElapsed', () => {
  const origin = '2026-09-13T00:00:00.000Z';
  const at = (ms: number) => Date.parse(origin) + ms;

  it('floors to 1s below one second', () => {
    expect(formatGoalElapsed(origin, at(0))).toBe('1s');
    expect(formatGoalElapsed(origin, at(999))).toBe('1s');
  });

  it('uses seconds, minutes, then hours', () => {
    expect(formatGoalElapsed(origin, at(1000))).toBe('1s');
    expect(formatGoalElapsed(origin, at(59_000))).toBe('59s');
    expect(formatGoalElapsed(origin, at(60_000))).toBe('1m');
    expect(formatGoalElapsed(origin, at(3_599_000))).toBe('59m');
    expect(formatGoalElapsed(origin, at(3_600_000))).toBe('1h');
  });
});
```

重写 `GoalPill.test.tsx` 的文案与按钮断言（保留现有 mock / `makeSnapshot` / `beforeEach`）。**删掉**「通过抽屉两步改条件」那条（改条件改在本文件的行内编辑，以及任务 6 的抽屉）。新用例：

```ts
  it('renders the active bar with a glowing lamp and control buttons', async () => {
    render(<GoalPill />);
    expect(await screen.findByText('执行中的目标')).toBeTruthy();
    expect(screen.getByText('写完测试')).toBeTruthy();
    expect(screen.getByTestId('goal-lamp').getAttribute('data-status')).toBe('active');
    expect(screen.getByTestId('goal-lamp').getAttribute('data-glow')).toBe('true');
    expect(screen.queryByText('3/256')).toBeNull();
    expect(screen.getByRole('button', { name: '暂停目标' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑目标' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '清除目标' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '展开目标详情' })).toBeTruthy();
  });

  it('renders a disarmed goal as not running', async () => {
    goalGet.mockResolvedValue(makeSnapshot({ status: 'disarmed' }));
    render(<GoalPill />);
    expect(await screen.findByText('未运行的目标')).toBeTruthy();
    expect(screen.getByTestId('goal-lamp').getAttribute('data-status')).toBe('disarmed');
    expect(screen.getByTestId('goal-lamp').getAttribute('data-glow')).toBe('false');
    expect(screen.getByRole('button', { name: '恢复目标' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '暂停目标' })).toBeNull();
  });

  it('keeps a complete goal visible with clear and expand only', async () => {
    goalGet.mockResolvedValue(makeSnapshot({ status: 'complete' }));
    render(<GoalPill />);
    expect(await screen.findByText('已完成的目标')).toBeTruthy();
    expect(screen.getByTestId('goal-lamp').getAttribute('data-glow')).toBe('false');
    expect(screen.queryByRole('button', { name: '暂停目标' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑目标' })).toBeNull();
    expect(screen.getByRole('button', { name: '清除目标' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '展开目标详情' })).toBeTruthy();
  });

  it('hides the bar without a snapshot or after a successful clear', async () => {
    goalGet.mockResolvedValue(undefined);
    const { unmount } = render(<GoalPill />);
    await waitFor(() => expect(goalGet).toHaveBeenCalled());
    expect(screen.queryByTestId('goal-pill')).toBeNull();
    unmount();

    goalGet.mockResolvedValue(makeSnapshot({ status: 'cleared' }));
    render(<GoalPill />);
    await waitFor(() => expect(goalGet).toHaveBeenCalled());
    expect(screen.queryByTestId('goal-pill')).toBeNull();
  });

  it('edits inline through a single edit CAS call', async () => {
    goalUpdate.mockResolvedValue(makeSnapshot({ condition: '新目标', revision: 3 }));
    render(<GoalPill />);
    await screen.findByText('写完测试');
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }));
    const input = screen.getByRole('textbox', { name: '目标条件' });
    expect((input as HTMLInputElement).value).toBe('写完测试');
    fireEvent.change(input, { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: '保存目标' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '新目标' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(goalUpdate).toHaveBeenCalledWith({
      sessionId: 'session-a', goalId: 'goal-a', revision: 2, action: 'edit', payload: { condition: '新目标' },
    }));
  });

  it('cancels edit on Escape and keeps the draft after a failed save', async () => {
    render(<GoalPill />);
    await screen.findByText('写完测试');
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: '目标条件' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: '目标条件' })).toBeNull();
    expect(goalUpdate).not.toHaveBeenCalled();

    goalUpdate.mockRejectedValueOnce(Object.assign(new Error('VERSION_CONFLICT'), { code: 'VERSION_CONFLICT' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }));
    fireEvent.change(screen.getByRole('textbox', { name: '目标条件' }), { target: { value: '失败稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存目标' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('VERSION_CONFLICT');
    expect((screen.getByRole('textbox', { name: '目标条件' }) as HTMLInputElement).value).toBe('失败稿');
  });

  it('single-flights clear and hides immediately on success', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let release!: (value: GoalSnapshot) => void;
    goalUpdate.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    render(<GoalPill />);
    await screen.findByText('写完测试');
    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));
    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));
    expect(goalUpdate).toHaveBeenCalledTimes(1);
    release(makeSnapshot({ status: 'cleared', revision: 3 }));
    await waitFor(() => expect(screen.queryByTestId('goal-pill')).toBeNull());
    confirm.mockRestore();
  });

  it('opens details from expand and uses blockage summary as the blocked title', async () => {
    const onOpenDetails = vi.fn();
    goalGet.mockResolvedValue(makeSnapshot({
      status: 'blocked',
      blockage: { fingerprint: 'wait', count: 3, summary: '等待外部依赖', at: '2026-09-01T00:00:00.000Z' },
    }));
    render(<GoalPill onOpenDetails={onOpenDetails} />);
    expect(await screen.findByText('受阻的目标')).toBeTruthy();
    expect(screen.getByTestId('goal-pill').getAttribute('title')).toBe('等待外部依赖');
    fireEvent.click(screen.getByRole('button', { name: '展开目标详情' }));
    expect(onOpenDetails).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }));
  });
```

`MessageEditor.test.tsx`：给 `surface` 断言留钩。把 GoalPill mock 改成带 `data-testid="goal-pill"` 的按钮（保留点击打开抽屉）。追加：

```ts
  it('places the goal pill inside the editor surface', () => {
    render(<MessageEditor leftActions={[]} rightActions={[]} />);
    const surface = screen.getByTestId('message-editor-surface');
    expect(surface.querySelector('[data-testid="goal-pill"]')).not.toBeNull();
  });
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/goalElapsed.test.ts src/features/chat/input/GoalPill.test.tsx src/features/chat/input/editor/MessageEditor.test.tsx
```

预期：FAIL。

- [ ] **步骤 3：实现**

`goalElapsed.ts`：

```ts
export function formatGoalElapsed(updatedAt: string, nowMs: number = Date.now()): string {
  const then = Date.parse(updatedAt);
  const delta = Number.isFinite(then) ? Math.max(0, nowMs - then) : 0;
  const seconds = Math.max(1, Math.floor(delta / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
```

`MessageEditor.tsx`：

- `styles.surface` 的根加上 `data-testid="message-editor-surface"`。
- 把 `<GoalPill ... />` 从 `zone` 里、`surface` **外**，挪到 `surface` 的第一个子节点（chips / Editor / ActionBar 之前）。`SessionGoalDrawer` 仍留在 `zone`（抽屉不是顶行）。

`GoalPill.tsx` 按规格重写，要点：

- 不再用 `Target` 图标当状态；左侧 8px 圆灯。`data-testid="goal-lamp"`，`data-status={status}`，`data-glow={active|judging ? 'true' : 'false'}`。
- 灯色 / 光晕按规格写死。光晕：`box-shadow: 0 0 0 3px`，active 用 18% 绿，judging 用 20% 蓝。
- 状态句 13px / 500；条件 13px 次要色单行省略；`·` + `formatGoalElapsed(updatedAt)`。
- **不要**渲染 `roundsUsed/maxRounds`。
- 非 blocked：条件 span 的 `title={condition}`；整行不要设 title。blocked：整行 `title={blockage.summary}`，条件 span 不要设 title。
- 无快照 / 无 `sessionId` / `status === 'cleared'` / 本地 `clearedGoalId === snapshot.goalId`：`return null`。
- 按钮集：

| 状态 | 暂停/恢复 | 编辑 | 清除 | 放大 |
| --- | --- | --- | --- | --- |
| active | 暂停 | 有 | 有 | 有 |
| disarmed / paused / blocked / error | 恢复 | 有 | 有 | 有 |
| judging | 无 | 无 | 无 | 有 |
| complete | 无 | 无 | 有 | 有 |

- 图标：`Pause` / `Play` / `PencilLine` / `Trash2` / `Maximize2`。放大 `aria-label="展开目标详情"`，调用 `onOpenDetails`（有 prop）或本地抽屉。
- 连点：`flightRef` 单飞，busy 时按钮 `disabled`。不要只靠 `useState` 挡第二次同步点击。
- 清除：`window.confirm('清除当前目标？')` 后 `action:'clear'`；成功把 `clearedGoalId` 设为该 `goalId`，立刻不渲染。
- 编辑：整行换成 textbox（`aria-label="目标条件"`，预填）+ 保存 / 取消。Enter 保存（`action:'edit'`，`payload: { condition: draft.trim() }`），Esc / 取消丢草稿。`draft.trim()` 为空时保存 `disabled`。失败：`role="alert"` 显示 `message (code)`（有 `code` 才加括号），留在编辑态。`snapshot.goalId` 变化时退出编辑并清空 alert。
- 样式：去掉独立 pill 边框 / 底色 / `margin-bottom`。根：`display:flex; align-items:center; gap:8px;` 底部分隔 `1px solid ${cssVar.colorBorderSecondary}`。与编辑器共用 `surface` 底色。
- `update` 的 action 类型改为 `'pause' | 'resume' | 'clear' | 'edit'`。

失败不藏条（除 clear 成功的本地藏）。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/goalElapsed.test.ts src/features/chat/input/GoalPill.test.tsx src/features/chat/input/editor/MessageEditor.test.tsx
```

预期：PASS。旧 GoalPill 文案「执行中」「业务阻塞 · 3 次」「修改目标」不应再出现在断言里。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/chat/input/goalElapsed.ts" "electron-agent/src/features/chat/input/goalElapsed.test.ts" "electron-agent/src/features/chat/input/GoalPill.tsx" "electron-agent/src/features/chat/input/GoalPill.test.tsx" "electron-agent/src/features/chat/input/editor/MessageEditor.tsx" "electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx"
git commit -m @"
feat(goal): 把 Goal 嵌进输入框顶行

"@
```

---

### 任务 6：抽屉改条件走单次 `edit`

**文件：**
- 修改：`electron-agent/src/features/chat/input/SessionGoalDrawer.tsx`
- 修改：`electron-agent/src/features/chat/input/SessionGoalDrawer.test.tsx`

- [ ] **步骤 1：编写失败的测试**

把 `saves a controlled condition editor...` 整段换成：

```ts
  it('saves a blocked condition with a single edit CAS call', async () => {
    history.mockResolvedValue([]);
    update.mockResolvedValue({ ...snapshot, revision: 5, condition: '新条件' });
    const onSnapshot = vi.fn();
    render(<SessionGoalDrawer open onClose={vi.fn()} onSnapshot={onSnapshot} sessionId="session-a" snapshot={snapshot} />);

    const input = screen.getByRole('textbox', { name: '目标条件' });
    fireEvent.change(input, { target: { value: '新条件' } });
    fireEvent.click(screen.getByRole('button', { name: '保存目标' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith({
      sessionId: 'session-a', goalId: 'goal-a', revision: 4, action: 'edit', payload: { condition: '新条件' },
    });
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ condition: '新条件', revision: 5 }));
  });

  it('clears a complete goal', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    history.mockResolvedValue([]);
    const complete = { ...snapshot, status: 'complete' as const, blockage: undefined, stopReason: undefined };
    update.mockResolvedValue({ ...complete, status: 'cleared', revision: 5 });
    render(<SessionGoalDrawer open onClose={vi.fn()} sessionId="session-a" snapshot={complete} />);
    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      sessionId: 'session-a', goalId: 'goal-a', revision: 4, action: 'clear',
    }));
    confirm.mockRestore();
  });
```

默认 fixture `snapshot` 已是 `blocked`，正好覆盖「blocked 不再走 `block`+condition」。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/SessionGoalDrawer.test.tsx
```

预期：FAIL（仍调用两次 pause/resume，或 complete 没有清除钮）。

- [ ] **步骤 3：改 `SessionGoalDrawer.tsx`**

- 删除 `saveCondition` 里 `status === 'blocked'` 的 `block` 分支，以及其后 pause/resume/disarm 两步 hack（约 205-251 行）。整段收敛为：

```ts
      const next = await agentDataApi.goals.update({
        sessionId,
        goalId: current.goalId,
        revision: current.revision,
        action: 'edit',
        payload: { condition },
      });
      setLocalSnapshot(next);
      onSnapshot?.(next);
      setConditionDraft(next.condition);
```

- `clearable` 数组加上 `'complete'`。
- `editableStatuses` 保持不含 `judging` / `cleared`。`complete` **不要**加入抽屉编辑（条上完成态也没有编辑）；CAS 仍允许 complete `edit`，只是抽屉不暴露。
- 确认文案仍是 `window.confirm('清除当前目标？')`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/SessionGoalDrawer.test.tsx src/features/chat/input/GoalPill.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/chat/input/SessionGoalDrawer.tsx" "electron-agent/src/features/chat/input/SessionGoalDrawer.test.tsx"
git commit -m @"
feat(goal): 抽屉改条件改为单次 edit

"@
```

---

### 任务 7：coordinator 与 block 条件回归

**文件：**
- 修改：`electron-agent/electron/app/goalCoordinator.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `goalCoordinator.test.ts` 追加：

```ts
  it('does not dispatch the next round when an active goal is edited', async () => {
    const h = harness();
    const c = new GoalCoordinator({ data: h.data, worker: h.worker });
    c.onGoalChanged(h.current, { kind: 'edit', payload: { condition: 'rewritten' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.worker.enqueueGoalTurn).not.toHaveBeenCalled();
    await c.stop();
  });
```

`harness()` 默认 `status: 'active'`。不要改 `goalCoordinator.ts`。若这条一开始就 PASS，保留它当回归，不要为了「先红」去改 coordinator。

- [ ] **步骤 2：运行测试**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/goalCoordinator.test.ts electron/agentData/goalStore.test.ts src/features/chat/input/SessionGoalDrawer.test.tsx src/features/chat/input/GoalPill.test.tsx
```

预期：PASS。`goalStore` 的 `block+condition` 用例仍抛 `INVALID_TRANSITION`。抽屉测试里没有 `action: 'block'`。全仓库再搜一次 `updateBlockedCondition` 与 `condition_update`，源码应只剩本计划与规格文档。

- [ ] **步骤 3：Commit**

```powershell
git add "electron-agent/electron/app/goalCoordinator.test.ts"
git commit -m @"
test(goal): 回归 edit 不触发 coordinator 续跑

"@
```

---

## 规格覆盖自检

| 规格条目 | 任务 |
| --- | --- |
| `CHAT_CONTENT_WIDTH` 新表达式 + 注释 + 窄容器取舍 | 1 |
| `edit` CAS、human 权限、complete 可 edit、judging/cleared 拒绝 | 2 |
| `clear` 含 `complete` | 2、5、6 |
| 废弃 `updateBlockedCondition` / `condition_update`；`block` 拒 condition | 2、7 |
| 条件 trim 后 1..4000，`INVALID_GOAL`；扩展预检 `INVALID_PARAMS` | 2、3 |
| 两端 contracts + IPC/runtime `readGoalAction` | 2 |
| runtime project 通道放行 human 动作、origin 分派盖章、`disarm`/`judge_*` 仍拒 | 2 |
| 裸 `/goal` 查询；`clear`/`reset` 仍清除；独占控制词；`pause after verify` 创建 | 3 |
| 回执状态句 + 条件 + 轮次，不含 id/revision；`notify` info/error | 3 |
| ChatView「已执行 /goal」toast 保留 | 4（只加行，不删 toast） |
| `goal` ∈ `EXECUTIVE_COMMANDS`，改白名单注释，`skill:` 不变 | 4 |
| `command-input` 形态、按 sessionId、不写 JSONL、切会话消失 | 4 |
| Goal 进 `surface` 顶行、1px 分隔 | 5 |
| 灯 / 状态句 / 条件 / 经过时间 / 按钮矩阵 / 完成态留下 | 5 |
| 行内编辑、单飞、`clearedGoalId`、confirm 文案、blocked title | 5 |
| 条上不显示轮次 | 5 |
| 抽屉单次 `edit`，删两步 hack | 6 |
| coordinator 不因 `edit` dispatch | 7（只测不改） |
| 不改 tauri / `tools.ts` / 裁判 / lease / 快捷键 | 动工前必读 |

占位符扫描：无 TODO / 待定 /「类似任务 N」。

类型名对齐：`GoalCasUpdate.action` 含 `'edit'`；事件 kind 为 `'edit'`；`DisplayMessage` 变体名为 `command-input`；store 方法名 `record` / `listForPath`。
