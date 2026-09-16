# 输入框增强提示词

- 日期：2026-09-17
- 范围：GrenAgent 主对话输入栏。把草稿改写成更清晰、更完整的提示词，写回输入框，不发送、不进会话历史。
- 状态：设计已按节批准，待实现计划

> **裁决记录（2026-09-17）**
>
> - **做什么：** 改写成更清晰、更完整的提示词（保留原意，补结构和约束），类似 Cursor Enhance Prompt。不是单纯润色，也不是扩成带验收清单的长任务书。
> - **位置：** 发送按钮左侧，始终可见（不进左侧工具栏折叠）。
> - **写回：** 输入框上方预览浮层，用户点「应用」才替换正文。预览内流式出字。
> - **模型：** 设置项 `enhancePromptModel` 可选；留空＝当前会话模型。设了但不可用则失败，不静默回退。
> - **改写范围：** 只改编辑器正文。粘贴块、图片附件不动。正文里的 `@路径` / `/命令` / URL 由模型原样保留。
> - **实现：** 独立 oneshot（`streamSimple`），不走 `agent_prompt`。

## 1. 目标 / 非目标

**目标**

1. 输入栏发送按钮左侧有「增强提示词」按钮（`Wand2` 图标，无 emoji）。
2. 点击后用一次性 LLM 调用改写当前正文，预览浮层流式展示；点「应用」只替换编辑器正文，不发送。
3. 调用不进入对话历史、不跑工具、不改会话模型。
4. 设置里可指定增强用的模型；留空则用当前会话模型。

**非目标**

- 不把改写丢进当前会话当一轮对话。
- 不改 `@` ChatTag pill 的还原（应用后允许变成普通 `@路径` 文本）。
- 不把粘贴块、图片送进 oneshot。
- 不为子代理面板单独做入口（子代理不复用 `ChatInput`）。
- 不和询问浮层叠两层 portal。
- 不做快捷键、不做多版本对比、不把增强模型做成按会话覆盖。
- 不测真实供应商网络、不测像素级样式。

**成功标准**

有正文时点按钮出现齐宽预览卡，文字边生成边出现；「应用」后输入框正文变成美化稿，芯片区附件仍在；「取消」或发送后原文不动且没有新的用户/助手消息。设置留空时走会话模型；填了不可用模型时预览卡报错。

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
| 同一 workspace | 同时只跑一次增强 |
| 切工作区 | 中止并关浮层 |
| `/` `@` 菜单 | z-index 高于预览卡，打开不关预览卡 |
| 超时 | 60 秒 |
| 超长 | 正文超过 16000 字则 toast，不开浮层 |
| 短调用队列 | 不进 `ShortCallQueue`（避免和标题 / wiki 排队） |
| ChatTag | 第一版不重建 pill |

## 3. 架构

```
ChatInput / SendArea
  EnhancePromptAction ──► enhancePromptStore ──► EnhancePromptOverlay
                                │                      ▲
                                │ Channel delta        │ 应用 setValue
                                ▼                      │
                         IPC enhance_prompt            │
                                │                      │
                     resolveModel → streamSimple ──────┘
                     enhance_prompt_abort → AbortSignal
```

- 前端只读 `readDraft()`（与发送同一套 markdown 序列化，含 `\_` → `_`）。
- 主进程 `electron-agent/electron/app/enhancePrompt.ts` 负责解析模型、系统提示、流式、清洗、中止。不写 session。
- 流式通道复用 `diagnose_provider_model` 的 `Channel` 模式：delta 为纯文本 chunk；invoke 结束返回 `{ ok, content, error?, cancelled? }`。

## 4. 组件与交互

### 4.1 按钮

新文件 `electron-agent/src/features/chat/input/actions/EnhancePromptAction.tsx`，登记进 `config.tsx` 的 `actionMap`。

`SendArea` 已按 `rightActions` 渲染在停止/发送之前，不必改布局结构。`ACTION_WIDTH.enhancePrompt = 28`。

禁用当且仅当：

- `empty === true`（只看编辑器正文，有粘贴块但正文空仍禁用）
- 当前 workspace 有待答询问浮层（`inlineQuestionStore` 或应进 overlay 的 `uiPromptStore`）
- 没有可用模型：`peekComposerModel(workspace)` 为空，且已 persist 的 `enhancePromptModel` 也空（不因设置了但暂时不可用而禁用，那种情况点开后由预览卡报错）

加载中：按钮保持可点外观但不重复开浮层；用 `aria-busy` / `title`「正在增强…」区分。

### 4.2 预览浮层

新文件 `electron-agent/src/features/chat/input/EnhancePromptOverlay.tsx`。

- 无条目时不 portal。
- 锚定 `surfaceRef`，`position: fixed`，齐宽，与 `ComposerPromptOverlay` 同一套量位置方式（`MENU_GAP` 等）。
- 卡片：标题「增强提示词」、状态（生成中 / 完成 / 失败）、预览正文、取消、应用。
- 生成中「应用」可用（预览非空）；失败或预览为空时「应用」禁用。
- 失败时预览区可保留原文快照作对照，错误一行写在按钮上方。
- 关闭入口：取消、关闭（X）、Esc、发送。不关：失焦、点外面、打开 `/` `@`。

`MessageEditor` 在现有 `ComposerPromptOverlay` 旁挂上本浮层。两层不同时出现：询问待答时按钮禁用，因此不会开增强浮层。

### 4.3 Store

`electron-agent/src/stores/enhancePromptStore.ts`，按 workspace 分槽：

| 字段 | 含义 |
| --- | --- |
| `status` | `idle` \| `streaming` \| `done` \| `error` |
| `preview` | 已收到的文本 |
| `error` | 失败文案 |
| `seq` | 单调递增，忽略过期 delta |

`start` 把 status 置 `streaming`、清空 preview/error 并 bump seq。`append(seq, chunk)` 仅当 seq 匹配。`finish(seq, content)` 用清洗后的全文替换 preview。`fail` / `cancel` 清槽或置 error。切 workspace 由组件 `useEffect` 调 abort + `clear`。

## 5. 数据流

### 5.1 发起

1. 按钮读取 `readDraft().trim()`。空 → 禁用，走不到这里。
2. 长度 `> 16000` → `message.warning('正文过长，请缩短后再增强')`，return。
3. `store.start(workspace)`，打开浮层。
4. `pi.enhancePrompt(workspace, text, onChunk)`。`onChunk` 为 `Channel<string>`，`onmessage` 里 `append`。
5. invoke 返回后：`cancelled` → `clear`（浮层已关则忽略）；`ok` → `finish`（以服务端清洗后的 `content` 为准，避免流式中的围栏残留）；否则 `fail`。

前端再点发送：现有 `send()` 在 `cancelPendingOverlay` 之后、真正 `onSend` 之前，增加 `abortEnhancePrompt(workspace)` 并 `clear` store。失败中止不阻断发送（与询问浮层 `failed` 不同：增强不是必须先成功取消的协议回传）。

### 5.2 主进程模型解析

顺序：

1. 读设置 `enhancePromptModel`，`trim`。
2. 非空：按第一个 `/` 切成 `provider` / `id`（非法串当「设了但不可用」）。`ModelRuntime.getModel(provider, id)` 有值则用；否则失败，错误：「增强提示词模型不可用，请在设置中重选或留空」。
3. 空：`agentHost.get(workspace)?.session.model`；有 `provider`+`id` 则用。
4. 仍没有：失败，「没有可用模型」。

不把「设了但不可用」回退成会话模型。草稿若 handle 已有 `session.model` 可以用；没有则失败（按钮侧也会因 `peekComposerModel` 为空而禁用，双保险）。

### 5.3 调用

- `modelRuntimeHost.streamSimple({ user: text, systemPrompt, model, signal })`。
- 每条 `text_delta` 向 Channel 发 `delta`。
- `error` 事件或抛错 → invoke 以失败返回。
- `done` → 拼接全文，走 §5.4 清洗，返回 `{ ok: true, content }`。
- workspace → `AbortController` 映射；新的 `enhance_prompt` 先中止同 workspace 上一次。`enhance_prompt_abort` 只 abort，不从 Channel 再推 delta。
- 超时 60 秒 abort，错误：「增强超时，请重试」。
- 不经 `ProviderService.oneshot` JSON 行、不经 `ShortCallQueue`。

### 5.4 系统提示与清洗

系统提示（固定字符串，测试可对这份原文断言）：

```
你是提示词改写器。把用户的草稿改写成更清晰、更完整的提示词：保留原意，补上结构、约束和成功标准。
只输出改写后的提示词正文，不要开场白、不要解释、不要用代码围栏包住整段。
原文中的 @路径、/命令、URL、文件名必须原样保留。
使用与原文相同的语言。
```

清洗 `sanitizeEnhanceOutput(raw)`：

1. `trim`。
2. 若整段匹配「可选语言标记的一对围栏包住全部内容」（首尾各一行 ` ``` `，中间任意），则取内层再 `trim`。中间的代码块不动。
3. 结果为空 → 失败，「模型返回为空」。

流式过程中不清洗。用户在 `streaming` 时点应用：写入当前 `preview` 原样。`done` 之后预览已是清洗稿，应用写清洗稿。

## 6. 设置

`electron-agent/src/features/settings/settingsSchema.ts` 的 `id: 'general'`，插在 `titleModel` 之后、`AUTO_TITLE` 之前：

| 属性 | 值 |
| --- | --- |
| `key` | `enhancePromptModel` |
| `label` | 增强提示词模型 |
| `type` | `model` |
| `placeholder` | 留空＝当前会话模型 |
| `description` | 输入框「增强提示词」使用的模型；留空＝当前会话模型 |
| `effect` | `instant` |

testid：`set-field-enhancePromptModel`（`SettingFieldInput` 现有规则）。

存盘与 `titleModel` 同形：`provider/id`，落 `runtime-settings.json`。删除供应商时 `scrubLinkedModelSettings` 已覆盖 `type: 'model'`，不必单写清理。

`settingsSchema.test.ts` 的 general 字段表要加上这一项。

## 7. IPC

`electron-agent/src/lib/pi.ts`：

- `enhancePrompt(workspace, text, onChunk: Channel<string>)` → `invoke('enhance_prompt', { workspace, text, onChunk })`
- `abortEnhancePrompt(workspace)` → `invoke('enhance_prompt_abort', { workspace })`

`register.ts` 注册这两条。Channel 发送方式与 `diagnose_provider_model` 相同。

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

## 9. 测试

**主进程（`enhancePrompt.test.ts`）**

- 模型解析：留空 → 会话模型；有设置且 `getModel` 命中 → 用设置；有设置但未命中 → 抛错，不回退。
- `sanitizeEnhanceOutput`：剥掉整段围栏；保留中间代码块；剥完为空失败。
- 超长拒绝（与前端同一阈值，主进程也挡一层）。
- abort：signal 触发后不再把后续 delta 当成功。
- 超时：假时钟 / 立即 abort 的 signal，返回超时错误。

**前端**

- `EnhancePromptAction`：空正文、询问待答时 `disabled`；有正文可点。
- Overlay：delta 追加；应用后 `setValue` 被调用且粘贴块 mock 仍在；取消后 `setValue` 不被调用。
- `ChatInput` send：发送前调用 abort 且不把预览稿当发送正文。
- `settingsSchema`：含 `enhancePromptModel`，`type: 'model'`。
- `scrubLinkedModelSettings`：删供应商会清 `enhancePromptModel`（可并入现有表驱动用例）。

不测真实 LLM、不测 ChatTag pill 还原、不做 e2e。

## 10. 文件清单

| 文件 | 动作 |
| --- | --- |
| `electron-agent/src/features/chat/input/config.tsx` | 登记动作与右侧默认列表 |
| `electron-agent/src/features/chat/input/actions/EnhancePromptAction.tsx` | 新增按钮 |
| `electron-agent/src/features/chat/input/EnhancePromptOverlay.tsx` | 新增预览浮层 |
| `electron-agent/src/features/chat/input/editor/MessageEditor.tsx` | 挂浮层 |
| `electron-agent/src/features/chat/ChatInput.tsx` | 发送前 abort 增强 |
| `electron-agent/src/stores/enhancePromptStore.ts` | 新增 |
| `electron-agent/src/lib/pi.ts` | IPC 封装 |
| `electron-agent/electron/app/enhancePrompt.ts` | 解析 / 流式 / 清洗 |
| `electron-agent/electron/ipc/register.ts` | 注册命令 |
| `electron-agent/src/features/settings/settingsSchema.ts` | 设置项 |
| 对应 `*.test.ts(x)` | 见 §9 |
