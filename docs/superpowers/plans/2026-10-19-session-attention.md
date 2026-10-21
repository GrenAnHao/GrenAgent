# 会话注意状态（角标、提示、系统通知、任务栏）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 侧栏会话行显示「等待批准 / 需要你选择 / 运行中 / 失败 / 任务受阻 / 完成未读」六种状态；会话不在画面上时给应用内提示或系统通知，窗口不在前台时闪烁任务栏并显示待处理数。

**架构：** 状态在渲染层：`sessionAttention` store 用 pi 事件和 Goal 快照记未读，用现有四个请求 store 派生等待中的请求。渲染层 `AttentionHost` 观察状态转变，调主进程 `attention_notify`；主进程 `AttentionService` 读设置和窗口焦点，决定不提示、应用内提示还是系统通知，并负责任务栏闪烁、覆盖图标和通知点击。

**技术栈：** Electron 38（`Notification`、`BrowserWindow.flashFrame` / `setOverlayIcon`、`app.setBadgeCount`）、React + zustand 5、antd 6（`App.useApp().notification`、`Tooltip`）、antd-style、lucide-react 1.47、vitest、ui-harness。

**规格：** `.agents/notes/implemented/feature/2026-10-19-session-attention-badges-and-notifications.md`（执行时在 proposed/，已随代码转 implemented）。

## 全局约束

- 所有命令在 `electron-agent/` 下跑；ui-harness 的 `--xxx` 参数放在 `--` 后面。
- 工作区里有大量与本需求无关的未提交改动（包括本计划要改的 `App.tsx`、`register.ts`、`lib/pi.ts`、`features/sessions/*`、`AGENTS.md`），会话归档功能也还没提交。任务内不 commit，不 `git stash`、不 `git checkout` 任何文件；全部完成后由用户决定怎么提交。
- 状态优先级（从高到低）：`approval` > `choice` > `running` > `failed` > `blocked` > `done`。
- 完成宽限 `DONE_GRACE_MS = 1500`；完成 / 失败的应用内提示 `duration: 8`（秒），选择 / 批准 / 受阻的提示 `duration: false`；行 Tooltip `mouseEnterDelay={0.4}`；任务栏数字超过 9 写 `9+`。
- 设置默认值：`notify.done` 为 `'0'`，`notify.choice` / `notify.blocked` / `notify.failed` / `notify.sound` / `notify.taskbar` 为 `'1'`。开关只管提示、通知和任务栏，侧栏角标始终显示。
- 颜色：`approval` 用 `cssVar.orange`，`choice` 用 `cssVar.colorInfo`，`running` 保持现有 `cssVar.colorWarning`，`failed` 用 `cssVar.colorError`，`blocked` 用 `cssVar.purple`，`done` 用 `cssVar.colorSuccess`。
- 状态名（`ATTENTION_LABEL`）：approval「等待批准」、choice「需要你选择」、failed「失败」、blocked「任务受阻」、done「已完成」。
- Tooltip 文案：「等待批准：<标题>」「等待你选择：<标题>」「失败：<报错，超过 60 字截断加 …>」「Goal 受阻：<原因>」「已完成，未查看」；缺标题时分别写「有操作等待批准」「有问题等你回答」「回合出错」「需要你处理」。
- 会话路径一律用 `sessionControlKey`（`src/stores/modeStore.ts`）作键，用 `pathsEquivalent` 比较；调 `handleOpenSession` 和主进程时传原始写法的路径。
- `env.source` 为 `goal` / `subagent` 的事件、没有 `sessionPath` 的事件不参与。
- 不用 emoji。界面文案中文。
- 新增或改动 UI 只跑本计划点名的场景：`session-row`、`attention-toast`，以及任务 7 / 任务 9 里写明要加跑的场景。

## 审查重点（Review Focus）

- 同一个会话在事件、侧栏列表、Goal 的 `sessionIdByPath` 里写法不同（`D:\Repo\a.jsonl` 和 `d:/repo/a.jsonl`）：必须认成同一个会话，角标、计数、已读都只有一份。任务 6 测试 `treats differently spelled paths as one session`。
- Goal 多轮续跑：`agent_end`（stop）后 1 秒才到 `agent_settled`，紧接着 `agent_start`，不能冒「完成」。宽限从 `agent_settled` 重新起算。任务 6 测试 `restarts the grace window at agent_settled`。
- 有未读的会话被删除或归档后，任务栏数字不能一直挂着。删除时调 `forgetSessionAttention`；计数只算还在侧栏列表里的会话。任务 6 测试 `forgets a deleted session`，任务 5 测试 `counts only listed sessions`。
- 窗口最小化时点系统通知：窗口要还原、拿到焦点并打开那个会话。任务 1 测试 `restores a minimized window on click`。
- 多个后台会话同时结束：每个会话一条提示，同一个会话新的替换旧的；系统通知对象在关闭前一直有引用（Electron 的通知被 GC 后点击回调不再触发）。任务 1 测试 `replaces the previous notification of the same session`，任务 8 测试 `uses one toast key per session`。

---

### 任务 1：主进程通知契约与 `AttentionService`

**文件：**
- 创建：`electron/app/attentionContract.ts`
- 创建：`electron/app/attentionService.ts`
- 测试：`electron/app/attentionService.test.ts`

**Interfaces（后续任务引用）：**

```ts
// attentionContract.ts（渲染层也从这里 import 类型和默认值）
export const ATTENTION_KINDS = ['approval', 'choice', 'failed', 'blocked', 'done'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export type NotifySettingKey = 'notify.done' | 'notify.choice' | 'notify.blocked' | 'notify.failed' | 'notify.sound' | 'notify.taskbar';
export const NOTIFY_SETTING_DEFAULTS: Record<NotifySettingKey, '0' | '1'>;
export function notifySettingOf(kind: AttentionKind): NotifySettingKey; // approval/choice → notify.choice，其余同名
export function notifyEnabled(settings: Record<string, string>, key: NotifySettingKey): boolean; // 空值或缺省取默认，'1' 为开
export interface AttentionNotifyInput { kind: AttentionKind; workspace: string; sessionPath: string; title: string; body: string }
export interface AttentionNotifyResult { route: 'off' | 'in-app' | 'os'; sound: boolean }
export const WINDOW_FOCUS_EVENT = 'pi://window-focus';     // payload { focused: boolean }
export const ATTENTION_OPEN_EVENT = 'pi://attention-open'; // payload { workspace: string; sessionPath: string }

// attentionService.ts
export interface AttentionWindow {
  isFocused(): boolean; isMinimized(): boolean; restore(): void; show(): void; focus(): void;
  flashFrame(flag: boolean): void; setOverlayIcon(icon: unknown, description: string): void;
  on(event: 'focus' | 'blur', listener: () => void): unknown;
}
export interface AttentionNotification { on(event: 'click' | 'close', listener: () => void): unknown; show(): void; close(): void }
export interface AttentionServiceDeps {
  window: () => AttentionWindow | undefined;
  readSettings: () => Promise<Record<string, string>>;
  /** 返回 undefined 表示系统不支持通知。 */
  createNotification: (options: { title: string; body: string; silent: boolean }) => AttentionNotification | undefined;
  createImage: (dataUrl: string) => unknown;
  setBadgeCount: (count: number) => void;
  send: (event: string, payload: unknown) => void;
  platform: NodeJS.Platform;
}
export class AttentionService {
  constructor(deps: AttentionServiceDeps);
  attachWindow(win: AttentionWindow): void;
  isFocused(): boolean;
  notify(input: AttentionNotifyInput): Promise<AttentionNotifyResult>;
  badge(input: { count: number; overlayDataUrl?: string }): Promise<void>;
}
```

- [ ] **步骤 1：编写失败的测试** `attentionService.test.ts`，用假窗口（`vi.fn()` 方法 + 记录 `on` 监听）和假通知工厂：

```ts
it('returns off when the kind is disabled', async () => {
  // readSettings → { 'notify.failed': '0' }
  expect(await svc.notify(input('failed'))).toEqual({ route: 'off', sound: false });
  expect(createNotification).not.toHaveBeenCalled();
});
it('keeps done off by default and the others on', async () => {
  // readSettings → {}
  expect((await svc.notify(input('done'))).route).toBe('off');
  expect((await svc.notify(input('approval'))).route).not.toBe('off');
});
it('routes in-app while the window is focused', async () => {
  win.isFocused.mockReturnValue(true);
  expect(await svc.notify(input('choice'))).toEqual({ route: 'in-app', sound: true });
  expect(createNotification).not.toHaveBeenCalled();
});
it('shows an OS notification and flashes the frame when unfocused', async () => {
  expect(await svc.notify(input('approval'))).toEqual({ route: 'os', sound: true });
  expect(createNotification).toHaveBeenCalledWith({ title: 'T', body: 'B', silent: false });
  expect(notification.show).toHaveBeenCalled();
  expect(win.flashFrame).toHaveBeenCalledWith(true);
});
it('does not flash for done or when notify.taskbar is off', ...);           // done 开着也不闪；notify.taskbar='0' 时 approval 不闪
it('is silent when notify.sound is off', ...);                               // silent: true，返回 sound: false
it('replaces the previous notification of the same session', ...);          // 同一 sessionPath 第二次 notify 前对第一条 close()
it('restores a minimized window on click', ...);                            // isMinimized → restore、show、focus，send(ATTENTION_OPEN_EVENT, { workspace, sessionPath })
it('falls back to in-app when notifications are unsupported', ...);         // createNotification 返回 undefined → route 'in-app'
it('forwards focus and blur and stops flashing on focus', ...);             // attachWindow 后触发 focus → flashFrame(false) + send(WINDOW_FOCUS_EVENT, { focused: true })；blur → { focused: false }
it('sets an overlay icon on win32 and clears it at zero', ...);             // badge({ count: 3, overlayDataUrl }) → setOverlayIcon(image, '3 个会话需要处理')；badge({ count: 0 }) → setOverlayIcon(null, '')
it('uses setBadgeCount elsewhere', ...);                                    // platform 'darwin' → setBadgeCount(3)
it('clears the badge when notify.taskbar is off', ...);                     // 关着时 badge({ count: 3 }) 等同 count 0
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/app/attentionService.test.ts`
预期：FAIL，找不到 `./attentionService`。

- [ ] **步骤 3：实现 `attentionContract.ts` 与 `AttentionService`**

通知对象按 `sessionPath` 的 `sessionControlKey` 同款归一（主进程里自己写一个 `replace(/\\/g,'/').toLowerCase()`，不 import 渲染层）存在 Map 里，`close` / `click` 时删掉，保证关闭前一直有引用。`badge` 的 win32 分支只在 `count > 0 && overlayDataUrl` 时设图标。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/app/attentionService.test.ts`
预期：PASS。

---

### 任务 2：IPC、主窗口接线与渲染层客户端

**文件：**
- 修改：`electron/ipc/register.ts`（`IpcServices` 加 `attention?: AttentionService`；新增 `registerAttentionCommands`）
- 修改：`electron/main.ts`（建服务、`createWindow` 返回窗口并 `attachWindow`、Windows 设 AppUserModelId）
- 修改：`src/lib/pi.ts`
- 测试：`electron/ipc/register.test.ts`

**Interfaces：**

```ts
// register.ts 注册三条命令
'attention_notify'          // args: AttentionNotifyInput → AttentionNotifyResult；kind 不在 ATTENTION_KINDS、workspace / sessionPath 为空时 throw
'attention_badge'           // args: { count: number; overlayDataUrl?: string } → void；count 非负整数，否则 throw
'attention_window_focused'  // → boolean

// lib/pi.ts，加进 pi 对象
attentionNotify: (input: AttentionNotifyInput) => Promise<AttentionNotifyResult>;
attentionBadge: (count: number, overlayDataUrl?: string) => Promise<void>;
attentionWindowFocused: () => Promise<boolean>;
// lib/pi.ts 新导出
export function onWindowFocus(handler: (e: { focused: boolean }) => void): Promise<UnlistenFn>;
export function onAttentionOpen(handler: (e: { workspace: string; sessionPath: string }) => void): Promise<UnlistenFn>;
```

- [ ] **步骤 1：编写失败的测试**（`register.test.ts` 新增 `describe('attention commands')`）

```ts
it('validates and forwards attention_notify', async () => {
  const attention = { notify: vi.fn().mockResolvedValue({ route: 'os', sound: true }), badge: vi.fn(), isFocused: vi.fn() };
  registerIpcHandlers({ attention: attention as never }); const invoke = handler(IPC_CHANNELS.invoke);
  const args = { kind: 'failed', workspace: 'D:/repo', sessionPath: 'D:/s.jsonl', title: 'T', body: 'B' };
  await expect(invoke({}, { command: 'attention_notify', args })).resolves.toEqual({ route: 'os', sound: true });
  expect(attention.notify).toHaveBeenCalledWith(args);
  await expect(invoke({}, { command: 'attention_notify', args: { ...args, kind: 'nope' } })).rejects.toThrow();
});
it('rejects a negative badge count', ...);   // count: -1 → reject；count: 2 → badge({ count: 2, overlayDataUrl: undefined })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/ipc/register.test.ts -t "attention"`
预期：FAIL，`Electron command is not registered: attention_notify`。

- [ ] **步骤 3：实现**

- `register.ts`：`if (services.attention) registerAttentionCommands(services.attention);`，参数用文件里现成的 `readString` / `readText`。
- `main.ts`：`whenReady` 开头 `if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.rxstudio.grenagent' : process.execPath);`（值同 `electron-builder.yml` 的 appId）。用 `new AttentionService({ window: () => mainWindow, readSettings: () => settings.getAll(), createNotification: (o) => Notification.isSupported() ? new Notification(o) : undefined, createImage: (u) => nativeImage.createFromDataURL(u), setBadgeCount: (n) => app.setBadgeCount(n), send: broadcastPiEvent, platform: process.platform })` 建服务，传进 `registerIpcHandlers`；`createWindow` 改成返回 `BrowserWindow`，调用处 `mainWindow = createWindow(...)` 后 `attention.attachWindow(mainWindow)`。
- `pi.ts`：三个 invoke 和两个 `listen` 包装，类型从 `../../electron/app/attentionContract` import。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/ipc/register.test.ts electron/ipc/commandCoverage.test.ts`
预期：PASS。

---

### 任务 3：设置页「通知」分类

**文件：**
- 修改：`src/features/settings/settingsSchema.ts`
- 测试：`src/features/settings/settingsSchema.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
it('核心组在外观之后有「通知」分类，六个开关的默认值与主进程一致', () => {
  const ids = SETTINGS_SCHEMA.filter((c) => c.group === '核心').map((c) => c.id);
  expect(ids.indexOf('notifications')).toBe(ids.indexOf('appearance') + 1);
  const fields = SETTINGS_SCHEMA.find((c) => c.id === 'notifications')!.fields!;
  expect(fields.map((f) => [f.key, f.label, f.type, f.default, f.effect])).toEqual([
    ['notify.done', '会话完成', 'boolean', '0', 'instant'],
    ['notify.choice', '需要选择或批准', 'boolean', '1', 'instant'],
    ['notify.blocked', '任务受阻', 'boolean', '1', 'instant'],
    ['notify.failed', '失败', 'boolean', '1', 'instant'],
    ['notify.sound', '提示音', 'boolean', '1', 'instant'],
    ['notify.taskbar', '任务栏闪烁与待处理数', 'boolean', '1', 'instant'],
  ]);
  for (const f of fields) expect(f.default).toBe(NOTIFY_SETTING_DEFAULTS[f.key as NotifySettingKey]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/settings/settingsSchema.test.ts`
预期：FAIL，找不到 `notifications` 分类。

- [ ] **步骤 3：实现** 分类 `{ id: 'notifications', title: '通知', group: '核心', icon: Bell }`，`default` 直接引用 `NOTIFY_SETTING_DEFAULTS`。各项 `description`：
  - 会话完成：「后台会话跑完时提醒（默认关）」
  - 需要选择或批准：「后台会话弹出选项卡、视觉设计确认或审批时提醒（默认开）」
  - 任务受阻：「Goal 受阻时提醒（默认开）」
  - 失败：「回合出错结束时提醒（默认开）」
  - 提示音：「提醒时播放提示音（默认开）」
  - 任务栏闪烁与待处理数：「窗口不在前台时闪烁任务栏，图标上显示待处理的会话数（默认开）」

  打开设置页确认这个分类按通用字段渲染；如果 `SettingsPanel` 按 id 白名单渲染，把 `notifications` 加进去。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/settings`
预期：PASS。

---

### 任务 4：后台暂存可订阅

**文件：**
- 修改：`src/stores/backgroundUiRequests.ts`
- 测试：`src/stores/backgroundUiRequests.test.ts`（没有就新建）

**Interfaces：**

```ts
export const useStashedUiRequestsVersion: UseBoundStore<StoreApi<{ version: number }>>;
export interface StashedUiRequests { sessionPath: string; inline?: InlineQuestionItem; prompts: UiPromptItem[] }
export function listStashedUiRequests(): StashedUiRequests[];
```

- [ ] **步骤 1：编写失败的测试**

```ts
it('bumps the version on every stash change and lists entries', () => {
  const v0 = useStashedUiRequestsVersion.getState().version;
  stashUiPrompt('D:/b.jsonl', prompt('r1'));
  expect(useStashedUiRequestsVersion.getState().version).toBe(v0 + 1);
  expect(listStashedUiRequests()).toEqual([{ sessionPath: 'D:/b.jsonl', prompts: [expect.objectContaining({ request: expect.objectContaining({ id: 'r1' }) })] }]);
  dismissUiRequest('r1');
  expect(useStashedUiRequestsVersion.getState().version).toBe(v0 + 2);
  expect(listStashedUiRequests()).toEqual([]);
});
```

另测 `stashInlineQuestion`、`restoreStashedUiRequests`、`dropStashedUiRequests`、`clearStashedUiRequestsForTest` 各自让版本号加一（实际删改了东西才加）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/stores/backgroundUiRequests.test.ts`
预期：FAIL，`useStashedUiRequestsVersion` 未导出。

- [ ] **步骤 3：实现** 每个改动 `stash` 的函数末尾调一个内部 `bump()`；`listStashedUiRequests` 返回 `[...stash]` 的拷贝。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/stores/backgroundUiRequests.test.ts src/features/extensionUi`
预期：PASS。

---

### 任务 5：注意状态的纯函数（请求派生与显示规则）

**文件：**
- 创建：`src/stores/attentionPending.ts`
- 创建：`src/stores/attentionView.ts`
- 测试：`src/stores/attentionPending.test.ts`、`src/stores/attentionView.test.ts`

**Interfaces：**

```ts
// attentionPending.ts
export interface PendingEntry { path: string; workspace: string; kind: 'approval' | 'choice'; title?: string }
export interface PendingSources {
  prompts: UiPromptItem[];          // uiPromptStore 的 byWorkspace + waiting 摊平
  inline: InlineQuestionItem[];     // inlineQuestionStore.byWorkspace 的值（live 和 restored 都算）
  visual: VisualEntry[];            // visualStore.entries 的值，只用 pending 为 true 的
  stashed: StashedUiRequests[];
  /** 请求没带 sessionPath 时归到该工作区画面上的会话；返回 undefined 就丢掉这条。 */
  ownerOf: (workspace: string) => string | undefined;
}
export function derivePending(src: PendingSources): Record<string, PendingEntry>; // 键为 sessionControlKey

// attentionView.ts
export type RowStatusKind = AttentionKind | 'running';
export interface UnreadEntry { path: string; workspace: string; outcome?: { kind: 'done' | 'failed'; message?: string; seq: number }; blocked?: { message?: string } }
export interface SessionAttentionState { pending?: PendingEntry; unread?: UnreadEntry }
export const ATTENTION_LABEL: Record<AttentionKind, string>;
export function resolveRowStatus(state: SessionAttentionState | undefined, running: boolean): RowStatusKind | undefined;
export function attentionTooltip(kind: AttentionKind, state: SessionAttentionState): string;
export function needsAction(state: SessionAttentionState | undefined): boolean; // pending / failed / blocked
export function attentionCount(states: Iterable<[key: string, SessionAttentionState]>, listed?: ReadonlySet<string>): number;
export function summarizeGroup(items: Array<{ state: SessionAttentionState | undefined; running: boolean }>): { kind: RowStatusKind; count: number } | undefined;
```

- [ ] **步骤 1：编写失败的测试**

`attentionPending.test.ts`：

```ts
it('maps prompts to approval and ask_user / visual to choice', ...);        // confirm 请求 → approval，title 取 request.title ?? request.message；inline → choice，title 取 data.questions[0].title；visual pending → choice，title '视觉设计等待确认'
it('lets approval win over choice in the same session', ...);
it('keeps the first approval title in queue order', ...);                   // byWorkspace 那条在 waiting 前面
it('attributes requests without sessionPath to ownerOf', ...);              // 没带 sessionPath → ownerOf(workspace)；ownerOf 返回 undefined → 不出现
it('includes stashed requests of background sessions', ...);
it('ignores visual entries that are not pending', ...);
```

`attentionView.test.ts`：

```ts
it.each([
  [{ pending: approval, unread: failed }, true, 'approval'],
  [{ pending: choice }, true, 'choice'],
  [{ unread: failed }, true, 'running'],
  [{ unread: { ...failed, blocked: {} } }, false, 'failed'],
  [{ unread: blockedOnly }, false, 'blocked'],
  [{ unread: done }, true, 'running'],
  [{ unread: done }, false, 'done'],
  [undefined, false, undefined],
])('resolveRowStatus %#', (state, running, kind) => expect(resolveRowStatus(state, running)).toBe(kind));
it('writes tooltips with fallbacks and truncates long errors at 60 chars', ...); // 61 字报错 → 前 60 字 + '…'
it('counts approval, choice, failed and blocked but not done', ...);
it('counts only listed sessions', ...);                                     // listed 不含某键 → 不计
it('summarizes a group by top priority and action count', ...);             // [running, failed, done] → { kind: 'running', count: 1 }；[done] → { kind: 'done', count: 0 }；全空 → undefined
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/stores/attentionPending.test.ts src/stores/attentionView.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现** 两个文件都不 import 任何 store，只依赖类型与 `sessionControlKey`。

- [ ] **步骤 4：运行测试验证通过**

运行：同步骤 2。
预期：PASS。

---

### 任务 6：注意状态 store（事件、宽限、Goal、已读、可见）

**文件：**
- 创建：`src/stores/sessionAttention.ts`
- 测试：`src/stores/sessionAttention.test.ts`

**Interfaces：**

```ts
export const DONE_GRACE_MS = 1500;
export interface AttentionStoreState {
  unread: Record<string, UnreadEntry>;
  pending: Record<string, PendingEntry>;
  focused: boolean;            // 初始 true，start 时向主进程问一次
  visibleKey?: string;         // focused 且有 activeSessionPath 时为它的键
}
export const useAttentionStore: UseBoundStore<StoreApi<AttentionStoreState>>;
export function handleAttentionEvent(env: PiEventEnvelope): void;
export function applyGoalState(state: Pick<GoalStoreState, 'bySession' | 'sessionIdByPath'>): void;
export function recomputePending(): void;           // 读四个请求 store + listStashedUiRequests，ownerOf 用 useSessionStore.workspaceSessionPaths
export function setWindowFocused(focused: boolean): void;
export function syncVisibility(): void;             // 按 focused + activeSessionPath 算 visibleKey；有可见会话就清它的未读
export function isSessionVisible(path: string): boolean;
export function forgetSessionAttention(path: string): void;
export function sessionStateOf(s: AttentionStoreState, path: string): SessionAttentionState | undefined;
export function listedSessionKeys(): Set<string>;   // visibleSessions(allSessions, optimisticSessions, deletedSessionPaths)（lib/mergeSessions）的路径键，去掉归档 / 乐观删除
export function startSessionAttention(): void;      // 幂等：onPiEvent、onWindowFocus、goalStore / sessionStore / 四个请求 store / 暂存版本号订阅，pi.attentionWindowFocused()
export function resetSessionAttentionForTest(): void;
export function useSessionAttention(path: string, running: boolean): { kind: AttentionKind; tooltip: string } | undefined;
export function useGroupAttention(paths: readonly string[], running: ReadonlySet<string>, enabled: boolean): { kind: RowStatusKind; count: number } | undefined;
```

事件规则（每个会话记 `awaitingDone` 和一个计时器）：

- `agent_start`：取消计时器，`awaitingDone = false`，`outcome.kind === 'done'` 时删掉 outcome。
- `agent_end` 且 `willRetry !== true`：用 `assistantStopFromMessages(event.messages)`。`'error'` → 不可见时写 `outcome = { kind: 'failed', message: <最后一条 assistant 的 errorMessage>, seq: seq + 1 }`；`'stop'` → `awaitingDone = true` 并起计时器；`'aborted'` / 读不出 → 什么都不改。
- `agent_settled`：`awaitingDone` 时重新起计时器。
- 计时器到点：不可见时写 `outcome = { kind: 'done', seq: seq + 1 }`，`awaitingDone = false`。
- Goal：快照 `status === 'blocked'` 且上次不是 → 用 `sessionIdByPath` 反查键，不可见时写 `blocked = { message: blockedReason?.message }`；快照不再是 blocked 或被删掉 → 删 `blocked`。条目的 `path` / `workspace` 用 `useSessionStore.getState().getMergedSessions()` 里对上的那条会话（`path`、`cwd`），对不上就跳过。
- hooks 只用返回原始值的 selector（kind、tooltip、`"kind|count"` 字符串），再 `useMemo` 拼对象，避免每次渲染新对象。

- [ ] **步骤 1：编写失败的测试**（`vi.useFakeTimers()`；`useSessionStore.setState` 造当前会话与列表；`resetSessionAttentionForTest` 放 `afterEach`）

```ts
it('marks done after the grace window', () => {
  end(B, 'stop'); settled(B);
  vi.advanceTimersByTime(DONE_GRACE_MS - 1); expect(outcome(B)).toBeUndefined();
  vi.advanceTimersByTime(1); expect(outcome(B)).toMatchObject({ kind: 'done', seq: 1 });
});
it('skips done when the next Goal round starts within the window', ...);       // end → settled → 300ms 后 start → 推进 5s 仍无 outcome
it('restarts the grace window at agent_settled', ...);                        // end，1000ms 后 settled，再过 1000ms start → 无 outcome
it('records failed immediately with the error message', ...);                 // messages 末条 { role: 'assistant', stopReason: 'error', errorMessage: '429 rate limited' }
it('keeps failed while running and replaces it with the next outcome', ...);  // failed → start（仍是 failed）→ end stop + 宽限 → done，seq 递增
it('clears done when a new round starts', ...);
it('leaves outcomes alone on abort', ...);                                    // 已有 failed，aborted 结束后仍是同一条 failed
it('ignores goal and subagent sources and events without sessionPath', ...);
it('does not record unread for the visible session', ...);                   // B 是 activeSessionPath 且 focused
it('records unread for the active session while unfocused and clears it on focus', ...);
it('clears unread when the session is opened', ...);                         // 改 activeSessionPath 后 syncVisibility
it('treats differently spelled paths as one session', ...);                  // 事件 'D:\\Repo\\b.jsonl'，列表 'd:/repo/b.jsonl'，sessionStateOf 两种写法都拿到同一份
it('marks blocked from the Goal snapshot and clears it when resumed', ...);
it('derives pending from the request stores', ...);                          // useUiPromptStore.setRequest 后 recomputePending → pending[B].kind === 'approval'
it('forgets a deleted session', ...);                                        // forgetSessionAttention(B) 后 unread、计时器都没了
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/stores/sessionAttention.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现** `sessionAttention.ts`。`startSessionAttention` 照 `runningSessions.startRunningSessionTracking` 的写法用模块级 `started` 防重复。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/stores/sessionAttention.test.ts src/stores/runningSessions.test.ts`
预期：PASS。

---

### 任务 7：侧栏渲染（会话行角标、Tooltip、折叠分组汇总）

**文件：**
- 修改：`src/features/sessions/SessionItem.tsx`（去掉没人传的 `waiting` 和它的 `Hand` 分支；加 `attention` 属性）
- 修改：`src/features/sessions/ProjectItem.tsx`（加 `attention` 属性）
- 修改：`src/features/sessions/GroupSessionRow.tsx`、`ConversationRow.tsx`（调 `useSessionAttention`）
- 修改：`src/features/sessions/ProjectHeaderRow.tsx`（加 `runningSessionPaths` 属性，调 `useGroupAttention(paths, running, !expanded)`）
- 修改：`src/features/sessions/Sidebar.tsx`（给 `ProjectHeaderRow` 传 `runningSessionPaths`）
- 修改：`src/App.tsx`（调 `forgetRunningSession` 的地方同时调 `forgetSessionAttention`）
- 测试：`src/features/sessions/SessionItem.test.tsx`、`ProjectItem.test.tsx`（没有就新建）
- 场景：`ui-harness/scenarios/session-row.tsx`、`ui-harness/probes/session-row.mjs`

**Interfaces：**

```ts
// SessionItemProps 新增（running 照旧传）
attention?: { kind: AttentionKind; tooltip: string };
// ProjectItemProps 新增
attention?: { kind: RowStatusKind; count: number };
```

DOM 约定（probe 依赖）：
- 行尾格 `span[data-running]` 加 `data-attention={kind}`；有 `data-attention` 时和运行中一样常显（`display: grid`），悬停时换成按钮，规则同转圈。
- 角标 `<span data-testid="session-attention" data-kind={kind} aria-label={tooltip}>`，`grid-area: 1 / 1`。approval 用 `Hand`，choice 用 `MessageCircleQuestion` 加呼吸动画（opacity 1 → 0.45，1.6s，ease-in-out，infinite alternate），failed 用 `CircleX`，blocked 用 `OctagonPause`，done 是 8px 实心圆点。传了 `attention` 就不画转圈。
- `RowActions` 的预挂载条件改为 `hovered || running || Boolean(attention)`。
- 整行外面包 `<Tooltip title={attention?.tooltip} placement="right" mouseEnterDelay={0.4}>`，放在 `Dropdown` 里面、行 `div` 外面。Tooltip 总是挂着，没有状态时 title 为 undefined，不要条件包裹，否则状态一变整行重挂、悬停状态丢掉。
- 分组头：`!expanded && attention` 时在名字后面画 `<span data-testid="project-attention" data-kind={kind}>`，图标同会话行（running 用转圈），`count > 0` 时后面跟数字 `<span data-testid="project-attention-count">`。

- [ ] **步骤 1：编写失败的测试**

```ts
// SessionItem.test.tsx
it('renders the attention badge instead of the spinner', () => {
  const { container } = render(<SessionItem {...base} running attention={{ kind: 'approval', tooltip: '等待批准：执行 npm publish？' }} />);
  const badge = container.querySelector('[data-testid="session-attention"]')!;
  expect(badge.getAttribute('data-kind')).toBe('approval');
  expect(badge.getAttribute('aria-label')).toBe('等待批准：执行 npm publish？');
  expect(container.querySelector('[data-testid="session-running"]')).toBeNull();
  expect(container.querySelector('[data-attention="approval"]')).not.toBeNull();
});
it('mounts row actions for an idle row with attention', ...);   // running=false + attention done → 有「更多」按钮节点
// ProjectItem.test.tsx
it('shows the summary only when collapsed', ...);                // expanded=false → project-attention data-kind=approval、count 文本 '2'；expanded=true → 没有
it('hides the count when it is zero', ...);                      // { kind: 'done', count: 0 } → 没有 project-attention-count
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/sessions`
预期：新增用例 FAIL。

- [ ] **步骤 3：实现** 组件与行接线。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/sessions src/stores`
预期：PASS。

- [ ] **步骤 5：扩展 `session-row` 场景和 probe**

场景在现有两行下面再加五行：`approval-row`（running + approval）、`choice-row`、`failed-row`（报错文本 70 字，验证截断）、`blocked-row`、`done-row`；再加两个分组头：`collapsed-project`（`expanded=false`，`attention={ kind: 'approval', count: 2 }`）和 `expanded-project`（同样的 attention，`expanded`）。各行 tooltip 用 `attentionTooltip` 现算，期望文案 `exposeData` 出去。

probe 新增断言（原有断言不动）：
- 五行角标各一个、`data-kind` 对，approval 行没有转圈。
- 颜色：probe 里写 `tokenColor(name)`，往 `[data-testid="failed-row"]` 里临时插一个 `style.color = 'var(--ant-' + name + ')'` 的 span 读计算色再删掉；approval 的 svg 颜色 ≈ `orange`，choice ≈ `color-info`，failed ≈ `color-error`，blocked ≈ `purple`，done 圆点背景 ≈ `color-success`，都用 `checkColor`。
- choice 角标 `animation-name` 不是 `none`。
- 悬停 approval 行：角标不可见、「更多」可见，「更多」中心和角标原中心距离 ≤ 2px，`hitTest` 命中「更多」。
- 悬停 failed 行 600ms 后 `[role="tooltip"]` 可见，文字等于 exposeData 的期望（含截断的「…」）；鼠标移开后不可见（`countVisible`）。
- 悬停不到 400ms（等 200ms）时没有 Tooltip。
- `collapsed-project` 有汇总、数字 `2`；`expanded-project` 没有。
- `t.setTheme('light')` 后 failed 角标颜色重新对一遍 `color-error`。

- [ ] **步骤 6：跑场景**

运行：`npm run ui:check -- session-row > ui-check-session-row.log 2>&1`
预期：全部 PASS。

- [ ] **步骤 7：查波及范围**

运行：`npm run ui:check -- --changed --dry-run`
预期：列出 `session-archive`、`isolated-workspace`（都渲染真实侧栏行 / 分组头）。这两个场景的行尾格和分组头布局确实变了，接着跑：`npm run ui:check -- session-archive isolated-workspace > ui-check-sidebar.log 2>&1`，预期全部 PASS。列表里还有别的场景时，按 AGENTS.md 的规则逐个判断要不要跑，并记下原因。

---

### 任务 8：提示与任务栏（`AttentionHost`）

**文件：**
- 创建：`src/features/attention/attentionNotifier.ts`
- 创建：`src/features/attention/badgeOverlay.ts`
- 创建：`src/features/attention/chime.ts`
- 创建：`src/features/attention/openSessionBridge.ts`
- 创建：`src/features/attention/AttentionHost.tsx`
- 修改：`src/App.tsx`（`<ExtensionUiHost />` 旁边挂 `<AttentionHost />`；有 `handleOpenSourceSession` 的那个组件里 `useEffect(() => registerAttentionOpenHandler(handleOpenSourceSession), [handleOpenSourceSession])`）
- 测试：`src/features/attention/attentionNotifier.test.ts`、`badgeOverlay.test.ts`

**Interfaces：**

```ts
// attentionNotifier.ts
export interface AttentionTransition { key: string; path: string; workspace: string; kind: AttentionKind; body: string }
export function diffAttention(prev: AttentionStoreState, next: AttentionStoreState): { opened: AttentionTransition[]; cleared: Array<{ key: string; kinds: AttentionKind[] }> };
export interface ToastApi { open(cfg: { key: string; kind: AttentionKind; title: string; body: string; autoClose: boolean; onGo: () => void }): void; destroy(key: string): void }
export interface NotifierDeps {
  notify: (input: AttentionNotifyInput) => Promise<AttentionNotifyResult>;
  badge: (count: number, overlayDataUrl?: string) => Promise<void>;
  drawOverlay: (count: number) => string | undefined;
  toast: ToastApi;
  chime: () => void;
  openSession: (workspace: string, path: string) => void;
  titleOf: (path: string) => string;
  listedKeys: () => ReadonlySet<string>;
}
export function createAttentionNotifier(deps: NotifierDeps): { stop(): void }; // 订阅 useAttentionStore 和 useSessionStore
// badgeOverlay.ts
export function badgeText(count: number): string;                       // 1..9 原样，>9 → '9+'
export function drawBadgeOverlay(count: number): string | undefined;     // 32×32 红底（#d93026）白字圆，toDataURL('image/png')；count ≤ 0 或拿不到 2d context 返回 undefined
// chime.ts
export function playChime(): void;                                       // 懒建 AudioContext，880Hz → 660Hz 正弦，0.18s，峰值 gain 0.08，出错静默
// openSessionBridge.ts
export function registerAttentionOpenHandler(fn: (workspace: string, path: string) => void | Promise<void>): () => void;
export function openSessionFromAttention(workspace: string, path: string): void; // 没有注册时什么都不做
```

转变规则（`diffAttention`）：
- `opened`：pending 从无到有或 kind 变了 → 该 kind，body 为 pending.title（没有就用 Tooltip 的兜底文案）；`outcome.seq` 变大 → outcome.kind，body 为 message（done 写「已完成」）；blocked 从无到有 → `blocked`，body 为原因。
- `cleared`：pending 没了 → `['approval', 'choice']`；blocked 没了 → `['blocked']`；outcome 没了 → `['failed', 'done']`；`visibleKey` 变成这个键 → 全部五种。

通知器行为：
- 每条 `opened`：`isSessionVisible(path)` 为真就跳过；否则调 `notify({ kind, workspace, sessionPath: path, title: \`${titleOf(path)} · ${ATTENTION_LABEL[kind]}\`, body })`。返回 `in-app` 时 `toast.open({ key: 'attention:' + key, kind, title, body, autoClose: kind === 'done' || kind === 'failed', onGo })`，`sound` 为真时 `chime()`；`onGo` 先 `destroy` 再 `openSession`。
- 每条 `cleared`：这个键上开着的提示 kind 在列表里时 `destroy`。
- 计数 `attentionCount(..., listedKeys())` 变化时（启动时为 0 不发）调 `badge(count, count > 0 ? drawOverlay(count) : undefined)`。

`AttentionHost`：`App.useApp().notification` 做 `ToastApi`，`open` 映射为 `notification.open({ key, type, title, description: body, duration: autoClose ? 8 : false, actions: <Button size="small" type="primary" data-testid="attention-go" onClick={onGo}>前往</Button>, props: { 'data-testid': 'attention-toast', 'data-kind': kind } })`，`type` 映射 approval → warning、choice → info、failed → error、blocked → warning、done → success。挂载时 `startSessionAttention()`，订阅 `onAttentionOpen` 转给 `openSessionFromAttention`。`titleOf` 在 `getMergedSessions()` 里按 `pathsEquivalent` 找，取 `name || friendlyTime(timestamp)`，找不到写「会话」。组件 `return null`。

- [ ] **步骤 1：编写失败的测试**

```ts
it('opens one transition per new state', ...);                     // diffAttention：pending 新增、seq +1、blocked 新增各出一条
it('clears toasts when the session becomes visible', ...);         // visibleKey 变成 B → cleared 含 B 的五种
it('skips the visible session', ...);                              // isSessionVisible 为真 → notify 未调
it('shows an in-app toast with go and chime when routed in-app', async () => {
  notify.mockResolvedValue({ route: 'in-app', sound: true });
  setUnread(B, { outcome: { kind: 'failed', message: 'boom', seq: 1 } });
  await flush();
  expect(notify).toHaveBeenCalledWith({ kind: 'failed', workspace: 'D:/repo', sessionPath: B, title: '重构订单页 · 失败', body: 'boom' });
  expect(toast.open).toHaveBeenCalledWith(expect.objectContaining({ key: `attention:${keyOf(B)}`, autoClose: true }));
  expect(chime).toHaveBeenCalled();
  toast.open.mock.calls[0][0].onGo();
  expect(openSession).toHaveBeenCalledWith('D:/repo', B);
});
it('does nothing on route off or os', ...);                        // toast.open、chime 都不调
it('uses one toast key per session', ...);                         // B 连续两次 opened → 同 key；C → 不同 key
it('keeps approval toasts open and destroys them when answered', ...); // autoClose false；pending 删掉后 destroy(key)
it('syncs the taskbar count with an overlay', ...);                // count 0→2 → badge(2, 'data:...')；→0 → badge(0, undefined)
// badgeOverlay.test.ts
it('caps the badge text at 9+', () => { expect(badgeText(9)).toBe('9'); expect(badgeText(10)).toBe('9+'); });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/attention`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现** 上述文件与 `App.tsx` 接线。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/attention src/stores src/features/sessions`
预期：PASS。

- [ ] **步骤 5：类型检查** 照 AGENTS.md「运行的坑」临时写一份 extends `tsconfig.json`、include 本计划新建和改动的 `src/**` 文件的配置，跑 `npx tsc -p <临时配置> --noEmit`，只看这些文件的报错，清零后删掉临时配置。主进程部分跑项目已有的主进程 tsc（`package.json` 里的 typecheck 脚本；没有就同样用临时配置）。

---

### 任务 9：`attention-toast` 场景与 AGENTS.md

**文件：**
- 创建：`ui-harness/scenarios/attention-toast.tsx`
- 创建：`ui-harness/probes/attention-toast.mjs`
- 修改：`AGENTS.md`（仓库根）

场景：真实 `AttentionHost`，外面包 antd `App`；`installBridge` 的 `invoke` 桩：`attention_window_focused` → `true`，`attention_notify` → `track('notify:' + kind + ':' + 名字)` 后返回 `{ route: 'in-app', sound: false }`，`attention_badge` → `track('badge:' + count)`；`subscribe` 桩记下 `pi://event`、`pi://window-focus`、`pi://attention-open` 的 handler。`useSessionStore` 造两个会话 A（当前）、B（后台，标题「重构订单查询栏」）。`registerAttentionOpenHandler` 注册 `(ws, p) => { track('open:' + 名字); useSessionStore.getState().setActiveSession(p) }`。`exposeActions`：
- `finish(name)`：按顺序推 `agent_start`、`agent_end`（末条 assistant `stopReason: 'stop'`）、`agent_settled`。
- `fail(name, message)`：推 `agent_start`、`agent_end`（`stopReason: 'error'`, `errorMessage`）。
- `goalRound(name)`：推 `agent_end` stop、`agent_settled`，300ms 后 `agent_start`。
- `approve(name)` / `answer()`：`useUiPromptStore` 放入 / 清掉 `{ id: 'r1', method: 'confirm', title: '执行 npm publish？' }`，sessionPath 为该会话。
- `activate(name)`：改 `activeSessionPath`。

probe 断言：
- `goalRound('B')` 后等 2.5s，没有 `notify:done:B` 事件，也没有提示。
- `finish('B')`：2.5s 内出现 `[data-testid="attention-toast"][data-kind="done"]`，标题含「重构订单查询栏 · 已完成」；不悬停的情况下 10s 内自动收起（`countVisible` 为 0）。
- `fail('B', '429 rate limited')`：出现 failed 提示，正文「429 rate limited」；点 `[data-testid="attention-go"]` → 事件有 `open:B`，提示收起。
- `activate('A')` 后 `approve('B')`：出现 approval 提示，正文「执行 npm publish？」，事件有 `badge:1`；等 9s 仍在；`answer()` 后收起，事件有 `badge:0`。
- `approve('A')`（当前会话、窗口在前台）：没有新的 `notify:approval:A`。
- `t.setTheme('light')` 后再 `fail('B', …)`，提示背景 `checkColor` ≈ 浅色 `--ant-color-bg-elevated`；截图。

AGENTS.md：
- 「目前有 … 二十六个场景」的列表加上 `attention-toast`，数字改成二十七。
- 「现有场景」里 `session-row` 那条补上：五种注意状态的角标与颜色、悬停 400ms 的状态 Tooltip、悬停仍换成按钮、折叠分组头的汇总角标与计数。
- 新增一条 `attention-toast`，写清：真实 AttentionHost + sessionAttention，主进程三条命令用桩、`route` 固定 in-app；Goal 续跑不冒完成、完成 8 秒收起、失败「前往」打开会话、批准不自动收起且答复后收起、任务栏计数、当前会话不提示、浅色主题。

- [ ] **步骤 1：写场景和 probe**
- [ ] **步骤 2：跑场景**

运行：`npm run ui:check -- attention-toast > ui-check-attention-toast.log 2>&1`
预期：全部 PASS。失败时先单独复跑一次再下结论。

- [ ] **步骤 3：改 AGENTS.md**

---

### 任务 10：实跑、证据、笔记转 implemented

**文件：**
- 创建：`.agents/evidence/2026-10-19-session-attention-badges-and-notifications/`（日志、截图）
- 移动：`.agents/notes/proposed/feature/2026-10-19-session-attention-badges-and-notifications.md` → `.agents/notes/implemented/feature/`（同名）

- [ ] **步骤 1：汇总自动化证据** 把任务 1–9 的 vitest 输出（`npx vitest run electron/app/attentionService.test.ts electron/ipc src/features/settings src/stores src/features/sessions src/features/attention > vitest.log 2>&1`）和三份 ui-check 日志、场景截图复制进证据目录。
- [ ] **步骤 2：实跑** 后台启动 `npm run dev`。仓库没有 verify-* skill，按下面清单逐项做，每项截图（PowerShell `System.Drawing` 的 `CopyFromScreen` 截全屏），做不到的写明原因：
  1. 开两个会话，让 B 跑一个要几十秒的任务后切到 A；B 跑完后侧栏出绿点，点开消失。
  2. 设置里打开「会话完成」，重复 1：出现应用内提示，「前往」打开 B。
  3. 让 B 调 ask_user 后切走窗口：出现 Windows 系统通知、任务栏图标闪烁并显示数字 1；点通知拉起窗口并打开 B；答完数字消失。
  4. 关掉「需要选择或批准」，重复 3：只有侧栏蓝色角标，没有通知、不闪烁。
- [ ] **步骤 3：笔记转 implemented** 按 write-notes-like-deepseek 的转换契约：`Status: implemented`，`## Proposal` 改成现在时 `## Decision`（事实以实际代码为准，文件名和接口照实写），`## Acceptance criteria` / `## Risks` 折进 `## Consequences`，`## 验证` 写跑了哪些命令和场景、证据路径、结果（通过 / 失败 / 部分通过）。实跑里发现的回归单独开一篇 bug-fix 笔记。
- [ ] **步骤 4：校验**

运行（仓库根）：`npm run verify-notes`
预期：三线 ok，`verify-note-evidence 通过`，新笔记不在警告列表里。
