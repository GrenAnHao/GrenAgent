# Agent Note: 把 gpt-with-taste 作为编译进 sidecar 的行为层扩展

Status: implemented

## Problem

[NB-Corp/gpt-with-taste](https://github.com/NB-Corp/gpt-with-taste) 的 GPT 行为配方只能按它自己的方式接入：
`pi install git:github.com/NB-Corp/gpt-with-taste` 装成一个独立包，靠包内根 `package.json` 的
`pi.extensions` 指向 `dist/pi/index.js`。本仓库的扩展不走这条发现路径，而是 `extensions/index.ts` 的
静态工厂清单编译进 sidecar（`cli/src/runtime.ts`、`cli/src/pi-worker.ts` 的 `extensionFactories`），
并有自己的扩展白名单（`cli/src/extension-profile.ts`）、代理侧扩展过滤（`multi-agent/embedded-runner.ts`）
和打包资源拷贝（`copyPiAdjacentAssets`）。装成独立包会同时绕过这四处：Electron 产品里不加载、子代理不继承、
asar 内读不到文本。

更麻烦的是它与已有的 `fable-behavior` 属于同一层：两者都是每轮往系统提示里塞整段行为文本。直接叠加会让
语气、自主性、协作纪律两组规则互相覆盖，模型拿到的是两份互相矛盾的指令。

## Decision

`extensions/gpt-with-taste/` 是本仓库的一个普通扩展目录，进 `allExtensions`、`namedExtensions` 与
`CORE_ALWAYS_ON`（产品常驻，子代理也加载）。它把上游 `recipe/` 的六份 Markdown 逐字落到自己目录的
`texts/`（MIT，`LICENSE` 一并保留），由 `copyPiAdjacentAssets` 在构建时拷到 `out/main/texts` 与
`out/main/chunks/texts`，`electron-builder.yml` 的 `asarUnpack` 同时解包 `out-pkg/main/texts/**`。

行为通过两个 Pi 事件实现，**文本与提醒都是请求期投影，不写会话日志**：

- `context_with_system`：把整块 `<gpt-with-taste>…</gpt-with-taste>` 挂到前导 system 消息的独立段落
  `gpt_with_taste` 上（Pi 的 section 名规范 `^[a-z][a-z0-9_-]*$`），并按「最后一条 assistant 之后的新输入 /
  已完成的协作结果」插入 `gpt-with-taste:steer` 隐藏消息（`display: false`）。角色由会话身份推断：
  有 `subagent_meta` / `PI_IS_SUBAGENT=1` / ALS origin 为 subagent → `sub`，否则 `main`；
  `GPT_WITH_TASTE_ROLE` 可显式指定（对应上游三个入口文件）。
- `before_provider_request`：兜底守卫。宿主或其它扩展用 `forceSystemPrompt` 顶掉结构化 sections 时
  （`agent-session.js` 的 `_installAgentForcedPromptProjection` 会把 system 消息折成一条 `content`），
  只在缺失时把整块补回 `instructions`（Responses / Codex）、顶层 `system`（Anthropic）或首条
  system / developer 消息（Chat Completions）。只补不改，看不懂的格式只提示一次。

生效范围按**模型 id** 判（默认 `^gpt-`，`GPT_WITH_TASTE_MODEL_PATTERN` 覆盖），不按 provider：本机 GPT 走
自建 provider id（`custom-mvrhmv0y`），上游默认的 `openai` / `openai-codex` 白名单在这里永远不命中。

与 fable-behavior 的分工写在 `extensions/_shared/taste-scope.ts`，两侧共用同一份判据：taste 生效的那一轮
（模型匹配 + 整机开关 + 分支上未 `/taste off`）fable 的 `before_agent_start` 直接返回 `undefined` 让位；
切回非 GPT 模型、`/taste off` 或 `GPT_WITH_TASTE=0` 后自动恢复。会话内开关 `/taste status|on|off|
steer on|steer off|reset` 写在会话分支的 `gpt-with-taste:state` 条目上，随分支走、resume 后仍生效。

## Alternatives considered

- **按上游方式 `pi install git:...` 装包**：上游适配器完整、可独立更新，是最省事的路线。不选：它绕过本
  产品的扩展白名单与 `copyPiAdjacentAssets`，Electron 里根本不加载；而且它与 fable-behavior 的让位规则
  无法实现——那边不知道 taste 是否存在。
- **直接改 fable-behavior，把 taste 的文本并进它的 Tier 结构**：只维护一套行为层，重复最少。不选：taste 的
  六份文本按角色（main / sub / independent）和 steer 时机划分，与 fable 的「内核 + 模式片」不是同一套维度，
  合进去要么丢角色区分，要么把 fable 改得认不出原样；上游更新时也无法整目录替换。
- **默认关闭（`GPT_WITH_TASTE=0`），要试时手动开**：风险最低，现有行为零变化。不选：用户明确要求 GPT 模型上
  默认由 taste 接管，切回 Claude 模型时 fable 自动恢复。
- **两者同时注入**：GPT 模型上既有 taste 的判断力文本又有 fable 的身份与纪律。不选：语气和自主性规则互相
  覆盖，模型行为不可预测；用户已在选择时排除。

## Consequences

- GPT 模型上的行为层变成 taste 的文本，fable 的**身份句**（「GrenAgent 的 Pi sidecar」）不再注入，
  由 taste 的 persona 段替代。
- 同一轮里还删掉了 fable 的 refusal 段（`prompts/tier2/refusal.md`：四条硬拒绝 + 授权白名单），
  所有模型都不再收到它。理由：taste 的 `recipe/` 本来就没有拒绝文本，GPT 模型上早就没这一层；
  只留在一家行为层会让同一个产品在不同模型上的护栏不一致，而护栏本来就不该靠提示词——工具闸
  （`safety` / `approval` / `sandbox`）和宿主权限才是拿得住的那一层。代价：模型侧的拒绝口径完全依赖
  基座对齐，提示词层面没有任何声明。要回到「有声明」的状态，就加在一个模型无关的位置（例如
  `diagram-hint` 那种全局注入），而不是加回某一家的行为层。
- 文本随模型切换而来回切换，GPT ↔ Claude 之间每切一次系统前缀都会变，命中不了跨模型的前缀缓存。
  这是行为分层的固有代价，不是本实现引入的。
- `texts/` 是逐字副本：上游更新需要人工整目录替换（README 写了做法与 commit）。上游若改 `recipe/` 的
  键名或文件数量，`texts.ts` 的 `TASTE_TEXT_FILES` 与测试会同时红，不会静默少注入。
- 子代理会话里的角色靠 `subagent_meta` 判断。若将来有新的子代理后端不写这个条目也不设 `PI_IS_SUBAGENT`，
  子代理会被当成 main，拿到主代理的协作文本。

## 验证

结果：通过。证据目录 `.agents/evidence/2026-10-29-gpt-with-taste-as-pi-extension/`。

`cd extensions && env -u PI_RUNTIME_CONFIG npx vitest run --maxWorkers=4`：253 文件通过 / 3 跳过，
2425 项通过 / 28 跳过（`extensions-full-green.log`）。首次不带 `env -u PI_RUNTIME_CONFIG` 跑时，
`multi-agent/runner.test.ts` 有 3 条失败，原因与本改动无关（本机 runtime config 的 `SUBAGENT_MODEL`），
清环境后单独复跑 23/23 通过。

新扩展自身：`gpt-with-taste/index.test.ts` 25 条（投影、角色路由、steer 只跟在末条 assistant 之后、
重复投影不叠加、三种报文格式的补全与幂等、范围判定、命令写分支）；`gpt-with-taste/taste-live.real.test.ts`
3 条走真实 `AgentSession` + faux 模型（`gpt-6.1-sol` / `claude-opus-5`）：请求里带 `<gpt-with-taste>`、
第二轮只有一份、会话日志里没有任何 taste 文本或 steer，非 GPT 模型交给 fable，`/taste off` 后交还。

`fable-behavior` 新增「gpt 模型上让位、`/taste off` 后恢复」用例，34/34 通过。
`extensions/index.test.ts` 钉死 `gpt-with-taste` 紧跟 `fable-behavior`，与 `prompt-metadata.test.ts` 合计
41 文件 / 459 项通过。

`cd electron-agent && npx vitest run electron/agent/copyPiAdjacentAssets.test.ts`：3/3 通过，断言
`texts/main.md` 与 `chunks/texts/sub.md` 落到产物目录、`asarUnpack` 含 `out-pkg/main/texts/**`
（`copy-assets-green.log`）。

`cd cli && node --import tsx --test src/extension-profile.test.ts`：8/8 通过（新增的 `gpt-with-taste`
在 `CORE_ALWAYS_ON`，chat profile 不剔除）；`src/agent-data-plugins.test.ts` 6/6 通过（新扩展无 manifest，
必须在 `CORE_ALWAYS_ON` 里才不被白名单丢掉）。

`cd cli && ./node_modules/.bin/esbuild src/main.ts --bundle ... --outfile=/tmp/sidecar-check.mjs`：成功，
4.4MB，确认新扩展进了 sidecar 的静态图。新文件的定向 TypeScript 检查（临时 tsconfig，含实现与测试）退出码 0。

**未验证**：`npx electron-vite build --mode localrun`（dev 产物）在拷贝 `pi-job-guard.exe` 时报 EBUSY——本机有正在运行的 dev 实例占用 `out/main/pi-job-guard.exe`，这一条不需要确认（同一份代码已用生产构建验证）。生产构建
`npx electron-vite build` 通过：`out-pkg/main/texts/` 与 `out-pkg/main/chunks/texts/` 各有六份 Markdown 加
`LICENSE`，`chunks/extensions-*.jsc` 里能查到 14 处 taste 标记（`prod-build-assets.log`）。
但没有启动打包产物（electron-builder 出包后跑起来）验证 asar unpack 下读取，也没有在真实会话里用 GPT 模型
看一眼 `/taste status`——这两条需要在关掉运行中的 dev 实例后补跑。
