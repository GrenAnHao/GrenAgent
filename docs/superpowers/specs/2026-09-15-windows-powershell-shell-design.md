# Windows `bash` 工具改走 PowerShell

- 日期：2026-09-15
- 状态：已按 2026-09-15 评审修订（见文末 §10 评审补记：4 项阻断级缺口已闭环），可进 writing-plans
- 主题：Windows 上 Agent 的 `bash` 工具不再启动 Git Bash / WSL `bash.exe`，改为原生 PowerShell；模型与 `!` 命令按 PowerShell 语法书写。Linux / macOS 仍是 bash。
- 对照：修订 `docs/superpowers/specs/2026-09-12-os-sandbox-design.md` §4.5 的 Windows shell 定位；不改五档审批、`confine`、helper 实现。对齐 Codex Desktop 在 Windows native 上默认 PowerShell，而不是内置 Git。

> **裁决记录（2026-09-15）**
>
> - **壳 = 原生 PowerShell**：优先 `pwsh.exe`，否则 Windows PowerShell 5.1。不用 `cmd.exe` 当默认。
> - **语法 = PowerShell**：不把 POSIX 原样塞进 `pwsh`，不做 POSIX→PS 翻译，不内置 Git / BusyBox。
> - **工具名仍叫 `bash`**：官方工具、UI 卡片、历史会话不改名。
>
> **评审补记（2026-09-15，实测后追加，详见 §10）**
>
> - **输出编码 = 命令前注入 UTF-8 前缀**：PowerShell 在 stdio pipe 下默认输出 ANSI/GBK，必须注入 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;`（实测有效），否则中文乱码且 `denialSignatures` 的「拒绝访问」匹配失效。
> - **退出码 = 提示词约定，不自动注入**：`powershell -Command` 不传播原生命令退出码（实测 `cmd /c exit 3` → 1），由描述与提示词要求模型写 `; exit $LASTEXITCODE`。
> - **提示词 = 同时覆盖 `promptSnippet` / `promptGuidelines`**：只改 tool `description` 不够，SDK 的 `snippet`「Execute bash commands (ls, grep, find, etc.)」会进系统提示。

## 1. 背景与目标

2026-09-15 在本机复现：Pi 的 `bash` 走 `confine` 后包 `pi-sandbox-win.exe`，再启动 `C:\Windows\System32\bash.exe`（Microsoft Bash Launcher）。受限令牌无法 `Bash/Service/CreateInstance`，stderr 为无 BOM 的 UTF-16LE「拒绝访问。错误代码: Bash/Service/CreateInstance/E_ACCESSDENIED」，`Buffer.toString()` 显示成乱码。Git Bash（`D:\Kits\Git\bin\bash.exe`）在同一 helper 下是 `couldn't create signal pipe, Win32 error 5`。`isolation.live.test.ts` 已注明此事，生产路径却仍 spawn bash。

对照实验：同一 helper 下 `powershell.exe -NoProfile -Command`、`pwsh.exe -NoProfile -Command`、`cmd.exe /c` 均可 exit 0 并列出目录。

OS 沙箱规格 §4.5 写「Windows 上解析到的 `bash.exe` 或 `pwsh.exe`」，实际 `resolveShellPath` 只找 bash。本规格把 Windows 默认壳钉死为 PowerShell。

### 成功标准

1. Windows 上 `resolveShellPath()` 返回 `pwsh.exe` 或 `powershell.exe` 的绝对路径，**永不**把 `System32\bash.exe` / Git Bash 当作默认壳。
2. 受限档（非「完全权限」）下，`bash` 工具能执行只读 PowerShell（至少 `Write-Output` 与 `Get-ChildItem`）并拿到 UTF-8 可读输出，不再出现 CreateInstance 乱码。
3. spawn argv 为 `[shell, "-NoProfile", "-NonInteractive", "-Command", <UTF-8 前缀 + command>]`，不是 `[bash, "-c", command]`。前缀只影响传给壳的脚本，工具入参与 `pendingDenial` 记录的仍是原始 `command`。
4. 系统提示（含 SDK 注入的 `promptSnippet`）与 bash 工具 description 写明 Windows 用 PowerShell 语法；`plan` / Ask 的 `isSafeCommand` 放行只读 cmdlet，拦截 `Remove-Item` 等破坏性 cmdlet 及其别名。
5. Linux / macOS 行为不变：仍 `bash -c`，无编码前缀。
6. 实现拆除 2026-09-15 调试会话埋点（`debugLog` / ingest fetch），并清理因此变成未使用的 `source` 变量与 `isLegacyWslBashPath` 导入。
7. 中文验收：本机跑 `Write-Output "中文"` 与 `Write-Error "中文错误"`，stdout / stderr 字节为 `e4b8ad...`（UTF-8），不是 `d6d0cec4`（GBK）；原生命令退出码 `cmd /c exit 3; exit $LASTEXITCODE` 得到 3。

### 非目标

- 不内置 Git、MinGit、PortableGit、BusyBox。
- 不改 helper.c 让 MSYS/WSL 在 `WRITE_RESTRICTED` 下能启动。
- 不把工具改名为 `powershell` / `pwsh`。
- 不翻译 POSIX（`ls -la`、`grep`、`find`、`&&`）为 PowerShell。
- 不自动追加 `exit $LASTEXITCODE`（会掩盖 cmdlet 非终止错误），只做提示词约定。
- 不改造 helper 的命令行拼接，不引入 `-EncodedCommand`。
- 不改 PTY 终端、子代理壳、网络沙箱。
- 不要求每台机器安装 PowerShell 7；5.1 必须能跑。

## 2. 已确认的设计决定

| 维度 | 决定 |
| --- | --- |
| 默认壳 | `pwsh.exe`（where 到则用）→ 否则 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` |
| 不用 | `cmd.exe` 默认；`System32\bash.exe`；Git Bash |
| argv | `-NoProfile -NonInteractive -Command`（5.1 没有 bash 式 `-c`） |
| 编码 | `-Command` 的脚本前固定注入 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;`（win32 only） |
| 退出码 | 不自动追加 `exit $LASTEXITCODE`；由工具描述与提示词要求模型显式书写 |
| 语法 | 模型与 `!` 用户命令写 PowerShell |
| 链式 | 提示词要求用 `;`，不依赖 `&&`（5.1 无 `&&`） |
| 工具名 / UI | 仍 `bash`；卡片仍 `bash · <命令>` |
| 误解析到 bash.exe | 受限档继续拒绝 spawn（现有 `WINDOWS_BASH_UNAVAILABLE`），不静默改跑 PowerShell 之外的 bash |
| UTF-16 | 保留 `decodeSpawnChunk`（其他来源仍可能吐宽字符） |
| 传参 | 继续 `-Command` 明文传参。**已排除 `-EncodedCommand`**：实测 helper 的 `quoteArg` 命令行往返对 8 类含引号 / 反斜杠 / 管道 / 多行的命令与直连结果逐字节一致，无转义损失 |
| 沙箱 | 继续 `confine` 包装 PowerShell argv；helper 与五档不变 |

## 3. Shell 解析

改 `extensions/_shared/sandbox/shellPath.ts` 的 win32 分支。

顺序写死：

1. `where.exe pwsh.exe` 的第一条**非存根**命中，且文件存在。Store 版 PowerShell 只在 `%LOCALAPPDATA%\Microsoft\WindowsApps\` 放一个 0 字节的 App Execution Alias，`existsSync` 对它是 true 但 spawn 会失败——与 `System32\bash.exe`（WSL launcher）是同一类陷阱。命中判断：`exists(path) && statSync(path).size > 0`；路径含 `\Microsoft\WindowsApps\` 直接跳过。
2. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`（`SystemRoot` / `WINDIR` 缺省 `C:\Windows`），且文件存在。
3. 若都没有：返回该 5.1 路径字符串（与现今回退 `"bash.exe"` 同类；实际 Windows 必有 5.1）。**禁止**再回退到 WSL / Git Bash。

同时删除（不再参与默认解析，避免死代码）：

- `DEFAULT_BASH_PATHS` 常量与 `git.exe` → `bin\bash.exe` 推导分支。
- `resolveShellPath` 里的 `source` 变量——它只供已拆除的调试日志使用，留下会成为未使用变量。
- `operations.ts` 对 `isLegacyWslBashPath` 的导入。该函数的现有调用点只有调试日志；**受限档拒绝分支用的是 `isWindowsBashExe()`（正则 `(bash|sh).exe$`）**，不是它。函数本身保留在 `shellPath.ts` 并继续被单测覆盖。

`spawnWhere` / `spawnWhereAll` / `getWindowsSearchPath`（走 5.1 查注册表 PATH）继续复用，不重写。

测试：

- 注入 `which("pwsh.exe")` → 用 pwsh 绝对路径。
- 无 pwsh、`exists` 命中 5.1 路径 → 用 5.1。
- `which("bash.exe")` 即使返回 `System32\bash.exe` 也不当选。
- `which("pwsh.exe")` 返回 `...\Microsoft\WindowsApps\pwsh.exe` 时跳过，落到 5.1。

## 4. Spawn

改 `extensions/_shared/sandbox/operations.ts`。

```ts
const PS_UTF8_PREFIX = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\n";

function shellArgv(platform: NodeJS.Platform, shell: string, command: string): string[] {
  if (platform === "win32") {
    return [shell, "-NoProfile", "-NonInteractive", "-Command", PS_UTF8_PREFIX + command];
  }
  return [shell, "-c", command];
}
```

前缀是**必需的，不是美化**：

- 实测（2026-09-15，本机 5.1 与 pwsh 7 各跑一遍）：Node `stdio: ["ignore","pipe","pipe"]` 下，`Write-Output "中文"` 的 stdout 字节是 `d6d0cec4`（GBK/ANSI），按 UTF-8 解成「锟斤拷」。加前缀后为 `e4b8ade69687`，无 BOM。
- stderr 同理。这直接影响 `attribute.ts` 的 `denialSignatures`（含「拒绝访问」）——GBK 下中文拒绝信息匹配不上，拒写会被漏判成普通失败。
- pwsh 7 上 stdout 与 stderr 的默认编码还不一致（实测 stdout GBK、stderr UTF-8），不能靠「用 7 就没事」绕开。
- 前缀用 `\n` 与用户命令分隔：5.1 的错误记录会回显出错语句，独占一行可避免前缀混进报错文案。

`confine` 与完全权限都走 `shellArgv`。现有「win32 + 受限 + `bash.exe`/`sh.exe` → 不 spawn」保留（判定函数是 `isWindowsBashExe`，不变）。

`pendingDenial` 与 `bash_escalate` 的「同一条命令」比对继续用**原始** `command`（工具入参），不比对加前缀后的脚本——前缀对所有调用恒定，两边一致，无需改动。

测试：win32 的 `spawnImpl` 收到 `-NoProfile`、`-NonInteractive`、`-Command`，且 `-Command` 的值以 UTF-8 前缀开头、结尾是原命令；linux 仍 `-c` 且无前缀。

## 5. 提示词与工具描述

工具名不变，必须改「写什么」。

1. `extensions/sandbox/index.ts`：`createBashToolDefinition(...)` 返回后，若 `process.platform === "win32"`，在注册前覆盖三处（都在返回对象上直接改写，`agent-session` 在收集工具时读取的是 definition 上的这三个属性）：
   - `description` 末尾追加一段（英文，给模型）：Windows 上本工具运行 PowerShell（`pwsh` 或 5.1），`command` 必须是 PowerShell，禁止 POSIX `ls -la` / `grep` / `find` / `&&`；列目录用 `Get-ChildItem`，搜内容用 `Select-String`，读文件用 `Get-Content`，链式用 `;`；跑构建 / 测试等原生命令时结尾补 `; exit $LASTEXITCODE`，否则真实退出码会丢（PowerShell 只会回 1）。
   - `promptSnippet`：默认值为 SDK 的 `bashToolSystemPromptContribution.snippet = "Execute bash commands (ls, grep, find, etc.)"`，它会进系统提示并在 Windows 上教错语法，必须换成 PowerShell 版本（如 "Execute PowerShell commands (Get-ChildItem, Select-String, Get-Content, etc.)"）。
   - `promptGuidelines`：数组里追加同一段 Windows 语法约束（默认数组只有一条 PI_* 环境变量说明，追加而非替换）。
   
   只改 `description` **不够**：`promptSnippet` / `promptGuidelines` 由 `agent-session.js:2135-2146` 在收集工具时读取，与 `description` 是两个通道。
2. `extensions/fable-behavior/prompts/tier2/terminal-harness.md`：Bash 链式 `&&` 改为分平台——POSIX 仍 `&&`；Windows 用 PowerShell 与 `;`。
3. `extensions/fable-behavior/prompts/tier2/tool-discipline.md`：同样改「Chain dependent bash with `&&`」。

`!` 用户命令无模型描述：Windows 上 `!ls -la` 按 PowerShell 执行并可能失败，不翻译、不改 UI 提示（本规格不做输入框帮助文案）。

## 6. `isSafeCommand`（plan / Ask）

`extensions/agent-mode/utils.ts` 的白名单是 POSIX。Windows 上模型写 `Get-ChildItem` 会被 plan/Ask 拦下。必须补：

**放行（行首 cmdlet，大小写不敏感）：**  
`Get-ChildItem`、`Get-Content`、`Get-Item`、`Select-String`、`Get-Location`、`Get-Command`、`Get-Help`、`Test-Path`、`Resolve-Path`、`Get-Date`、`Get-Process`、`Write-Output`、`Write-Host`、`Measure-Object`。现有 POSIX 行首 `ls` / `pwd` / `cat` / `echo` 仍放行（PowerShell 上分别是别名）。

**拦截（加入 `DESTRUCTIVE_PATTERNS`，沿用现有全文 `\b` 匹配的保守风格）：**  
`Remove-Item`、`Move-Item`、`Copy-Item`、`New-Item`、`Rename-Item`、`Set-Content`、`Add-Content`、`Set-Item`、`New-ItemProperty`、`Stop-Process`、`Start-Process`、`Invoke-WebRequest`、`Invoke-RestMethod`、`Out-File`、`Set-Location`、`Clear-Content`、`Clear-Item`、`Remove-ItemProperty`、`Set-ExecutionPolicy`、`Start-Service`、`Stop-Service`、`Restart-Computer`。`Set-Location` 只影响该次 spawn，plan / Ask 仍当非只读拦。

**必须一并拦的别名**（PowerShell 上它们是同一个写操作，只拦全名等于漏拦）：`del`、`erase`、`rd`、`rmdir`、`rm`（已有）、`copy`、`move`、`ni`、`sc`、`ac`、`ri`、`mi`、`ci`、`clc`、`cli`、`rd`。

现有 `>` / `>>` 破坏性规则保留（`2>&1` 一类的 PowerShell 重定向同样命中）。`git status` 等现有 git 只读规则保留。

测试：新建 `extensions/agent-mode/utils.test.ts`。当前仓库**没有** `isSafeCommand` 的用例（`plan.test.ts` / `modes.test.ts` 都未覆盖它）。至少覆盖：`Get-ChildItem` 放行、`Get-Content .\a.txt | Select-String "x"` 放行、`Remove-Item` / `del` / `Set-Content` / `Out-File` 拦截、POSIX 用例不受影响。

## 7. 与 OS 沙箱规格的关系

修订口径（实现时在 `2026-09-12-os-sandbox-design.md` §4.5 加一句指针即可，不必重写整份）：

> Windows 默认壳与 argv 以 `2026-09-15-windows-powershell-shell-design.md` 为准：PowerShell `-Command`，不是 Git Bash `-c`。

`confine`、helper、五档、`bash_escalate` 不变。live isolation 测试继续用 `cmd.exe` 测 ACL 即可；可另加一条 PowerShell `Set-Content` 拒写断言（需确认 `denialSignatures` 的「拒绝访问」在 UTF-8 前缀生效后可命中），非必须。

另在 §4.5 补一句边界：`cli/scripts/patch-pi-shell.mjs` 打的是 SDK `dist/utils/shell.js`（官方 `createLocalBashOperations` 的壳解析）。我们的 `operations.exec` 自己解析壳并 spawn，**不经该 patch**，本规格不改动它；若将来 Pi 启用官方 `powershell` 工具（`createPowerShellToolDefinition`），它也走 SDK 自己的解析，与本规格无关但需按 OS 沙箱规格 §4.5 接入同一 `operations`。

## 8. 实现落点

| 文件 | 职责 |
| --- | --- |
| `extensions/_shared/sandbox/shellPath.ts` | win32 解析 pwsh → 5.1；删 `DEFAULT_BASH_PATHS` / git.exe 分支 / `source` |
| `extensions/_shared/sandbox/shellPath.test.ts` | 解析顺序、「不选 WSL bash」、跳过 WindowsApps 存根。**现有 3 条 win32 用例（注入 which → Git Bash、WSL 回退）全部失效，需重写** |
| `extensions/_shared/sandbox/operations.ts` | `shellArgv` + UTF-8 前缀；删 `debugLog` 与 4 处调用、`isLegacyWslBashPath` 导入 |
| `extensions/_shared/sandbox/operations.test.ts` | 新增 win32 标志与前缀断言；第 1 条「spawns [shell, -c, command]」改为按平台；「refuses Windows bash.exe」「decodes UTF-16LE」两条保留并核对是否仍贴合 |
| `extensions/sandbox/index.ts` | Windows 下覆盖 `description` + `promptSnippet` + `promptGuidelines` |
| `extensions/fable-behavior/prompts/tier2/terminal-harness.md` | 分平台语法 |
| `extensions/fable-behavior/prompts/tier2/tool-discipline.md` | 链式 |
| `extensions/agent-mode/utils.ts` | PowerShell 只读 / 破坏性模式 + 写别名 |
| `extensions/agent-mode/utils.test.ts`（新建） | `isSafeCommand` 的 PowerShell 用例 |
| `docs/superpowers/specs/2026-09-12-os-sandbox-design.md` | §4.5 指针 + patch-pi-shell 边界 |

## 9. 风险

- **退出码失真**：实测 `powershell -Command "cmd /c exit 3"` 的进程退出码是 **1**，不是 3；`exit $LASTEXITCODE` 才拿到 3。构建 / 测试（`tsc`、`vitest`、`pnpm build`）的真实退出码会丢。本规格选择靠提示词约定而**不自动注入**——自动注入会把 cmdlet 非终止错误（`Get-ChildItem` 找不到路径时 `$LASTEXITCODE` 仍为 0）掩盖成 0。残留风险：模型漏写时只看到 exit 1。
- 只装 Store 版 pwsh 的机器：`where pwsh` 可能只命中 App Execution Alias 存根，靠 §3 的 size 检查落到 5.1（5.1 必须能跑，已在非目标）。
- 5.1 的错误记录会回显出错语句；前缀独占一行已把这种噪音限制在首行。
- 模型仍写 `ls -la`：PowerShell 可能报参数错误。靠 description + 提示词，不翻译。
- `pwsh` 与 5.1 语言不完全相同：提示词按两者交集写（`;`、完整 cmdlet 名）。5.1 无 `&&`、无 `??` / 三元，模型按交集写即可。
- plan 白名单漏网：未列入的只读 cmdlet 会被拦，宁可漏放行不可漏拦截。

## 10. 评审补记（2026-09-15）

结论：方向成立，但原稿有 4 项阻断级缺口，已在本文 §1–§9 就地修正。**不要按原稿进 writing-plans。**

| 级别 | 缺口 | 修正落点 |
| --- | --- | --- |
| B1 | 成功标准 2「拿到 UTF-8 可读输出」在原设计下不成立。实测 5.1 与 pwsh 7 在 `stdio: pipe` 下输出 GBK（`d6d0cec4`），按 UTF-8 解成「锟斤拷」；GBK 还会让 `denialSignatures` 的「拒绝访问」匹配失效，拒写被漏判 | §2 / §4：固定注入 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;`；§1 成功标准 7 给出字节级验收 |
| B2 | 退出码语义与 bash 不同，构建 / 测试真实退出码丢失（实测 `cmd /c exit 3` → 1） | §2 / §5 / §9：工具描述与提示词要求 `; exit $LASTEXITCODE`，并写明不自动注入的理由 |
| B3 | 只改 tool `description` 覆盖不到系统提示。SDK 的 `promptSnippet`「Execute bash commands (ls, grep, find, etc.)」与 `promptGuidelines` 由 `agent-session.js:2135-2146` 读取 | §5：win32 同时覆盖 `description` / `promptSnippet` / `promptGuidelines` |
| B4 | `isSafeCommand` 只列 cmdlet 全名，漏掉 PowerShell 写别名（`del` / `rd` / `copy` / `move` / `ni` / `sc` / `ac` / `ri` / `mi` / `ci`）；且仓库当前没有该函数任何用例 | §6：补全名 + 别名；新建 `extensions/agent-mode/utils.test.ts` |

同时修正的三处事实性错误：

1. 原 §3 称「`isLegacyWslBashPath` 供 operations 保险分支使用」——operations 的受限档拒绝分支用的是 `isWindowsBashExe()`；拆调试埋点后前者在 operations 里只剩未使用导入。
2. 原 §9 称 5.1「编码更易 UTF-16」——实测是 ANSI/GBK，`decodeSpawnChunk` 的 UTF-16 分支对它无效。
3. 原 §6 未说明新增模式加在 `DESTRUCTIVE_PATTERNS` 还是 `SAFE_PATTERNS`——已明确为前者。

已排除的替代方案：`-EncodedCommand`（base64 传参）。实测 helper 的 `quoteArg` 命令行往返对 8 类含引号 / 反斜杠 / 管道 / 多行的命令与直连 spawn 结果逐字节一致，无转义损失，不需要额外引入不可读的 base64 传参。
