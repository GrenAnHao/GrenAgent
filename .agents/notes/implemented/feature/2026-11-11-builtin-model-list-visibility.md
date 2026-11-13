# Agent Note: 内置模型平铺卡片与手动候选隐藏

Status: implemented

## Problem

用户反馈 OpenAI 公共目录的模型太多，希望可以隐藏内置供应商模型；内置参数编辑也应与自定义模型一致，所有模型卡片直接排列，而不是先通过 Select 选择一张。用户已确认隐藏应影响所有手动模型选择入口，设置页始终可以管理和恢复；不删除参数或凭据、不强行切换已有会话。

历史审计：[内置模型参数定点编辑](../../implemented/feature/2026-11-11-builtin-model-parameter-editing.md) 部分重叠，本篇仅取代“一次只选择一个模型卡片”的界面决定，SDK 基线、固定 ID/协议、稀疏覆盖、非法草稿与凭据隔离继续适用；[Fast 能力](../../implemented/feature/2026-10-28-model-fast.md) 的能力与使用偏好分离继续适用。没有发现模型隐藏的已否决方案。

## Decision

内置目录直接纵向列出全部模型卡片，每张独立展开、编辑和恢复默认，保持同 ID 自定义替换只在原自定义列表编辑。每张卡片提供显示/隐藏操作，隐藏后仍保留管理条目。展开状态和输入态按模型身份隔离，不将隐藏当作删除或禁用。

卡片使用单行紧凑头部，不在每张卡上方重复独立操作栏和“跟随默认”。显隐以有 Tooltip / 可访问名称的眼睛图标放在行尾，恢复图标仅在参数或草稿有改动时出现；已修改模型才显示简短状态。只读内置 ID 使用无输入框底色的定宽标识，自定义模型的可编辑 ID 与现有控件行为不变。

隐藏是桌面界面偏好，使用独立 localStorage 键 pi-model-visibility 持久化精确 provider + model ID 身份（沿用现有 NUL 分隔 modelKey，不按模型名或仅 ID 匹配）。同步存储成功后才发布内存变化，失败保留原状态并显示原因；不改 SDK models/auth 配置，也不让普通设置表单保存覆盖这项偏好。保留已不存在目录中的隐藏身份，避免目录更新后模型意外复活；设置页提供恢复入口。

保留 availableModelsCache / 原始目录与运行时权限语义不变。在手动候选投影处统一过滤隐藏身份，覆盖合并模型/思考控件、旧模型控件、设置模型选择/路由多选/能力候选与供应商测活。读取当前模型能力、初始化显式默认、已有会话和已配置路由仍使用原始数据；已选隐藏值只保留回显，不重新作为可选项加入。所有模型被隐藏时显示空候选，不回退旧候选、不触发自动切模或覆盖保存配置。

## Implementation

- src/stores/modelVisibilityStore.ts 持有独立偏好、精确身份、损坏解析和手动候选投影；存储先写后发布，挂载中的同窗口消费者通过 Zustand 统一更新。
- BuiltinModelEditor 的每张 BuiltinModelRow 独立拥有展开和原始输入叶子；参数提交沿用稀疏覆盖适配器。目录中全部非替换模型直接展示，目录缺失/同 ID 替换的已隐藏身份有单独恢复入口。
- ModelThinkingAction、旧 ModelAction、providerModelData 下三类设置字段及 ProviderDiagnostics 使用统一可见性规则。原始缓存、SDK、默认解析和名称目录不变；测活在途请求仍保留原模型身份与结果。
- 真实 UI 发现旧 Select 自补当前值与错误探针边界，另以[真实 Select 候选修正](../bug-fix/2026-11-11-model-visibility-select-verification.md)记录并完成真实控件红绿验证。

## Alternatives considered

- 过滤 SDK 或共享 availableModelsCache：一个边界便可影响大量入口，代码最少；但这些原始目录也用于当前模型能力、Fast、默认草稿和自动路由，隐藏会误变成运行时禁用或触发回退，因此只过滤手动候选。
- 把隐藏写入 modelOverrides / models.json：可与供应商参数一起保存；但不是 SDK 模型参数，可能被 schema 拒绝或改变 Pi 官方 TUI/子代理行为，因此独立保存桌面偏好。
- 继续保留 Select 并加搜索：大目录占用小；但用户明确要求像自定义模型一样直接看到全部卡片，故改为全量列表、默认折叠高级区。

## Consequences

目录全部卡片直接出现且无模型选择 Select；每张卡独立编辑/展开/恢复；隐藏跨重载保留、其他供应商同名 ID 不受影响；所有手动候选即时过滤且可恢复，全部隐藏无旧列表回流。原始目录、模型覆盖、登录信息、当前会话及显式默认和路由均不变；存储失败可见且保留旧偏好。

代价是大目录会产生较多卡片，因此默认折叠高级区而不挂载编辑器；不是删除目录或账号权限探测。隐藏按精确路由保存，即使同 ID 后来被自定义条目替换也继续生效，设置页恢复入口始终保留。localStorage 仅影响当前桌面安装，不影响独立运行的官方 TUI；其他窗口的保存会在单项更新时合并，但已挂载的其他窗口不主动接收 storage 事件，需重载读取。

## 验证

本轮紧凑布局验证已通过，功能和落盘契约不变：

- `cd electron-agent && npx vitest run src/features/settings/BuiltinModelEditor.test.tsx src/features/settings/ProvidersSettings.test.tsx src/features/settings/builtinModelOverrides.test.ts src/features/settings/providerConfigAdapter.test.ts`：4 文件 78/78 通过，compact-tests.log；compact-row-red.log 先复现动作脱离卡片，修正后验证图标可访问名称、条件恢复及状态隔离。
- `cd electron-agent && npm run ui:check -- builtin-model-settings model-visibility`：181/181 与 109/109 通过，compact-ui-check.log；只跑 2/54 个场景，其余 52 个未跑。真实1420px供应商详情列验证折叠卡≤72px、与自定义卡高一致、显隐/展开同一头部、不重复默认状态、只读ID无填充底色、Tooltip/Tab焦点、改名后恢复出现/恢复后消失；深浅及窄屏无横向溢出。已检查 ui/compact-builtin-model-settings-overview-light.png 的真实浅色概览，深色概览与窄屏截图也已落盘。
- `cd electron-agent && npm run build`：通过，compact-build.log；本轮定向 renderer 类型检查无新增诊断，compact-typecheck.log 仅保留此前5条OAuth相关错误。根目录笔记校验和改动路径空白检查结果见 compact-notes.log、compact-diff-check.log。

此前验证计划已按 electron-ui-harness skill 执行，结果：通过（定向测试、真实 SDK、两个真实 Electron 场景及生产构建）。证据目录：`.agents/evidence/2026-11-11-builtin-model-list-visibility/`。

- `cd electron-agent && npx vitest run src/stores/modelVisibilityStore.test.ts src/features/settings/providerModelData.visibility.test.tsx src/features/settings/ProviderDiagnostics.test.tsx src/features/settings/ModelSelectField.test.tsx src/features/settings/ModelListField.test.tsx src/features/settings/CapabilityModelField.test.tsx src/features/chat/input/actions/ModelThinkingAction.test.tsx src/features/chat/input/actions/ModelAction.test.tsx src/features/settings/BuiltinModelEditor.test.tsx src/features/settings/ProvidersSettings.test.tsx src/features/settings/builtinModelOverrides.test.ts src/features/settings/providerConfigAdapter.test.ts electron/app/builtinModelOverrides.integration.test.ts`：13 文件、140/140 通过，见 final-tests.log。包括原始目录/当前能力不丢、在途测活身份、存储故障、多卡隔离和真实 SDK 临时文件合并。
- `cd electron-agent && npm run ui:check -- builtin-model-settings model-visibility`：首场景 builtin-model-settings 154/154 通过，第二场景首轮失败（90 通过、2 失败），见 ui-first-red.log。修复真实旧 Select 与 probe 后，仅定向复跑 `cd electron-agent && npm run ui:check -- model-visibility`：99/99 通过，见 visibility-ui-green.log。本次仅运行这 2/54 个场景，其余 52 个未跑；没有全量验证。ui/ 中保存管理概览、深浅、窄屏与显隐截图，已检查多卡概览。
- 红绿证据：cards-red.log 明确复现仅一张卡而不是两张；visibility-red-functional.log 记录 15 个功能失败后 visibility-green.log 为 61 项通过；legacy-real-select-red.log 真实控件复现隐藏当前值被补回，再由 legacy-real-select-green.log 验证修正。独立静态审查的两个阻塞项已修，最后复查未发现新阻塞；审查者未独立实跑。
- `cd electron-agent && npm run build`：通过，见 production-build.log；保留现有动态导入构建警告，未借机调整打包。根目录 `npm run verify-notes` 与本次路径 `git diff --check` 为收尾门禁，结果见 verify-notes.log、diff-check.log。
- `cd electron-agent && npx tsc -p ../.agents/evidence/2026-11-11-builtin-model-list-visibility/renderer.tsconfig.json`：未完全通过，见 renderer-typecheck.log；本次组件与两个场景无诊断，剩余为原有 providerService.ts 的 AuthPrompt.placeholder 两处与 pi.ts 三个 OAuth 类型缺失，共 5 条诊断。未宣称全仓类型检查通过。

未登录真实账号、未读取真实授权文件、未请求付费模型；隐藏不改变 OAuth 模型目录或模型运行权限。
