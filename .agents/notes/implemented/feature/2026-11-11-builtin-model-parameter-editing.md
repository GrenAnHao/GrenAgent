# Agent Note: 内置模型复用模型卡片并定点覆盖参数

Status: implemented

## Problem

用户希望内置供应商模型与自定义模型一样可编辑部分参数。现有页面仅能追加/替换模型；SDK 已支持 modelOverrides，但入口在 11 月 10 日界面收敛时撤下。OAuth 列表来自公共目录和供应商级凭据判断，不代表当前账号逐模型权限，本次只解释原因，不修改目录过滤。

历史审计：[界面收敛](../../implemented/simplification/2026-11-10-remove-chat-inspection-panels.md) 的内置编辑入口决定由本篇局部取代，其他撤下面板保持；[高级模型设置](../../implemented/feature/2026-11-10-desktop-model-settings.md) 的无损配置、协议边界与显式覆盖继续适用；[OAuth 所有权](../../implemented/architecture/2026-11-08-pi-native-provider-oauth-ownership.md) 继续适用。

## Decision

在供应商页增加内置模型选择与同款 ProviderModelCard，一次只展开一个模型，固定模型 ID，不支持删除/拖排内置目录。开放卡片中 SDK modelOverrides 接受的元数据、思考、兼容与高级字段，支持恢复该模型默认值。自定义追加/同 ID 替换仍在原位置，同 ID 替换不显示第二份内置编辑器。

后续用户要求全部卡片平铺及可隐藏模型；“一次选择一张卡”的界面决定由[内置模型列表与可见性](2026-11-11-builtin-model-list-visibility.md)局部取代。本篇保留 SDK 基线、稀疏覆盖、协议固定与凭据隔离的有效约束。

使用 Pi SDK 公开 providers/all 的内置聊天目录读取未合并用户覆盖的基线，经只读 IPC 返回白名单元数据（无凭据、请求头和连接地址）。该基线明确称为 SDK 内置默认值；不伪称是账号权限目录，也不发网络请求或新建凭据运行时。运行时的远程目录刷新保持原机制；只存用户修改项而非快照，未编辑字段继续跟随实际 SDK/公共目录。

modelOverrides 按 SDK 实际合并层级定点修改，显式 false/0 保留，未触及的未知字段不丢失；删除覆盖恢复继承。compat 只在顶层与四个路由/模板对象上浅合并，模板变量等更深对象必须原子替换，不能假设任意递归继承。高级输入保留非法草稿并阻止保存。恢复默认删除当前模型覆盖，不改其他模型/供应商或 OAuth 凭据。保存沿用既有磁盘/刷新状态与仅重试刷新。

分段价格复用自定义模型的标准化：无阈值行跳过、缺价采用有效基础价格、同阈值取最后一行；内置删除最后一档保留显式 tiers: []，不重新继承 SDK 分段。未修改的 SDK 分段不规范化、不复制为覆盖。思考协议别名清除先去除 compat 中的旧值，避免旧覆盖复活。

清空继承的基础输入时，表单需要保留空输入以便继续键入，但不为此复制整份有效模型。组件只缓存基础文字/数字输入及已改成本/兼容输入叶子；推理开关、厂商档位映射、兼容布尔值和协议别名始终从当前覆盖派生。该临时输入态不落盘，恢复默认时清除，避免形成第二份参数权威源。

## Implementation

- cli/src/builtin-models.ts 通过公开 SDK 目录读取并深拷贝白名单元数据；ProviderService 与 list_builtin_models IPC 只转发经过校验的 provider。
- BuiltinModelEditor / builtinModelOverrides 复用 ProviderModelCard，支持原位参数编辑、清除/恢复、只写修改项、选择/加载失败重试；共享卡片保持自定义模式原语义。
- 新增 builtin-model-settings 真实 Electron 场景及真实 SDK 临时目录集成；独立审查发现的浅合并、分段和双源输入态问题均补定向测试后修正，最后复查未发现阻塞问题。

## Alternatives considered

- 复制目录条目到 models：复用成本最低，但冻结所有元数据且同 ID 语义变成替换，不满足只修改部分参数。
- 恢复独立的高级覆盖面板：已有实现线索，但用户要求与自定义模型一致，独立面板割裂基础参数与高级参数。
- 从 list_models_global 反推未覆盖基线：能显示缓存的新目录，但列表已应用用户替换/覆盖，无法可靠恢复默认；因此用公开 SDK 内置原始目录并标明基线来源，不访问私有成员。
- 任意对象递归 merge/diff：实现短、看起来能最大限度稀疏，但与 SDK 浅合并边界不符，会丢模板变量的必需 $var，故改为明确的 SDK 合并边界。
- 缓存整份模型卡片 patch：能保留空输入而不改共享控件，但会产生陈旧 compat 与派生别名，以及丢失厂商档位映射；只缓存实际文字/数字输入叶子。

## Consequences

内置模型支持选取、原位编辑与恢复默认；保存只含明确覆盖、false/0 不丢、其他字段/凭据不变；同 ID 替换保持原语义；失败可重试，非法草稿不丢。目录读取增加一条只读 IPC，不新增模型调用或登录流程；成本是需要随 SDK 合并规则变化维护定点覆盖适配器。对应真实 UI 检查全通过。

## Risks

SDK 打包目录与运行时公共目录缓存可能存在版本差异，页面需明确基线来源。手工覆盖或声明能力不会赋予服务端权限，非法能力组合仍可能被服务端拒绝。真实厂商登录/付费请求不属于本次验证。

## 验证

验证计划已按 electron-ui-harness skill 落地。结果：通过（定向单测、真实 SDK、真实 UI 与生产构建）；额外 renderer 类型检查部分受现有工作区错误阻塞，未宣称全项目类型检查通过。

证据根目录：`.agents/evidence/2026-11-11-builtin-model-parameter-editing/`。

- `cd electron-agent && npx vitest run src/features/settings/BuiltinModelEditor.test.tsx src/features/settings/builtinModelOverrides.test.ts src/features/settings/ProvidersSettings.test.tsx src/features/settings/providerConfigAdapter.test.ts electron/app/builtinModelOverrides.integration.test.ts electron/app/providerService.builtinModels.test.ts electron/app/providerService.test.ts electron/ipc/register.test.ts electron/ipc/commandCoverage.test.ts`：9 文件 150/150 通过，见 final-tests.log。真实 SDK 使用临时 models/auth 路径，禁止 fetch，验证稀疏覆盖/价格 0/布尔 false/完整 tiers/模板变量 $var/恢复继承与凭据内容不变。
- `cd electron-agent && npm run ui:check -- builtin-model-settings`：164/164 通过，见 ui-check.log；只跑 1/53 个场景，其余 52 个未跑。真实组件、鼠标键盘，验证编辑/跨模型及供应商草稿/非法 JSON/保存重挂/恢复当前默认/分段删除与缺值/思考协议清除/错误与重试/深浅及窄屏，ui/ 下保存四张截图，已检查暗色宽屏与浅色窄屏。
- 测试先红后绿记录见 catalog-red.log、merge-boundary-red.log。首轮真实 UI 发现继承值清空回填，后续复跑暴露 compact 数字 parser 空串回 0；修正后通过。ui-inheritance-red.log 保留了失败复跑与探针超时证据；只移除探针 reveal 中冗余等待（真实 t.click 已等几何稳定），未放宽断言或改 harness 全局超时。
- `cd electron-agent && npm run build`：通过，见 production-build.log。最后独立静态复查无 Critical/Warnings，审查者没有独立实跑、不读取真实凭据。
- `cd electron-agent && npx tsc -p ../.agents/evidence/2026-11-11-builtin-model-parameter-editing/renderer.tsconfig.json`：未完全通过，见 renderer-typecheck.log；剩余为 providerService.ts 的 AuthPrompt.placeholder 收窄与 pi.ts 的三个 OAuth 类型缺失（5 条诊断），本次新增组件/适配器无诊断。CLI 全量类型检查也受已有测试 vitest 类型及 extensions 类型错误阻塞；新增只读目录模块的隔离严格检查与原生离线探针通过，见 catalog-module-typecheck.log、catalog-native-offline.log。未在本任务中顺带修复其他改动。

未使用真实账号登录、未验证逐模型账号权限、未发送付费模型请求；OAuth 模型名单未裁剪。
