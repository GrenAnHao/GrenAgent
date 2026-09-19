# 完全权限切换二次确认

- 日期：2026-09-19
- 状态：已审查（2026-09-19）
- 主题：桌面端从其它审批档切到「完全权限」时，必须先过带风险勾选的确认弹窗，确认成功后才写入策略。
- 相关：`docs/superpowers/specs/2026-09-12-os-sandbox-design.md`（五档审批；「完全权限」= 关 OS 沙箱且不问）

## 1. 背景

输入栏审批选择器（`ApprovalAction`）当前在 `onChange` 里立刻：

1. `useApprovalStore.setLevel(workspace, target)`
2. `pi.setApproval(workspace, target)` → 主进程 `agent_set_approval`

「完全权限」会关掉 OS 沙箱、跳过逐次确认，可直接执行敏感操作、改文件、跑外部命令。现在从「替我审批」等档位一点就生效，没有二次确认。

## 2. 目标 / 非目标

**目标**

1. 任何桌面界面入口把当前工作区审批策略从**非 full** 切到 **full** 时，先弹出确认窗。
2. 未勾选风险、未点「启用完全权限」之前：不写 `approvalStore`，不调 `pi.setApproval`，选择器继续显示旧档。
3. 勾选并确认后：等 `pi.setApproval(workspace, 'full')` 成功，再 `setLevel(workspace, 'full')`。
4. 以后若增加快捷键或命令，必须走同一套 `enableFullAccess(workspace)`，不得再直调 `pi.setApproval(..., 'full')`。

**非目标**

- 不改主进程 `agent_set_approval`。测试、会话回读、扩展侧写内存，都不弹窗。
- 不改五档策略语义、沙箱、safety。
- 不为确认结果做持久化（会话 / 工作区 / 全局都不记住）。
- 不给其它档位加确认。从「完全权限」切走立刻生效。
- 不改 CLI。
- 不改 Ask 模式（选择器本就禁用；Ask 下 `resolvePreset` 仍强制只读）。
- 不改 sidecar 经 `setStatus` 把当前档推回 `approvalStore` 的回读通道。

## 3. 已确认的设计决定

| 维度 | 决定 |
| --- | --- |
| 触发入口 | 所有界面入口；主进程 IPC 仍直接写入 |
| 弹出时机 | 仅「当前不是 full → 用户要切到 full」。已是 full 再点、切走，都不弹 |
| 是否记住 | 每次都要勾选并确认，不提供「不再询问」 |
| 选择器 | 确认成功前一直显示旧档（受控于 `approvalStore`） |
| 实现 | 共享弹窗 + 显式 `enableFullAccess(workspace)`，弹窗挂在应用根 |
| 失败 | 弹窗不关，按钮结束 loading，toast 错误，策略保持旧档，可重试或取消 |

## 4. 架构

```text
界面入口（ApprovalAction；以后的快捷键 / 命令）
        │
        ├─ 目标不是 full ──► 立刻 setLevel + pi.setApproval
        │
        └─ 目标是 full
                │
                ▼
        enableFullAccess(workspace)
                │
                ├─ 当前已是 full ──► 直接返回（不弹窗、不写 IPC）
                │
                └─ 打开 FullAccessConfirmModal（全局只挂一次）
                        │
         取消 / Esc / X / 点遮罩          勾选 +「启用完全权限」
                        │                        │
                        ▼                        ▼
              关闭，什么都不写          busy：禁用关闭与取消
                                         await pi.setApproval(..., 'full')
                                         │
                          成功 ──► setLevel(full)，关窗
                          失败 ──► toast，保持开窗，可重试
```

三个单元：

1. **`FullAccessConfirmModal`**：只负责弹窗 UI 与勾选门闩。不直接调 IPC。
2. **`enableFullAccess(workspace)`** + 小型确认 store：打开弹窗、串起 Promise、在确认后写 IPC 与 store。界面入口只调这一函数来启用 full。
3. **`ApprovalAction`**：第一个调用方。选非 full 仍走原路径；选 full 则 `void enableFullAccess(workspace)`，**不要**在 `onChange` 里抢先 `setLevel`。

弹窗宿主挂在 `App.tsx` 的 `ThemeProvider` 内、与 `ExtensionUiHost` 同级，保证任何模块的界面入口都能打开，且用到同一套主题。不要把弹窗塞进 `ApprovalAction` 内部。

## 5. 组件与 API

### 5.1 确认 store

新建 `electron-agent/src/stores/fullAccessConfirmStore.ts`（zustand，不 persist）。

状态至少：

```ts
{
  open: boolean;
  workspace: string | null;
  busy: boolean;
}
```

对外：

- `enableFullAccess(workspace: string): Promise<void>`
  - 读 `useApprovalStore.getState().byWorkspace[workspace] ?? 'auto'`。已是 `'full'` 则立即 resolve，不改 `open`。
  - 若已有进行中的确认（`open === true`）：后到的调用直接返回，不排队、不抢占。避免连点选择器叠出两次写入。
  - 否则 `open=true`、记下 `workspace`，返回的 Promise 在关闭时 resolve（无论成功启用还是取消）。取消不算错误。
- 弹窗取消 / 关闭：`busy` 时忽略；否则 `open=false`、`workspace=null`，resolve 等待中的 Promise。
- 弹窗确认：见 §7。

不把 `pi` 写进 store 的同步 reducer；IPC 在 `enableFullAccess` 的确认路径里 await。

### 5.2 弹窗

新建 `electron-agent/src/features/chat/input/FullAccessConfirmModal.tsx`。

用 antd `Modal` + `Alert` + `Checkbox`，对齐现有知识库弹窗，并贴近产品截图。

| 项 | 值 |
| --- | --- |
| `title` | `确认启用完全权限?` |
| 警告 | `Alert` `type="error"` `showIcon`。正文：`启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。` |
| 勾选 | `我已了解风险，并愿意继续` |
| 取消钮 | `取消` |
| 确认钮 | `启用完全权限` |
| `data-testid` | `full-access-confirm-modal` |

交互：

- 每次 `open` 从 false→true 时清空勾选，确认钮禁用。
- 未勾选：确认钮 `disabled`。
- 已勾选且未 busy：确认钮可点。
- 取消、右上角关闭、点遮罩、Esc：等同取消。`maskClosable` 与 `keyboard` 均为 true。
- `busy` 时：`confirmLoading`，确认 / 取消 / 关闭 / Esc / 点遮罩全部不可用，避免 IPC 进行中途取消造成竞态。
- 不提供「不再询问」。

宿主：`App.tsx` 渲染 `<FullAccessConfirmModal />`（无 props，读确认 store）。

### 5.3 ApprovalAction

`onChange`：

```ts
const onChange = (next: string) => {
  const target = next as ApprovalPolicy;
  if (target === 'full') {
    void enableFullAccess(workspace);
    return;
  }
  useApprovalStore.getState().setLevel(workspace, target);
  void pi.setApproval(workspace, target);
};
```

`Select` 仍 `value={level}`。确认前 `level` 不变，选择器显示旧档。Ask 模式继续 `disabled`。

弹窗打开时有遮罩，不处理「弹窗未关又改审批档」的并行操作。

## 6. 数据流

当前档来源不变：sidecar `setStatus` → `ExtensionUiHost` → `approvalStore`。本规格只改**界面写入 full 的路径**。

| 事件 | `approvalStore` | IPC | 选择器显示 |
| --- | --- | --- | --- |
| 选非 full | 立刻 `setLevel` | `pi.setApproval` | 新档 |
| 选 full，弹窗未确认 | 不变 | 不调用 | 旧档 |
| 选 full，确认且 IPC 成功 | 然后 `setLevel('full')` | `agent_set_approval` full | 完全权限 |
| 选 full，确认但 IPC 失败 | 不变 | 调用失败 | 旧档 |
| 选 full，取消 | 不变 | 不调用 | 旧档 |
| 已是 full | 不弹窗 | 不调用 | 完全权限 |
| 会话回读 / 测试直写 IPC | 由 `setStatus` 或测试自己写 | 不经弹窗 | 回读值 |

工作区切换：若 `open && store.workspace !== 当前活动 workspace`，按取消关闭（不写 IPC）。活动 workspace 仍由现有 `AgentStoreContext` / `useSessionStore` 决定；宿主订阅切换即可。

## 7. 错误处理

确认钮点击后：

1. `busy = true`。
2. `await pi.setApproval(workspace, 'full')`。
3. 成功：`setLevel(workspace, 'full')`，关窗，`busy=false`。
4. 失败：`App.useApp().message.error` 提示失败原因（`Error.message` 或 `String(cause)`），`busy=false`，**弹窗保持打开**，勾选保持，用户可再点启用或取消。

失败路径不得先 `setLevel` 再回滚——确认成功前选择器必须一直显示旧档。

`enableFullAccess` 对取消与失败都不 throw 给 `ApprovalAction`（`void enableFullAccess`）。失败只通过 toast 告诉用户。

## 8. 测试

不改 `piRuntimeService` 的 `agent_set_approval` 测试。

**弹窗组件**（`FullAccessConfirmModal.test.tsx`）：

- 打开时确认钮禁用；勾选后可点。
- 未勾选点确认（若还能点）不得触发确认回调。
- 点取消 / 关闭不触发启用。
- 每次重新打开时勾选被清空。

**`enableFullAccess` / store**（`fullAccessConfirmStore.test.ts`）：

- 当前已是 full：不把 `open` 设为 true，不调 `pi.setApproval`。
- 当前不是 full：`open` 为 true；取消后不调 `pi.setApproval`，`approvalStore` 仍为旧档。
- 确认后 `pi.setApproval` resolve：随后 `approvalStore` 为 `full`。
- 确认后 `pi.setApproval` reject：不改 `approvalStore`，`open` 仍为 true。
- `open` 已为 true 时第二次 `enableFullAccess`：不另开、不覆盖 workspace。

**ApprovalAction**（`ApprovalAction.test.tsx`）：

- 点「替我审批」等非 full：立刻 `pi.setApproval(workspace, 该档)`，不出现确认窗。
- 点「完全权限」：出现确认窗，**在确认前**不调用 `pi.setApproval`。
- 勾选并确认：才调用 `pi.setApproval(workspace, 'full')`。
- 取消：不调用 `pi.setApproval`，选择器文案仍是旧档。

测试里把 antd `Modal` / `Checkbox` / `Alert` 收成可点的 DOM，对齐 `ModelSyncModal.test.tsx` 的 mock 方式。`pi.setApproval` 用 `vi.mock`。

## 9. 文件

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/stores/fullAccessConfirmStore.ts` | 确认状态 + `enableFullAccess` |
| `electron-agent/src/stores/fullAccessConfirmStore.test.ts` | store / 写入时序 |
| `electron-agent/src/features/chat/input/FullAccessConfirmModal.tsx` | 弹窗 UI |
| `electron-agent/src/features/chat/input/FullAccessConfirmModal.test.tsx` | 勾选门闩与关闭 |
| `electron-agent/src/features/chat/input/actions/ApprovalAction.tsx` | 选 full 改走 `enableFullAccess` |
| `electron-agent/src/features/chat/input/actions/ApprovalAction.test.tsx` | 选择器与 IPC 的先后 |
| `electron-agent/src/App.tsx` | 挂载弹窗宿主 |

不新增主进程文件。`extensions/_shared/approval.ts` 不改。

## 10. 验收

1. 从「替我审批」（或其它非 full 档）选「完全权限」：弹出确认窗，选择器仍显示旧档，未勾选时「启用完全权限」为灰。
2. 不勾选就无法启用；点取消 / X / 遮罩 / Esc 后策略不变。
3. 勾选并启用后选择器才变成「完全权限」，智能体按 full 档运行（关沙箱、不问）。
4. 再次从其它档切到 full，仍要重新勾选确认。
5. Ask 模式下选择器不可用，不会弹出此窗。
6. 现有 `agent_set_approval` 单测仍通过。
