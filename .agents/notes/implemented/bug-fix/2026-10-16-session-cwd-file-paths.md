# Agent Note: 会话切换工作目录后，交付卡和改动卡找不到文件

Status: implemented

## Problem

项目会话里模型用 `working_directory` 切到项目工作区之外的目录（如 `E:\linghoumiaohui-kefu-extract`，项目根是 `D:\OneDrive\...\Engineering Decision Management`），在那里写文件、`present` 交付。对话末尾的交付卡点「打开」，右侧「文件」标签报「打不开这个文件：File does not exist」。

根因不是路径存成了相对路径本身，而是**同一个相对路径在两侧按不同的基准目录解析**：

- 工具侧：`write` / `edit` / `present` 的相对路径按会话**当前** cwd 解析（`extensions/_shared/session-cwd.ts` 的 `applyCwd` 原地改 `ExtensionRunner.cwd`；`extensions/present/present.ts` 用 `ctx.cwd` 校验存在性，却把用户给的原始 `path` 原样放进 `details.files`）。
- 界面侧：`TurnTimeline` 的 `workspace` 取项目根（会话头 cwd），`resolveWorkspaceFile(workspace, path)` 把相对路径拼在项目根下，得到 `D:/.../Engineering Decision Management/docs/x.md`；主进程 `safeWorkspacePath` 再 `realpath` 失败，报 `File does not exist`。绝对路径落在项目根之外时，`resolveWorkspaceFile` 直接返回 null，卡片置灰，主进程也会报 `Path escapes workspace`。

实测（会话 `2026-10-15T13-40-33-465Z_01a13fcb-...jsonl`）：`present` 的 `docs/lhr-ui-restore-4.2.2-验证.md` 在 `E:\linghoumiaohui-kefu-extract\docs\` 下存在，在项目根下不存在。把该会话的全部交付物与改动文件（123 项）送进旧解析，磁盘上找到 0 个；新解析找到 123 个。

触发条件：会话 cwd 被切走（`working_directory`、`create_worktree` 且目标在项目根之外），且之后的 `present` / `write` / `edit` 用了相对路径；或写入用绝对路径指向项目根之外。`working_directory` 不切则不触发。

## Decision

渲染层记住「工具调用当时的会话 cwd」，按它解析相对路径，并为项目根之外的文件选出能读到它的根目录。

- `chat/sessionCwd.ts` 的 `cwdAfterTool`：从成功的 `working_directory`（`details.cwd`）和 `create_worktree`（`details.path`）结果取新目录。
- `groupMessages` 按消息顺序跨回合跟踪这个目录，写进每个 `ToolSegment.cwd`（没切过则无该字段）。嵌套调用（`parentToolCallId`，子代理里的工具）有自己的会话目录，不更新主会话的值。失败的 `cd` 不更新。
- `turnDeliverables`：`ChangeFile` / `PresentedFile` 带 `cwd`，合并键是 `(cwd, path)`，同一个相对路径在不同目录下是不同文件；`reviewView` 取 hunks 时同样比较 `cwd`。
- `resolveSessionFile(workspace, cwd, path)` 返回 `{ absolute, root }`：相对路径按 `cwd`（无则项目根）解析；绝对路径原样用；含 `..` 或没有工作区返回 null（沿用原规则）。`root` 优先项目根，其次会话 cwd，都不包含时取文件所在目录。大小写不敏感、正反斜杠等价。
- `TurnTail`、`TurnReviewBody` 改用它；`openWorkspaceFile(absolute, root)` 把 `root` 作为「文件」标签的工作区。主进程沙箱根就是传入的 `workspace`，不用改，也没有放宽主进程的越界检查。
- `openLauncherTab` 查已有文件标签改为 `pathsEquivalent` 比较，`E:\x` 与 `E:/x` 复用同一个标签，不产生重复。
- `resolveWorkspaceFile` 保留不动（导出与测试仍用）。

`present` 本身也照 DSH 的 `tool-present`（`packages/deliverables/tool-present`，决策笔记 `2026-09-08-present-workspace-source-files`）改成：

- 相对路径按会话当前 cwd 解析，**绝对路径可以指向工作区之外**（包括含 `..` 的相对路径，只要文件存在）。不再有「必须在工作区内」的围栏。
- 只做一次 `stat`（存在、是普通文件），不读内容；失败提示里写明怎么恢复。
- 结果里记**解析后的绝对路径**，之后再切 cwd 也不会改指向。旧版记的是模型给的原始相对路径，历史会话仍靠上面的 cwd 跟踪还原。
- 工具说明和 `promptGuidelines` 同步改成「相对路径用会话工作目录，工作区外的文件传绝对路径」。

为什么不再设围栏：DSH 把访问控制交给文件系统 provider 和沙箱策略，不在 `present` 里另设工作区检查。我们这边的对应关系是：`safety` 只对 `write` / `edit` 做越界判断，`read` 本来就能读任意路径，`present` 只 `stat`、不读内容，放宽后风险与 `read` 相当；打开文件由用户点击触发。DSH 的另一条做法——打开动作只带声明坐标、由服务端按已存声明取路径，不接受浏览器给的路径——这里没有采用：我们的主进程文件命令本来就把渲染层当可信方（它传什么 workspace 就用什么），改这条是另一件事。

## Alternatives considered

- 只让 `present` 记绝对路径，渲染层不还原 cwd。最强理由：来源最权威，不依赖界面猜 cwd，也避开「cd 失败 / 冷恢复时目录回退」的偏差，DSH 就是这么做的。不用：只覆盖新产生的 `present`，`write` / `edit` 的相对路径仍旧错，更修不了已存在的历史会话；用户这次的会话就是历史数据。所以两者叠加：新结果记绝对路径（权威），旧结果和 `write` / `edit` 靠渲染层的 cwd 跟踪。
- 保留 `present` 的「必须在会话 cwd 之内」。最强理由：交付卡只该指向工作区里的东西，能挡住模型把任意本机文件挂成卡片。不用：它挡不住 `read`（本来就能读任意路径），却逼模型先 `working_directory` 切走再交付，用户这次的会话就是这么绕的；DSH 也不设这道围栏。
- 把 `workspace` 换成会话当前 cwd。最强理由：改动最小，所有 `workspace` 消费者自动一致。不用：项目根才是权限、记忆、审批、文件树的身份根，渲染层大量逻辑依赖它；cwd 会随回合变化，一个会话里前后不同。
- 放宽主进程 `safeWorkspacePath`，允许读任意绝对路径。最强理由：不用选 root。不用：这是唯一的越界防线，渲染层传入的 root 已经是受控的（项目根、会话 cwd、文件所在目录），没必要拆掉它。
- 给工具消息在 reducer 里直接盖 `cwd`。最强理由：不用每次 `groupMessages` 重算。不用：历史重载走 `messagesFromAgent`，实时走 `applyEvent`，要两处都维护初始值；`groupMessages` 一次顺序扫描更简单，也天然覆盖历史。

## Consequences

- 收益：切换过目录的会话里，交付卡、已编辑文件行、审查标签的「打开 / 在资源管理器中显示」都能找到文件；历史会话无需迁移即可修好。项目根之外的文件现在能在右侧标签里打开（以该目录为根，另开一个「文件」标签）。
- 代价：多出一个以 `root` 为工作区的「文件」标签；两个标签标题都是「文件」，靠文件树区分。`groupMessages` 每次多一个 O(n) 状态量，可忽略。
- 残留：`ToolSegment.cwd` 来自工具结果而非会话真值。会话冷恢复时若记录的目录已不存在，运行时会静默退回原始目录（`attachSessionCwd` 写一条 `unavailable` 记录），界面无从知道，之后的相对路径会被当成还在旧目录。
- 变化：`present` 现在接受工作区外的绝对路径，模型可以直接交付写到别处的文件；它能把任意存在的本机文件挂成交付卡，用户点了才会打开。
- 其它模块核对：`image-gen`、`tts` 的输出目录用 `projectCwd(ctx)`（项目根），`ImageThumb` / `AudioPlayer` 用项目根读，二者一致，不受影响；`@` 引用（`contextPayload`）、文件树都以项目根或标签工作区为准，没有相对路径拼接问题；子代理里的工具路径界面未处理（它们的 cwd 不在主会话 store 里）。

## 验证

verify: n/a 真实启动应用走用户路径：仓库当前没有 `verify-*` skill；用真实会话回放加测试代替。

- 真实会话回放（临时测试，已删除）：`messagesFromAgent → groupMessages → presentedForTurn / changesForTurn` 处理 `2026-10-15T13-40-33-465Z_01a13fcb-...jsonl`，对 123 个交付物与改动文件用 `existsSync` 检查：旧 `resolveWorkspaceFile(项目根, path)` 找到 0，新 `resolveSessionFile` 找到 123。通过。
- `cd electron-agent && npx vitest run src/features/chat src/features/dock src/features/tools src/features/fileExplorer src/stores`：191 个文件、1552 个用例全部通过。新增 `src/features/chat/sessionCwd.test.ts`（cwd 跟踪跨回合、嵌套与失败不更新、同名相对路径分开、解析规则与大小写、复现会话的调用序列），并补了 `TurnTail.test.tsx`、`openWorkspaceFile.test.ts` 的项目根之外用例。
- 改动文件的类型检查（临时 tsconfig）无报错。
- `present` 放宽后：`cd extensions && npx vitest run present prompt-metadata.test.ts` 通过（`present.test.ts` 重写：记绝对路径、接受工作区外绝对路径、接受存在的 `../` 路径、cwd 切换后仍指向原文件、缺失文件提示可恢复）；`cd electron-agent && npx vitest run src/features/chat src/features/dock` 142 个文件、1000 个用例通过（含新结果形状的渲染层用例）。`extensions` 全量运行有失败，但都在我没改的模块里：`multi-agent/runner.test.ts`（`SUBAGENT_MODEL` 用例，单独跑也失败）、`working-directory/worktree.test.ts` 和 `_shared/ripgrep.live.test.ts`（超时类，两次运行失败集合不同）。这几个测试不引用 `present`，对应文件在 git 里无改动，判断为既有或环境问题，未处理。
