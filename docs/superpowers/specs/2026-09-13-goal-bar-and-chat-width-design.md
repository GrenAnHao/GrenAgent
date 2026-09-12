# 简化 Goal 条与会话内容加宽

- 日期：2026-09-13
- 状态：规格已写，待审查
- 主题：Goal 嵌进输入框顶行；补 `edit` 与 `/goal` 命令平面；会话正文加宽到接近 Codex。

## 1. 目标

现有 `GoalPill` 是输入框上方一条独立 pill，状态、轮次、问号挤在一起。改目标和 DSH/Codex 比，缺真正的 `edit`、缺对齐的 `/goal` 语法，完成态和未运行态也说不清楚。同一会话区宽度下，`CHAT_CONTENT_WIDTH` 的 61.8% / 上限 960 把正文压得比 Codex 窄。

改完之后：

1. 目标嵌在输入框同一张卡片的顶行，不再单独一条。
2. 行内：指示灯、状态句、条件、经过时间；右侧恢复/暂停、编辑、清除、放大（开现有详情抽屉）。
3. 完成态仍展示。无目标、加载中、已清除不渲染这一行。
4. AgentData 增加 `edit`，条上编辑和 `/goal edit` 都走它。
5. `/goal` 对齐 DSH 命令平面：裸查询、独占控制词、对话里命令气泡、不进模型轮次。
6. 消息列和输入框共用 `min(100%, 1120px, max(760px, 86%))`。

成功标准：有目标时输入框顶行能看出状态灯和状态句，点放大能开抽屉，点编辑能在这一行改条件且 revision 增加、status 不变。同一约 1100px 会话区里正文明显宽于现在的约 680px。`/goal pause after verify` 会创建该字面目标，不会暂停。

## 2. 布局与交互

### 2.1 附着

`GoalPill` 从 `MessageEditor` 的 `zone` 里、`surface` 外，挪进 `surface` 顶部，作为第一行。与 chips / 编辑器 / 操作栏共用边框和底色。顶行与编辑器之间用 1px `colorBorderSecondary` 分隔。

无目标、`sessionId` 未就绪、快照 `status === 'cleared'`：不渲染这一行，`surface` 外观与现在无目标时一致。

### 2.2 行内容

从左到右：

1. 8px 实心圆指示灯。
2. 状态句（13px / 500）。
3. 条件（13px，次要色，单行省略）。
4. `·` + 经过时间（四次要色）。
5. 操作：暂停或恢复、编辑、清除、放大。

状态句：

| status | 文案 |
| --- | --- |
| `active` | 执行中的目标 |
| `disarmed` | 未运行的目标 |
| `paused` | 已暂停的目标 |
| `judging` | 正在验收的目标 |
| `blocked` | 受阻的目标 |
| `error` | 已停止的目标 |
| `complete` | 已完成的目标 |

指示灯：

| status | 颜色 | 光晕 |
| --- | --- | --- |
| `active` | `#3dd68c` | 有（`0 0 0 3px`、18% 绿） |
| `complete` | `#3dd68c` | 无 |
| `disarmed` | `#8b919c` | 无 |
| `paused` | `#f5a524` | 无 |
| `judging` | `#4c8dff` | 有（20% 蓝） |
| `blocked` / `error` | `#f53f3f` | 无 |

经过时间：`now - Date.parse(updatedAt)`，小于 60s 写 `Ns`，小于 60min 写 `Nm`，否则 `Nh`。不足 1s 按 `1s`。

`blocked` 时整行 `title` 为 `blockage.summary`；其它状态不设 title。

不在条上显示 `roundsUsed/maxRounds`。轮次只在详情抽屉和裸 `/goal` 回执里。

### 2.3 按钮

| 状态 | 暂停/恢复 | 编辑 | 清除 | 放大 |
| --- | --- | --- | --- | --- |
| `active` | 暂停 | 有 | 有 | 有 |
| `disarmed` / `paused` / `blocked` / `error` | 恢复 | 有 | 有 | 有 |
| `judging` | 无 | 无 | 无 | 有 |
| `complete` | 无 | 无 | 有 | 有 |

`aria-label`：暂停目标、恢复目标、编辑目标、清除目标、展开目标详情。

连点用 ref 单飞，busy 时按钮 `disabled`。清除成功后用本地 `clearedGoalId` 立刻藏行，等投影；新 `goalId` 再出现。清除失败留在原行并报错。

编辑：整行换成输入框（预填当前条件）+ 保存 / 取消。Enter 保存，Esc 或取消丢掉草稿。空白禁用保存。失败留草稿，行内 `role="alert"` 显示 `message (code)`。`goalId` 变化时丢掉编辑态，避免写到新目标上。

放大打开现有 `SessionGoalDrawer`。抽屉里改条件也改走 `edit`，不再 pause/resume 两步。

动作失败不藏条。

### 2.4 内容宽度

`CHAT_CONTENT_WIDTH` 改为：

```ts
export const CHAT_CONTENT_WIDTH = 'min(100%, 1120px, max(760px, 86%))';
```

`ChatView` 输入列、`VirtualizedMessageList`、`ChatListSkeleton` 继续引用同一常量。不改消息条目的 `paddingInline`。

## 3. 组件与数据流

```text
/goal 或 GoalBar
  → agentDataApi.goals.update / create
  → goalStore.setSnapshot
  → GoalBar 重绘

edit：status 不变，revision + 1
pause / resume / clear：现有 transition
GoalCoordinator：不因 edit 事件 dispatch 或 judge
```

`GoalCasUpdate.action` 增加 `'edit'`。`payload.condition` 为非空、最长 4000 的字符串。`transition`：任意未 `cleared` / 未 `judging` 的状态可 `edit`（`active` / `paused` / `disarmed` / `blocked` / `error` / `complete`）。`judging` 拒绝 `edit`。`complete` 允许 `edit`（只改文案，不重新激活）。`kind` 审计为 `edit`。

扩展 `/goal` 解析：

| 输入（trim 后） | 结果 |
| --- | --- |
| 空 | 回执当前快照；无目标则提示没有目标 |
| 整段 `pause` / `resume` / `clear` / `reset` | 对应动作 |
| 整段 `edit` | 错误：缺少新条件 |
| `edit` + 空白 + 条件 | `edit` |
| 其它非空 | `create` |

回执文本含状态句、条件、`roundsUsed/maxRounds`，不含 `goalId` / `revision`。`blocked` 附加阻塞摘要。

`goal` 加入 `EXECUTIVE_COMMANDS`。发送 `/goal …` 不走乐观用户气泡、不 `awaitingResponse`。对话列表插入一条本地 `command-input` 行：`/goal` 作命令标签，其余为原文。成功/失败用现有 toast；不把命令正文交给模型。`skill:` 前缀规则不变。

前端仍按 `sessionId` 索引投影。只改 `electron-agent` 与 `extensions/goal`（命令解析）。不改 `tauri-agent`。

## 4. 边界

- 重启后仍是持久 `disarmed`，条上为「未运行的目标」+ 恢复。不新增 activation 事件通道。
- 裁判、lease、worker、`layoutStore`、窗口最小化/最大化/关闭不改。
- `/goal` 不带附件。
- 不加目标快捷键。
- `FullscreenLoading`、空状态 π、标题栏折叠不改。

## 5. 测试

仅 electron（及 `extensions/goal` 命令解析）。

条：

- 有 `active` 快照：顶行在 `surface` 内，文案「执行中的目标」，绿灯带光晕，有暂停/编辑/清除/放大。
- `disarmed`：「未运行的目标」，灰灯，恢复而不是暂停。
- `complete`：仍渲染，「已完成的目标」，绿灯无光晕，无暂停/编辑，有清除/放大。
- 无快照 / `cleared`：`surface` 内无 `goal-pill`。
- 编辑：输入框预填；Enter 调用 `edit`；Esc 不调用；空白禁用保存；失败出现 `alert` 且草稿还在。
- 清除：连点一次请求；成功后立刻找不到条。
- 放大：`onOpenDetails` 被调用。
- `blocked`：`title` 为阻塞摘要。

命令：

- 解析表第 3 节各行。
- `isExecutiveCommand('goal') === true`。
- 发送 `/goal 你好` 不插入普通 user 气泡，列表有 `command-input`。

宽度：`CHAT_CONTENT_WIDTH` 严格等于新表达式。

回归：`goalStore` 旧 CAS 用例仍过；`edit` 不改变 `status`；coordinator 收到 `edit` 事件不 `dispatchNext`。

## 6. 非目标

- 不把 tauri Goal 条升级到同一套。
- 不改独立裁判与自动续跑策略。
- 不在条上显示轮次。
- 不把 `/goal` 做成第二套详情页。

## 7. 规格自检

- 无待定。状态句、灯色、宽度表达式、`edit` 可转换状态、`/goal` 解析表均已写死。
- 完成态「留下」与 DSH「藏掉」的差异已写在 2.1 / 2.3。
- `edit` 不触发 coordinator 续跑，避免和条上编辑抢 revision。
- 范围可收进一份实现计划：条、CAS `edit`、命令平面、一个宽度常量。
