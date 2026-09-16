# 输入框增强提示词

- 日期：2026-09-17
- 范围：GrenAgent 主对话输入栏。把草稿改写成更清晰、更完整的提示词，写回输入框，不发送、不进会话历史。可选实验：结合会话目标、wiki/记忆与代码图。
- 状态：设计已按节批准，待实现计划

> **裁决记录（2026-09-17）**
>
> - **做什么：** 改写成更清晰、更完整的提示词（保留原意，补结构和约束），类似 Cursor Enhance Prompt。不是单纯润色，也不是扩成带验收清单的长任务书。
> - **位置：** 发送按钮左侧，始终可见（不进左侧工具栏折叠）。
> - **写回：** 输入框上方预览浮层，用户点「应用」才替换正文。预览内流式出字。
> - **模型：** 设置项 `enhancePromptModel` 可选；留空＝当前会话模型。设了但不可用则失败，不静默回退。
> - **改写范围：** 只改编辑器正文。粘贴块、图片附件不动。正文里的 `@路径` / `/命令` / URL 由模型原样保留。
> - **默认实现：** 走主进程短调用标准入口 `ModelRuntimeHost.streamSimple`，不走 `agent_prompt`，不跑工具。
> - **短调用标准：** 唯一入口是 `ModelRuntimeHost.completeSimple / streamSimple`（模型、system、user、`AbortSignal`）。不向渲染层暴露通用 `pi.oneshot`。mermaid / 诊断的 JSON 行适配器改为调 Host 并透传 signal。实验工具循环不是 short call。
> - **实验：** 设置 `enhancePromptUseProjectContext` 默认关。打开后主进程跑有限轮只读工具（wiki / 记忆 / 代码图），会话目标由渲染进程随 IPC 注入。不 spawn 子代理。

## 1. 目标 / 非目标

**目标**

1. 输入栏发送按钮左侧有「增强提示词」按钮（`Wand2` 图标，无 emoji）。
2. 点击后用一次性 LLM 调用改写当前正文，预览浮层流式展示；点「应用」只替换编辑器正文，不发送。
3. 调用不进入对话历史、不改会话模型。默认路径不跑工具。
4. 设置里可指定增强用的模型；留空则用当前会话模型。
5. 可选实验开关：打开后改写可查阅会话目标、项目 wiki/记忆和代码图，生成更贴项目的提示词。
6. 短调用收口到 `ModelRuntimeHost`：增强默认路径、mermaid 修复、供应商诊断共用同一套 `completeSimple` / `streamSimple`（含取消）。

**非目标**

- 不把改写丢进当前会话当一轮对话。
- 不改 `@` ChatTag pill 的还原（应用后允许变成普通 `@路径` 文本）。
- 不把粘贴块、图片送进 oneshot。
- 不为子代理面板单独做入口（子代理不复用 `ChatInput`）。
- 不和询问浮层叠两层 portal。
- 不做快捷键、不做多版本对比、不把增强模型做成按会话覆盖。
- 实验路径不 spawn 子代理、不 `session.prompt`、不写 wiki/记忆、不跑 `codegraph_impact` / callers / callees。
- 实验路径不把工具原文展示在预览卡里。
- 不向渲染层增加通用 `pi.oneshot` IPC（避免任意提示词通道）。
- 不删除 `extensions/_shared/oneshot.ts` 的 CLI `runOneshot()`；Electron 主进程不再调用它。
- 不修诊断里 usage 字段与 pi-ai `Usage` 对不齐（仍可恒 null）。
- 不测真实供应商网络、不测像素级样式、不测真实 wiki/代码图索引质量。

**成功标准**

有正文时点按钮出现齐宽预览卡，文字边生成边出现；「应用」后输入框正文变成美化稿，芯片区附件仍在；「取消」或发送后原文不动且没有新的用户/助手消息。设置留空时走会话模型；填了不可用模型时预览卡报错。实验开关默认关，关时行为与纯正文 oneshot 相同；打开且 wiki/代码图为空时仍能改写（工具空结果，不整次失败）。

## 2. 已确认的设计决定

| 维度 | 决定 |
| --- | --- |
| 按钮位置 | `DEFAULT_RIGHT_ACTIONS = ['enhancePrompt']`，画在停止/发送左侧 |
| 折叠 | 不进 `COLLAPSE_PRIORITY`；右侧动作永不折叠 |
| 图标 / 文案 | `Wand2`；`title` 与 `ACTION_LABELS` 均为「增强提示词」 |
| 预览 | 独立 portal，锚定 `composer-surface`，定位对齐 `ComposerPromptOverlay` |
| 流式 | 预览卡内流式；生成中允许「应用」当前已生成文本 |
| 应用 | `setValue(预览稿)`，只改正文 |
| 取消 | 中止调用，关浮层，正文不动，不弹错误 |
| 发送 | 先按取消丢掉预览，再发送输入框现有正文 |
| 空正文 / 询问浮层待答 / 无会话模型且未配置增强模型 | 按钮禁用 |
| 浮层已开再点按钮 | 忽略 |
| 点浮层外 | 不关（避免误触丢掉生成中的稿） |
| Esc | 等同取消 |
| 输入框在浮层打开时 | 仍可编辑；「应用」仍写入预览稿，会盖掉这段编辑 |
| 同一 workspace | 同时只跑一次增强：新的 `enhance_prompt` 先中止上一次（bump `seq`、清旧槽），不是忽略新请求 |
| 切工作区 | 中止并关浮层 |
| `/` `@` 菜单 | z-index 高于预览卡，打开不关预览卡 |
| 超时 | 默认路径 60 秒；实验路径 90 秒 |
| 超长 | 正文超过 16000 字则 toast，不开浮层 |
| 短调用队列 | 不进 `ShortCallQueue`（避免和标题 / wiki 排队） |
| ChatTag | 第一版不重建 pill |
| 实验开关 | `enhancePromptUseProjectContext`，默认关 |
| 短调用入口 | `ModelRuntimeHost.completeSimple` / `streamSimple`；Electron 不再调用 `runOneshotWithRuntime` |

## 3. 架构

```
ChatInput / SendArea
  EnhancePromptAction ──► enhancePromptStore ──► EnhancePromptOverlay
                                │                      ▲
                                │ Channel 文本 delta    │ 应用 setValue
                                ▼                      │
                         IPC enhance_prompt            │
                                │                      │
                     resolveModel                      │
                      ├─ 开关关：Host.streamSimple ────┘
                      └─ 开关开：只读工具循环 ─────────┘
                     enhance_prompt_abort → AbortSignal
```

- 前端只读 `readDraft()`（与发送同一套 markdown 序列化，含 `\_` → `_`）。`readDraft` 需新增进 `ChatInputContext`——目前它是 `ChatInput.tsx` 的局部闭包，动作按钮取不到。实验开时额外带上当前会话 Goal 快照文案。
- 主进程 `electron-agent/electron/app/enhancePrompt.ts` 负责解析模型、系统提示、默认流式 / 实验工具循环、清洗、中止。默认流式只调 `ModelRuntimeHost.streamSimple`（§12）。不写 session。设置经注入的 `settings: () => Promise<Record<string, string>>`（生产＝`SettingsService.getAll()`）读取；不用 `SettingsManager`（它只暴露 `getDefaultProvider` / `getDefaultModel`）。
- 流式通道复用 `diagnose_provider_model` 的 `Channel` 模式：delta 为纯文本 chunk（只含提示词正文，不含工具输出）；invoke 结束返回 `{ ok, content, error?, cancelled? }`。

## 4. 组件与交互

### 4.1 按钮

新文件 `electron-agent/src/features/chat/input/actions/EnhancePromptAction.tsx`，登记进 `config.tsx` 的 `actionMap`。

`SendArea` 已按 `rightActions` 渲染在停止/发送之前，不必改布局结构。`ACTION_WIDTH.enhancePrompt = 28`。

禁用当且仅当：

- `empty === true`（只看编辑器正文，有粘贴块但正文空仍禁用）
- 当前 workspace 有待答询问浮层（`inlineQuestionStore` 或应进 overlay 的 `uiPromptStore`）
- 没有可用模型：`peekComposerModel(workspace)` 为空，且已 persist 的 `enhancePromptModel` 也空（不因设置了但暂时不可用而禁用，那种情况点开后由预览卡报错）

`peekComposerModel` 读的是 `ModelThinkingAction` 的模块级缓存，只有该组件挂载过才有值；未挂载时按「无模型」禁用，属可接受的保守退化（不会误放行）。

加载中：按钮保持可点外观但不重复开浮层；用 `aria-busy` / `title`「正在增强…」区分。实验开关不改变禁用规则。

### 4.2 预览浮层

新文件 `electron-agent/src/features/chat/input/EnhancePromptOverlay.tsx`。

- 当前 workspace 槽 `status === 'idle'` 时不 portal。
- 锚定 `surfaceRef`，`position: fixed`，齐宽，与 `ComposerPromptOverlay` 同一套量位置方式（`MENU_GAP = 8`）。z-index 取 **1040**：低于 `/` `@` 菜单（1100）与询问浮层（1050），两者可盖在预览卡之上。
- 卡片：标题「增强提示词」、状态、预览正文、取消、应用。
- 默认路径状态：生成中 / 完成 / 失败。
- 实验路径在收到第一段文本 delta 之前状态为「正在结合项目上下文…」，之后改为「生成中」。工具原文不进预览正文。
- 生成中「应用」可用（预览非空）；失败或预览为空时「应用」禁用。
- 失败时预览区可保留原文快照作对照，错误一行写在按钮上方。
- 关闭入口：取消、关闭（X）、Esc、发送。不关：失焦、点外面、打开 `/` `@`。Esc 用 **capture 阶段**监听，避免焦点在编辑器内时被编辑器吞掉。

`MessageEditor` 在现有 `ComposerPromptOverlay` 旁挂上本浮层。两层不同时出现：询问待答时按钮禁用，因此不会开增强浮层。

### 4.3 Store

`electron-agent/src/stores/enhancePromptStore.ts`，按 workspace 分槽：

| 字段 | 含义 |
| --- | --- |
| `status` | `idle` \| `streaming` \| `done` \| `error` |
| `preview` | 已收到的文本 |
| `error` | 失败文案 |
| `seq` | 单调递增，忽略过期 delta |
| `awaitingContext` | 实验路径：尚未收到第一段文本 delta |
| `source` | 发起时的原文快照；失败时预览为空则用它作对照 |

`start` 把 status 置 `streaming`、清空 preview/error 并 bump seq；若实验开则 `awaitingContext = true`。`append(seq, chunk)` 仅当 seq 匹配，并把 `awaitingContext` 置 false。`finish(seq, content)` 用清洗后的全文替换 preview。`fail` / `cancel` 清槽或置 error。切 workspace 由组件 `useEffect` 调 abort + `clear`。

## 5. 数据流

### 5.1 发起

1. 按钮经 `useChatInput().readDraft()` 读正文并 `trim()`。空 → 禁用，走不到这里。
2. 长度 `> 16000` → `message.warning('正文过长，请缩短后再增强')`，return。
3. `store.start(workspace)`，打开浮层。
4. `pi.enhancePrompt(workspace, text, onChunk, goalText?)`，返回 `Promise<EnhancePromptResult>`。`goalText` 仅实验开时传递，由 `EnhancePromptAction` 自己组装：先 `pi.getState(workspace)` 取 sessionId（复用从 `GoalPill.tsx` 导出的 `readSessionId`，不另写一份），再读 `useGoalStore().bySession[sessionId]`；有 `GoalSnapshot` 则格式为 `状态: {status}\n条件: {condition}`，超过 2000 字截断；无 Goal 或取不到 sessionId 则传空串。主进程在开关关时忽略该字段。
5. `onChunk` 为 `Channel<string>`，`onmessage` 里 `append`。
6. invoke 返回后：`cancelled` → `clear`（浮层已关则忽略）；`ok` → `finish`（以服务端清洗后的 `content` 为准，避免流式中的围栏残留）；否则 `fail`。

前端再点发送：在现有 `send()` 的 `sendingRef` 判定之后、`cancelPendingOverlay` **之前**，先 `abortEnhancePrompt(workspace)` 并 `clear` store——必须早于 `editor.cleanDocument()`，否则中止竞态下预览稿可能被写回已清空的编辑器。失败中止不阻断发送（与询问浮层 `failed` 不同：增强不是必须先成功取消的协议回传）。

### 5.2 主进程模型解析

顺序：

1. 读设置 `enhancePromptModel`（来自 §3 注入的 `settings()`，生产＝`SettingsService.getAll()`），`trim`。
2. 非空：按第一个 `/` 切成 `provider` / `id`（非法串当「设了但不可用」）。`ModelRuntime.getModel(provider, id)` 有值则用；否则失败，错误：「增强提示词模型不可用，请在设置中重选或留空」。
3. 空：取 `agentHost.get(workspace)?.session.model` 的 `provider` / `id`，再走 `ModelRuntime.getModel(provider, id)`；命中才用。**不直接把 `session.model` 当 `model` 对象往下传**——它是 pi-sdk 的 `AgentSession['model']`，与 `ModelRuntime.getModel()` 返回的 `Model` 不同形（`workspaceHandle.ts` 的 `snapshotSessionModel` 只把它当 `unknown` 处理）。
4. 仍没有：失败，「没有可用模型」。

不把「设了但不可用」回退成会话模型。草稿若 handle 已有 `session.model` 可以用；没有则失败（按钮侧也会因 `peekComposerModel` 为空而禁用，双保险）。

### 5.3 默认调用（开关关）

- 只调 §12 的 `modelRuntimeHost.streamSimple({ user: text, systemPrompt, model, signal })`。`model` 来自 §5.2。
- 每条 Host 事件 `type === 'delta'` 且有 `text` 时向 Channel 发该字符串（Host 已把 runtime `text_delta` 映射为 `{ type: 'delta', text }`）。
- `error` 事件或抛错 → invoke 以失败返回。
- `done` → 拼接全文，走 §5.4 清洗，返回 `{ ok: true, content }`。
- workspace → `AbortController` 映射；新的 `enhance_prompt` 先中止同 workspace 上一次。`enhance_prompt_abort` 只 abort，不从 Channel 再推 delta。
- 超时 60 秒 abort，错误：「增强超时，请重试」。
- 不经 `ProviderService.oneshot`、不经 `runOneshotWithRuntime`、不经 `ShortCallQueue`。

### 5.4 系统提示与清洗

默认系统提示（固定字符串，测试可对这份原文断言）：

```
你是提示词改写器。把用户的草稿改写成更清晰、更完整的提示词：保留原意，补上结构、约束和成功标准。
只输出改写后的提示词正文，不要开场白、不要解释、不要用代码围栏包住整段。
原文中的 @路径、/命令、URL、文件名必须原样保留。
使用与原文相同的语言。
```

实验开时以 `\n\n` 拼接在其后（有 Goal 才插入 Goal 段）：

```
你可以调用只读工具查阅本项目的 wiki、记忆和代码图，以便改写后的提示词贴合该项目的关键约定与实现。
不要向用户复述工具原始输出。最终只输出改写后的提示词正文。
当前会话目标：
<goalText 或「无」>
```

清洗 `sanitizeEnhanceOutput(raw)`：

1. `trim`。
2. 若整段匹配「可选语言标记的一对围栏包住全部内容」（首尾各一行围栏，中间任意），则取内层再 `trim`。中间的代码块不动。
3. 结果为空 → 失败，「模型返回为空」。

流式过程中不清洗。用户在 `streaming` 时点应用：写入当前 `preview` 原样。`done` 之后预览已是清洗稿，应用写清洗稿。

## 6. 设置

`electron-agent/src/features/settings/settingsSchema.ts` 的 `id: 'general'`，插在 `titleModel` 之后、`AUTO_TITLE` 之前，连续两项：

| 属性 | 值 |
| --- | --- |
| `key` | `enhancePromptModel` |
| `label` | 增强提示词模型 |
| `type` | `model` |
| `placeholder` | 留空＝当前会话模型 |
| `description` | 输入框「增强提示词」使用的模型；留空＝当前会话模型 |
| `effect` | `instant` |

| 属性 | 值 |
| --- | --- |
| `key` | `enhancePromptUseProjectContext` |
| `label` | 增强提示词结合项目（实验） |
| `type` | `boolean` |
| `default` | `'0'`（`SettingField.default` 是 `string`） |
| `description` | 打开后允许查阅会话目标、wiki/记忆和代码图；更慢，且依赖索引。默认关 |

testid：`set-field-enhancePromptModel`、`set-field-enhancePromptUseProjectContext`。

`enhancePromptModel` 存盘与 `titleModel` 同形：`provider/id`，落 `runtime-settings.json`。删除供应商时 `scrubLinkedModelSettings` 已覆盖 `type: 'model'`，不必单写清理。布尔项不参与供应商清理。

`settingsSchema.test.ts` 的 general 字段表要加上这两项。

## 7. IPC

`electron-agent/src/lib/pi.ts`：

- `enhancePrompt(workspace, text, onChunk: Channel<string>, goalText?: string)` → `invoke<EnhancePromptResult>('enhance_prompt', { workspace, text, onChunk, goalText })`
- `abortEnhancePrompt(workspace)` → `invoke<void>('enhance_prompt_abort', { workspace })`

其中 `EnhancePromptResult = { ok: boolean; content: string; error?: string; cancelled?: boolean }`。

`goalText` 可选字符串；缺省或非字符串当空。`register.ts` 注册这两条。处理器**必须**按 `diagnose_provider_model` 的方式从 `args.onChunk` 构造 `emit`：校验 `__grenChannelId` 为字符串后，用 `event.sender.send(\`${IPC_CHANNELS.eventPrefix}channel:${id}\`, chunk)` 推 delta——漏掉这一步渲染层收不到任何流式文本。

## 8. 失败与边界

| 情况 | 表现 |
| --- | --- |
| 正文为空 | 按钮禁用 |
| 仅有粘贴块 / 图片、正文空 | 按钮禁用（改写范围不含芯片） |
| 询问浮层待答 | 按钮禁用 |
| 无模型 | 按钮禁用；若仍打到主进程则预览卡错误 |
| 超长 | toast，不开浮层 |
| 设置模型不可用 | 预览卡错误，原文不动，「应用」禁用 |
| 超时 / 网络 / 空回复 | 预览卡错误 |
| 用户取消、Esc、发送、切工作区 | 中止，关浮层，不弹错误 |
| 主对话正在流式生成 | 允许增强（不抢 `agent_prompt`） |
| 实验开但 wiki/记忆/代码图不可用或空 | 工具返回空，继续改写，不整次失败 |
| 实验开达到工具轮次上限 | 停止再调工具，用已有上下文出提示词 |

## 9. 测试

**主进程（`enhancePrompt.test.ts`）**

- 模型解析：留空 → 会话模型；有设置且 `getModel` 命中 → 用设置；有设置但未命中 → 抛错，不回退。
- `sanitizeEnhanceOutput`：剥掉整段围栏；保留中间代码块；剥完为空失败。
- 超长拒绝（与前端同一阈值，主进程也挡一层）。
- abort：signal 触发后不再把后续 delta 当成功。
- 超时：假时钟 / 立即 abort 的 signal，返回超时错误。
- 开关关：不注册、不调用任何工具；忽略 `goalText`。
- 开关开：只允许 `wiki.search` / `wiki.read` / `memory.search` / `codegraph_search` / `codegraph_explore`；调用 `wiki.replace` 或 `codegraph_impact` 被拒绝。
- 工具空结果：仍返回 ok 的改写（mock 模型在无工具结果时仍产出文本）。
- 上限：第 9 次工具调用被拒绝；超过 4 轮不再发工具。
- 单次工具结果超过 4000 字被截断。

**短调用收口（`modelRuntimeHost.test.ts` / `hostOneshotAdapter.test.ts`）**

- `completeSimple` / `streamSimple` 接受 `provider`+`modelId`，命中 `getModel`；缺省走 `resolveDefaultModel`。
- `signal` 透传到 runtime 第三参（已有用例保留；`streamSimple` 补一条）。
- `ProviderService.oneshot` 适配器：`signal` 透传到 Host（`ProviderServiceOptions.oneshot` 已扩出第三参）。
- 适配器流式行 `{ type: 'delta' | 'done' | 'error' }`，非流式 `{ ok, content }`；模型未命中 emit `model not found: provider/id`；`signal` 传到 Host。
- `enhancePrompt.ts` 与 `main.ts` 不 import `runOneshotWithRuntime`。

**前端**

- `EnhancePromptAction`：空正文、询问待答时 `disabled`；有正文可点。
- `EnhancePromptAction` 实验开：把 Goal 格式化为 `状态: …\n条件: …` 随 IPC 传入；取不到 sessionId 时传空串。
- Overlay：delta 追加；应用后 `setValue` 被调用且粘贴块 mock 仍在；取消后 `setValue` 不被调用。
- Overlay 实验：`awaitingContext` 时显示「正在结合项目上下文…」，首包 delta 后改为生成中。
- `ChatInput` send：发送前调用 abort 且不把预览稿当发送正文。
- `settingsSchema`：含 `enhancePromptModel`（`type: 'model'`）与 `enhancePromptUseProjectContext`（默认 `'0'`）。
- `scrubLinkedModelSettings`：删供应商会清 `enhancePromptModel`（可并入现有表驱动用例）。

不测真实 LLM、不测 ChatTag pill 还原、不测真实索引质量、不做 e2e。

## 10. 文件清单

| 文件 | 动作 |
| --- | --- |
| `electron-agent/src/features/chat/input/config.tsx` | 登记动作与右侧默认列表 |
| `electron-agent/src/features/chat/input/actions/EnhancePromptAction.tsx` | 新增按钮 |
| `electron-agent/src/features/chat/input/EnhancePromptOverlay.tsx` | 新增预览浮层 |
| `electron-agent/src/features/chat/input/editor/MessageEditor.tsx` | 挂浮层 |
| `electron-agent/src/features/chat/ChatInput.tsx` | 发送前 abort 增强；向 ctx 暴露 `readDraft` |
| `electron-agent/src/features/chat/input/ChatInputContext.tsx` | `ChatInputContextValue` 增加 `readDraft` |
| `electron-agent/src/features/chat/input/GoalPill.tsx` | 导出 `readSessionId`，供增强动作复用 |
| `electron-agent/src/stores/enhancePromptStore.ts` | 新增 |
| `electron-agent/src/lib/pi.ts` | IPC 封装 |
| `electron-agent/electron/app/enhancePrompt.ts` | 解析 / 默认流式 / 实验工具循环 / 清洗 |
| `electron-agent/electron/agent/modelRuntimeHost.ts` | 短调用标准入口：按 provider/id 解析模型 |
| `electron-agent/electron/agent/hostOneshotAdapter.ts` | mermaid / 诊断 JSON 行 → Host |
| `electron-agent/electron/main.ts` | `ProviderService.oneshot` 改为调适配器，不再 `runOneshotWithRuntime` |
| `electron-agent/electron/ipc/register.ts` | 注册命令 |
| `electron-agent/src/features/settings/settingsSchema.ts` | 两项设置 |
| 对应 `*.test.ts(x)` | 见 §9 |

## 11. 实验：结合项目上下文

仅当已 persist 的 `enhancePromptUseProjectContext` 为真（`'1'` / 布尔控件开）时走本节。关则 §5.3，行为不得依赖 Goal 或工具。

### 11.1 注入与工具

**始终注入（非工具）：** IPC `goalText`。无 Goal 或空串则系统提示写「无」。主进程不读 renderer 的 `goalStore`。

**只读工具（workspace 收口，host 本地执行）：**

| 工具 | 落到现有能力 | 参数 |
| --- | --- | --- |
| `wiki.search` | `agentData.request('wiki.search', …)` | `{ workspace, query, limit }` |
| `wiki.read` | `agentData.request('wiki.read', …)` | `{ workspace, page }` |
| `memory.search` | `agentData.request('memory.search', …)` | `{ userId, workspace, query, limit }` |
| `codegraph_search` | `agentData.request('codeRetrieval.call', …)` | `{ workspace, tool: 'codegraph_search', args }` |
| `codegraph_explore` | `agentData.request('codeRetrieval.call', …)` | `{ workspace, tool: 'codegraph_explore', args }` |

只用 workspace 收口的这一组：**不引 `wiki.pages.search` / `wiki.pages.read`**——它们按 `kbId` 收参、走 `requestAdmin` 管理面语义，与本工具的 workspace 收口不匹配，且没有「workspace → kbId」的现成解析路径。`memory.search` 的 `userId` 取当前用户 id，取不到回退 `'local'`（与 `memoryService.ts` 的既有回退一致）。

其它名字一律拒绝并回给模型一句错误，不执行。

### 11.2 循环与上限

在 `enhancePrompt.ts` 自建 tool loop：走 `ModelRuntime` 带 tools 的 complete/stream 回灌工具结果，不走 `Host.streamSimple`。不创建可见 `AgentSession`，不写主会话 JSONL，不进 `ShortCallQueue`。

| 上限 | 值 |
| --- | --- |
| 工具回合 | 4 |
| 合计工具调用 | 8 |
| 单次工具结果 | 4000 字，超出截断 |
| 超时 | 90 秒 |

达到回合或次数上限后不再发工具，要求模型立刻只输出改写后的提示词。「合计上限 8」与「第 9 次调用被拒绝」是同一条规则：第 8 次执行完即关闭工具通道，第 9 次请求直接拒绝。wiki/记忆/代码图抛错或未索引：该次工具返回空/错误字符串，循环继续。

### 11.3 流式

工具回合的 JSON / 结果不进 Channel。仅把最终助手正文的纯文本 chunk 发给预览（与 §5.3 相同的 Channel 字符串约定）。用户取消时 abort 掉整段循环。此循环不是 §12 短调用。

## 12. 短调用标准入口

SDK 模式下短调用的**唯一**主进程 API 是 `ModelRuntimeHost`。不进会话、不加载扩展、不跑工具。

### 12.1 签名

在现有 `completeSimple` / `streamSimple` 上增加按供应商解析（都空则仍 `resolveDefaultModel`）。两个方法当前用的是内联对象类型，需抽成下面这个共用接口：

```ts
interface ShortCallInput {
  user: string;
  systemPrompt?: string;
  model?: Model;
  provider?: string;
  modelId?: string;
  signal?: AbortSignal;
}
```

解析顺序：`model` 对象 → `provider`+`modelId` 且 `getModel` 命中 → 否则若提供了 provider/id 但未命中则抛「模型不可用」→ 都未指定则 `resolveDefaultModel()`。`signal` 必须传到 `ModelRuntime.completeSimple / streamSimple` 的第三参。

`streamSimple` 对外事件保持：`{ type: 'delta', text }` / `{ type: 'done', usage }` / `{ type: 'error', error, usage }`。

### 12.2 谁必须走这里

| 调用方 | 方式 |
| --- | --- |
| 增强提示词默认路径 | 直接 `streamSimple`（已解析的 `model` 对象 + `signal`） |
| `SystemWorkerManager` | 已走 `completeSimple` + `ShortCallQueue`，保持 |
| mermaid 修复 / 供应商诊断 | `ProviderService.oneshot` 适配器内部改调 Host；stdout JSON 行形状不变，**必须透传 `AbortSignal`** |
| 实验增强（§11） | 不是 short call |

Electron `main.ts` **禁止**再 `runOneshotWithRuntime`。`formatNonStream` 仍可给 `completeSimple` 抽文本。适配器抽成可单测函数（如 `hostOneshotAdapter.ts`）：`oneshot(request, onLine, signal?)` → Host；`request.system` 映到 `systemPrompt`。流式行 `{ type: 'delta' | 'done' | 'error' }`，非流式 `{ ok, content }` / `{ ok: false, error }`。模型未命中时适配器仍 emit `model not found: provider/id`，不改诊断现有文案。诊断 / mermaid 本期可不新增 abort IPC，但签名必须能传 `signal`——为此要把 `ProviderServiceOptions.oneshot` 从 `(request, onLine)` 扩成 `(request, onLine, signal?)`（`providerService.ts:20`），`main.ts` 的注入点同步透传。

### 12.3 明确不是 short call

- 实验 wiki / 记忆 / 代码图工具循环（§11）
- `agent_prompt` / 子代理 `session.prompt`
- 渲染层通用 oneshot IPC（不新增）

诊断 usage 与 pi-ai `Usage` 字段不对齐的问题本期不修。
