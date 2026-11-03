# gpt-with-taste

把 [NB-Corp/gpt-with-taste](https://github.com/NB-Corp/gpt-with-taste) 的行为配方编进 GrenAgent 的扩展包。
与上游 `pi install git:github.com/NB-Corp/gpt-with-taste` 二选一：本仓库的扩展是编译进 sidecar 的工厂清单，
装成独立包会绕过 `copyPiAdjacentAssets` 的文本拷贝和扩展白名单。

## 做什么

每轮请求把整块行为文本挂到 Pi 前导 system 消息的独立段落 `gpt_with_taste` 上，并在「最后一条 assistant
之后的新输入 / 已完成的协作结果」后面插入隐藏的 steer 提醒（`display: false`）。文本与提醒都是请求期投影，
**不写会话日志**：后台唤醒、goal 续跑不会重复累积整段文本。

`before_provider_request` 还有一道守卫：宿主或其它扩展用 `forceSystemPrompt` 顶掉结构化 sections 时，
把整块补回报文。只补不改，已有指令、工具声明、结果正文一律保持原样。

## 与 fable-behavior 的关系

两者都是行为层。taste 生效的那一轮由它接管，fable 让位；切回非 GPT 模型、`/taste off` 或
`GPT_WITH_TASTE=0` 后 fable 自动恢复。判据在 `extensions/_shared/taste-scope.ts`，两侧共用同一份。

因此 GPT 模型上**不再有** fable 的身份句（「GrenAgent 的 Pi sidecar」），由 taste 的 persona 段替代。
拒绝清单已从 fable 的核心里移除（原 `prompts/tier2/refusal.md`），两家行为层都不写这类内容；
护栏由 `safety` / `approval` / `sandbox` 的工具闸与宿主权限承担，理由见
`.agents/notes/implemented/feature/2026-10-29-gpt-with-taste-as-pi-extension.md`。

## 生效范围

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `GPT_WITH_TASTE` | `1` | 整机开关，`0` 关闭 |
| `GPT_WITH_TASTE_MODEL_PATTERN` | `^gpt-` | 按模型 id 匹配（不区分大小写，可用正则） |
| `GPT_WITH_TASTE_ROLE` | 空 | 显式角色 `main` / `sub` / `independent`，对应上游三个入口文件 |

角色默认按会话身份推断：会话里有 `subagent_meta`、`PI_IS_SUBAGENT=1` 或 ALS origin 为 subagent → Sub。

## 命令

`/taste status`（默认）、`/taste on`、`/taste off`、`/taste steer on`、`/taste steer off`、`/taste reset`。
状态写在会话分支的 `gpt-with-taste:state` 条目上，随分支走、resume 后仍生效。

## 文本来源

`texts/` 下六份 Markdown 逐字取自上游 `recipe/`（commit `079fb26`，MIT，见 `LICENSE`）。
上游更新时整目录替换后跑 `npx vitest run gpt-with-taste`。
