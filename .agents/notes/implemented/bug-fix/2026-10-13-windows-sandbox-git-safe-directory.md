# Agent Note: Windows 沙箱里 git 因所有权检查全部失败，注入 safe.directory 信任工作区

Status: implemented

## Problem

Windows 沙箱里的命令以 PiSandbox 账户运行，工作区归真实用户所有。git 2.35.2 起的所有权检查（`safe.directory`）把这种情况判为不可信，工作区里每条 git 命令都报：

```
fatal: detected dubious ownership in repository at 'C:/Users/rxstudio/AppData/Local/Temp/sbx-git-…'
… is owned by: …/rxstudio (S-1-5-21-…-1000) but the current user is: …
```

2026-10-13 在沙箱里实测（`D:\Kits\Git\cmd\git.exe`，机器级 git 2.54）：不注入时 `git init && git status` 退出码 128，`commit`、`log` 跟着失败。这与是哪份 git 无关，只要工作区不归 PiSandbox 所有就会失败，所以沙箱里的 git 一直不可用，而 git 是最常用的命令。项目里没有任何 `safe.directory` 处理（`rg` 过 `safe.directory`、`dubious`、`GIT_CONFIG_COUNT`，只有 `extensions/working-directory/worktree.ts` 用 `GIT_CONFIG_COUNT` 传别的配置）。

同一轮探测还看到另一个独立的失败：PATH 上先命中 `E:\depot_tools\git.bat`，它最终调用装在用户目录里的 SourceTree 自带 git，沙箱账户读不了它旁边的 `etc\gitconfig`（`Permission denied`）。那是这台机器 PATH 顺序加用户目录安装造成的，本篇不处理。

## Decision

`extensions/_shared/sandbox/env.ts` 导出 `withGitSafeDirectory(env, workspaceRoot)`，用 git 自己的环境变量配置注入两条 `safe.directory`：工作区本身，和 `<工作区>/*`（工作区下面的仓库）。`safe.directory` 只认系统级、全局级和命令行级配置，环境变量配置属于命令行级，实测有效。

- 路径写成 git 比较用的样子：正斜杠，不带结尾斜杠。
- 已有 `GIT_CONFIG_COUNT` 时在其后追加，不覆盖调用方传的配置；计数不是正整数时从 0 开始。
- 不修改传入的对象。
- 不用 `*`，也不放开工作区以外的路径。`<工作区>/*` 这种写法要 git 2.46 以上才认，更老的 git 只信工作区本身。

`operations.ts` 的 `exec` 在受限运行、平台为 `win32` 时，对过滤后的环境调用它，再写入 `PS_CWD_GUARD_ENV`。非 Windows（命令以同一个用户运行，没有所有权问题）和不受限运行不动。

## Alternatives considered

- **在 PiSandbox 的全局 gitconfig 里写 `safe.directory = *`** — 最强理由：一次配置、永久生效，所有 git 调用都受益，不依赖每条命令的环境。没选是因为 `*` 对沙箱账户可能碰到的任何仓库都放行，包括工作区以外的；而且要写 PiSandbox 的家目录，得再管一份状态，环境变量方式随命令走、范围就是工作区。
- **`safe.directory=*` 经环境变量注入** — 最强理由：写法最简单，不用处理路径格式。没选是因为范围比需要的宽，用工作区路径同样有效（已实测）。
- **让 PiSandbox 成为工作区所有者或加进所有者组** — 最强理由：从根上消除所有权不一致。没选是因为改所有者要碰用户的文件，风险和范围都大得多。
- **调整 PATH 顺序，让沙箱优先命中机器级 git（原计划的 B 方案）** — 最强理由：能绕开用户目录里的 SourceTree git 读不到 `etc\gitconfig`。没选是因为它只对这台机器 PATH 里 depot_tools 排前面的情形有用，对通用的所有权问题没有帮助，而且改变沙箱里工具的解析顺序是更大的行为变化。
- **`GIT_CONFIG_NOSYSTEM=1` 绕过读不了的系统配置** — 最强理由：一行就让 SourceTree 那份 git 能跑。没选是因为会丢掉系统级配置里的 `core.autocrlf`、凭据助手等设置，改变 git 的行为。

## Consequences

收益：
- 沙箱里工作区内的 git 命令可以正常工作，范围只限工作区及其下的仓库。

代价和已知缺口：
- `safe.directory` 的本意是挡住别的用户在你的目录里放带恶意配置的仓库。这里信任的是用户自己选的工作区，沙箱本来就在它里面运行，风险没有增加；但工作区下被沙箱命令自己克隆或放入的仓库，在 git 2.46 以上也被信任。
- 更老的 git（比如 SourceTree 自带的 2.46.0，刚好在边界上）可能不认 `/*`，嵌套仓库仍报所有权错误，只有工作区根上的仓库可用。
- 装在用户目录里的 git 仍然读不到自己的系统配置，见 Problem 最后一段，没有解决。
- 探针里用的 `D:\Kits\Git` 路径只是这台机器的情况，live 用例用 `PI_SANDBOX_LIVE_GIT` 传入，没设置就跳过。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| `withGitSafeDirectory`：两条条目、路径格式、追加不覆盖、非法计数、不改入参 | `cd extensions && npx vitest run _shared/sandbox/env.test.ts` | 通过 |
| `exec` 只在受限的 Windows 运行注入，不受限和非 Windows 不动 | `npx vitest run _shared/sandbox/operations.test.ts` | 通过 |
| 沙箱整体单测 | `npx vitest run _shared/sandbox` | 通过，162 项（10 项跳过） |
| 真机端到端：沙箱账户在别人拥有的工作区里 `init`、`commit`、`log` | `PI_SANDBOX_LIVE=1 PI_SANDBOX_LIVE_GIT='D:\Kits\Git\cmd\git.exe' npx vitest run _shared/sandbox/isolation.live.test.ts --testTimeout=180000` | 通过：整个文件 9 项通过、1 项跳过（强制分配失败那项） |

红的基线：把注入那几行临时改回去，同一个 live 用例失败，输出 `fatal: detected dubious ownership in repository at 'C:/Users/rxstudio/AppData/Local/Temp/sbx-git-…'`；还原后通过。基线输出没有存成文件，记在这里。

另有一次不经 `exec`、直接用 provider 的探针：不注入时退出码 128（`dubious ownership`）；注入 `safe.directory=<工作区>` 后 `init`、`commit`、`log` 退出码 0；注入 `*` 也是 0。

证据：`.agents/evidence/2026-10-13-windows-sandbox-git-safe-directory/`（`unit.txt`、`live.txt`）。

没有覆盖：
- git 2.46 以下对 `<工作区>/*` 的行为，没有在沙箱里实测。
- 工作区下嵌套仓库的实测。
- 其他依赖所有权检查的工具。

结果：通过（上面“没有覆盖”的项除外）。

相关：[受限令牌](../architecture/2026-10-13-windows-sandbox-restricted-token-authenticated-users.md)（同一轮里发现这两个 git 失败与令牌无关）。
