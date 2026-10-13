# Agent Note: 宿主自己在工作区里跑 git 时加固

Status: implemented

## Problem

沙箱账户对工作区有修改权，能改 `.git/config`、`.gitattributes`、放一个 `git.exe`（[工作区配置保护](2026-10-13-windows-sandbox-workspace-config-protection.md)只保护了 `.pi/.vscode/.idea`，`.git` 没有，原因见那篇）。而 Pi 宿主以**真实用户**身份，在没人点任何东西的时候就在这个工作区里跑 git：文件浏览器每次加载文件树都 `git status`，git 面板跑 status/diff/branch/log。这些调用会执行工作区里写好的东西：

- `core.fsmonitor`：配置里的一条命令，`git status` 会运行它。
- `.gitattributes` 指派的 `filter.<名>.clean`：`status`、`diff` 比较内容时会运行。`diff.<名>.textconv` 同理。
- hooks：`.git/hooks/*`，建分支触发 `reference-transaction`。
- Windows 对不带路径的程序名先在子进程的当前目录里找 `.exe`：子进程的当前目录是工作区时，工作区根里的 `git.exe` 会被当成 git 运行。实测（默认环境，没有 `NoDefaultCurrentDirectoryInExePath`）会被打中；这台机器设了这个变量，所以日常没中。
- partial clone 缺对象时的按需拉取会按 `remote.<n>.uploadpack`、`core.sshCommand` 去运行命令。
- 子模块有自己的配置（`.git/modules/<m>/config`），`git status` 会递归进去运行它的 filter。

## Decision

所有宿主自己发起的 git 调用走 `extensions/_shared/git-safe.ts` 的 `runSafeGit(工作区, 参数, {mode})`，接入点是 `gitService.ts`（面板的 status/diff/branches/log/checkout/createBranch）、`fileService.ts`（文件树的 status），`working-directory/worktree.ts` 也改成用同一份环境清洗和前缀。

每次调用：

- 子进程当前目录是 Temp，仓库用 `git -C <工作区>` 指；sandbox 写不进用户 Temp 的根目录。
- 环境清洗：去掉 `GIT_DIR/WORK_TREE/COMMON_DIR/INDEX_FILE/…/CONFIG/CONFIG_COUNT/KEY_n/VALUE_n/PARAMETERS`，加 `GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`、`GIT_NO_LAZY_FETCH=1`。用户自己的 `GIT_CONFIG_GLOBAL/SYSTEM` 保留（工作区碰不到）。
- `-c core.fsmonitor=false -c log.showSignature=false`，automatic 模式再加 `-c core.hooksPath=NUL`（非 Windows 是 `/dev/null`）。
- automatic 模式下，凡可能运行 filter 的子命令（不在 `rev-parse/branch/log/show-ref/check-ref-format/config/symbolic-ref` 里的），先 `git config --show-scope --null --name-only --get-regexp ^filter\.` 列出驱动，把 **local/worktree/command 范围定义**的驱动的 clean/smudge/process 用 `GIT_CONFIG_COUNT/KEY_n/VALUE_n` 置空、`required` 置 false。global/system 里定义的驱动（典型是 LFS）保留。名字为空的驱动（`[filter ""]`，`.gitattributes` 写 `filter=` 选中）也在其中。
- automatic 模式下 `status`/`diff`（不含 `--no-index`）自动加 `--ignore-submodules=dirty`：子模块的驱动列不出来。子模块指针变化仍然报告，只是不再显示子模块工作区里的脏状态。
- `diff` 的调用方另加 `--no-textconv --no-ext-diff`。
- 列驱动的退出码不是 0 或 1（超时、输出超限、配置损坏）时直接抛错，不放行。
- 错误信息带原因（没装 git、超时、输出超限），不再只剩 `failed: `。

两种模式：`automatic`（默认，宿主自己发起）和 `user`（用户点的 checkout、建分支）。`user` 保留 hooks 和 filter：那是用户自己的工作流，LFS 的 smudge 关掉检出的就是指针文本。宿主分不出哪个 hook 是被放进去的，这是留下的缺口。

### 没有封住的

- **先列驱动、再执行是两个进程，各读一次 `.git/config`（TOCTOU）。** 沙箱每 15ms 交替写一份含 `[filter "evil"]`、一份不含的 config，再配上 `.gitattributes`，评审时实测 60 次 `status` 里 evil 的 clean 执行了 63 次（config 固定时是 0 次）。代码层面封不住；要在系统层面不让沙箱账户写 `.git/config`、`config.worktree`、`.git/modules/<m>/config`。这一条没有做。
- **`gitdir:`、`include.path`、`core.worktree`、`core.excludesFile`、`objects/info/alternates` 可以指向 `\\host\share`**，宿主会以真实用户身份访问那个共享，可能带出 NTLM 凭据。这是推断，没有实测网络。
- 宿主自己环境里的 `GIT_EXTERNAL_DIFF`、`GIT_PAGER`、`GIT_SSH*`、`GIT_EXEC_PATH`、`GIT_TRACE*` 按可信处理。
- 以后的 git 若支持写在配置里的 hooks（`hook.<name>.command`），`core.hooksPath` 管不到。
- `user` 模式下，被放进去的 hook 或 filter 照跑。
- 用户自己在终端或编辑器里敲的 git、`terminalService` 允许的 `git` 命令不经过这里。
- global/system 里的驱动被保留，所以如果用户机器上的全局配置本身有问题，不在范围内。

## Alternatives considered

- **一律置空所有 filter 驱动（第一版就是这样）** — 最强理由：不依赖范围信息，简单，也不用考虑谁定义的。评审实测不行：本机系统 gitconfig 里装了 `filter.lfs`，LFS 仓库里只是改过时间戳的文件，原生 `status` 显示干净（clean 过滤出的指针和索引一致），置空后变成 ` M`；`GIT_OPTIONAL_LOCKS=0` 不刷新索引，误报一直留着。所以改成只置空工作区范围里定义的。
- **给 `diff`/`status` 加 `--no-filters` 之类的开关** — git 没有这个选项。
- **用 `--attr-source` 让 git 不读工作区的 `.gitattributes`** — 最强理由：直接掐断“指派”这一步，不需要列驱动，也就没有 TOCTOU。没用是因为它要 git ≥ 2.40，行为在 status 与 worktree 比较里的覆盖面没有验证过，而且 `info/attributes` 仍会被读。
- **让沙箱账户不能写 `.git/config`**（上一篇的“保护 `.git`”） — 最强理由：从源头堵死，宿主和用户自己的终端都受益。上一篇做过一版，绕得过去（`.git` 里能新建文件），撤掉了；完整保护的成本是每个仓库几秒的 ACL 遍历，且要处理 git 自己写 config 时的 lockfile 加 rename。这仍然是封住 TOCTOU 的唯一办法，本篇没做。
- **宿主完全不跑 git，改用 libgit2 / isomorphic-git** — 最强理由：不执行任何外部程序。没用是因为不识别 LFS、行尾转换等，状态和 git 面板的结果会和用户终端里的不一致。
- **automatic 模式的 `status` 去掉 `GIT_OPTIONAL_LOCKS=0`，让它顺手刷新索引** — 会让宿主的读操作写 `.git/index`，和用户同时跑 git 时会抢 `index.lock`。没用。

## Consequences

收益：
- 默认环境里，工作区的 `git.exe` 不再被宿主运行（测试里是一份 `whoami.exe` 的副本，有对照）。
- `fsmonitor`、filter（本地配置、空名驱动、子模块各一条）、textconv、hooks、按需拉取的环境变量都挡住，每一类都有“原生 git 会执行”的对照。
- LFS 之类用户自己的驱动保留，LFS 仓库的状态不变坏。
- `worktree.ts` 与宿主共用同一份清洗和前缀，两边不再各写一份；顺手补上了它此前没有的当前目录问题。

代价：
- 每次 `status`/`diff` 多起一个 git 进程（列驱动），约 30–60 ms；`branch/log/rev-parse` 等不需要的不起。
- 子模块在文件树里不再显示“工作区里有改动”，只显示指针变化。
- `GitService` 的测试每条要起好几个真实 git 进程，整套并行时会超过 5 秒，所以 describe 级别加了超时（30s/60s）。
- “没有封住的”一节列出的口子仍在，其中 TOCTOU 在沙箱账户能写 `.git/config` 的前提下是真实可利用的。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 环境清洗（含保留 GLOBAL/SYSTEM、清 PARAMETERS、`GIT_NO_LAZY_FETCH`）、前缀、驱动解析（含空名）、按范围筛驱动、置空环境 | `cd extensions && npx vitest run _shared/git-safe.test.ts` | 27 项通过；先红后绿 |
| 真实 git：fsmonitor、clean filter、空名驱动、子模块自己的 filter、textconv、automatic 模式的 hooks 都不执行，每条有原生 git 会执行的对照；user 模式保留 filter 和 hooks；global 里的驱动保留（LFS 式误报用例）；列驱动失败时抛错；超时有原因；`-C` 取仓库；Windows 上工作区的 `git.exe` 不被运行 | 同上 | 同上；子模块用例去掉 `--ignore-submodules=dirty` 后变红，还原后通过 |
| worktree 重构后行为不变，加 Windows 上工作区 `git.exe` 不被运行 | `npx vitest run working-directory/worktree.test.ts` | 20 项通过 |
| 宿主服务接线：面板 status/diff/checkout/createBranch、文件树 status | `cd electron-agent && npx vitest run electron/app/gitService.test.ts electron/app/fileService.test.ts` | 14 项通过 |
| 扩展包整体 | `cd extensions && npx vitest run _shared working-directory` | 469 通过、22 跳过、1 超时：`deleteSemantics.test.ts` 在并行负载下超过默认 5 秒，单跑通过，与 git 无关 |
| 宿主整体 | `cd electron-agent && npx vitest run electron/app` | 670 通过、5 失败；5 项是上一个提交上就失败的 `subagentService`/`taskViewService`（见证据 `baseline.txt`） |
| 类型检查 | 临时 tsconfig（strict、`noUnusedLocals`）对 `git-safe/worktree/gitService/fileService` 跑 `tsc` | 通过 |
| 独立评审 | 一个没看过实现的评审在临时仓库里用标记文件逐条实测 | 提出的 8 条：TOCTOU（记入没封住的）、子模块 filter、按需拉取、空名驱动、LFS 误报、测试超时与清理、注释说过头、错误原因丢失，除 TOCTOU 外都已修并有测试 |

证据：`.agents/evidence/2026-10-13-host-git-hardening/`。
