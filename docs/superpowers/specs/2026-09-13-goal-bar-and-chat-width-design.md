# 简化 Goal 条与会话内容加宽

- 日期：2026-09-13
- 状态：已按同日审查更正（补 `complete` 清除、`edit` 与既有改条件路径的取舍、4000 校验归属、`/goal` 裸命令语义变更标注、回执与 `command-input` 行的数据形态）
- 主题：Goal 嵌进输入框顶行；补 `edit` 与 `/goal` 命令平面；会话正文加宽到接近 Codex。

## 1. 目标

现有 `GoalPill` 是输入框上方一条独立 pill，状态、轮次、问号挤在一起。改目标和 DSH/Codex 比，缺真正的 `edit`、缺对齐的 `/goal` 语法，完成态和未运行态也说不清楚。同一会话区宽度下，`CHAT_CONTENT_WIDTH` 的 61.8% / 上限 960 把正文压得比 Codex 窄。

改完之后：

1. 目标嵌在输入框同一张卡片的顶行，不再单独一条。
2. 行内：指示灯、状态句、条件、经过时间；右侧恢复/暂停、编辑、清除、放大（开现有详情抽屉）。
3. 完成态仍展示。无目标、加载中、已清除不渲染这一行。
4. AgentData 增加 `edit`，条上编辑和 `/goal edit` 都走它；同时**废弃**既有两条改条件通道：`SessionGoalDrawer` 的 pause/resume 两步 hack（`SessionGoalDrawer.tsx:218-251`）与 `human-ui` + `action:'block'` + `payload.condition` 路径（`goalStore.updateBlockedCondition`，事件 kind `condition_update`）。
5. `/goal` 对齐 DSH 命令平面：裸查询、独占控制词、对话里命令气泡、不进模型轮次。**行为变更**：裸 `/goal` 从「清除目标」翻转为「查询回执」（现状见 `extensions/goal/index.ts:81`），`clear` / `reset` 保留原语义。
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
3. 条件（13px，次要色，单行省略，`title` 为完整条件以便 hover 看全文）。
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

经过时间是**执行时长**，不是 `updatedAt`。从 `create` 起累加 `ranMs`；`active` 且有 `runStartedAt` 时再加当前段。`pause` / `blocked` / `complete` 冻结，条上数字不回零。`resume` 从冻结值继续。`edit` / `round` 不动计时。显示：小于 60s 写 `Ns`，小于 60min 写 `Nm`，否则 `Nh`。不足 1s 按 `1s`。

`blocked` 时整行 `title` 为 `blockage.summary`（此时条件自身的 `title` 被整行 title 覆盖，条件全文可从抽屉查看）；其它状态只有条件 span 设 `title`。

不在条上显示 `roundsUsed/maxRounds`。轮次只在详情抽屉和裸 `/goal` 回执里。

### 2.3 按钮

| 状态 | 暂停/恢复 | 编辑 | 清除 | 放大 |
| --- | --- | --- | --- | --- |
| `active` | 暂停 | 有 | 有 | 有 |
| `disarmed` / `paused` / `blocked` / `error` | 恢复 | 有 | 有 | 有 |
| `judging` | 无 | 无 | 无 | 有 |
| `complete` | 无 | 无 | 有 | 有 |

`aria-label`：暂停目标、恢复目标、编辑目标、清除目标、展开目标详情。

连点用 ref 单飞，busy 时按钮 `disabled`。清除沿用现有 `window.confirm('清除当前目标？')` 二次确认（`cleared` 不可逆）；确认后单飞，成功后用本地 `clearedGoalId` 立刻藏行，等投影；新 `goalId` 再出现。清除失败留在原行并报错。

编辑：整行换成输入框（预填当前条件）+ 保存 / 取消。Enter 保存，Esc 或取消丢掉草稿。空白禁用保存。失败留草稿，行内 `role="alert"` 显示 `message (code)`。`goalId` 变化时丢掉编辑态，避免写到新目标上。

放大打开现有 `SessionGoalDrawer`。抽屉里改条件也改走 `edit`：删除 `status === 'blocked'` 的 `block`+condition 分支与 pause/resume 两步 hack（`SessionGoalDrawer.tsx:199-255`），全部收敛为单次 `edit` 调用。

动作失败不藏条。

### 2.4 内容宽度

`CHAT_CONTENT_WIDTH` 改为：

```ts
export const CHAT_CONTENT_WIDTH = 'min(100%, 1120px, max(760px, 86%))';
```

`ChatView` 输入列、`VirtualizedMessageList`、`ChatListSkeleton` 继续引用同一常量。不改消息条目的 `paddingInline`。同步改写 `chatStyles.ts:7-11` 的理据注释（61.8% / 960px 的旧依据不再成立，改为记录 1120px / 86% / 760px 下限的新依据）。

窄容器取舍（已确认接受）：新表达式在容器 ≤883px 时 86% 分支失效、由 760px 下限接管；容器 ≤760px 退回 100% 铺满。即子代理面板等窄场景下正文列不再保留左右留白（旧行为在 700px 容器仍留约 40px 单侧边距）。`ChatView` 输入列与消息列恒用同一表达式，边缘对齐关系不变。

## 3. 组件与数据流

```text
/goal 或 GoalBar
  → agentDataApi.goals.update / create
  → goalStore.setSnapshot
  → GoalBar 重绘

edit：status 不变，revision + 1
pause / resume / clear：现有 transition；clear 的前置状态扩为 active / paused / blocked / disarmed / error / complete（complete 可清除，配合条上清除按钮）
GoalCoordinator：不因 edit 事件 dispatch 或 judge（依据：`goalCoordinator.ts:105` 的 dispatch 白名单为 `status==='active' && kind ∈ {create, resume}`，`edit` 不在其中，无需改 coordinator）
```

`GoalCasUpdate.action` 增加 `'edit'`。`payload.condition` 为非空、最长 4000 的字符串。`transition`：任意未 `cleared` / 未 `judging` 的状态可 `edit`（`active` / `paused` / `disarmed` / `blocked` / `error` / `complete`）。`judging` 拒绝 `edit`。`complete` 允许 `edit`（只改文案，不重新激活）。`kind` 审计为 `edit`（`goalStore.update` 以 `input.action` 作事件 kind，自动成立）。

权限与既有路径的取舍：

- `edit` 加入 `goalStore.update` 的 human 权限判断（`goalStore.ts:98` 的 `HUMAN_AUTH_REQUIRED` 白名单，与 `pause` / `resume` / `clear` 同列）：目标条件只能由人改。
- **扩展 RPC 通道放行 human 动作**（已定案，方向 A）：`/goal` 经 `client.request("goal.update")` 落在 AgentDataRuntime 的 project 通道（`runtime.ts:699-718`），现状只放行 `begin_judging` / `block`（`runtime.ts:702`），origin 一律盖章 `human-agent`（`runtime.ts:705`）—— 因此现状 `/goal pause` / `resume` / `clear` 全部 FORBIDDEN，是死分支。本次：
  - project 通道 `goal.update` 动作白名单扩为 `begin_judging` / `block` / `edit` / `clear` / `pause` / `resume`；`disarm` / `judge_pass` / `judge_fail` 仍 FORBIDDEN。
  - origin 盖章按动作分派：human 动作（`edit` / `clear` / `pause` / `resume`）盖 `human-ui`，agent 动作（`block` / `begin_judging`）保持 `human-agent`。`create` 盖章不变（`human-agent`，审计语义）。
  - 防线论证：模型唯一写通道是 `tools.ts` 的工具 schema（仍只暴露 `block` / `begin_judging`）；`registerCommand` handler 只能由用户输入触发（pi 层路由，模型无法调用）；残余风险是其它用户安装的扩展代码可发这些动作 —— 扩展本身视为用户可信代码，接受。同步改写 `runtime.goal.test.ts:20` 的 FORBIDDEN 断言。
  - 连带收益：现状死分支（`/goal pause` / `resume` / `clear`）由此真正可用。
- 废弃 `updateBlockedCondition`（`goalStore.ts:114-125`）与事件 kind `condition_update`：blocked 态改条件统一走 `edit`。`action:'block'` 回归纯进度记录语义（payload 只剩 `reason` / `fingerprint`）。
- 条件长度校验收归服务端：`create` 与 `edit` 在 trim 后统一校验 1..4000 字符，超限抛 `INVALID_GOAL`（`extensions/goal` 前端预检保留现状 `INVALID_PARAMS`，`edit` 分支补同样的预检）。
- `extensions/goal/contracts.ts` 的 `kind`（:33）与 `action`（:62）联合类型同步追加 `'edit'`，与 `electron/agentData/goalContracts.ts:30` 保持一致，否则扩展端类型报错。

扩展 `/goal` 解析：

| 输入（trim 后） | 结果 |
| --- | --- |
| 空 | 回执当前快照；无目标则提示没有目标。**语义变更**：现状（`extensions/goal/index.ts:81`）裸 `/goal` 会清除目标，本表翻转为查询；同步更新命令 description（`index.ts:76`） |
| 整段 `pause` / `resume` / `clear` / `reset` | 对应动作 |
| 整段 `edit`，或 `edit` + 条件但当前无目标 | 错误：前者缺少新条件，后者提示「当前没有生效的目标」 |
| `edit` + 空白 + 条件 | `edit` |
| 其它非空 | `create` |

回执文本含状态句、条件、`roundsUsed/maxRounds`，不含 `goalId` / `revision`。`blocked` 附加阻塞摘要。回执载体写死：由 extension 的 `ctx.ui.notify` 承载（成功 `info`、失败 `error`）；`ChatView` 既有执行性命令泛化 toast「已执行 /goal」（`ChatView.tsx:140`）保持不变，两处提示并存为既有行为，本次不合并。

`goal` 加入 `EXECUTIVE_COMMANDS`。发送 `/goal …` 不走乐观用户气泡、不 `awaitingResponse`。对话列表插入一条本地 `command-input` 行：`/goal` 作命令标签，其余为原文。数据形态写死：`DisplayMessage` 新增变体 `{ kind: 'command-input'; id: string; command: string; rest: string }`，仅存于按 `sessionId` 索引的本地内存，不写会话 JSONL、不参与 `groupMessages` 分组，切换会话或重载后消失；`VirtualizedMessageList` 按普通行渲染（命令标签 + 原文）。不把命令正文交给模型。`skill:` 前缀规则不变；同步更新 `commandClassification.ts:4-5` 的白名单注释（「goal 不放」的旧说明已失效）。

前端仍按 `sessionId` 索引投影。范围内文件清单见第 4 节。

## 4. 边界

- 重启后仍是持久 `disarmed`，条上为「未运行的目标」+ 恢复。不新增 activation 事件通道。
- 裁判、lease、worker、`layoutStore`、窗口最小化/最大化/关闭不改。
- `/goal` 不带附件。
- 不加目标快捷键。
- `FullscreenLoading`、空状态 π、标题栏折叠不改。
- 范围内文件：`electron-agent`（`GoalPill`、`MessageEditor`、`SessionGoalDrawer`、`goalContracts.ts`、`goalStore.ts`、`runtime.ts`、`runtime.goal.test.ts`、`commandClassification.ts`、`ChatView`、`groupMessages`、`VirtualizedMessageList`、`chatStyles.ts`）与 `extensions/goal`（`index.ts` 命令解析、`contracts.ts` 类型同步）。不改 `tauri-agent` 与模型工具 schema（`tools.ts` 仍只暴露 `block` / `begin_judging`）。

## 5. 测试

仅 electron（及 `extensions/goal` 命令解析）。

条：

- 有 `active` 快照：顶行在 `surface` 内，文案「执行中的目标」，绿灯带光晕，有暂停/编辑/清除/放大。
- `disarmed`：「未运行的目标」，灰灯，恢复而不是暂停。
- `complete`：仍渲染，「已完成的目标」，绿灯无光晕，无暂停/编辑，有清除/放大；清除调用成功（依赖 `clear` 扩展 `complete` 的 transition）。
- 无快照 / `cleared`：`surface` 内无 `goal-pill`。
- 编辑：输入框预填；Enter 调用 `edit`；Esc 不调用；空白禁用保存；失败出现 `alert` 且草稿还在。
- 清除：连点一次请求；成功后立刻找不到条。
- 放大：`onOpenDetails` 被调用。
- `blocked`：`title` 为阻塞摘要。

命令：

- 解析表第 3 节各行，含：裸 `/goal` 为查询回执而非清除；`/goal edit`（无参数）与 `/goal edit …`（无目标）两条错误分支；`/goal` + 4001 字符条件的前端预检拒绝。
- `isExecutiveCommand('goal') === true`。
- 发送 `/goal 你好` 不插入普通 user 气泡，列表有 `command-input`；该行不写入会话 JSONL，切换会话后不出现。
- **runtime 集成**（真实 `AgentDataRuntime` + project endpoint，替换 `runtime.goal.test.ts:20` 的 FORBIDDEN 断言）：project 通道 `goal.update` + `pause` / `resume` / `clear` / `edit` 成功且落库快照正确；`disarm` 与 `judge_pass` 仍 FORBIDDEN；project 通道产生的 human 动作事件 origin 为 `human-ui`。

宽度：`CHAT_CONTENT_WIDTH` 严格等于新表达式。

回归：`goalStore` 旧 CAS 用例仍过；`edit` 不改变 `status`；coordinator 收到 `edit` 事件不 `dispatchNext`；`action:'block'` + `payload.condition`（原 `updateBlockedCondition` 路径）被拒绝或不再被任何前端调用方使用；`SessionGoalDrawer` 在 `blocked` 态保存条件走单次 `edit`。

## 6. 非目标

- 不把 tauri Goal 条升级到同一套。
- 不改独立裁判与自动续跑策略。
- 不在条上显示轮次。
- 不把 `/goal` 做成第二套详情页。

## 7. 规格自检

- 无待定。状态句、灯色、宽度表达式（含窄容器取舍）、`edit` 可转换状态、`clear` 扩 `complete`、条件 1..4000 校验归属、`/goal` 解析表（含裸命令语义翻转）、回执载体、`command-input` 行数据形态、扩展 RPC 通道放行范围与 origin 盖章规则均已写死。
- 完成态「留下」与 DSH「藏掉」的差异已写在 2.1 / 2.3。
- `edit` 不触发 coordinator 续跑（`goalCoordinator.ts:105` dispatch 白名单不含 `edit`），避免和条上编辑抢 revision。
- 改条件三条既有/新增通道收敛为一条 `edit`：废弃 `SessionGoalDrawer` 两步 hack 与 `updateBlockedCondition`（`condition_update` 事件随之废弃）。
- 裸 `/goal` 从清除翻转为查询属 breaking change，已在解析表标注并同步命令 description。
- 扩展 RPC 通道放行（方向 A，已定案）的信任取舍：模型防线收敛到 tools schema 单点；project 通道盖 `human-ui` 仅限 4 个 human 动作；`disarm` / `judge_pass` / `judge_fail` 与 admin 通道防线不变。
- 范围可收进一份实现计划：条、CAS `edit`（含废弃路径清理）、runtime 放行、命令平面、一个宽度常量。
