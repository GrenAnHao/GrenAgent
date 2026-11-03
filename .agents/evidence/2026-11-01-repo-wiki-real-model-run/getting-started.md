# 开发指南

本页只写能从仓库内的 README、安装脚本与脚本源码读出来的东西：安装流程、安装器实际做了什么、装完怎么自检、以及按什么顺序读剩下的文档。所有命令都带出处；仓库里没有出现过的命令一律不写。包的整体定位见 [项目概览](./overview.md)，模块与依赖关系见 [系统架构](./architecture.md)。

## 0. 前置条件

| 条件 | 依据 |
|---|---|
| Node ≥ 18 | `README.md:47`；安装器硬检查 `scripts/install.mjs:94-95`；两个外壳脚本只检查 `node` 是否在 PATH（`install.sh:7`、`install.ps1:13`），真正裁决版本的是 `install.mjs` |
| 目标必须是一个已存在的目录 | `scripts/install.mjs:96` |
| `tsx` 不要求预装 | 安装器会在缺失时自行安装，或按 `--no-tsx` 跳过（`scripts/install.mjs:196-215`） |

一个容易误判的点：**本包仓库自身没有 `package.json`**（全仓 glob `package.json` 无结果），也没有 `pyproject.toml`/`Makefile`。`npm run npf -- …` 这类命令之所以可用，是因为安装器把这些 scripts 写进了**宿主仓库**的 `package.json`（`scripts/install.mjs:180-194`）。所以在包仓库里直接敲 `npm run npf` 不会成立。

## 1. 安装 / 升级

两个外壳脚本只负责转发参数，逻辑只有一份（`README.md:47`、`install.sh:10`、`install.ps1:16-20`）：

```powershell
# Windows / PowerShell 7（或 Windows PowerShell 5.1）
pwsh -File .\note-pocock-flow\install.ps1 -Target D:\path\to\repo [-Force] [-DryRun] [-SkipVerify] [-NoTsx]
```

```bash
# Linux / macOS / Git-Bash
bash note-pocock-flow/install.sh /path/to/repo [--force] [--dry-run] [--skip-verify] [--no-tsx]
```

| 参数 | 作用 | 出处 |
|---|---|---|
| `-Target` / 第一个位置参数 | 宿主仓库路径，缺省为当前目录 | `install.ps1:8`、`install.sh:9` |
| `--force` | 覆盖「同名但非本包托管」的 skill（原目录先备份） | `scripts/install.mjs:6`、`README.md:58` |
| `--dry-run` | 只打印将要做什么，不写任何文件 | `scripts/install.mjs:7`、`:270`（dry-run 直接退出） |
| `--skip-verify` | 装完不跑 `verify` / `doctor` | `scripts/install.mjs:8`、`:243` |
| `--no-tsx` | 不往宿主 devDependencies 装 `tsx`，之后由 `npx` 临时下载 | `scripts/install.mjs:9`、`README.md:89` |

退出码有语义（`scripts/install.mjs:10-11`）：`0` 成功，`1` 失败，`2` 存在未托管的同名 skill 冲突且**未改动任何文件**。

## 2. 安装器实际做了什么

按 `scripts/install.mjs` 的执行顺序，安装一次会做这些事：

1. **前置检查**：Node 主版本 < 18 或目标不是目录即失败（`scripts/install.mjs:94-98`）。
2. **冲突扫描**：遍历 `pocock/` 下每个子目录，目标 `.agents/skills/<name>` 不存在 → 新装，带本包标记且内容不同 → 升级，存在但非托管 → 冲突。有冲突且没 `--force` 时打印清单并以码 2 退出，**一个文件都不改**（`scripts/install.mjs:100-113`）。
3. **复制包本体**到 `.agents/skills/note-pocock-flow`，只复制白名单条目：`SKILL.md`、`README.md`、`VERSION`、`NOTE-CONTRACT.md`、`npf-workflow.md`、`.gitattributes`、两个 `install.*`、`bin`、`notes`、`pocock`、`scripts`、`templates`、`examples`；`SELFTEST.log`、`.DS_Store`、`node_modules`、`.git` 与 `*.zip` 一律跳过（`scripts/install.mjs:39-42`、`:50-52`、`:74`）。从已安装位置再次运行会跳过这一步（`scripts/install.mjs:130`）。
4. **装入子 skill**：`pocock/<name>` → `.agents/skills/<name>`，并写入托管标记 `.npf-managed`（含包名与版本），同时归一 `.sh` 行尾与非 Windows 平台的可执行位（`scripts/install.mjs:150-158`、`:80-88`；`.gitattributes` 规定 `*.sh`、`bin/npf` 为 LF，`*.ps1` 为 CRLF）。
5. **建目录骨架**：`.agents/notes/{proposed,implemented,rejected,archived} × {feature,bug-fix,simplification,architecture,process,testing}`，空目录写 `.gitkeep`；另建 `.agents/evidence`、`.agents/visual-companion`（`scripts/install.mjs:144-157`）。
6. **追加 `.gitignore`**：缺则补 `.agents/visual-companion/` 与 `.agents/.npf-backup/`（`scripts/install.mjs:174-177`）。
7. **写 package.json scripts**：`verify-notes`、`archive-agent-note`、`check-anchors`、`build-board`、`npf`（`scripts/install.mjs:183-189`）。若同名 script 已存在且不是本包写入的，保留用户版本并打印警告「npf 命令可能不可用，请人工合并」（`scripts/install.mjs:190-191`）——这是安装后 `npf` 跑不通的首要嫌疑点。
8. **装 tsx**：已在依赖里则跳过；否则按锁文件探测 pnpm / bun / yarn / npm 并安装，失败即让安装失败（`scripts/install.mjs:196-215`）。
9. **维护 `AGENTS.md` 分工段**：以 `<!-- note-pocock-flow:begin … -->` / `<!-- note-pocock-flow:end -->` 为界整段替换，无标记则追加；有 begin 无 end 只警告不改文件（`scripts/install.mjs:218-235`，段内容模板见 `templates/AGENTS.section.md`，当前横幅版本 `v1.1.0`，与 `VERSION` 文件一致）。
10. **自检**：`--dry-run` 或 `--skip-verify` 到此结束（退出 0），否则依次跑 `npf verify` 与 `npf doctor`，任一非 0 即安装失败（`scripts/install.mjs:243-253`）。

所有备份都落在 `.agents/.npf-backup/<时间戳>/`，不在 `skills/` 下留重复目录（`README.md:59`、`scripts/install.mjs:35-37`）。

## 3. 装完先做的三件事

```bash
npm run npf -- doctor     # 托管 skill 是否齐全/最新、同名冲突、备份残留、npm scripts、CRLF、证据新鲜度
npm run npf -- verify     # 树 + 格式 + 归档封印 + 证据闸，四道闸全绿才算完成
npm run npf -- status     # 当前相位面包屑 + 下一步
```

- `verify` 的实现就是顺序跑四个脚本，任一红即整体非 0（`scripts/npf-cli.ts:516-531`）；脚本清单与各自校验内容见 `notes/references/verification.md`。
- `doctor` 必须在「已安装」的仓库里运行，否则直接报错退出（`scripts/npf-cli.ts:598-599`）。
- 包自身回归用 `npm run npf -- selftest [--keep]`：在路径含空格的临时仓库里回放 20+ 条契约，`--keep` 保留临时仓库便于排查（`scripts/npf-cli.ts:747-756`）。
- 想只跑证据闸：`npm run npf -- gate`（`scripts/npf-cli.ts:522`）。
- 要在 CI 里复现同一套检查：`npm run verify-notes` 是四段 `npx tsx` 的串联（`scripts/install.mjs:184`）；GitHub Actions 模板在 `notes/templates/verify-notes.yml`，里面显式设置 `AGENT_NOTE_ARCHIVE_BASE_REF` 为变更前的 commit，否则 append-only 检查等于没查（该文件注释；`notes/references/verification.md` 亦然）。

## 4. 卸载

```bash
node .agents/skills/note-pocock-flow/scripts/uninstall.mjs [--dry-run]
```

移除：带 `.npf-managed` 标记的子 skill、`.agents/skills/note-pocock-flow`、`package.json` 里指向本包路径的 scripts、`AGENTS.md` 的 note-pocock-flow 分工段。
保留：`.agents/notes/`、`.agents/evidence/`、未托管的同名 skill、`tsx` 依赖。被移除的目录先移到 `.agents/.npf-backup/uninstall-<时间戳>/`（`scripts/uninstall.mjs:7-13`、`:34-58`；`README.md:63-68`）。

## 5. 阅读顺序

包根 `SKILL.md` 已给出「按需读，不必全读」的映射表（`SKILL.md:36-43`），照它读即可，不要从头线性读 30 个子 skill。推荐顺序：

| 顺序 | 读什么 | 什么时候读 | 依据 |
|---|---|---|---|
| 1 | `README.md`（本页的上游事实源） | 只做安装/升级/卸载 | `README.md:44-103` |
| 2 | `SKILL.md` | 要判断「这次改动到底走不走流程」——机械改动的红线表在此 | `SKILL.md:10-19` |
| 3 | `npf-workflow.md` | 需要相位合同、意图路由、禁止跳步 | `SKILL.md:40`、`npf-workflow.md:1-126` |
| 4 | `NOTE-CONTRACT.md` | 要用/改 `pocock/*` skill，需要各 skill 与 note 的接口和交棒规则 | `SKILL.md:41`、`NOTE-CONTRACT.md:1-54` |
| 5 | `notes/METHOD.md` → `notes/references/` | 真正开始写 note：格式、六个分类、原地改 vs 新建、取代与归档 | `SKILL.md:42`、`notes/METHOD.md:1-193` |
| 6 | `examples/README.md` | 想先看一遍完整走通的样子，以及反面教材 | `SKILL.md:34`、`examples/README.md:1-151` |
| 7 | `README.md` CLI 段 + `npm run npf -- --help` | 需要全部参数 | `SKILL.md:43`、`scripts/npf-cli.ts:761-773` |

按角色取用：**只安装不改代码** → 1 即可；**第一天就要写第一篇 note** → 1 → 2 → 5 → 6；**要改本包或接 skill** → 1 → 4 → `notes/references/verification.md`（校验脚本细节）与 `notes/METHOD.md`。

## 6. 日常命令（全部有出处，未出现的命令不要臆造）

```bash
npm run npf -- status
npm run npf -- new-note --title "…" --class <feature|bug-fix|simplification|architecture|process|testing>
npm run npf -- supersede-check --note <path|slug>
npm run npf -- evidence-init --note <slug|路径> --cmd "真实验收命令"
npm run npf -- promote --note <slug|路径> [--dry-run] [--supersedes <旧 implemented>]
npm run npf -- archive --note <implemented 路径> [--superseded-by <新 note>]
npm run npf -- verify
npm run npf -- list | doctor | selftest [--keep] | gate
npm run npf -- --help
```

来源：`SKILL.md:22-33`、`npf-workflow.md:118-126`、`scripts/npf-cli.ts:761-773`。参数细节以 `--help` 输出为准（`scripts/npf-cli.ts:5`）。

可选替代入口 `bin/npf`：按脚本自身位置定位包目录，然后 `exec npx --yes tsx <包>/scripts/npf-cli.ts "$@"`，等价于 `npm run npf -- <cmd>`（`bin/npf:2-8`）。CLI 内部调子脚本时会优先复用当前 `tsx` loader，其次本地可解析的 `tsx/cli`，最后才回落到 `npx`（`scripts/npf-cli.ts:78-112`）。

视觉伴侣的启停命令只在 `README.md:96-101` 出现过：

```powershell
pwsh -File .agents/skills/visual-companion/scripts/start-server.ps1 -ProjectDir . -Open
pwsh -File .agents/skills/visual-companion/scripts/stop-server.ps1 <session_dir>
```

```bash
bash .agents/skills/visual-companion/scripts/start-server.sh --project-dir . --open
```

## 7. 环境变量（会影响装完后的行为）

| 变量 | 作用 | 出处 |
|---|---|---|
| `AGENT_NOTE_ROOT` | 覆盖 notes 根，缺省 `<cwd>/.agents/notes` | `scripts/npf-cli.ts:27` |
| `AGENT_EVIDENCE_ROOT` | 覆盖证据根，缺省 `<cwd>/.agents/evidence` | `scripts/npf-cli.ts:28` |
| `NPF_EVIDENCE_MAX_BYTES` | 证据输出保留的尾部字节数，缺省 64KB | `scripts/npf-cli.ts:31` |
| `AGENT_NOTE_ARCHIVE_BASE_REF` | 归档 append-only 检查的 git 基线，本地缺省 HEAD | `notes/references/verification.md` |
| `AGENT_NOTE_CODE_ROOT` | `check-anchors` 扫描源码的根，缺省 cwd | `notes/references/verification.md` |

## 8. 不确定的点（已核对，但不该由本页拍板）

1. **视觉伴侣会话目录的文档自相矛盾。** `pocock/visual-companion/visual-companion.md:6` 写的是「Session files live under `.agents/visual-companion/` (not `.agents/visual-companion/`)」——括号里外是同一个路径，明显是上游仓库改名时替换残留。安装器实际创建的是 `.agents/visual-companion`（`scripts/install.mjs:165`），`README.md:103` 也是这个。本页按安装器与 README 走；那段文档建议修。
2. **安装末尾的 `verify` 对宿主既有内容没有豁免。** `scripts/install.mjs:249-250` 只在 `verify` 非 0 时报错退出，没看到对「宿主本来就有 implemented note」的特殊处理。因此在已有 note 的老仓库里首次安装，如果那些 note 缺合法证据，安装可能以失败告终。这是从代码顺序推断的，未实测；规避路径是先用 `--skip-verify` 装上，再单独排查 `verify` 红在哪一道闸。
3. **`build-board` 的 `--init board.html 工程决策看板` 只在安装器写 script 时出现**（`scripts/install.mjs:187`），README 的 CLI 段落没有展开它；具体行为需要读 `notes/scripts/build-board.ts` 才能确认，本页不下结论。
4. **`install.sh` 的第一个位置参数与 `--target` 的关系**：`install.sh:9` 只把「不以 `--` 开头」的第一个参数当目标，其余原样转发给 `install.mjs`；`install.mjs:28` 既认 `--target` 也认这个位置参数。两条路径同时给时谁优先，代码上看是 `--target` 先取（`val("--target") || positional`），但这不是文档承诺的行为，别依赖它。
5. **本页没有覆盖的**：`pocock/*` 各 skill 的具体规则（属 `NOTE-CONTRACT.md` 与各 `SKILL.md` 正文）、note 的文风与语义自检（属 `notes/references/prose-checklist.md`、`quality-gate.md`），以及子 skill 的启停条件（多数带 `disable-model-invocation: true`，只能由人输入 `/name` 触发，见 `NOTE-CONTRACT.md` §4）。
