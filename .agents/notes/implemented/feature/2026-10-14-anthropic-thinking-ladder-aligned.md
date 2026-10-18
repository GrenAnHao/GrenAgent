# Agent Note: Anthropic 默认思考档位与 pi 档位同名对齐，「最高」改名「极致」

Status: implemented

## Problem

Anthropic 协议（`anthropic-messages`）的默认 `thinkingLevelMap` 是整体上移一档：最低→`low`、低→`medium`、中→`high`、高→`xhigh`、很高→`max`，最高没有映射。设置页「思考档位对照」和对话里的档位选择器因此是错位的：

- 对话里选「中」，实际发给服务商的是 `high`；选「低」发的是 `medium`。名字和实际强度差一档，和 Anthropic 官方 effort 名对不上。
- 「最高」一档默认被隐藏，真正的最高 effort（`max`）要选「很高」才到。

## Decision

- `providerConfigAdapter.ts` 的 `ANTHROPIC_THINKING_MAP` 是 pi 档位与 Anthropic effort 同名一一对应：`low→low`、`medium→medium`、`high→high`、`xhigh→xhigh`、`max→max`；`minimal` 显式写 `null`（对话里不出现），`off` 不写（和之前一样不出现）。设置页五档「低 / 中 / 高 / 很高 / 极致」全部显示，「最低」「关闭」隐藏。
- `minimal` 写成 `null` 而不是缺省：这正是设置页关掉「出现」时写入的形态，也让子代理的 `supportedThinkingLevels`（只认 `null` 为不支持）不再把 `minimal` 当可选档。
- `modelCompatCatalog.ts` 的 `THINKING_LEVEL_ROWS` 里 `max` 的显示名从「最高」改为「极致」。这张表同时驱动设置页的「对话档位」列、对话档位选择器、子代理标题和测活下拉，所以各处同步改名；`xhigh` 仍叫「很高」。
- 默认值只在新勾「推理」、供应商换 API 类型（`modelsWithApiThinkingLevels`）、以及 `serializeModel` 没有每模型映射时生效。已经写进 `models.json` 的每模型映射原样保留，不迁移。
- 不按模型 ID 裁剪的原则不变：所有 Anthropic 模型拿到同一份默认。

## Alternatives considered

- **保持整体上移（五个 pi 推理档 minimal…xhigh 对应 low…max）** — 最强论据：对话里一眼看到「最低」到「很高」五档，`max` 不用额外露出一行，而且不需要改名；2026-09-27 的默认就是这样定的。否决：档位名和实际发给服务商的 effort 差一档（选「中」发 `high`），用户读设置页的对照表时要自己心算；最高 effort 要靠「很高」去触达，名字更是反的。
- **`minimal` 也映射成 `low`（两行都发 `low`）** — 最强论据：不隐藏任何已有档位，老会话里存着 `minimal` 时不用被钳。否决：选择器里会出现两个标签都是 `low` 的选项，选哪个效果一样，只会让人困惑；已存的 `minimal` 会话由 `coerceVisibleLevel` 落到默认档。
- **按模型 ID 裁剪（Opus 4.6 / Sonnet 4.6 没有原生 `xhigh`，只给它们 `xhigh: null`）** — 最强论据：避免给不支持的模型发 `xhigh`。否决：2026-09-27 已把「不按模型裁剪」定为原则（旧的裁剪逻辑方向就是反的，见 pi-ai `mapThinkingLevelToEffort`），模型清单会随 pi-ai 升级变化，写死 ID 很快过时；内置模型本来就带 pi 自己的元数据，自定义模型用户可在设置页关掉「很高」。
- **「最高」改名为「极致」只改对话选择器、设置页保留原名** — 否决：同一张表驱动所有展示位置，分开改要另起一张映射，两处名字不一致比改名本身更糟。

## Consequences

- **收益**：档位名和 Anthropic effort 同名，设置页对照表左右两列读起来一致；最高档（`max`）直接叫「极致」且默认可选。
- **默认档位行为变化**：对话默认档仍是「中」（pi 档位 `medium`），但发给服务商的 effort 从 `high` 变成 `medium`，新建的 Anthropic 推理模型默认推理强度更低、更省。已保存的模型不变，仍按各自旧映射发。
- **代价与已知上限**：
  - 已有的 Anthropic 推理模型保留旧的整体上移映射，要换成新映射需关掉再勾一次「推理」，或手改对照表，或换一次供应商 API 类型。
  - Opus 4.6 / Sonnet 4.6 这类没有原生 `xhigh` 的模型，选「很高」会发出它们不支持的 `xhigh`（pi-ai 只在映射值是字符串时直发）；之前这个代价落在「高」上，现在落在「很高」上，更少被选到。pi-ai 升级后需要重新核对 `xhigh` / `max` 的支持面。
  - 模型换成新映射后，老会话里存着 `minimal` 的，打开时由 `coerceVisibleLevel` 落到默认档「中」。

## Verification

- `cd electron-agent && npx vitest run src/features/settings/providerConfigAdapter.test.ts src/features/chat/input/thinkingLevels.test.ts src/features/chat/input/actions/ModelThinkingAction.test.tsx src/features/settings/ProvidersSettings.test.tsx src/features/settings/ProviderDiagnostics.test.tsx src/features/settings/providerDiagnosticsUtils.test.ts src/features/chat/SubAgentInline.test.tsx`：7 个文件、104 个用例全部通过。日志：`.agents/evidence/2026-10-14-anthropic-thinking-ladder-aligned/vitest-thinking.txt`。
- 新增 / 改动的断言：`defaultThinkingLevelMap('anthropic-messages')` 是新映射；自定义 Anthropic 供应商序列化进 `models.json` 的映射是新映射；API 类型切换后重写成新映射；`levelDisplayLabel('max')` 是「极致」；自定义 Anthropic 且没有映射时，选择器只有 `low / medium / high / xhigh / max` 五项。
- 没有跑 ui-harness：只改了文案和默认值，没有改任何组件的结构或样式；`provider-model-list` / `provider-diagnostics` 场景用的是显式映射夹具，不依赖这份默认。
