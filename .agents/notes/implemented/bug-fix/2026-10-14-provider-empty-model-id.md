# Agent Note: 供应商设置保存时拦下空模型 ID，一张空卡片不再让所有自定义供应商消失

Status: implemented

## Problem

2026-10-14 打包后启动，对话里的模型选择器只剩内置模型（Amazon Bedrock 的 Nova 等），草稿页的模型列表加载不出来，用户自己的三个自定义供应商全不见了。一开始以为是打包问题，实际和打包无关，dev 读的是同一份文件、同一版 pi，一样会坏。

- `~/.pi/agent/models.json` 里 `custom-muqywnc8` 的第 7 个模型是 `{"id":"","reasoning":true,"thinkingLevelMap":…,"compat":…}`，是当天 02:36 设置页保存写进去的：点「添加模型」会插入 `{ id: '' }` 的卡片，ID 没填就点了保存。
- 设置页保存只校验 Provider ID（`validateProviderIds`），不看模型 ID；`serializeState` 把每张卡片原样写进 `models.json`。
- pi 的 `ModelConfig.load` 按 schema 校验整份文件（模型 `id` 要求至少 1 个字符），不通过就整份丢掉，`ModelRuntime.getError()` 记下 `Invalid models.json schema: providers.custom-muqywnc8.models.6.id: must not have fewer than 1 characters`，模型列表退回只有内置模型。应用不展示这个错误，所以界面上只看到「模型不对」。
- 同类问题之前在价格上碰到过：`completeCost` 的注释写着缺任一价格字段时整份文件被拒、自定义供应商全部消失，当时的修法是落盘前补齐。

## Decision

- `ProvidersSettings.tsx` 的 `persist` 在 Provider ID 校验之后再查一遍：任何供应商有 ID 为空（trim 后）的模型，就不写盘，底栏报「供应商「X」有模型 ID 为空：填上 ID 或删掉这张卡片」，并切到那个供应商。`removeProvider` 走的也是 `persist`，同样被拦。
- 被拦下之后才标红：`ProvidersSettings` 记一个 `markEmptyModelIds`，经 `SortableModelCards` 的 `markEmptyIds` 传给 `ProviderModelCard` 的 `markEmptyId`，ID 为空的输入框 `status="error"`。刚点「添加模型」的空卡片不会一上来就红；下一次保存通过时清掉。
- 用户本机已经坏掉的 `models.json` 当场修了：先备份成 `~/.pi/agent/models.json.bak-20261014`，只删掉那一条空 ID 的模型，其余内容不变。

## Alternatives considered

- **`serializeState` 落盘时静默丢掉空 ID 的模型** — 最强论据：保存永远不会被挡，和 `completeTiers` 丢掉没填阈值的分段行是同一个做法，改一处就够。否决：填了一半的卡片（勾了推理、填了上下文窗口、只差 ID）保存后会悄悄消失，用户不知道哪里没填；而 Provider ID 为空时已经是拦下并报错，模型 ID 跟着一样更一致。用户选了拦下。
- **界面拦下 + 序列化再兜底丢弃** — 最强论据：双保险，以后别的入口（同步模型、迁移）写进空 ID 也不会坏文件。否决：`addSyncedModels` 已经过滤空 ID，迁移只改 Key 不动模型，目前没有第二个入口会产生空 ID；兜底只会把界面校验漏掉的情况藏起来。
- **输入框实时标红（和 Provider ID 一样）** — 最强论据：不用多一个状态，所见即所得。否决：每次点「添加模型」新卡片一出来就是红的，像是报错；只在保存被拦下后标红，提示的是「这张卡片挡住了保存」。

## Consequences

- **收益**：设置页再也写不出空 ID 的模型，一张空卡片不会再连累所有自定义供应商。已经坏掉的文件加载进设置页后，空卡片还在，保存会被拦下并标红，用户删掉或填上即可。
- **代价**：有空卡片时整次保存都被挡，包括删除另一个供应商（`removeProvider` 会先把列表从界面上去掉，但落盘被拦，底栏报错；删掉空卡片后再保存才真正写盘）。
- **没做的**：pi 的 `ModelRuntime.getError()` 仍然没有在界面上展示。手改 `models.json` 写坏了（其它字段不合 schema），界面照旧只表现为「只剩内置模型」，要靠这篇笔记里的办法查。
- 另一处观察：`~/.pi/agent/settings.json` 的默认模型是 `custom-mtrmhl52/claude-opus-5`，这个供应商已经不在 `models.json` 里了，选择器会落到第一个可用模型。这次没改。

## Verification

结果：通过。

- 先写测试再改：`cd electron-agent && npx vitest run src/features/settings/ProvidersSettings.test.tsx -t "empty ID"`，改之前失败（找不到「有模型 ID 为空」），日志 `.agents/evidence/2026-10-14-provider-empty-model-id/vitest-red-before-fix.txt`。新用例：两张卡片、第二张不填 ID，保存被拦、`setProviderConfig` 没被调用、只有空的那张标红；删掉空卡片后保存，落盘的模型只有 `kept-model`。
- 改之后 `npx vitest run src/features/settings/`：16 个文件 107 条全部通过，日志 `vitest-settings.txt`。
- `npm run ui:check -- provider-model-list`（改了 `SortableModelCards` 的 props，这个场景走真实的卡片列表、拖动排序和保存写盘）：21 条全部 PASS，日志 `ui-check-provider-model-list.txt`。只跑了这一个场景。
- 打包后的 exe 实测：修文件之前 `list_models_global` 返回 1563 个、全是内置；主进程里读到的 schema 错误、修文件之后返回 1572 个并带回 9 个自定义模型，记录在 `packaged-list-models-global.txt`。这一步验的是数据修复，界面拦下的改动没有在打包后的 exe 里点过。
