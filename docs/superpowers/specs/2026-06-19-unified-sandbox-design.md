# 统一沙箱层（Unified Sandbox · WSL2 + sandbox-runtime）设计

- 日期：2026-06-19
- 状态：已废弃（2026-09-12 起以 `2026-09-12-os-sandbox-design.md` 为准；不再走 WSL2 + srt，不可用时不再降级宿主）
- 主题：把 `extensions/safety/sandbox.ts` 的 `SandboxAdapter` 桩落地为一个**统一沙箱层**，给「代码/命令执行」提供真隔离的执行环境，被 code-exec、im-platforms、multi-agent、safety 四处复用。Windows 优先，后端走 WSL2 内的 `@anthropic-ai/sandbox-runtime`。

## 1. 背景与目标

当前项目**没有**真正的容器/沙箱：
- `extensions/safety/sandbox.ts` 只是 `NoopSandbox`（`isEnabled()=false`），注释预留 `@anthropic-ai/sandbox-runtime` / gondolin。
- 现有"隔离"全在宿主机进程内：safety 策略闸（`SAFETY_READONLY` / `SAFETY_DENY_TOOLS` / 受保护路径 / 危险命令确认）、multi-agent 进程级隔离（`process` 已实现、`worktree` 已实现、`sandbox` 抛 "P4 未支持"）、code-exec 用 `node:vm`（**非安全沙箱、可逃逸**）+ Python 子进程，都在宿主权限内跑。
- 触发点：微信 bot 接入后，外部/无主人消息可驱动一个能写文件、执行代码的 agent（等于远程 RCE）。已临时用 owner-gated「无主人=受限只对话（deny-based）」兜底，但这是**禁用**而非**隔离**。

### 调研：Claude Code / Codex 怎么做（2026）

业界**不堆 VM/容器**，用 OS 级原语 + workspace 绑定 + 网络代理：
- **Codex**：macOS Seatbelt；Linux bubblewrap + seccomp + `PR_SET_NO_NEW_PRIVS` + namespace unshare（legacy Landlock）；**Windows 仅 restricted-token 弱限制**；模式 read-only / workspace-write（默认，写 workspace+tmp、`.git` 只读、网络可选）/ danger-full-access；网络 unshare + 代理桥 + 域名白名单。
- **Claude Code**：开源 `@anthropic-ai/sandbox-runtime`（`anthropic-experimental/sandbox-runtime`，npm 包，`npx @anthropic-ai/sandbox-runtime <cmd>`）。macOS Seatbelt；**Linux 和 WSL2：bubblewrap + socat（网络代理）+ 可选 seccomp**；文件写限定 cwd、其余 bind-mount 只读（**不复制 workspace**）；网络移除命名空间、全走宿主代理白名单。**Windows 原生尚不支持，但 WSL2 内等同 Linux。**

启示：① 强隔离 = OS 原语 + workspace 绑定 + 网络代理，不必复制工作区；② Windows 上要拿到 Claude/Codex 级隔离，正路就是 WSL2；③ stub 注释里的 `@anthropic-ai/sandbox-runtime` 就是 Claude 同款、开源可复用——**包一层**即可，不必从零搓 bubblewrap。

### 成功标准（用户确认）

1. **统一**：一个 `SandboxAdapter`，code-exec / im-platforms / multi-agent / safety 四处复用同一契约。
2. **Windows 优先**：后端走 WSL2 + `@anthropic-ai/sandbox-runtime`（bubblewrap + seccomp + 网络代理）。
3. **强隔离（文件 + 执行）**：workspace 用 `/mnt` bind-mount 可写、其余只读、网络默认关 + 白名单。
4. **优雅降级 + 自动安装**：检测不到 WSL2/依赖 → 回退现有 deny-based 策略闸（不阻断）+ 面板引导一键安装。
5. **能力分级延续**：无主人微信会话从"禁执行"升级为"沙箱内可执行"；沙箱不可用则维持 deny。

### 关键决策（来自评审问答）

- 范围：**B（文件+执行强隔离）**，具体形态采 **B1**——WSL2 里包 `@anthropic-ai/sandbox-runtime`，workspace 用 `/mnt` bind-mount（非复制）。
- 后端唯一聚焦 **WSL2**（Windows 原生原语太弱，Windows Sandbox 太重/临时/Pro-only，均排除）。
- 不可用时 **优雅降级 + 一键安装**（`wsl --install` 需管理员/重启，引导而非静默）。
- 网络**默认关**，白名单经 srt 代理放行（对标 Codex/Claude 默认）。

### 非目标（YAGNI）

- 不在沙箱内常驻 JS/Python 内核（先一次性 exec；常驻为后续）。
- 不做 B2（复制 workspace 进 WSL ext4 + diff 回传）——先 `/mnt` bind；大仓/重 IO 再说。
- 不做 macOS/Linux 原生后端（Seatbelt / 原生 bwrap）——接口留口，后补。
- 不做 C（整个 sidecar 进 WSL）——架构改动过大。
- 不在 Windows 原生用 restricted-token（弱且复杂，直接走 WSL2）。

## 2. 架构总览

```
消费者（code-exec / im-platforms / multi-agent / safety）
   └─ getSandbox(): SandboxAdapter        // _shared/sandbox/，进程内单例 + 探测缓存
        ├─ WslSandbox（可用时）
        │     exec(cmd, {cwd, writableRoots, network, timeoutMs})
        │       1) Win 路径 → /mnt（D:\proj → /mnt/d/proj）
        │       2) settings 与命令各落盘宿主 temp（转 /mnt 路径），组
        │            wsl -d <distro> --cd <wslCwd> -- bash -lc \
        │              "srt --settings '<settings>' bash '<cmd.sh>'"
        │       3) 捕获 stdout/stderr/code 回传，清理 temp
        │     后端：WSL2 内 @anthropic-ai/sandbox-runtime = bubblewrap(文件) + seccomp + socat(网络代理) + ripgrep(srt 运行时依赖)
        └─ NoopSandbox（不可用时）isAvailable()=false → 消费者走 safety deny-based 降级

setup（Tauri 命令 + 连接面板）
   "沙箱未就绪 [一键安装]" → wsl --install（管理员/重启）→ distro 内 apt-get install bubblewrap socat
                                                          + npm i -g @anthropic-ai/sandbox-runtime
```

数据流：`消费者 → getSandbox().exec() → WslSandbox 转路径+组 srt 命令 → wsl 执行（bwrap+seccomp+proxy）→ 回 {stdout,stderr,code}`。文件经 `/mnt` bind-mount（workspace rw、其余 ro）；网络默认关、白名单经 srt 代理。

## 3. 组件

### 3.1 `extensions/_shared/sandbox/index.ts`

放 `_shared`（已有 `runtime-config.ts` 先例），因被多扩展复用，避免耦合到单个扩展。

```ts
export interface SandboxSpec {
  cwd: string;                       // Windows workspace 路径
  writableRoots?: string[];          // 默认 [cwd]
  network?: "none" | { allowDomains: string[] };  // 默认 "none"
  timeoutMs?: number;
}
export interface SandboxResult { stdout: string; stderr: string; code: number; }
export interface SandboxAdapter {
  isAvailable(): Promise<boolean>;
  exec(command: string, spec: SandboxSpec): Promise<SandboxResult>;
}
export function getSandbox(): SandboxAdapter;  // 进程内单例；按平台+探测结果返回 WslSandbox 或 NoopSandbox
```

保留并扩展现有 `safety/sandbox.ts` 的 `SandboxAdapter`/`NoopSandbox`（迁移到 `_shared`，`safety` re-export 兼容）。

### 3.2 `srt.ts` / `wsl.ts` — settings 生成 + WslSandbox

- `winToWslPath("D:\\a\\b")` → `/mnt/d/a/b`（纯函数，单测；`paths.ts`）。
- `buildSrtSettings(spec, wslCwd)` → srt **settings JSON**：`filesystem.{denyRead,allowWrite,denyWrite}` + `network.{allowedDomains,deniedDomains}`；写默认拒（仅放开 workspace + `/tmp`），网络默认拒（空 allowlist）（纯函数，单测；`srt.ts`）。
- `exec()`：经 `prepare()` 把 settings 与命令各落盘宿主 temp（转 WSL 路径），组 `wsl.exe -d <distro> --cd <wslCwd> -- bash -lc "srt --settings '<settings>' bash '<cmd.sh>'"`，注入式 `run`（便于单测），捕获三元组后清理 temp。
  - **命令落盘**（非内联 argv）：规避 Windows 命令行长度上限、免转义；经**登录 shell**（`bash -lc`）解析 srt/node 的自定义 PATH。

### 3.3 `detect.ts` / `index.ts` — 可用性探测

- `parseWslDistros(stdout)` + `pickDistro(distros, preferred?)`：解析 `wsl.exe -l -v` 找可用 v2 distro（纯函数，单测；`detect.ts`）。
- distro 内探测 `srt`/`bwrap`/`socat`/`rg`（`command -v`）——**`rg`(ripgrep) 是 srt 运行时依赖，缺则会误判可用、运行时炸**。
- `getSandbox()` 工厂（`index.ts`）：正缓存长期有效、负缓存带 TTL（装好依赖后自愈），`resetSandboxCache()` 显式失效；驱动 `isAvailable()` 与面板状态。
- `wslExec`：剔 NUL 字节 + UTF-8 解码——`wsl.exe` 自身输出（`-l -v`）是 UTF-16LE、子命令（`-d .. -- ..`）输出是 UTF-8，统一处理。

### 3.4 setup — 引导安装

- Tauri 命令 `sandbox_status` / `sandbox_install`（`src-tauri/src/commands/`）。
- 连接/设置面板新增"沙箱"卡片：状态（就绪 / 缺 WSL2 / 缺依赖）+ [一键安装]。
- 安装流程：`wsl --install`（管理员、提示重启）→ 重启后 distro 内 `apt-get install -y bubblewrap socat && npm i -g @anthropic-ai/sandbox-runtime`。分步、可见、可重试；失败回报原文。

## 4. 执行路由（关键）

pi 扩展能力：`tool_call` 可拦截/改 `event.input`、`tool-override`（替换工具）、`setActiveTools()`、`registerTool()`。

- **code-exec `js_run`/`py_run`**（自有工具，完全可控）：沙箱开启时把代码经 srt/WSL 里的 node/python 跑（工具名不变，对 agent 透明）。
- **内置 `bash`**：优先用 tool-override 透明改路由进 srt；若运行时"override 返回结果"不可用，**回退**为：沙箱模式下 safety `tool_call` 禁用内置 `bash` + 自有 `sandbox_sh` 工具（经 srt 执行）替代，system prompt 引导用 `sandbox_sh`。（实现期先验证 tool-override 能力，二选一。）
- **文件越界**：内置 `write`/`edit` 跑在宿主、绕不过 bwrap，故沙箱模式下由 safety 把可写范围锁到 workspace（`SAFETY_READONLY=1` + `SAFETY_WRITE_ALLOW=<workspace>`）。workspace 同时是 bind-mount 目标 → 宿主侧写与沙箱内写指向同一份、视图一致。
- **网络**：默认 `none`；白名单经 srt 代理放行。

## 5. 三处复用

- **im-platforms（无主人/受限）**：当前是"禁 exec/code/写"。沙箱可用时升级为"允许，但只在沙箱内执行"（`sandbox_sh` + 沙箱化 code-exec，写仍锁 workspace）；不可用则回退现有 deny-only。owner 直连仍可选完整能力。
- **multi-agent `isolation:"sandbox"`**：不再抛 "P4 未支持"。子代理的 exec 经 `getSandbox().exec()`；其能力档案（capability.ts 的 fs/net/tools）映射到 SandboxSpec（writableRoots/network）。
- **safety**：① 沙箱不可用时的降级执行策略（deny-based）；② 沙箱模式下宿主文件工具的 workspace 锁兜底。两者互补。

## 6. 配置

| key | 默认 | 说明 |
| --- | --- | --- |
| `SANDBOX_ENABLE` | `auto` | `off`=总关闭（NoopSandbox）；其余（auto/on）=走探测，不可用则降级。**on 与 auto 当前等价**（子进程注入 `on` 仅表「非 off」以触发路由；设计预想的「on 强制报错」未实现） |
| `SANDBOX_NET` | `none` | none / allowlist |
| `SANDBOX_ALLOW_DOMAINS` | 空 | 逗号分隔域名（allowlist 时生效） |
| `SANDBOX_DISTRO` | 自动选 | 指定 WSL distro |
| `SANDBOX_WRITABLE_ROOTS` | workspace | 逗号分隔；默认仅 workspace |

经 `_shared/runtime-config.ts` 读取，热更新。

## 7. 错误处理

- WSL/依赖缺失 → `isAvailable()=false` → 降级（不抛给用户）；面板提示安装。
- 不可用时一律静默降级（含 `SANDBOX_ENABLE=on`）：当前 `on` 与 `auto` 等价，均走探测、不可用回 `NoopSandbox`；面板 SandboxCard 引导安装。（设计预想的「on 强制报错」未实现。）
- srt 退出码透传为 `SandboxResult.code`；超时 kill WSL 子进程（沿用 multi-agent 的 idle/hard timeout 思路）。
- 路径转换失败（非 `/mnt` 可达，如 UNC/网络盘）→ 报错并提示把 workspace 放本地盘。

## 8. 测试

- `winToWslPath` / `buildSrtSettings` / `parseWslDistros` + `pickDistro`：纯函数单测。
- `WslSandbox.exec`：注入 `run` + `prepare`，断言 argv 组装（`bash -lc "srt --settings '...' bash '...'"`、cwd 映射）、结果三元组、超时、temp 清理。
- 降级路径：`NoopSandbox.isAvailable()=false` + 消费者回退 deny-based 的单测。
- 端到端：真 WSL2 手动验证（exec 隔离、写越界被拦、网络默认不通、白名单放行）。

## 9. 风险 / 待验证（实现期解决）

- **tool-override 能否"返回结果"替换内置 bash 执行**：决定走"透明 override"还是"禁 bash + sandbox_sh"。先验证，二选一，不阻塞其余设计。
- **`/mnt` IO 性能**：大仓/重 IO 可能慢；本期接受，后续可加 B2（复制 ext4）作为可选档。
- **srt 在 WSL2 的安装与版本**：`@anthropic-ai/sandbox-runtime` 需 bwrap+socat(+seccomp helper)；安装流程要稳。
- **WSL2 首装需重启**：一键安装体验分两步（装 WSL → 重启 → 装依赖），面板要能识别"已装 WSL 待装依赖"的中间态。
