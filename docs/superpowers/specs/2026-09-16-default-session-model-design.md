# 新会话默认模型

- 日期：2026-09-16
- 状态：设计已按节批准，待实现计划
- 主题：在「通用与模型」增加新会话默认模型；仅空白草稿使用，已有会话不变。

> **裁决记录（2026-09-16）**
>
> - **何时：** 只在进入空白草稿时用（输入栏「新会话」、侧栏新建、斜杠 `/new` / `/newSession`）。打开已有会话、切项目、冷启动不读这项。
> - **留空：** 沿用现在：上次选过的（`lastGlobalModelKey`），没有再用列表第一项。
> - **设了但不可用：** 回退列表第一项。
> - **存储：** GrenAgent `runtime-settings.json`，与 `titleModel` 同形 `provider/id`。不写官方 `settings.json` 的 `defaultProvider` / `defaultModel`。
> - **思考档 / 子代理 / 标题模型：** 本轮不改。

## 1. 目标

用户能在设置里指定「点新会话之后输入栏自动选中的模型」，而不影响已经打开的对话。

成功标准：

1. 「通用与模型」第一项为「新会话默认模型」，控件与「对话标题模型」相同（`type: 'model'`，`ModelSelectField`）。
2. 进入空白草稿后，输入栏显示该模型；此时没有会话文件，**不**调用 `pi.setModel`。
3. 首条消息落盘（`newSession` 之后、`prompt` 之前）把输入栏当前模型写进新会话。
4. 留空时行为与现在一致（上次选过的 → 列表第一项）。
5. 删除供应商后，这项若仍指向该供应商则被 `scrubLinkedModelSettings` 清掉（schema 的 `type: 'model'` 已覆盖，不必单写清理逻辑）。

### 非目标

- 不改官方 SDK `SettingsManager.getDefaultProvider` / `getDefaultModel`（标题生成、短调用仍走那条）。
- 不改思考档默认、子代理模型、对话标题模型。
- 不把默认模型应用到已有会话、fork、切会话、冷启动打开上次会话。
- 不在设置页未保存时让草稿读到脏值：与其它通用字段一样，以 `persist()` 后的 `getSettings()` 为准。

## 2. 设置项

`electron-agent/src/features/settings/settingsSchema.ts` 的 `id: 'general'` 字段表**最前**插入：

| 属性 | 值 |
| --- | --- |
| `key` | `defaultSessionModel` |
| `label` | 新会话默认模型 |
| `type` | `model` |
| `placeholder` | 如 anthropic/claude-sonnet |
| `description` | 进入空白草稿时使用；留空＝上次选过的，没有再用列表第一项 |
| `effect` | `instant` |

其后顺序保持：`titleModel`、`AUTO_TITLE`、`COMPACTION_PREVIEW`、`goal.autoContinueOnOpen`。

testid 沿用 `SettingFieldInput`：`set-field-defaultSessionModel`。

存盘值与现有 `type: 'model'` 一致：`"provider/id"`（按第一个 `/` 切开）。输入栏内部键仍是 `modelKey`（NUL 分隔）。草稿回退时用 `sessionModel.ts` 新增的转换，不要把斜杠串直接塞进 `pickFallbackModelKey`。

```ts
export function settingsModelToKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const idx = trimmed.indexOf('/');
  if (idx <= 0 || idx === trimmed.length - 1) return '';
  return modelKey(trimmed.slice(0, idx), trimmed.slice(idx + 1));
}
```

非法串（无 `/`、空段）当留空。

## 3. 草稿回退

现况：`ModelThinkingAction` 在 `getState().model` 为空时 `pickFallbackModelKey(models, lastGlobalModelKey)`，并可能 `setModel`。点新会话后同 workspace 的 cache / 旧 handle 仍可能带回上一会话模型，输入栏不会换成设置默认。

### 3.1 判定草稿

与 `ChatView` 相同：`draftConversationCwd` 与当前 `workspace` 路径等价（`pathsEquivalent`）。所有 `enterPendingNewSession` 入口都置上该草稿，因此输入栏新会话、侧栏新建、斜杠 `/new` 走同一条规则。

### 3.2 草稿时的模型

当处于草稿：

1. **不要**用 `getState().model` 填充输入栏（那是上一会话或 SDK 新建会话的模型）。
2. 从设置算出 `fromSettings = settingsModelToKey(settings.defaultSessionModel)`。
3. 选 `preferred`：`fromSettings` 在可用列表里 → 用它；`fromSettings` 非空但不在列表（设了但不可用）→ `''`（`pickFallbackModelKey` 会落到列表第一项，**不要**再并上 `lastGlobalModelKey`）；设置为空 → `lastGlobalModelKey`。
4. `key = pickFallbackModelKey(models, preferred)`，`applySelection(key, ...)` 且 **`bind = false`**（不 `setModel`）。

`pickFallbackModelKey` 现有语义已满足：preferred 在列表里就用它，否则列表第一项，列表空则 `''`。不必改函数签名。

读设置：进入草稿时 `pi.getSettings()` 一次即可。供应商删除走 `hydrateSettingsValues` 之后，下一次进草稿会读到空值。不要订阅整个设置表单的未保存 dirty 态。

### 3.3 离开草稿（首发落盘）

`ChatView.ensureSessionForSend` 在 `pi.newSession` 之后、`pi.prompt` 之前，必须把输入栏当前模型写进新会话。否则 SDK 新会话可能带着官方 default / 列表第一项，和输入栏显示不一致。

实现：从 `ModelThinkingAction` 导出只读 `peekComposerModel(workspace): { provider: string; id: string } | null`（读现有 `cacheByWorkspace`）。`ensureSessionForSend` 在 `clearDraftConversation` 之后：

```ts
const selected = peekComposerModel(workspace);
if (selected) await pi.setModel(workspace, selected.provider, selected.id);
```

无可用模型则跳过，保持现在的失败路径。

草稿阶段用户若在输入栏另选了模型，cache 已是新选择，首发写的是用户刚选的，不是设置默认。这是正确行为。

## 4. 错误与边界

- 可用模型列表尚未返回：草稿输入栏可暂空或保持 loading，列表到达后再跑 §3.2。与现在空会话等列表的路径一致。
- `defaultSessionModel` 指向已删除供应商：schema 清理后为空，下一次新会话走留空链。
- 设置页未保存：草稿仍读盘上旧值。
- 官方 `defaultProvider` / `defaultModel` 本轮不读不写。

## 5. 测试

| 文件 | 断言 |
| --- | --- |
| `settingsSchema.test.ts` | `general.fields` 顺序以 `defaultSessionModel` 开头，字段标签 / type / effect 如上 |
| `sessionModel.test.ts` | `settingsModelToKey('openai/g')` 等于 `modelKey('openai','g')`；`'openai'` / `''` / `'/'` 得到 `''` |
| `ModelThinkingAction.test.tsx` | mock `draftConversationCwd === workspace` 且 settings 为 `openai/g` 时，输入栏为 GPT，**不**调用 `setModel`；`getState.model` 即使是 anthropic 也不采用 |
| `ModelThinkingAction.test.tsx` | 设置空：退回 `lastGlobalModelKey`（若在列表）或第一项 |
| `ChatView.test.tsx` 或发送路径测试 | 草稿首发：`newSession` 之后、`prompt` 之前调用 `setModel` 为输入栏当前模型 |
| `scrubLinkedModelSettings.test.ts` | 删供应商 `gone` 时 `defaultSessionModel: 'gone/flash'` 被清成 `''`（靠 schema，不必特殊分支） |

主进程不新增 IPC。

## 6. 文档

不改 `docs/architecture.md`、不改 `docs/pi/`。设置项自描述。
