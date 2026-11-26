# Agent Note: 内置供应商 API Key 必须写进 auth.json，不能用运行时 overlay

Status: implemented

## Problem

设置页「供应商 → 内置供应商 → API Key」填好并点保存后：

- 当时能用（模型测活、对话都正常）；
- 重新打开设置页，输入框变回原始值或空；
- 重启应用，key 彻底消失。

三个现象来自同一条错误实现。`ProviderService.setApiKey()` 调的是
`ModelRuntime.setRuntimeApiKey()`。它在官方 SDK 里是 `RuntimeCredentials.overrides`——
一个 `Map`，只覆盖本进程的读路径（`read()` 先查 overrides，命中就返回
`{ type: 'api_key', key }`），从不写 `auth.json`。而设置页回显读的是

```ts
// providerConfigAdapter.ts loadState()
apiKey: auth[p.id]?.key ?? providers[p.id]?.apiKey
```

`get_provider_config` 读的也是磁盘上的 `auth.json`。于是：写入点与读取点根本不是同一个存储。
`overrides` 随进程销毁，重启后 key 无影无踪。

排查时排除的三条：

- **内置供应商是否走了独立分支**：是独立分支（`ProvidersSettings.persist` 只对 `p.builtIn`
  发 `set_provider_api_key`，自定义供应商的 key 写在 `models.json`），但分支本身没问题，
  问题在它的落点。
- **脱敏/掩码导致回显丢弃**：没有。`Input.Password` 只控制显示，`value={active.apiKey ?? ''}`
  拿的是明文，保存时也只比较明文。
- **默认配置加载顺序覆盖用户值**：没有。`loadState` 的 `auth[id].key` 优先级高于
  `models.json.apiKey`，用户写进 auth.json 就不会被预设覆盖。

## Decision

`setApiKey` 的两条路径都改走官方持久化存储：

- 写：`runtime.models.credentials.modify(providerId, async (current) => ({ type: 'api_key', key,
  ...(current?.type === 'api_key' && current.env ? { env: current.env } : {}) }))`。
  `modify` 是 pi-ai `CredentialStore` 声明的唯一写路径，内部是加文件锁的读-改-写，
  落在 `agentDir/auth.json`。保留同供应商已有的 `env`（Cloudflare account id、AWS profile
  等），否则一次改 key 会把这些 provider env 冲掉，供应商反而变成不可用。
- 清：`runtime.logout(providerId)`，也就是官方 `Models.logout` → store `delete`。
  仍然保留「当前是 OAuth 凭据就不动」的判断，避免空输入把订阅登录删掉。
- 写完成即 `this.refresh()`：快照里的 `storedProviders` / `configuredProviders` 是缓存值，
  不重读不会变，供应商列表的绿点和凭据状态会滞后。主进程与 agent 子进程各持一份
  `ModelRuntime`，两份都要重读。
- 拒绝给 OAuth-only 供应商（目前只有 `openai-codex`）写 API Key：它没有 `auth.apiKey`，
  写进去运行时也解析不到，只会让状态谎报「已配置」。

退化路径：内部 `models.credentials` 形状不可用时（SDK 升级），退回公开的
`runtime.login(providerId, 'api_key', interaction)`——官方 login 同样经 `modify` 落盘，
只是要喂一个交互面（首个 secret 回填 key，其余提示给空串）。失败关闭，不静默丢弃。

`set_provider_config`（models.json）与 `auth.json` 的边界不变：设置页永不整份重写 auth.json，
OAuth 凭据仍只由 `login/logout` 拥有。

## 同类项排查

- **其余内置供应商**：共用同一条 `setApiKey`，一处修复全部覆盖。逐项差异只在 OAuth 能力
  （`providerPresets` 里的订阅制供应商）与 provider env（Bedrock / Cloudflare / Vertex），
  后者的 env 由上面的「保留 current.env」保住。
- **其他 key 类设置项**（`ANYSEARCH_API_KEY`、`WECHAT_OC_TOKEN`、`IM_GATEWAY_TOKEN`）：走
  `useSettingsForm.persist` → `set_settings` → `runtime-settings.json`，是真正的磁盘写入，
  回显读 `getSettings()`。没有同类缺陷，不动。
- **自定义供应商的 apiKey**：走 `serializeState` → `models.json`，一直是落盘的，无此缺陷。

## Alternatives considered

- **保留 `setRuntimeApiKey`，在保存时另外补写一份 auth.json**：改动最小，内存 overlay 还能让
  当前进程立刻生效。不采用：两处写入必然分叉，overlay 与磁盘值谁真谁假没有单一事实源；
  而且 UI 自己拼 auth.json 会回到「设置页整份重写凭据、抹掉 OAuth」的老问题（见
  [Pi 原生供应商 OAuth 的凭据所有权归官方运行时独占](../architecture/2026-11-08-pi-native-provider-oauth-ownership.md)）。
- **走公开 `runtime.login(providerId, 'api_key', …)` 并伪造交互面**：只用公开 API。不采用：
  多个供应商的 api-key login 会额外 prompt（Bedrock 选方式、Cloudflare 要 account id、
  Vertex 选区），伪造交互只能填空串；实测这样写出的 `env: { CLOUDFLARE_ACCOUNT_ID: '' }`
  会让供应商从「按环境变量可用」退化成不可用。`modify` 才是既能落盘、又不动其他字段的正路。
- **直接 `fs` 写 auth.json**：最直白。不采用：要自己实现跨进程文件锁、与官方
  `RuntimeCredentials.pendingModifications` 竞争，OAuth 刷新可能同时写同一个文件。
- **只改回显，让设置页从 runtime overlay 读 key**：能让「重开设置页」看起来正常。不采用：
  重启仍然丢，且要求渲染层能读到明文凭据，与「令牌不进渲染层」的既有边界冲突。

## Consequences

- 保存即刻生效：`getAuth` 每次读 auth.json（有 revision 检查），主进程与子进程都能拿到新 key；
  显式 `refresh()` 只为刷新快照里的可用模型与凭据状态。
- 重启后保留，重新进入设置页从 `auth.json` 回显。
- 代价：保存内置供应商 key 现在会触发一次 runtime 刷新（与保存 models.json 同一代价）；
  一次改多个供应商时每个 key 各刷一次，未做合并。
- `openai-codex` 这类 OAuth-only 供应商现在会明确报错，不再写一条解析不到的凭据。
- auth.json 格式不变（`{ [providerId]: { type: 'api_key', key, env? } }`），已有用户凭据不受影响。

## Verification

- `npx vitest run electron/app/providerService.test.ts electron/app/providerApiKeyPersistence.integration.test.ts`：
  41 用例通过。新增集成用例用真实 `ModelRuntime` + 临时 agentDir，覆盖三步——
  保存后 `getAuth` 立即返回新 key、`auth.json` 里有凭据、全新 runtime（模拟重启）仍能解析；
  另覆盖 OAuth 凭据与 provider env 不被冲掉、空输入只清 api_key。
- `npx vitest run src/features/settings`：224 用例通过（含 `ProvidersSettings` 的
  「保存内置 key 走凭据命令」「key 未改动不发写」、`providerConfigAdapter` 的
  「内置 key 从 auth.json 读取」）。
- `npx vitest run electron/ipc/register.test.ts electron/app/providerService.builtinModels.test.ts
  electron/app/packageConfiguration.test.ts`：通过。
- 手工核对 SDK 行为（非自动化用例）：`setRuntimeApiKey` 后 `auth.json` 不变；
  `credentials.modify` 后另一个已存在的 runtime 实例无需 refresh 即可 `getAuth` 到新 key。
- 未做真实 Electron UI 点击验证；`ProvidersSettings` 侧的读写契约由既有渲染层用例覆盖。
