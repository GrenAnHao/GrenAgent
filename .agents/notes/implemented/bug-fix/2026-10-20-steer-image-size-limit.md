# Agent Note: 引导 / 跟进里的大图先缩到 2000×2000，已进历史的大图在请求前兜底

Status: implemented

## Problem

electron-mall-manager 的会话卡死：之后每次请求都被 Anthropic 拒掉，`messages.N.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests`。扫会话 JSONL，36 张图里有 3 张超过 2000px（2160×1350、2559×1527、3906×1557），都是用户消息；最后那张正文为空，转成 Anthropic 请求时图片就是 `content.0`。同一会话里走 `prompt` 发的图都被缩成了 2000 宽、带 `[Image: original …]` 说明，只有这三张没缩。

原因在 pi 1.3.0：`AgentSession._normalizePromptImages` 只在开始新一轮时跑；`steer` / `followUp`，以及正在跑时 `prompt(…, { streamingBehavior })` 走的 `_queueSteer` / `_queueFollowUp` 把图片原样塞进队列。工具结果的图片另有 `normalizeToolResultImages`，不受影响。GrenAgent 回合进行中发出的消息默认就是引导，所以带截图的引导一张就能让会话之后所有请求失败。大图一旦进了历史，重开会话也没用。

## Decision

新增扩展 `extensions/image-limits/`，在两处补上：

- `input` 钩子：pi 在 prompt / steer / followUp 三条路上入队前都会跑输入钩子（`_runInputHandlers`），这里把超限的图片用 pi 导出的 `resizeImage` 缩好，`transform` 回去。历史里存的就是缩过的图。正文不动：撤回排队引导（`cancelQueuedSteer`）靠正文匹配，加尺寸说明会让它对不上；缩不下来时保留原图，交给后面的兜底。
- `context` 钩子：每次请求前过一遍 user / custom / toolResult 里数组形式的 content，超限的图片在发出去的副本里换成缩过的；缩不下来就换成一行 `[Image omitted: … exceeds the inline image limit and could not be resized.]`。会话文件不改。已经卡住的老会话靠这一步恢复。
- 超限的判定：先只解码 base64 开头 256KB，读 PNG / JPEG / GIF / WebP 头里的宽高，宽或高超过上限、或 base64 长度超过 `maxBytes` 才调 `resizeImage`，没超限的图片零成本。读不出宽高的格式只按体积判。
- 上限：当前模型 `inputLimits.images.resize` 有就用，否则和 pi 默认一致（2000×2000、base64 4.5MB）。不读 `images.autoResize` 设置：GrenAgent 没有暴露这个开关，而超过 provider 硬上限的图关掉缩放也只会让请求失败。
- 缩放结果按原图 base64 缓存（同一进程最多 64 张，LRU），老会话里的大图每次请求都会被看到，只缩第一次。
- 注册：`extensions/index.ts` 三张清单都加 `image-limits`（放在 `compaction-policy` 后面，先让排除集去掉的消息不参与），`multi-agent/embedded-runner.ts` 和 `cli/src/extension-profile.ts` 的 `CORE_ALWAYS_ON` 也加上，任何档位、子代理都会加载。最初漏了 `cli/src/extension-profile.ts` 那一份：Electron 主会话带插件白名单走 `filterManagedExtensions`，没有 manifest 又不在这份集合里的扩展不会加载，`cli/src/agent-data-plugins.test.ts` 为此报红；2026-10-21 接用量账本时补上。

## Alternatives considered

- **在主进程 `piRuntimeService` 的 `agent_steer` / `agent_follow_up` / `agent_prompt` 里先缩图再交给 pi**。最强理由：问题出在 GrenAgent 发引导这条路，就地修最直接，不多一个扩展。不用：pi 的 `processImage` 没有导出，只能自己再拼一份；子代理、`send_message` 等不经过这几个 IPC 的入口照样漏；而且救不了已经写进历史的大图，卡死的会话还是卡死。
- **只做 `context` 兜底，不在 `input` 缩**。最强理由：一处代码覆盖所有来源。不用：大图会一直留在会话文件里（单张 1MB 级），每次进程重启后的第一次请求都要重新解码缩放（实测这份 2000 条消息的会话首次约 3.5 秒）；入口缩掉后兜底只剩老会话会碰到。
- **把会话文件里的大图改写成缩过的**。最强理由：一次修好，之后零开销。不用：会话 JSONL 是只追加的历史，改写已有条目会和 pi 的分支 / entryId 机制、以及正在打开它的进程冲突；请求前改副本就够了。
- **等 pi 上游修**。会修，但卡住的会话现在就要能用；上游修好后 `input` 钩子会变成空操作（图已不超限），可以再删。

## Consequences

- 收益：引导 / 跟进带大截图不会再弄坏会话；已经卡住的会话下次请求自动恢复，不需要手动删消息。
- 收益：没有大图的请求只多一次图片头解析，没有解码开销。
- 代价：经引导发出的大图不带 pi 那行 `[Image: original …, displayed at …]` 尺寸说明，模型看不到原图坐标换算；走 `prompt` 的图照旧有。
- 代价：老会话里的大图在每个进程里第一次请求时要缩一遍，会话大时有几秒延迟（缓存后约 4ms）。
- 依赖 pi 1.3.0 的行为：`input` 钩子在入队前跑、`resizeImage` 从包入口导出。`image-limits-live.real.test.ts` 的第一条断言「不装扩展时引导的图原样进历史」会在 pi 自己修好后变红，那时可以考虑去掉 `input` 钩子。

## Verification

- `cd extensions && npx vitest run image-limits --reporter=verbose` 通过（17 条），日志 `.agents/evidence/2026-10-20-steer-image-size-limit/vitest-image-limits.txt`：
  - `limits.test.ts`：PNG / JPEG（SOF 在 APP1 后面）/ GIF / WebP 头读宽高；宽、高、体积三种超限；模型上限覆盖默认值；不超限时原数组原样返回、不调 resize；只换超限那张、顺序不变；输入阶段缩失败保留原图、请求阶段换成文字；user / custom / toolResult 都修、assistant 和字符串 content 不动、原消息不被改；缓存按原图和上限命中；用 pi 真实 `resizeImage` 把 3906 宽的 PNG 缩到 2000 以内。
  - `image-limits-live.real.test.ts`（真实 `AgentSession` + faux 模型，不联网）：工具卡住时 `steer("", [3906 宽 PNG])`，不装扩展时历史和发给模型的都是 3906（复现 pi 的缺口）；装上扩展后历史里存的和发出去的都在 2000 以内；历史里预先放一张 3906 宽的图再 `prompt`，发出去的是缩过的、会话里的原消息不变。
- 对卡住的真实会话实跑 `context` 钩子：`npx tsx image-limits/scan-session.ts <electron-mall-manager 会话>`，2032 条消息、36 张图，修正前超限 3 张、修正后 0 张，首次 3556ms、缓存后 4ms。日志 `scan-stuck-session.txt`。
- `npx vitest run multi-agent index.test.ts`：除 `runner.test.ts` 的 3 条 `resolveSubagentModel`（读到本机配置里的 `SUBAGENT_MODEL`，与本改动无关）外全部通过；`electron-agent` 的 `piPackageService.test.ts` 通过。
- 没有在真实 Electron + 真实 Anthropic 模型里重放那个会话：需要重启应用加载新扩展后在该会话里再发一条消息，留给用户确认。
