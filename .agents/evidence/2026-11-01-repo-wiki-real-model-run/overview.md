# 项目概览

## 一句话定位

`note-pocock-flow`（下称 NPF）是一个**可安装到任意仓库的 skill 包**，把两件事合成一套：用 agent note 记录「为什么」的决策中心，以及一整套 note 感知的 Matt Pocock skills 动作层。唯一完成判据是 `npm run npf -- verify` 全绿。依据：`README.md:1`、`SKILL.md:12`、`NOTE-CONTRACT.md:5-9`。

包自身版本号 `1.1.0`（`VERSION:1`）。

## 它想解决的问题

上游两份材料各自缺一半：

| 缺口 | 提供方 | 证据 |
|---|---|---|
| 推理与取舍留在聊天里，会话结束即失传；「做完了」没有可核验的含义 | 决策中心（`notes/`，提炼自 DeepSeek Harness，代码来自 czm15053/write-notes-like-deepseek） | `notes/METHOD.md:1`、`notes/METHOD.md:5-9` |
| skill 动作丰富但各自为政，无统一决策事实源，部分还依赖 tdd 当完成判据 | Pocock skills（`pocock/`，改写自 mattpocock/skills，MIT） | `pocock/UPSTREAM.txt:1-7`、`README.md:29-31` |

NPF 的答案是把「理由」和「完成」各自钉在唯一位置：理由只进 `.agents/notes/`，完成只由证据闸 + 四道校验决定（`NOTE-CONTRACT.md:7-9`、`npf-workflow.md:5-6`）。

## 边界（明确不做什么）

以下都写在文档里，属于可核验的显式边界，而不是我的推测：

- **不含 OpenSpec，不含 tdd**：本包不分发 tdd，也不调用宿主上的 `tdd` / `test-driven-development`；测试照写照跑，但验收命令走 `evidence-init` 落证据（`README.md:7`、`NOTE-CONTRACT.md:9`）。
- **不引入 Trellis**：不建 `.trellis/`、不引其 CLI/hook/AGPL 包，不建第二套 PRD/spec 真相源，不做跨平台 hook 注入（`npf-workflow.md:113-118`）。
- **不收录上游半成品**：`in-progress/*` 全部跳过（`pocock/UPSTREAM.txt:2`、`README.md:37`）。
- **不收录纯机械改动**：格式、错别字、无行为变化的样式/依赖补丁、发版打标明确不走本流程（红线表见 `notes/METHOD.md:13-21`、`SKILL.md:16-24`）。
- **不自判完成**：`brainstorm`、`visual-companion`、`code-review` 都是前置或交棒环节，不等于 done（`pocock/brainstorm/SKILL.md` 收尾段、`NOTE-CONTRACT.md:11`）。

## 组成与职责分层

`README.md:9-18` 给出了包结构表，可按「谁读」分成五层：

| 层 | 载体 | 面向 |
|---|---|---|
| 触发与合同 | `SKILL.md`、`npf-workflow.md`、`NOTE-CONTRACT.md` | 模型 |
| 方法正文 | `notes/METHOD.md` + `notes/references/*`（7 篇）+ `notes/templates/*` | 模型写 note 时 |
| 动作 | `pocock/*`（32 个 skill 目录，含新增的 `brainstorm` 与 `visual-companion`） | 宿主 skill 加载器 |
| 机器闸 | `scripts/npf-cli.ts`（794 行）、`evidence-lib.ts`、`promote-lib.ts`、`install.mjs` / `uninstall.mjs`、`notes/scripts/*`（6 个校验脚本） | 命令行 / CI |
| 示例 | `examples/README.md`（含反例） | 人 / 模型 |

模块间真实依赖与调用方向见[系统架构](./architecture.md)；安装与阅读顺序见[开发指南](./getting-started.md)。

`pocock/` 下 32 个目录与 README 声明一致：30 个 note 感知改写的 Pocock skill 加 `brainstorm`、`visual-companion` 两个新增件（`README.md:29-33`，目录列表实测吻合）。

## 源覆盖：哪些是上游、哪些是本包新增

这一节区分「文件里写着的事实」与「我根据结构做的归类」。许可声明本身来自 `README.md:20-27` 与两个 `UPSTREAM.txt`；目录归类来自文件系统结构。

| 目录 | 来源与许可（文档声明） | 快照内可核验的痕迹 |
|---|---|---|
| `notes/` | 上游 README 标 MIT，但**上游仓库无 LICENSE 文件**，`notes/UPSTREAM.txt:2` 如实记录了这一点 | `notes/UPSTREAM.txt` 列出 5 条适配差异（SKILL.md→METHOD.md、路径改写、证据闸等） |
| `pocock/` | mattpocock/skills，MIT | `pocock/LICENSE` + 每目录 `LICENSE.mattpocock`；`pocock/UPSTREAM.txt:4-7` 说明「每个 SKILL.md 两行横幅 + tdd 调用改为证据闸」 |
| `pocock/visual-companion/` | obra/superpowers，MIT | 独立 LICENSE 文件 + 独立 `UPSTREAM.txt`、`VERSION`、`SELFTEST.log` |
| `pocock/brainstorm/` | 本包自研编排 | 目录内无 `LICENSE.mattpocock`，SKILL.md 首行自述「note-pocock-flow 自研编排」 |
| `scripts/`、`NOTE-CONTRACT.md`、`npf-workflow.md`、`examples/`、`templates/` | 本包新增 | `README.md:27` 声明；`scripts/*.ts` 头部注释均为本包语义 |

改写策略是「规则只写一处」：横幅指向 `NOTE-CONTRACT.md`，30 个 skill 不再各自复制规则（`README.md:27`、`pocock/UPSTREAM.txt:6`）。

## 事实与推断必须分开看

**可直接验证的事实（快照文件内容支持）：**

1. 安装逻辑只有一份，`install.sh` / `install.ps1` 只是薄转发（`install.sh:1-11`、`install.ps1:1-21`、`scripts/install.mjs:1-13`）。
2. 证据合法性有机械定义：v2 头完整且 `exit: 0`，或旧版 `# cmd:` + `# exit: 0`；占位文件、`run.failed.txt`、手写无头文件一律不合法（`scripts/evidence-lib.ts:1-70`）。
3. 证据闸只检查未归档的 `implemented/**`：`## Verification` 必须引用 `.agents/evidence/` 下合法证据，任一份失效即红（`scripts/verify-note-evidence.ts:1-8` 与 `:45-70`）。
4. `promote` 的逐节转换规则是可执行的：Proposal→Decision 原位改名，Acceptance/Risks 折进 Consequences，含 `## Plan` 类计划节直接拒绝转换（`scripts/promote-lib.ts:1-30`）。
5. `verify` = 四道闸串跑，任一红即非 0（`scripts/npf-cli.ts:518-531`）。
6. 归档篇靠 `archived/manifest.json` 的 SHA-256 封印冻结，append-only 与 git 基线对比（`notes/references/verification.md` 第 3 条、`notes/scripts/verify-archived-agent-notes.ts:1-8`）。
7. `selftest` 真的是在路径含空格的临时仓库里回放 20+ 条契约，覆盖占位证据被拒、脱敏、自由节保留、互链不算取代、显式取代自动归档（`scripts/npf-cli.ts:657-760`）。

**属于推断（合理但未在快照内证实）：**

- 本仓库是**包源**而不是被安装的宿主仓库：`scripts/install.mjs:150-200` 会往 TARGET 写 `package.json` scripts 与 `AGENTS.md` 分工段，而本仓库根目录没有 `package.json`、`AGENTS.md`、`.github/`。由此推出 README 里的 `npm run npf -- ...` 只有在**装到目标仓库之后**才可用；在本仓库直接执行应当失败。仓库内没有留运行记录，所以这是结构推断，不是实测。
- `examples/README.md:3` 自称输出「都来自对 npf CLI 的真实运行」，但快照内没有对应的终端输出或测试产物，无法交叉验证；只能确认示例与 `promote-lib` 的转换契约、`evidence-lib` 的证据头格式自相一致。
- `notes/METHOD.md` 中「脚本除 `verify-notes.yml` 外与上游一致」（`notes/UPSTREAM.txt:8`）需要与上游逐行 diff 才能确认，快照内只有自述。

## 快照覆盖不到的地方

- **未包含**：`package.json`、`AGENTS.md`、`.github/workflows/`、任何 `node_modules` 或锁文件。因此依赖版本、实际 CI 是否启用、`tsx` 是否已装，都无法从本快照判定。
- **未包含**：任何 `.agents/` 运行时数据（notes、evidence、archived manifest、visual-companion 会话）。也就是说这份仓库自身**没有**决策实例；note 树的真实形态只能从 `notes/METHOD.md:35-47` 的规则与 `examples/` 的演示推断。
- **未逐行阅读**：`notes/scripts/agent-note-tree.ts` 与 `verify-agent-note-format.ts` 只读到函数级摘要，本页关于「树/格式校验」的描述主要来自 `notes/references/verification.md` 的说明文字；要写精确校验规则需再读这两个脚本。

## 读这一页之后

- 想知道模块怎么连、依赖方向如何：读[系统架构](./architecture.md)。
- 想知道怎么装、装完先读哪几个文件：读[开发指南](./getting-started.md)。
