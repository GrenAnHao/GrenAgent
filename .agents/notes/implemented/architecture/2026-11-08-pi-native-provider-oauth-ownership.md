# Agent Note: Pi 原生供应商 OAuth 的凭据所有权归官方运行时独占

Status: implemented

## Problem

Pi 官方 1.4.0 已为 9 个供应商内置原生 OAuth（7 个订阅制），三入口也锁定了 1.4.0 并通过 `ModelRuntime.create({ authPath, modelsPath })` 接上官方 `AuthStorage`。但桌面端只暴露 API Key 输入，且 `providerService.setConfig()` 整份覆写 `auth.json`、`serializeState()`（`electron-agent/src/features/settings/providerConfigAdapter.ts:355`）只从 `p.apiKey` 重建凭据且只写 `{ type: 'api_key' }`。任何一次设置页保存都会抹掉 `type: 'oauth'` 凭据。

这正是冻结决定 `docs/decisions/cli/2026-10-06-cursor-login-file-auth.md` 当年放弃「改成 pi 原生 `auth.oauth`」的第一条理由。升级到 1.4.0 后该行为仍在，所以接入 OAuth 之前必须先定凭据所有权。用户在 2026-11-08 明确要求跟进 Pi 官方厂商（排除 Cursor 一类三方自定义供应商），并选择方案 A。

另有一项此前未被记录的官方硬约束：`CredentialStore` 按 `Provider.id` 只存**一份**凭据，因此 API Key 与 OAuth 互斥，切换方式就是替换凭据，不是两个并存字段。这直接决定设置页的形态。

## Decision

- **凭据所有权**：OAuth 凭据只由 `ModelRuntime.login/logout` 经官方 `AuthStorage` 写入与删除；设置页不再生成整份 `auth.json`。文件锁、并发刷新、refresh token 轮换、跨进程一致性全部交给 SDK。
- **契约拆分**：`set_provider_config` 收敛为只写 `models.json`；新增 `set_provider_api_key(providerId, key | null)` 承载「用户显式编辑凭据」的意图，新增 `get_provider_credentials()` 返回不含任何令牌的派生状态。`get_provider_config` 的读取形状保持兼容。
- **互斥语义**：凭据区用互斥方式选择器；从 OAuth 切到 API Key（或反向）先二次确认「将替换当前凭据」。
- **进程归属**：登录在主进程 `ModelRuntimeHost` 的单份 runtime 上执行；成功后 `reload()` 并经既有刷新通道让 agent 子进程重载。请求路径刷新仍由各自 runtime 完成，依赖官方文件锁避免重复轮换。
- **能力发现**：OAuth 厂商清单与 `loginLabel` / `isSubscription` 从运行时 `getProviders()` 探测，不在渲染层硬编码；`providerPresets.ts` 只承担显示名与默认 api。
- **排除**：Cursor 三方链路（用户明确跳过）、`radius`（需自建网关提供 `/v1/oauth` 与 `/v1/oauth/token`，属部署侧能力）。
- 规划产物：`openspec/changes/adopt-pi-native-provider-oauth/`（`proposal.md`、`design.md`、`specs/provider-oauth-auth/spec.md`、`specs/provider-login-ui/spec.md`、`tasks.md`）。

### 历史决策审计

写本篇时按关键词检索 `.agents/notes/`（排除 `archived/`）与冻结的 `docs/decisions/`，逐篇分类：

- `implemented/architecture/2026-10-04-mcp-config-layers-and-oauth.md` — **部分重叠，互链**。已确立「登录交给 SDK 的 auth、凭据由 SDK 落盘」，本篇在 provider 侧沿用同一原则，不改其决定。
- `implemented/architecture/2026-11-01-pi-sdk-1.4.0-upgrade.md` — **部分重叠，互链**。其边界明确写着「真实 OAuth/供应商未验证」，本次验收要补上。
- `implemented/feature/2026-10-17-pi-1.3-capabilities.md` — **部分重叠，互链**。记录了 `serializeState` 写 `$schema`，与本次改动的同一函数相关；本次不动 `$schema` 行为。
- `implemented/simplification/2026-10-07-remove-cursor-provider.md` — **无关但确认边界**。Cursor 原生供应商已整块删除，本篇不恢复它。
- `docs/decisions/cli/2026-10-06-cursor-login-file-auth.md`（冻结只读）— **吸收其被否理由**。见下节；不修改冻结文件。
- 其余检索命中（各类 bug-fix / process 笔记）— **无关**。

## 1.4.0 上游缺口与设备标识适配

实跑发现：点「使用 ChatGPT 订阅登录」立即报 `Sign in with ChatGPT requires a device ID (UUID) for this installation`。根因不是我们的凭据所有权设计，而是 `@earendil-works/pi-coding-agent@1.4.0` 的 `ModelRuntime.login(providerId, type, interaction)` 只收三个参数，调用底层 `Models.login` 时没有传第四个 `LoginOptions`；`pi-ai` 的 OpenAI ChatGPT flow 在 `agentHostId(options?.getDeviceId?.())` 处校验 UUID 并直接抛错。`pi-ai` 自带 CLI 传的是 `{ getDeviceId: randomUUID }`，说明缺的是 coding-agent 的封装，不是 flow 本身。

决定：登录优先走同一 runtime 实例内 `Models` 集合的 `login(...)`，传入落盘在 `agentDir/device-id.json` 的稳定 UUID 与 `agentName='GrenAgent'`；`ModelRuntime.login` 额外做的 `synchronizeCredentialState` 由登录后的 `service.refresh()` → `runtime.refresh()` 覆盖。运行时内部集合结构不符时失败关闭、退回公开 `login()`。设备标识目录不可写时退化为进程内稳定，不阻塞登录。

- **改 `node_modules` 打补丁**：仓库已有 postinstall 补丁机制，能一次修好三入口。不选：每次升级 Pi 都要重新对锚点，且用户当前安装副本要 reinstall 才生效；本改动只需一个可失败关闭的适配函数。上游修好封装后删掉这段即可，不留补丁债务。
- **自建 `Models` 集合 + `AuthStorage` 专供登录**：完全走公开 API。不选：要重新注册全部内置 provider，且与主 runtime 的凭据存储/模型快照是两套，反而引入不一致。
- **每次登录用 `randomUUID()` 不落盘**：官方 demo CLI 就是这么做的。不选：`LoginOptions.getDeviceId` 的契约明确要求同一安装返回同一个 ID，每次换 ID 会被 OpenAI 当成新设备安装。

同时把界面英文统一中文：官方 `loginLabel` 按 providerId 做中文映射（未知厂商回退「使用 <官方名> 登录」），官方英文 OAuth 错误（device ID / 回调端口占用 / 授权被拒绝）映射成可操作的中文提示。是否要做完整 i18n 留待多语言需求出现时再定。

## Alternatives considered

- **B：设置页 merge 保留 `oauth` 项**。最强理由：改动最小，`set_provider_config(modelsJson, authJson)` 的双写形状不变，只要 `loadState` 记住原凭据、`serializeState` 合并回去即可。不采用：凭据所有权仍留在 UI，界面要持有令牌才能合并，与「令牌不进渲染层」冲突；`serializeState` 与 `AuthStorage` 形成双写竞争，且这正是 2026-10-06 被否决的老路。
- **C：只做只读状态展示，登录走外部 CLI**。最强理由：实现最快，风险最低。不采用：`cli/src/main.ts` 是 RPC sidecar、没有 TUI，桌面端不会有登录入口，不满足用户「UI 层也需要得到设计」的要求。
- **保留双写、仅在主进程 merge `auth.json`**。最强理由：命令形状完全不动。不采用：主进程无法区分「用户没动 API Key」与「用户清空了 API Key」，后者会误删同 provider 的 OAuth 凭据。
- **2026-10-06 放弃「改成 pi 原生 `auth.oauth`」的理由**（当时最强）：保存任意供应商时 `serializeState` 整份重写 `auth.json`、只保留 `api_key` 项，会把 Cursor 登出；要走这条路得先改序列化，并推翻「令牌存在 `cursor-credentials.json`」的约定。**本次为何解除**：用户已跳过 Cursor 三方链路，不再有私有登录文件约定；方案 A 直接把凭据所有权移出设置页，`serializeState` 不再产出整份 `auth.json`，阻塞点从根上消失。这是决定翻转，故新开本篇并与旧决定互链，不在旧笔记上改写 `## Decision`。
- **把登录放到 agent 子进程**。最强理由：更靠近实际发模型请求的 runtime。不采用：子进程随会话重建，登录中途重启会丢失回调服务器与交互通道；主进程单实例更适合串行化。
- **在 `providerPresets.ts` 里加静态 OAuth 元数据表**。最强理由：直观、渲染层不依赖主进程探测。不采用：官方每次增改厂商都要手工同步，与「跟进官方」目标冲突。
- **把 33 项 presets 全量改为运行时生成**。最强理由：长期维护成本最低。不采用：牵动显示名、默认 api、baseUrlHint 迁移匹配的既有逻辑，超出本次范围。

## 单实例约束与验收范围变更

用户在 5.2/5.3 收尾时明确：「不要测试发起对话，限制进程只能启动一个即可」。原本 5.2 要写「隔离目录集成用例断言两进程并发请求只发生一次刷新」，前提是有真实 refresh token 或桩 OAuth 服务才能数出刷新次数；用户选择从源头消除并发，而不是补这个验收。

决定：主进程用 `app.requestSingleInstanceLock()`，未取得锁立即 `app.quit()`；`second-instance` 事件里聚焦并恢复已有窗口。agent 子进程沿用 `AgentProcessClient.start()` 的 `this.running` 同步判重（已保证不会并发拉起两个），不改。`process.env.VITEST` 下跳过锁，避免单测与夹具被挡。锁逻辑抽成可测纯函数 `acquireSingleInstanceLock(app, isTest)`，`singleInstance.test.ts` 覆盖测试环境跳过 / 取得锁 / 第二实例退出三分支。

- **保留两进程并发、补跨进程刷新集成用例**：能直接证明官方文件锁有效。不选：需要真实轮换 refresh token 或自建桩 OAuth 服务，且用户已明确不要这类验收。
- **只在文档声明单实例，不加代码锁**：改动最小。不选：约束没有代码兜底，后来者仍可能打开多实例把并发刷新问题带回来。

5.3 同步收敛：用户已在真实环境添加 ChatGPT 凭据，自动化**不发起对话、不重放登录或登出、不触碰用户凭据**，只以只读状态查询（凭据不含令牌、账号卡、绿点）作为验收。真实登录链路不由自动化回放，这一边界如实保留。

## 验证

- 已通过：`electron-agent` 全量相关单测 57 文件 / 650 用例；`cli` 探针 6 用例；Electron `tsc --noEmit` 零错误。
- 已通过：`provider-oauth-login` ui-harness 30/30；共用组件的 `provider-model-list` + `provider-diagnostics` 42 项全 PASS（只跑了这 3 个场景，`--changed --dry-run` 的其余范围来自工作区原有 319 个未提交改动）。
- 已通过：`npm run verify-notes` 退出码 0、`openspec validate --strict` 通过。
- 已通过（设备标识修复后）：`providerService.test.ts` 34 用例（UUID 稳定/落盘、中文错误映射、内部集合缺失回退）、`ProvidersSettings.test.tsx` 15 用例；ui-harness `provider-oauth-login` 中文文案 30/30 PASS；Electron `tsc --noEmit` 仍零错误。
- 已通过（单实例锁）：`singleInstance.test.ts` 3 用例；Electron `tsc --noEmit` 零错误；5.2/5.3 按用户约束收敛为只读验收，全程未发起模型请求、未重放登录或登出、未读取用户凭据文件。
- 已覆盖：保存模型配置不改 `auth.json` 的 OAuth 凭据；凭据状态返回值不含令牌；登录成功 / 取消 / 失败 / 并发拒绝 / per-prompt signal 取消 / 刷新失败提示；OAuth 能力运行时探测不含 `radius`。
- 未验证：真实厂商 OAuth 登录、模型请求与退出登录（需用户授权账号），见 Risks。CLI 侧 `tsc` 的 12 条既有诊断与本次改动无关（`probe-models` 零错误）。

## Consequences

- 设置页保存只写 `models.json`；凭据写入收敛到 `set_provider_api_key` 与官方 `login/logout`；`phase2Migration` 改为返回 `apiKeys` 逐个写入。
- 新增 4 个凭据/能力 IPC 命令与 4 个登录命令，登录事件走 `__grenChannelId` 通道，反向提示用 `promptId` 应答。
- 三入口共用同一 `authPath`：修正了 `probe-models` 未传 `authPath`、自定义 agentDir 下读到空凭据的问题。
- OAuth 厂商清单由运行时探测，官方新增厂商无需改渲染层；`radius` 与 Cursor 三方链路排除。
- 代价：设置页新增两个降级查询（凭据状态、OAuth 能力），主进程不可用时退回纯 API Key 模式；登录流程全局单飞，同一时刻只允许一个供应商授权。

## Risks

- 凭据互斥是官方契约，若 UI 表达成「两种方式并存」会误导用户；需明确替换语义与二次确认。
- `set_provider_config` 是跨层契约改动，渲染层 / IPC / 主进程必须同批修改；`get_provider_config` 读取形状保持兼容可降低回归面。
- 主进程与 agent 子进程各自缓存 `auth.json` 读状态，登录后必须显式刷新；并发刷新依赖官方文件锁，需集成用例覆盖。
- 官方 `loginLabel` 为英文而产品 UI 为中文，先直显，映射表留作可推迟项。
- 真实浏览器授权、设备码轮询、固定回调端口的行为无法由 jsdom/ui-harness 完全覆盖；用户已在真实环境添加 ChatGPT 凭据，但按用户要求自动化不发起对话、不重放登录/登出，因此不宣称自动化端到端通过。
- `auth.json` 格式未变，回滚代码不会破坏已有凭据；但回退后 OAuth 凭据不再被界面使用，需要提示用户重新以 API Key 配置。
