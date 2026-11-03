# Agent Note: 模型 Fast 能力与按模型偏好

Status: implemented

Fast 的能力声明、协议字段及布局约定继续有效。本文原先“按供应商＋模型共享”的开关归属、全局加载与读取 fast-mode.json 的部分，由 [Fast 会话独立偏好](./2026-10-28-session-fast-mode.md)取代；下面相关段落保留为旧决定及其取舍，不再作为当前开关行为依据。

## Problem

供应商模型设置只有图片和推理能力；输入栏无法选择 Claude / OpenAI 的 Fast 请求，也无法在模型列表中辨认这三项能力。Fast 能力与是否实际开启必须分开，否则勾选能力就会意外改变费用和请求。

## Decision

模型设置新增“快速”（英文 Fast）checkbox，与推理、图片并列，默认未勾选，随现有保存按钮写入 models.json 的 compat.supportsFastMode。该扩展字段被 Pi 的开放 compat schema 接受，运行时模型仍携带它。只对 anthropic-messages / openai-completions / openai-responses / openai-codex-responses / azure-openai-responses 接入，其他协议不推断支持。

用户已选择按供应商 + 模型记忆 Fast 的实际开启状态，所有会话共用，默认关闭。偏好独立写 agentDir/fast-mode.json，通过主进程单字段合并、串行原子写入，避免覆盖供应商编辑中的草稿。取消能力后隐藏开关且不发送 Fast 参数，保留偏好供重新勾选后恢复。

选择器底部档位右侧显示闪电按钮；外侧模型按钮在该模型 Fast 实际开启时，按“模型名 · 档位 · 快速”展示，关闭或撤销能力后移除“快速”；非推理模型省略档位，紧凑模式仍保留快速状态。外侧状态订阅同一份 Fast 偏好，启动恢复不依赖先打开弹层。偏好由 ModelThinkingAction 加载，闪电子组件只订阅状态，避免打开弹层时再次加载而吞掉首次读取错误及其重试入口。非推理但支持 Fast 的模型也显示可操作的 Fast 行。能力未开启时无占位，现有档位语义不变。能力图标紧跟模型名称右侧，固定按图片 / 大脑 / 闪电排序，仅显示显式支持的能力；名称按内容宽度显示，过长时省略，图标区不收缩，选中勾号单独靠行尾对齐。现有选择顺序、搜索、选中逻辑不变。

CLI probe 与会话模型 IPC 快照都显式暴露 input、reasoning、fast。Fast 从 compat.supportsFastMode 严格为 true 且协议可接入得出，不能按模型名猜测。请求通过常驻 fast-mode 扩展的 before_provider_request 注入：Claude speed=fast 与 fast-mode-2026-02-01 beta（合并其他 beta），OpenAI service_tier=priority；不改 thinking。每次请求读已落盘偏好，最新 registry 元数据优先于会话旧快照。适用会话主请求及工具循环，独立的内部短调用不继承 UI 的 Fast 偏好。

仓库当前渲染层没有统一 i18n 引擎，新增依赖不合算。本次引入很小的集中中英文词条模块，按页面 lang 读取，新增提示与错误均经过该模块；沿用 Lucide Image / Brain / Zap 和现有主题 token。

## Related notes

检索 Fast / serviceTier / 模型选择 / 供应商配置。命中 [空模型 ID](../../implemented/bug-fix/2026-10-14-provider-empty-model-id.md) 为部分重叠：保留既有完整文件 schema 和模型顺序约束，其决定不变；其余命中与本次无关。没有已有 Fast 决定被取代。

## Alternatives considered

- 全局一个 Fast 开关最容易理解且配置最少；用户选择按模型记忆，避免换模型时把别的模型意外启用。
- 把偏好放 localStorage 能完全沿用推理记忆；请求在另一进程执行，必须再同步一份状态，容易重载后界面和实际请求不一致，因此采用主进程磁盘偏好单一来源。
- 把偏好与能力一起写 models.json 可以少一个文件；供应商编辑器持有整份草稿，频繁切换 Fast 会被后续保存覆盖，因此分开落盘。
- 把未知能力显示为灰色可以固定三格；本次只显示明确支持的能力，减少窄列表的常驻宽度，顺序仍固定。

## Consequences

能力声明、实际开关和模型切换规则有单独且可验证的来源；两条接入共用能力判定和磁盘偏好。代价是新增一个偏好文件、两个 IPC 操作及一个常驻扩展。独立短调用不继承 Fast，以免标题、记忆等辅助任务因主模型偏好改变费用。按模型键保存的旧偏好暂不清理，移除模型后保持惰性无效。

服务端可能不支持用户声明的 Fast 能力，仍按原请求错误流程显示，不静默降级。Fast 可能提高实际服务商收费；本地用量估价受 Pi 原有计价机制限制。本次不验证付费账号的实际加速与费用。

页面 lang 默认值同步为 zh-CN，和现有中文界面一致；新词条响应 lang 改变。未来引入应用统一语言设置时应将这个很小的词条模块接到统一语言来源，而不是再加第二套用户语言偏好。

## 验证

使用 electron-ui-harness skill 跑 `npm run ui:check -- model-fast`，63 条断言通过（含短名称图标间距、长名称 / 窄屏图标与勾号定位、中文“快速”名称、外侧快速状态随开关 / 模型 / 能力 / 重载 / 语言同步）：两种供应商各八种能力组合、三个图标的悬停、缺字段、按模型记忆、开关两态、键盘、保存失败、读取失败重试、重载恢复、取消能力、非推理模型、280px 窄屏、浅色主题和中英文。`provider-model-list` 22 条通过，排序、保存、分段计费与窄布局不受新增 checkbox 影响。本次追加外侧状态后只重跑 model-fast 场景，并重跑 ModelThinkingAction.test.tsx，31 条通过；之前 provider-model-list 的结果保留，其余场景未运行。

`npx vitest run src/features/settings/fastCapability.test.ts src/features/settings/providerConfigAdapter.test.ts src/features/chat/input/actions/ModelThinkingAction.test.tsx electron/agent/workspaceHandle.test.ts electron/app/piRuntimeService.test.ts electron/app/providerService.test.ts electron/app/fastMode.integration.test.ts`：7 文件、193 条通过。Fast 集成覆盖真实 Pi schema / ModelRuntime / 扩展 / HTTP serializer，捕获 Claude、OpenAI Responses / Completions、Codex 的压缩请求体；传输边界给受控 400 停止，未访问外部付费账号。`node --import tsx --test src/probe-models.test.ts src/extension-profile.test.ts`：12 条通过。

变更渲染层与 Fast 后端实现的定向 TypeScript 检查通过。主进程全量 `npx tsc --noEmit -p tsconfig.node.json` 仍有其他模块既有诊断，完整日志保留，不宣称整个项目构建通过。`--changed --dry-run` 因公共 HTML lang 属性与共享桥的依赖列出全部场景；本次没有改全局 CSS、主题或桥的既有操作，实际新增文案与模型卡片布局已由两个定向场景覆盖，未扩大执行范围。

证据：`.agents/evidence/2026-10-28-model-fast/`，含交付说明、勾选前后 / 开启 / 浅色 / 窄屏截图，以及测试、类型检查和笔记校验日志。`npm run verify-notes` 通过（105 篇笔记的目录、链接、格式、归档及证据检查，退出码 0）。