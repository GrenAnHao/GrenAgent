# Agent Note: 子代理思考档按模型能力收敛，并让默认路由的档位可见

Status: implemented

## Problem

一次普通的 `spawn_agent({ agent: "scout", thinking_level: "medium" })` 直接失败：

```
task · agent="scout" · thinking_level="medium"：模型 custom-mvjk9w7k/deepseek-v4.1-flash 不支持思考档 medium
```

该模型的 `thinkingLevelMap` 是 `{ minimal: null, low: "low", medium: null, high: "high", xhigh: "xhigh" }`，确实没有 medium。问题不在校验写错，而在**父模型拿不到判断依据**：

- 那条会话里父代理在 spawn 之前从未调用 `list_subagent_models`；即使调了也没用——`list_subagent_models` 在「普通子代理模型自选未开启」时只回一句「未开启；省略 model 使用普通默认配置」，而默认路由恰恰就是这条 deepseek 路由。
- 同时 `spawn_agent` 的 `thinking_level` 是常驻字段，描述写着「只写 list_subagent_models 列出的档位」。工具说「去查」，查询工具说「不必查」，剩下的只有让模型按别家默认档去猜。

于是失败点是纯信息缺口造成的空转：调用方不知道可用档，也不知道该改写成什么。

## Decision

两处一起改，方向一致——能力信息必须对模型可见，显式选择错了要收敛并说清楚。

`thinking_level` 不再整体拒绝，改为按模型能力就近收敛，规则与 SDK 的 `clampThinkingLevel` 相同：命中则原样；否则先向上找最近的可用档，再向下找，最后退回该模型最低档。收敛发生在 `selectionOf`，回执与 `details` 里用一行 `注意：<location> 路由 <model> 没有思考档 <requested>，已改为 <level>` 告诉调用方实际用了什么。`off` 与枚举外的值仍按原规则处理：不在枚举里照旧报错。

`supportedThinkingLevels` 与 SDK 的 `getSupportedThinkingLevels` 对齐：`xhigh` / `max` 必须有显式的 map 条目才算可用，没写即该协议没有这一档；其余档只排除显式写 `null` 的。

`list_subagent_models` 在普通自选关闭时不再只回一句话，而是列出子代理**实际会用的默认路由**（`SUBAGENT_MODEL`，未配置则父会话当前路由）以及 `cheap` / `strong` 解析到的路由，每行带可用思考档，`provider` 过滤照常生效。

会话本身用 SDK 的 clamp（写进去的档自动收敛），子代理此前比主会话更严；这次把两者对齐，父模型不必为「猜错一个档」换来一次完整失败。

## Alternatives considered

- **只补错误信息，不收敛**：改动最小、语义最严，失败仍然显式。但模型下一步只能重试，而它重试所需的可用档列表正是这次失败要告诉它的东西——一次工具调用换一次报错，成本高于收敛；且与主会话的 clamp 行为不一致，同一个档位在主会话可用、在子代理却报错。
- **只补 `list_subagent_models` 的默认路由，保留拒绝**：能让模型查到档位，但「查过之后仍写错」和「自选关闭时懒得查」两条路都还留着，用户的失败现场不会消失。
- **悄悄收敛、不回执**：回执多一段说明会占 token。但静默改掉调用方的显式选择会让它以为 `medium` 生效了，后续判断（比如「我给了中等思考」）全部建立在错误前提上，所以必须回执。

## Consequences

- 写一个本模型不支持的档不再失败，而是落到最近的可用档；`details` 里的 `thinkingLevel` 始终是实际生效值（嵌入子会话起来后仍以注册表里的实测档覆盖）。
- 收敛说明只出现在本次调用的正文开头，链式与并行的正常输出结构不变；没有收敛时正文与之前逐字相同。
- `list_subagent_models` 输出变长：自选关闭时多出 1–3 行。Ultra 分支不变。
- 枚举外的值（如 `turbo`）仍报错，因为那不是「档位不够用」而是参数写错。

## Verification

- `cd extensions/multi-agent; PI_RUNTIME_CONFIG= npx vitest run`：38 文件通过、1 文件跳过，560 项通过、2 项跳过。覆盖 `resolveThinkingLevel` 的五种落点（命中 / 向上 / 向下 / 非推理模型落 off / 枚举外报错）、`supportedThinkingLevels` 的 xhigh/max 显式映射规则、自选关闭时列出默认路由与父路由回退，以及 `spawn_agent` 三处出口（单任务、链式、并行）的收敛回执。
- `cd extensions; PI_RUNTIME_CONFIG= npx vitest run prompt-metadata.test.ts index.test.ts`：37 文件、433 项全通过，工具字段与提示词元数据未被破坏。
- 环境注意：本机 `PI_RUNTIME_CONFIG` 指向应用运行中的真实配置，直接跑会读到用户的 `SUBAGENT_MODE=custom`，与测试的 env 前提冲突；上面的命令都以空值覆盖它。
