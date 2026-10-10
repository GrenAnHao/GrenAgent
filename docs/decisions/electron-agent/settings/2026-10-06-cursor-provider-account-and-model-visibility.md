---
title: Cursor 供应商页改成账号卡 + 内置模型勾选，勾选在供应商的 filterModels 里生效
status: superseded
date: 2026-10-06
scope: electron-agent/settings
files:
  - electron-agent/src/features/settings/ProvidersSettings.tsx
  - electron-agent/src/features/settings/CursorAccountCard.tsx
  - electron-agent/src/features/settings/CursorModelList.tsx
  - electron-agent/electron/ipc/register.ts
  - electron-agent/electron/main.ts
  - cli/src/cursor/install.ts
  - cli/src/cursor/oauth.ts
  - cli/src/cursor/visibility.ts
supersedes:
superseded_by: cli/2026-10-07-remove-cursor-provider.md
---

> 已过时 → 见 [2026-10-07-remove-cursor-provider.md](../../cli/2026-10-07-remove-cursor-provider.md)

## 背景
Cursor 供应商页沿用了内置供应商的模板：一个提示文字写着 `sk-...` 的 API Key 输入框、Base URL 说明、「自定义追加模型」。Cursor 靠 OAuth 登录，手填的 key 会盖过登录令牌，目录外的模型 id 在开流前就会报错，三样都用不上。登录按钮只在点完后短暂显示一句结果，重开设置页就看不出登录了没有，也没有退出入口。左侧绿点看的是 API Key，靠登录接入的 Cursor 永远显示成未配置。目录里有 123 个模型，用户要能挑哪些出现在模型选择器里。

## 决定
Cursor 页的凭据区换成账号卡，显示「已登录 / 访问令牌到期时间」或「未登录」，按钮是登录（已登录时为重新登录）和退出。新增 `cursor_status`、`cursor_logout` 两个 IPC 命令，`cursor_login` 改为返回登录状态。这三条命令只回 `{ loggedIn, expiresAt }`，不带令牌。左侧绿点对 Cursor 改看登录状态。

模型区换成只读的内置目录，每个模型一个勾选框，默认折叠，摘要写「显示 n / 总数」，展开后可以搜索，并能对搜索结果批量显示或隐藏。取消勾选的 id 写进 `agentDir/cursor-models.json` 的 `hidden`，只记隐藏的，目录以后新增的模型默认显示。生效点放在原生供应商的 `filterModels` 里，所以 `getAvailable` / `getAvailableSnapshot` 拿不到被隐藏的模型，对话模型选择器、`agent_set_model`、子代理的 `list_subagent_models` 也都看不到。没打开项目时走的 `list_models_global` 返回全量 `getModels()`，在主进程里另用 `withoutHiddenCursorModels` 过滤一次。勾选的改动和页面其它改动一样，算进「保存」按钮的未保存状态。保存时先调 `cursor_set_hidden_models` 写文件，再调 `set_provider_config`，模型表只刷新一次。

## 放弃的方案
- 只在渲染层的模型下拉里过滤：子代理模型列表、`agent_set_model`、默认模型回落仍会选到被隐藏的模型，「不显示」只在一个下拉里成立。
- 把可见性写进 models.json 的 `providers.cursor`：pi 会校验 models.json 的 schema，写进未知字段可能导致整份文件被拒，所有自定义供应商一起消失（见 `2026-10-03-models-json-partial-cost.md` 那类问题）。
- 写进 runtime-settings.json：那份文件在 Electron 的 userData 下，sidecar 和子代理进程要另外传路径才能读到。agentDir 两边都已经有了。
- 记显示的白名单：目录更新后新增的模型默认隐藏，用户要回设置页才能发现。
- 每勾一次立即写盘并刷新：一次批量操作会触发多次全量模型表刷新，也和页面上其它字段「改完点保存」的方式不一致。
- 把同一模型的思考档变体合并成一项：要连带改对话模型选择器和思考档位，范围超出这次的设置页，留到以后单独做。

## 后果
`filterModels` 每次算可用列表时同步读一次 `cursor-models.json`。文件很小，只在刷新可用列表时读，不在请求路径上。pi 的 `updateModelSnapshot` / `markProvisionallyConfigured` 会先用「已配置供应商的全部模型」占位，紧接着的可用性刷新才套用 `filterModels`，所以注册供应商之后有一段很短的时间，被隐藏的模型仍在快照里。退出只删本机凭据文件，不去服务端吊销令牌。auth.json 里如果手填过 `cursor` 的 key，界面上已经看不到，但它仍然优先于登录令牌；要清掉得手动编辑 auth.json。
