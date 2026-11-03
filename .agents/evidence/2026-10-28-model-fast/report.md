# Claude / OpenAI Fast 接入交付说明

实现位置：供应商设置的每张模型卡片，以及输入栏“模型 + 推理档位”选择器。现有模型顺序、搜索、选中逻辑和推理档位含义保持原有行为。

## 界面与状态

模型卡片在“推理”“图片”旁新增 **快速** checkbox（英文为 Fast），使用同一个 Checkbox 组件和行样式。默认未勾选，与其他模型能力一起通过设置页原有“保存”操作落盘，重载时恢复。未接入的 API 协议显示禁用态并提供原因提示。

选中模型已声明 Fast 能力时，选择器弹层的推理档位右侧紧贴显示闪电按钮。关闭时为灰色描边闪电；开启时为主题强调色、实心闪电，并通过 `aria-pressed` 暴露状态。鼠标点击和键盘空格均能切换。读取或保存期间禁用，保存成功后更新状态；保存失败保持原值并显示错误，读取失败显示重试入口。不支持推理但支持 Fast 的模型仍可独立使用闪电按钮。开启后，外侧模型按钮追加“· 快速”（英文“· Fast”），与模型名、档位在同一行；关闭、切到未开启模型或撤销能力后同步移除。外侧状态直接订阅同一份偏好，重载后无需先打开弹层即可恢复，窄屏下完整保留状态文字。

按用户选择，**实际 Fast 开关按“供应商 ID + 模型 ID”分别记忆，所有会话共用该模型的偏好**。默认关闭；从 Claude A 切到 OpenAI B 时恢复 B 的状态，切回 A 恢复 A。两个供应商即使模型 ID 相同也互不影响。偏好保存到 `<agentDir>/fast-mode.json`，主进程串行合并、原子替换；不额外复制到 localStorage。

取消模型设置中的 Fast 并保存后，闪电控件和相关布局间距消失，档位恢复原宽度，后续请求不再携带本功能的加速参数。已记住的偏好保留，重新声明能力后恢复。模型条目上的闪电只表示“支持能力”，不会因为实际 Fast 关闭而消失。

## 模型能力数据

| 能力 | 来源与字段 | 显示条件 | 缺失时 |
| --- | --- | --- | --- |
| 图片输入 | Pi 模型的 `input` | 数组包含 `image` | 不显示 |
| 思考 | Pi 模型的 `reasoning` | 严格为 `true` | 不显示 |
| Fast | `models.json` 模型的 `compat.supportsFastMode`，经运行时投影为 `fast` | 严格为 `true` 且 API 已接入 | 不显示 |

CLI / 主进程全局模型枚举通过 `collectModels` 投影能力；会话模型列表与状态通过 `snapshotSessionModel` 投影能力。两路都保留图片、推理、Fast 字段。Fast 配置复用 Pi 开放的 `compat` 对象，不根据供应商名字、模型 ID 或名称猜测支持情况。

能力图标紧跟模型名称右侧，固定顺序为 **图片 → 大脑 → 闪电**，只显示明确支持的图标。短名称后保留 8px 间距，图标不贴行尾；长名称省略后完整保留图标，选中勾号独立靠行尾对齐。图标区不收缩，不挤压或遮挡图标。

## 图标与国际化

沿用 Lucide 的 `Image`、`Brain`、`Zap`，没有添加其他能力标识或图标依赖。悬停提示分别是“图片输入”“思考（reasoning）”“支持 Fast 接入”。

新增文案包括：Fast、三个能力提示、协议未接入说明、Fast 开启 / 关闭的操作提示（包含按模型记忆范围及可能增加费用）、读取失败、保存失败与重试。

当前仓库没有统一渲染层 i18n 引擎，本次新增文案集中在 `src/lib/modelMessages.ts` 的中英文词条中，按页面 `lang` 选择并响应语言变化，没有引入新依赖或迁移其他页面文案。正式页和 harness 页的默认语言属性改为与现有中文界面一致的 `zh-CN`。

## 请求接入

常驻 `fast-mode` 扩展在 `before_provider_request` 中读取该模型最新能力及磁盘偏好，同时满足时注入参数，不更改思考档位。

| 接口 | 开启时新增参数 |
| --- | --- |
| Claude / Anthropic Messages | `speed: "fast"`，合并 `fast-mode-2026-02-01` beta |
| OpenAI Chat Completions / Responses / Codex Responses / Azure Responses | `service_tier: "priority"` |

关闭、未声明能力、能力已被撤销或字段缺失时，不注入这些参数。两条路径共用能力判定和偏好规则。该开关作用于会话请求及工具循环；内部独立短调用（标题、记忆等）不继承输入栏偏好。

服务端是否接受 Fast 仍取决于账号、模型和接入端。服务端拒绝时走原有请求错误流程，不静默切换到标准模式；本次没有进行付费服务的真实加速或计费验证。本地费用估计仍受 Pi 既有计价实现限制。

## 边界与验证

新增 `model-fast` UI 场景使用真实 `ModelThinkingAction`、`ProviderModelCard`、配置 adapter 和 Fast 状态 store，主进程桥使用内存磁盘桩。生产构建后通过 Electron 的真实鼠标键盘事件操作。

- `model-fast`：63 条断言通过，新增外侧快速文案随开关 / 模型 / 能力 / 重载 / 语言同步检查，新增短名称图标间距、长名称 / 窄屏图标及勾号定位、中文“快速”名称检查。覆盖勾选前后、两种供应商各八种能力组合、三种图标的悬停提示、缺失元数据、按模型恢复、开关颜色、键盘、保存失败、重载恢复、读取失败重试、非推理模型、取消能力、中英文与浅色主题、280px 窄屏。
- `provider-model-list`：22 条断言通过。验证新增 checkbox 后原有拖动 / 键盘排序、保存、分段计费与窄布局仍可用。
- Electron 定向 Vitest：7 个文件、193 条测试通过，含配置 round-trip、原模型选择行为、IPC 快照、供应商服务及 Fast 集成。
- 本次外侧状态改动后，重跑 `ModelThinkingAction.test.tsx`，31 条通过。
- CLI 定向测试：12 条通过，覆盖模型能力投影及核心扩展加载规则。
- 变更渲染层与 Fast 后端实现的定向 TypeScript 检查通过。

Fast 集成测试使用真实 Pi 的模型 schema、ModelRuntime、扩展回调和 HTTP 请求序列化，实际捕获 Claude、OpenAI Responses、Chat Completions 与 Codex 请求体和请求头（Codex 的 zstd 请求体先解压）。传输边界返回受控的 400 响应以停止调用；这些测试证明参数构造与开关规则，不证明外部账号的 Fast 可用性或生成速度。

仅运行本次涉及的 `model-fast`、`provider-model-list` 场景，没有运行其余 UI 场景或全量测试。主进程全量 `tsc --noEmit -p tsconfig.node.json` 仍未通过，包含仓库其他模块的既有类型错误，不能据此宣称整个项目构建通过。完整检查日志随证据保留。

## 证据与复现

截图：`before.png`（未勾选）、`capabilities.png`（已勾选及能力图标）、`fast-on.png`（开启）、`light.png`（浅色）、`narrow.png`（窄屏）、`trigger-fast.png`（外侧快速状态）、`trigger-fast-detail.png`（外侧按钮局部放大）。

日志：`ui-model-fast.log`、`ui-provider-model-list.log`、`vitest.log`、`cli-tests.log`、`types-targeted.log`、`types-global.log`、`ui-affected-dry-run.log`、`verify-notes.log`。

命令：

```sh
cd electron-agent
npm run ui:check -- model-fast provider-model-list
npx vitest run src/features/settings/fastCapability.test.ts src/features/settings/providerConfigAdapter.test.ts src/features/chat/input/actions/ModelThinkingAction.test.tsx electron/agent/workspaceHandle.test.ts electron/app/piRuntimeService.test.ts electron/app/providerService.test.ts electron/app/fastMode.integration.test.ts
cd ../cli
node --import tsx --test src/probe-models.test.ts src/extension-profile.test.ts
cd ..
npm run verify-notes
```
