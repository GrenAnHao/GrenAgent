---
title: 模型测活从供应商设置里拆成下层停靠区，加思考档位与取消；测活一律走流式
status: active
date: 2026-10-09
scope: electron-agent/settings
files:
  - electron-agent/src/features/settings/ProviderDiagnostics.tsx
  - electron-agent/src/features/settings/providerDiagnosticsUtils.ts
  - electron-agent/src/features/settings/ProvidersSettings.tsx
  - electron-agent/src/lib/pi.ts
  - electron-agent/electron/app/providerService.ts
  - electron-agent/electron/ipc/register.ts
  - electron-agent/electron/agent/hostOneshotAdapter.ts
  - electron-agent/electron/agent/modelRuntimeHost.ts
  - cli/src/probe-models.ts
supersedes:
superseded_by:
---

## 背景
测活原来是供应商设置滚动区最底下的一张折叠卡，只对自定义供应商出现，模型列表取编辑态里的 id。没保存的模型点测活只会得到 model not found。测活不能选思考档，发出去也没法取消，供应商卡在连接上时只能干等。token 指标按 OpenAI 字段名（`prompt_tokens` / `completion_tokens`）读，pi-ai 的 Usage 实际是 `input` / `output` / `totalTokens`，这几格一直显示「—」。

## 决定
供应商详情分两层：上层是原来的设置，自己滚动；下层是「模型测活 / 诊断」停靠区，贴在详情列底边，可以收起，可以拖分隔条调高度。开合和高度存在模块变量里，换供应商、切设置页都保留，重启回默认。所有供应商都有这一层，内置供应商也有。

模型列表取 `list_models_global` 里 `provider` 等于当前供应商的条目，也就是已保存、运行时已加载的模型表，测活打的正是这份配置。设置有未保存的改动时停靠区给出提示，不再拿编辑态的 id 去测。`probe-models` 的行多带一个 `thinkingLevelMap`，可选档位和输入栏共用 `levelOptions`：内置模型能选到 xhigh / max，null 的档隐藏。默认选关闭，模型没有关闭档时用它的默认档。关闭档不带 `reasoning`，和对话里 off 的发法一致。

IPC 契约：
- `diagnose_provider_model` 的参数改成 `{ requestId, providerId, modelId, prompt, stream, reasoning? }`。`reasoning` 只收 minimal…max，别的值直接拒绝。
- 新增 `diagnose_provider_model_abort { requestId }`。主进程按 requestId 存 AbortController，取消后立即返回 `cancelled: true`，不等卡住的供应商收尾，此后到的分片丢弃。
- 分片从字符串改成 `{ type: 'text' | 'thinking', text }`。结果多了 `cancelled`、`thinking`、`reasoningTokens`。
- 没有正文算失败：只有思考时报「模型只返回了思考，没有正文」，什么都没有时报「模型返回了空内容」。

测活在主进程一律请求流式。`stream` 开关只决定输出是边到边推给渲染层，还是完成后一次显示。

## 放弃的方案
- 非流式测活继续走 `host.completeSimple`：这条路有意丢掉 `reasoning`（memory 抽取等调用传 'minimal' 反而会打开思考），选了思考档也不生效。pi-ai 的 `completeSimple` 本来就是 `streamSimple().result()`，线上一样是 SSE，改走流式什么都不损失。
- 让 `host.completeSimple` 透传 `reasoning`：会改变现有短调用的行为，为测活一处去动所有调用方，不值。
- 取消时渲染层直接把界面复位、不等主进程：要自己凑结果，丢掉主进程算的总耗时和已收到的部分输出。主进程收到 abort 就立刻返回，往返只要几毫秒，等它更准。
- 模型列表沿用编辑态的模型 id：没保存的模型测了必报 model not found，内置供应商也列不出 Pi 自带的模型。
- 用 `hasApiKey` 拦住发送：内置供应商可能走 OAuth 登录或环境变量，编辑态看不出凭据。只对自定义供应商没填 Key 时提醒一句，不拦。

## 后果
测活和对话走同一份运行时配置，结果可信。代价是改完设置得先保存才能测，停靠区会提示这一点。停靠区常驻在详情列底部，默认展开时占掉约 340px，设置区变矮；可以收起，也可以拖矮。`list_models_global` 的行多了一个可选字段，没打开项目时输入栏的档位也跟着变准。以后如果 pi-ai 的 `completeSimple` 改成真正的非流式请求，要重新看「一律走流式」这条。
