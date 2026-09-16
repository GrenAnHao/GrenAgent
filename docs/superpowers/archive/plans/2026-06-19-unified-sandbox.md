# 统一沙箱层（WSL2 + sandbox-runtime）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把 `SandboxAdapter` 桩落地为统一沙箱层——Windows 上经 WSL2 内 `@anthropic-ai/sandbox-runtime`(`srt`) 隔离命令/代码执行（bubblewrap + seccomp + 代理白名单），被 code-exec / im-platforms / multi-agent / safety 复用；不可用时优雅降级到现有 deny-based 策略闸。

**架构：** `extensions/_shared/sandbox/` 暴露 `getSandbox(): SandboxAdapter`，可用时返回 `WslSandbox`（把命令组装为 `wsl -d <distro> --cd <wslCwd> -- srt --settings <tmp.json> bash -lc <cmd>`，settings 写 `filesystem.allowWrite=[wslCwd,/tmp]` + `network` 默认拒/白名单），否则返回 `NoopSandbox`（`isAvailable=false`）。消费者在沙箱可用时把执行路由进去，否则走 safety deny。

**技术栈：** TypeScript（ESM，`.js` 导入）、vitest（co-located `*.test.ts`）、`node:child_process`、WSL2、`@anthropic-ai/sandbox-runtime`(`srt`)、Tauri（Rust commands + React 面板）。

**规格：** `docs/superpowers/specs/2026-06-19-unified-sandbox-design.md`

---

## 文件结构

新增（核心层 `extensions/_shared/sandbox/`）：
- `types.ts` — `SandboxSpec` / `SandboxResult` / `SandboxAdapter` 接口。单一职责：契约。
- `paths.ts` — `winToWslPath()` 纯函数（`D:\a\b` → `/mnt/d/a/b`）。
- `srt.ts` — `buildSrtSettings()` 纯函数（SandboxSpec → srt settings JSON）。
- `detect.ts` — `parseWslDistros()` / `pickDistro()` 纯函数（解析 `wsl -l -v`）。
- `wsl.ts` — `WslSandbox`（实现 `SandboxAdapter`，注入式 `run` 便于单测）。
- `noop.ts` — `NoopSandbox`。
- `index.ts` — `getSandbox()` 单例工厂 + re-export；`__resetForTest()`。
- 各自的 `*.test.ts`。

修改（消费者接线）：
- `extensions/safety/sandbox.ts` — 改为从 `_shared/sandbox` re-export（保持旧导入不破）。
- `extensions/code-exec/index.ts` — `js_run`/`py_run` 沙箱路由。
- `extensions/im-platforms/index.ts` — 无主人会话用沙箱执行（替代纯 deny）。
- `extensions/multi-agent/index.ts` — `isolation:"sandbox"` 不再抛错，走沙箱。
- `extensions/safety/index.ts` — 沙箱模式 workspace 写锁兜底（复用现有 readonly/write-allow）。

桌面（setup/UI）：
- `tauri-agent/src-tauri/src/commands/sandbox.rs` — `sandbox_status` / `sandbox_install`。
- `tauri-agent/src-tauri/src/lib.rs` — 注册上面两个 command。
- `tauri-agent/src/features/connections/SandboxCard.tsx` — 状态卡 + 一键安装。
- `tauri-agent/src/lib/pi.ts` — 两个 command 的前端封装。

---

## Phase 0：spike（先验证两处不确定，2 个产出，不写产品代码）

### 任务 0：验证 srt-in-WSL2 与 tool-override

- [ ] **步骤 1：在 WSL2 跑通 srt 隔离**（手动，记录结论到本计划末尾「spike 结论」）

运行（PowerShell）：
```powershell
wsl -l -v
wsl -d <distro> -- bash -lc "command -v bwrap socat srt || echo MISSING"
# 若缺：wsl -d <distro> -- bash -lc "sudo apt-get update && sudo apt-get install -y bubblewrap socat && sudo npm i -g @anthropic-ai/sandbox-runtime"
wsl -d <distro> --cd /mnt/d -- bash -lc 'printf "{\"filesystem\":{\"allowWrite\":[\"/mnt/d/tmpsbx\"]},\"network\":{\"allowedDomains\":[]}}" > /tmp/s.json; srt --settings /tmp/s.json bash -lc "echo ok; curl -sS -m5 https://example.com >/dev/null && echo NET_OK || echo NET_BLOCKED; touch /etc/should_fail 2>&1 | head -1"'
```
预期：打印 `ok`、`NET_BLOCKED`、写 `/etc` 报 EPERM。确认 `srt --settings <file> bash -lc <cmd>` 形态、settings 键名（`filesystem.allowWrite` / `network.allowedDomains`）、退出码可取。

- [ ] **步骤 2：确认 pi 是否支持 tool-override 返回结果替换内置 `bash`**

查 pi 包内示例（已安装于 `cli/node_modules/@earendil-works/pi-coding-agent`）：
```powershell
rg -n "tool-override|toolOverride|registerToolOverride|overrideTool|result:" cli/node_modules/@earendil-works/pi-coding-agent/dist 2>$null | Select-Object -First 40
```
结论二选一，记到末尾「spike 结论」：
- 支持 override 返回结果 → 内置 `bash` 透明改路由（任务 9 走 A 路）。
- 不支持 → 沙箱模式禁内置 `bash` + 注册自有 `sandbox_sh`（任务 9 走 B 路）。

- [ ] **步骤 3：Commit spike 结论**
```powershell
git add docs/superpowers/plans/2026-06-19-unified-sandbox.md
git commit -m "docs(sandbox): spike 结论（srt-in-WSL2 形态 + tool-override 能力）"
```

---

## Phase 1：核心沙箱层（`extensions/_shared/sandbox/`）

### 任务 1：契约类型 `types.ts`

**文件：** 创建 `extensions/_shared/sandbox/types.ts`

- [ ] **步骤 1：写类型**
```ts
// 统一沙箱契约：消费者只依赖这里，不关心 WSL/srt 细节。
export interface SandboxSpec {
  /** Windows workspace 绝对路径（如 D:\proj）。 */
  cwd: string;
  /** 可写根（Windows 路径）；默认 [cwd]。 */
  writableRoots?: string[];
  /** 网络：默认 "none"（全拒）。 */
  network?: "none" | { allowDomains: string[] };
  /** 执行超时（ms）。 */
  timeoutMs?: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SandboxAdapter {
  isAvailable(): Promise<boolean>;
  exec(command: string, spec: SandboxSpec): Promise<SandboxResult>;
}
```

- [ ] **步骤 2：Commit**
```powershell
git add extensions/_shared/sandbox/types.ts
git commit -m "feat(sandbox): SandboxAdapter 契约类型"
```

### 任务 2：Windows→WSL 路径转换 `paths.ts`

**文件：** 创建 `extensions/_shared/sandbox/paths.ts`、`extensions/_shared/sandbox/paths.test.ts`

- [ ] **步骤 1：写失败测试**
```ts
import { describe, expect, it } from "vitest";
import { winToWslPath } from "./paths.js";

describe("winToWslPath", () => {
  it("maps drive paths to /mnt", () => {
    expect(winToWslPath("D:\\a\\b")).toBe("/mnt/d/a/b");
    expect(winToWslPath("C:\\Users\\x")).toBe("/mnt/c/Users/x");
  });
  it("lowercases only the drive letter, keeps the rest", () => {
    expect(winToWslPath("E:\\Foo Bar\\Baz")).toBe("/mnt/e/Foo Bar/Baz");
  });
  it("passes through already-posix paths", () => {
    expect(winToWslPath("/mnt/d/x")).toBe("/mnt/d/x");
  });
  it("throws on non-drive paths (UNC / network)", () => {
    expect(() => winToWslPath("\\\\server\\share")).toThrow();
  });
});
```

- [ ] **步骤 2：运行确认失败** — `npx vitest run _shared/sandbox/paths` → FAIL（winToWslPath 未定义）。工作目录 `extensions`。

- [ ] **步骤 3：实现**
```ts
// D:\a\b → /mnt/d/a/b。仅支持本地盘符路径；UNC/网络盘抛错（WSL /mnt 不可达）。
export function winToWslPath(p: string): string {
  if (p.startsWith("/")) return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) throw new Error(`无法转换为 WSL 路径（需本地盘符绝对路径）：${p}`);
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}
```

- [ ] **步骤 4：运行确认通过** — `npx vitest run _shared/sandbox/paths` → PASS。

- [ ] **步骤 5：Commit**
```powershell
git add extensions/_shared/sandbox/paths.ts extensions/_shared/sandbox/paths.test.ts
git commit -m "feat(sandbox): winToWslPath 路径转换 + 测试"
```

### 任务 3：srt settings 生成 `srt.ts`

**文件：** 创建 `extensions/_shared/sandbox/srt.ts`、`srt.test.ts`

- [ ] **步骤 1：写失败测试**
```ts
import { describe, expect, it } from "vitest";
import { buildSrtSettings } from "./srt.js";

describe("buildSrtSettings", () => {
  it("allows writing the cwd + /tmp, denies network by default", () => {
    const s = buildSrtSettings({ cwd: "D:\\proj" }, "/mnt/d/proj");
    expect(s.filesystem.allowWrite).toEqual(["/mnt/d/proj", "/tmp"]);
    expect(s.network.allowedDomains).toEqual([]);
  });
  it("maps extra writableRoots and allowlist domains", () => {
    const s = buildSrtSettings(
      { cwd: "D:\\proj", writableRoots: ["D:\\proj", "D:\\out"], network: { allowDomains: ["api.github.com"] } },
      "/mnt/d/proj",
    );
    expect(s.filesystem.allowWrite).toEqual(["/mnt/d/proj", "/mnt/d/out", "/tmp"]);
    expect(s.network.allowedDomains).toEqual(["api.github.com"]);
  });
});
```

- [ ] **步骤 2：运行确认失败** — `npx vitest run _shared/sandbox/srt` → FAIL。

- [ ] **步骤 3：实现**
```ts
import { winToWslPath } from "./paths.js";
import type { SandboxSpec } from "./types.js";

export interface SrtSettings {
  filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
  network: { allowedDomains: string[]; deniedDomains: string[] };
}

// 生成 ~/.srt-settings.json 等价内容：写默认拒（只放开 workspace + /tmp），网络默认拒（空 allowlist）。
export function buildSrtSettings(spec: SandboxSpec, wslCwd: string): SrtSettings {
  const roots = (spec.writableRoots && spec.writableRoots.length > 0 ? spec.writableRoots : [spec.cwd]).map(winToWslPath);
  if (!roots.includes(wslCwd)) roots.unshift(wslCwd);
  const allowWrite = [...new Set([...roots, "/tmp"])];
  const allowedDomains = spec.network && spec.network !== "none" ? spec.network.allowDomains : [];
  return {
    filesystem: { denyRead: [], allowWrite, denyWrite: [] },
    network: { allowedDomains, deniedDomains: [] },
  };
}
```

- [ ] **步骤 4：运行确认通过** — PASS。

- [ ] **步骤 5：Commit**
```powershell
git add extensions/_shared/sandbox/srt.ts extensions/_shared/sandbox/srt.test.ts
git commit -m "feat(sandbox): buildSrtSettings 生成 srt 配置 + 测试"
```

### 任务 4：WSL distro 解析 `detect.ts`

**文件：** 创建 `extensions/_shared/sandbox/detect.ts`、`detect.test.ts`

- [ ] **步骤 1：写失败测试**
```ts
import { describe, expect, it } from "vitest";
import { parseWslDistros, pickDistro } from "./detect.js";

const OUT = [
  "  NAME            STATE           VERSION",
  "* Ubuntu          Running         2",
  "  docker-desktop  Stopped         2",
].join("\r\n");

describe("parseWslDistros", () => {
  it("parses name/state/version and default marker", () => {
    const d = parseWslDistros(OUT);
    expect(d).toEqual([
      { name: "Ubuntu", state: "Running", version: 2, default: true },
      { name: "docker-desktop", state: "Stopped", version: 2, default: false },
    ]);
  });
  it("tolerates UTF-16 NUL bytes from wsl.exe", () => {
    const noisy = OUT.split("").join("\u0000");
    expect(parseWslDistros(noisy).length).toBe(2);
  });
});

describe("pickDistro", () => {
  const list = parseWslDistros(OUT);
  it("prefers the requested distro when present", () => {
    expect(pickDistro(list, "docker-desktop")?.name).toBe("docker-desktop");
  });
  it("falls back to default v2, skipping docker-desktop", () => {
    expect(pickDistro(list)?.name).toBe("Ubuntu");
  });
});
```

- [ ] **步骤 2：运行确认失败** — FAIL。

- [ ] **步骤 3：实现**
```ts
export interface WslDistro { name: string; state: string; version: number; default: boolean; }

// 解析 `wsl.exe -l -v`。wsl.exe 默认 UTF-16LE，调用方常 decode 后含 NUL，这里先剔除。
export function parseWslDistros(stdout: string): WslDistro[] {
  const clean = stdout.replace(/\u0000/g, "");
  const lines = clean.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const rows = lines.filter((l) => !/^\s*NAME\s+STATE\s+VERSION/i.test(l));
  const out: WslDistro[] = [];
  for (const line of rows) {
    const isDefault = line.trimStart().startsWith("*");
    const cols = line.replace(/^\s*\*?\s*/, "").split(/\s{2,}|\t+/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 3) continue;
    const version = Number(cols[2]) || 0;
    out.push({ name: cols[0], state: cols[1], version, default: isDefault });
  }
  return out;
}

// 选 distro：优先 preferred；否则第一个 v2、非 docker-desktop 的（优先 default）。
export function pickDistro(distros: WslDistro[], preferred?: string): WslDistro | undefined {
  if (preferred) {
    const hit = distros.find((d) => d.name === preferred);
    if (hit) return hit;
  }
  const usable = distros.filter((d) => d.version === 2 && d.name !== "docker-desktop");
  return usable.find((d) => d.default) ?? usable[0];
}
```

- [ ] **步骤 4：运行确认通过** — PASS。

- [ ] **步骤 5：Commit**
```powershell
git add extensions/_shared/sandbox/detect.ts extensions/_shared/sandbox/detect.test.ts
git commit -m "feat(sandbox): parseWslDistros/pickDistro 解析 wsl -l -v + 测试"
```

### 任务 5：NoopSandbox `noop.ts`

**文件：** 创建 `extensions/_shared/sandbox/noop.ts`、`noop.test.ts`

- [ ] **步骤 1：写失败测试**
```ts
import { describe, expect, it } from "vitest";
import { NoopSandbox } from "./noop.js";

describe("NoopSandbox", () => {
  it("is never available and throws on exec", async () => {
    const s = new NoopSandbox();
    expect(await s.isAvailable()).toBe(false);
    await expect(s.exec("echo hi", { cwd: "D:\\x" })).rejects.toThrow(/不可用/);
  });
});
```

- [ ] **步骤 2：运行确认失败** — FAIL。

- [ ] **步骤 3：实现**
```ts
import type { SandboxAdapter, SandboxResult, SandboxSpec } from "./types.js";

export class NoopSandbox implements SandboxAdapter {
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async exec(_command: string, _spec: SandboxSpec): Promise<SandboxResult> {
    throw new Error("沙箱不可用（NoopSandbox）：消费者应在 isAvailable() 为 false 时走降级路径，而非调用 exec");
  }
}
```

- [ ] **步骤 4：运行确认通过** — PASS。

- [ ] **步骤 5：Commit**
```powershell
git add extensions/_shared/sandbox/noop.ts extensions/_shared/sandbox/noop.test.ts
git commit -m "feat(sandbox): NoopSandbox 降级实现 + 测试"
```

### 任务 6：WslSandbox `wsl.ts`

**文件：** 创建 `extensions/_shared/sandbox/wsl.ts`、`wsl.test.ts`

- [ ] **步骤 1：写失败测试（注入 run，断言 argv 组装 + 结果）**
```ts
import { describe, expect, it, vi } from "vitest";
import { WslSandbox } from "./wsl.js";

function fakeRun() {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run = vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args });
    return { stdout: "ok", stderr: "", code: 0 };
  });
  return { run, calls };
}

describe("WslSandbox.exec", () => {
  it("builds wsl + srt argv with cwd mapped and a settings file", async () => {
    const { run, calls } = fakeRun();
    const sbx = new WslSandbox({ distro: "Ubuntu", run, writeSettings: async () => "/tmp/s.json" });
    const r = await sbx.exec("echo hi", { cwd: "D:\\proj" });
    expect(r).toEqual({ stdout: "ok", stderr: "", code: 0 });
    expect(calls[0].file).toBe("wsl.exe");
    expect(calls[0].args).toEqual([
      "-d", "Ubuntu", "--cd", "/mnt/d/proj", "--",
      "srt", "--settings", "/tmp/s.json", "bash", "-lc", "echo hi",
    ]);
  });
});
```

- [ ] **步骤 2：运行确认失败** — FAIL。

- [ ] **步骤 3：实现**
```ts
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { winToWslPath } from "./paths.js";
import { buildSrtSettings } from "./srt.js";
import type { SandboxAdapter, SandboxResult, SandboxSpec } from "./types.js";

export type RunFn = (file: string, args: string[], timeoutMs?: number) => Promise<SandboxResult>;

// 默认 run：spawn wsl.exe，收集 stdout/stderr/code，带超时 kill。
const defaultRun: RunFn = (file, args, timeoutMs) =>
  new Promise<SandboxResult>((resolve) => {
    const child = spawn(file, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          try { child.kill(); } catch { /* gone */ }
          resolve({ stdout, stderr: stderr + `\n[sandbox] timeout ${timeoutMs}ms`, code: -1 });
        }, timeoutMs)
      : undefined;
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ stdout, stderr: String(e), code: -1 }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ stdout, stderr, code: code ?? -1 }); });
  });

// 默认 writeSettings：把 srt settings 写到宿主 temp，再转成 WSL 路径返回。
async function defaultWriteSettings(spec: SandboxSpec, wslCwd: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-sbx-"));
  const winPath = join(dir, "srt-settings.json");
  writeFileSync(winPath, JSON.stringify(buildSrtSettings(spec, wslCwd)), "utf8");
  return winToWslPath(winPath);
}

export interface WslSandboxOpts {
  distro: string;
  run?: RunFn;
  writeSettings?: (spec: SandboxSpec, wslCwd: string) => Promise<string>;
}

export class WslSandbox implements SandboxAdapter {
  private distro: string;
  private run: RunFn;
  private writeSettings: (spec: SandboxSpec, wslCwd: string) => Promise<string>;
  constructor(opts: WslSandboxOpts) {
    this.distro = opts.distro;
    this.run = opts.run ?? defaultRun;
    this.writeSettings = opts.writeSettings ?? defaultWriteSettings;
  }
  async isAvailable(): Promise<boolean> {
    return true; // 由 getSandbox() 的探测决定是否构造本类；构造出来即视为可用
  }
  async exec(command: string, spec: SandboxSpec): Promise<SandboxResult> {
    const wslCwd = winToWslPath(spec.cwd);
    const settings = await this.writeSettings(spec, wslCwd);
    const args = ["-d", this.distro, "--cd", wslCwd, "--", "srt", "--settings", settings, "bash", "-lc", command];
    return this.run("wsl.exe", args, spec.timeoutMs);
  }
}
```

- [ ] **步骤 4：运行确认通过** — PASS。

- [ ] **步骤 5：Commit**
```powershell
git add extensions/_shared/sandbox/wsl.ts extensions/_shared/sandbox/wsl.test.ts
git commit -m "feat(sandbox): WslSandbox 经 wsl+srt 执行（注入式 run）+ 测试"
```

### 任务 7：工厂 `index.ts`（探测 + 单例 + 降级）

**文件：** 创建 `extensions/_shared/sandbox/index.ts`、`index.test.ts`

- [ ] **步骤 1：写失败测试（注入探测器，验证可用→WslSandbox、不可用→NoopSandbox、缓存）**
```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { __resetForTest, getSandbox } from "./index.js";
import { WslSandbox } from "./wsl.js";
import { NoopSandbox } from "./noop.js";

beforeEach(() => __resetForTest());

describe("getSandbox", () => {
  it("returns WslSandbox when a usable distro + deps are detected", async () => {
    const probe = vi.fn(async () => ({ ok: true as const, distro: "Ubuntu" }));
    const s = await getSandbox({ probe });
    expect(s).toBeInstanceOf(WslSandbox);
    await getSandbox({ probe });
    expect(probe).toHaveBeenCalledTimes(1); // 缓存
  });
  it("returns NoopSandbox when probe fails", async () => {
    const s = await getSandbox({ probe: async () => ({ ok: false as const, reason: "no wsl" }) });
    expect(s).toBeInstanceOf(NoopSandbox);
  });
});
```

- [ ] **步骤 2：运行确认失败** — FAIL。

- [ ] **步骤 3：实现**
```ts
import { spawn } from "node:child_process";
import { getConfig } from "../runtime-config.js";
import { parseWslDistros, pickDistro } from "./detect.js";
import { NoopSandbox } from "./noop.js";
import type { SandboxAdapter } from "./types.js";
import { WslSandbox } from "./wsl.js";

export type { SandboxAdapter, SandboxResult, SandboxSpec } from "./types.js";
export { WslSandbox } from "./wsl.js";
export { NoopSandbox } from "./noop.js";

type ProbeResult = { ok: true; distro: string } | { ok: false; reason: string };
export type Probe = () => Promise<ProbeResult>;

let cached: SandboxAdapter | undefined;
let inflight: Promise<SandboxAdapter> | undefined;

function wslExec(args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const c = spawn("wsl.exe", args, { windowsHide: true });
    let stdout = "";
    c.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf16le")));
    c.on("error", () => resolve({ stdout, code: -1 }));
    c.on("close", (code) => resolve({ stdout, code: code ?? -1 }));
  });
}

// 默认探测：Windows 上跑 `wsl -l -v` 选 distro，再在 distro 内确认 srt/bwrap/socat 可用。
const defaultProbe: Probe = async () => {
  if (process.platform !== "win32") return { ok: false, reason: "仅 Windows 走 WSL 后端" };
  const list = await wslExec(["-l", "-v"]);
  if (list.code !== 0) return { ok: false, reason: "未检测到 WSL" };
  const distro = pickDistro(parseWslDistros(list.stdout), getConfig("SANDBOX_DISTRO") || undefined);
  if (!distro) return { ok: false, reason: "无可用的 WSL2 发行版" };
  const deps = await wslExec(["-d", distro.name, "--", "bash", "-lc", "command -v srt bwrap socat >/dev/null && echo OK"]);
  if (!deps.stdout.replace(/\u0000/g, "").includes("OK")) return { ok: false, reason: "WSL 内缺 srt/bwrap/socat" };
  return { ok: true, distro: distro.name };
};

export async function getSandbox(opts: { probe?: Probe } = {}): Promise<SandboxAdapter> {
  if (getConfig("SANDBOX_ENABLE") === "off") return new NoopSandbox();
  if (cached) return cached;
  if (inflight) return inflight;
  const probe = opts.probe ?? defaultProbe;
  inflight = (async () => {
    const r = await probe();
    cached = r.ok ? new WslSandbox({ distro: r.distro }) : new NoopSandbox();
    inflight = undefined;
    return cached;
  })();
  return inflight;
}

export function __resetForTest(): void {
  cached = undefined;
  inflight = undefined;
}
```

- [ ] **步骤 4：运行确认通过** — PASS。

- [ ] **步骤 5：Commit**
```powershell
git add extensions/_shared/sandbox/index.ts extensions/_shared/sandbox/index.test.ts
git commit -m "feat(sandbox): getSandbox 工厂（探测+缓存+降级）+ 测试"
```

### 任务 8：兼容旧桩 `safety/sandbox.ts`

**文件：** 修改 `extensions/safety/sandbox.ts`

- [ ] **步骤 1：改为 re-export，保留 NoopSandbox 名**
```ts
// 历史桩迁移到 _shared/sandbox。此文件仅 re-export 以不破坏旧导入。
export type { SandboxAdapter, SandboxResult, SandboxSpec } from "../_shared/sandbox/index.js";
export { NoopSandbox, getSandbox } from "../_shared/sandbox/index.js";
```

- [ ] **步骤 2：跑全量 safety 测试确认不破** — `npx vitest run safety` → PASS。

- [ ] **步骤 3：Commit**
```powershell
git add extensions/safety/sandbox.ts
git commit -m "refactor(safety): sandbox 桩迁移到 _shared/sandbox 并 re-export"
```

---

## Phase 2：消费者接线

### 任务 9：code-exec 路由（js_run/py_run 经沙箱）

**文件：** 修改 `extensions/code-exec/index.ts`（先读现状定位 `js_run`/`py_run` handler）

- [ ] **步骤 1：读现状** — `Read extensions/code-exec/index.ts`，找到 `py_run`/`js_run` 的 `execute`。记录它们当前如何跑（runner.mjs/runner.py 子进程或 node:vm）。

- [ ] **步骤 2：加沙箱分支（沙箱可用且 `SANDBOX_ENABLE!=off` 时，把代码写进 workspace 下临时文件，经 `getSandbox().exec()` 跑 `node <file>` / `python3 <file>`；否则保持现状）**
```ts
import { getSandbox } from "../_shared/sandbox/index.js";
// …在 py_run/js_run 的 execute 开头：
const sbx = await getSandbox();
if (await sbx.isAvailable()) {
  const ext = lang === "py" ? "py" : "mjs";
  const rel = `.pi/sbx-${Date.now()}.${ext}`;
  // 写到 ctx.cwd 下（workspace 内，bind-mount 可见），执行后清理
  writeFileSync(join(ctx.cwd, rel), code, "utf8");
  const runner = lang === "py" ? "python3" : "node";
  const r = await sbx.exec(`${runner} ${rel}`, { cwd: ctx.cwd, timeoutMs });
  rmSync(join(ctx.cwd, rel), { force: true });
  return { output: (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim() || "(no output)" };
}
// …否则走原有 node:vm / 子进程逻辑
```
（注：常驻内核在沙箱模式下退化为一次性 exec——本期 YAGNI 接受；具体变量名 `lang`/`code`/`timeoutMs`/`ctx` 以步骤 1 读到的实际签名为准对齐。）

- [ ] **步骤 3：跑 code-exec 测试** — `npx vitest run code-exec` → PASS（沙箱不可用时走原路径，CI 无 WSL 即覆盖降级）。

- [ ] **步骤 4：Commit**
```powershell
git add extensions/code-exec/index.ts
git commit -m "feat(code-exec): 沙箱可用时 js_run/py_run 经 WSL2 srt 执行"
```

### 任务 10：内置 bash 路由（按 spike 结论二选一）

**文件：** 修改 `extensions/safety/index.ts`（沙箱模式 deny 内置 bash）+ 新增 `extensions/code-exec/sandbox-sh.ts`（B 路时注册 `sandbox_sh`）

- [ ] **步骤 1：实现（B 路——更稳，spike 若确认 override 可用则改 A 路透明替换）**
  - safety `tool_call`：当 `getSandbox().isAvailable()` 且 `SANDBOX_ENABLE!=off` 时，`event.toolName==="bash"` → `{ block:true, reason:"沙箱模式：请用 sandbox_sh（在隔离环境执行）" }`。
  - 注册 `sandbox_sh` 工具（schema: `{ command: string }`），execute 调 `getSandbox().exec(command, { cwd: ctx.cwd, timeoutMs })` 返回 stdout/stderr。

```ts
// extensions/code-exec/sandbox-sh.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSandbox } from "../_shared/sandbox/index.js";

export function registerSandboxSh(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "sandbox_sh",
    label: "Sandboxed Shell",
    description: "在隔离环境(WSL2 沙箱)内执行 shell 命令；写仅限 workspace，网络默认禁。",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: async (input: { command: string }, ctx: { cwd: string }) => {
      const sbx = await getSandbox();
      if (!(await sbx.isAvailable())) return { output: "沙箱不可用：未配置 WSL2，命令未执行。" };
      const r = await sbx.exec(input.command, { cwd: ctx.cwd, timeoutMs: 120_000 });
      return { output: (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim() || "(no output)" };
    },
  });
}
```
在 `code-exec/index.ts` 的 default 函数里调 `registerSandboxSh(pi)`。

- [ ] **步骤 2：跑 safety + code-exec 测试** — PASS。
- [ ] **步骤 3：Commit**
```powershell
git add extensions/code-exec/sandbox-sh.ts extensions/code-exec/index.ts extensions/safety/index.ts
git commit -m "feat(sandbox): 沙箱模式禁内置 bash + 提供 sandbox_sh"
```

### 任务 11：im-platforms 无主人会话用沙箱

**文件：** 修改 `extensions/im-platforms/index.ts`（`runImTurn`）

- [ ] **步骤 1：受限模式从"禁执行"改为"沙箱内可执行"**
  - `restricted = !owner` 时：若 `getSandbox().isAvailable()` → 不再 deny 执行类工具，改为允许（执行经 sandbox_sh / 沙箱化 code-exec）；仍保留 `SAFETY_READONLY` 把宿主 write/edit 锁到 workspace。
  - 沙箱不可用 → 维持现有 deny-based（`RESTRICTED_DENY_TOOLS`）。
```ts
import { getSandbox } from "../_shared/sandbox/index.js";
// runImTurn 内：
const restricted = !wechatConfig().owner;
const sandboxed = restricted && (await getSandbox().isAvailable());
const env: Record<string, string> = { GOAL_ENABLED: "0", LOOP_GUARD: "1" };
if (restricted) {
  env.SAFETY_READONLY = "1";
  // 沙箱可用：允许执行（沙箱内）；不可用：沿用纯 deny 兜底
  if (!sandboxed) env.SAFETY_DENY_TOOLS = RESTRICTED_DENY_TOOLS;
}
const systemPrompt = restricted
  ? (sandboxed ? IM_SYSTEM_PROMPT_RESTRICTED_SANDBOXED : IM_SYSTEM_PROMPT_RESTRICTED)
  : IM_SYSTEM_PROMPT_FULL;
```
新增 `IM_SYSTEM_PROMPT_RESTRICTED_SANDBOXED`（告诉 agent 可在沙箱内执行、写限 workspace、网络默认禁）。

- [ ] **步骤 2：跑 im-platforms 测试** — `npx vitest run im-platforms` → PASS。
- [ ] **步骤 3：Commit**
```powershell
git add extensions/im-platforms/index.ts
git commit -m "feat(im-platforms): 无主人会话沙箱可用时改为沙箱内可执行"
```

### 任务 12：multi-agent `isolation:"sandbox"`

**文件：** 修改 `extensions/multi-agent/index.ts`

- [ ] **步骤 1：移除 "sandbox 未支持" 抛错，改为标记走沙箱**
找到 `if (profile.isolation === "sandbox") throw …`（规格记录在 index.ts:227-229），替换为：
```ts
const wantSandbox = profile.isolation === "sandbox";
// 与 worktree 同级的约束：沙箱档仅单任务、非 chain（先收紧，后续放开）
if (wantSandbox && (hasChain || list.length !== 1)) {
  throw new Error("sandbox 隔离仅支持单任务（非并行/非 chain）");
}
```
在子代理执行处：若 `wantSandbox` 且 `getSandbox().isAvailable()`，把子代理的命令经 `getSandbox().exec()` 跑（或给子进程注入 `SANDBOX_ENABLE=on` + profile 的 fs/net 映射成 `SANDBOX_WRITABLE_ROOTS`/`SANDBOX_ALLOW_DOMAINS`，由子代理内的本沙箱层执行）；不可用则回退 `process` 隔离 + deny 并在输出标注。

- [ ] **步骤 2：跑 multi-agent 测试** — `npx vitest run multi-agent` → PASS（capability.test 里 `sandbox` 仍是合法档值，不再断言抛错的话同步更新）。
- [ ] **步骤 3：Commit**
```powershell
git add extensions/multi-agent/index.ts extensions/multi-agent/capability.test.ts
git commit -m "feat(multi-agent): isolation=sandbox 走统一沙箱层（不可用回退 process）"
```

---

## Phase 3：setup（Tauri 命令 + 面板）

### 任务 13：Tauri `sandbox_status` / `sandbox_install`

**文件：** 创建 `tauri-agent/src-tauri/src/commands/sandbox.rs`；修改 `tauri-agent/src-tauri/src/lib.rs`

- [ ] **步骤 1：实现 status（跑 `wsl -l -v` + distro 内 `command -v srt bwrap socat`，回结构体）与 install（分步：`wsl --install`；distro 内 `apt-get install -y bubblewrap socat && npm i -g @anthropic-ai/sandbox-runtime`），用 `tauri::command` 暴露；status 回 `{ wsl: bool, distro: Option<String>, deps: bool, ready: bool }`。**

```rust
// commands/sandbox.rs（要点；遵循同目录其它 command 的错误处理/返回风格）
#[derive(serde::Serialize)]
pub struct SandboxStatus { pub wsl: bool, pub distro: Option<String>, pub deps: bool, pub ready: bool }

#[tauri::command]
pub async fn sandbox_status() -> Result<SandboxStatus, String> { /* 跑 wsl -l -v + command -v，组装 */ }

#[tauri::command]
pub async fn sandbox_install(step: String) -> Result<String, String> {
  // step == "wsl"  -> 运行 `wsl --install`（需管理员；返回提示重启）
  // step == "deps" -> distro 内装 bubblewrap/socat/srt
}
```
在 `lib.rs` 的 `invoke_handler![…]` 注册 `sandbox_status, sandbox_install`。

- [ ] **步骤 2：构建确认** — `cd tauri-agent/src-tauri && cargo check` → 通过。
- [ ] **步骤 3：Commit**
```powershell
git add tauri-agent/src-tauri/src/commands/sandbox.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(sandbox): Tauri sandbox_status/sandbox_install 命令"
```

### 任务 14：连接面板 SandboxCard

**文件：** 创建 `tauri-agent/src/features/connections/SandboxCard.tsx`；修改 `tauri-agent/src/features/connections/ConnectionsPanel.tsx`、`tauri-agent/src/lib/pi.ts`

- [ ] **步骤 1：pi.ts 加封装**
```ts
export interface SandboxStatus { wsl: boolean; distro?: string; deps: boolean; ready: boolean; }
export const sandboxStatus = () => invoke<SandboxStatus>("sandbox_status");
export const sandboxInstall = (step: "wsl" | "deps") => invoke<string>("sandbox_install", { step });
```

- [ ] **步骤 2：SandboxCard.tsx**——挂载时 `sandboxStatus()`；按 `ready/wsl/deps` 显示「就绪 / 待装依赖 [装依赖] / 未装 WSL2 [安装 WSL2(需管理员重启)]」；用 `@lobehub/ui` 的 `Icon` + lucide（遵守 no-emoji 规则）。在 `ConnectionsPanel.tsx` 渲染 `<SandboxCard/>`。

- [ ] **步骤 3：前端测试 + 构建** — `cd tauri-agent && npx vitest run connections && npm run build` → PASS。
- [ ] **步骤 4：Commit**
```powershell
git add tauri-agent/src/features/connections/SandboxCard.tsx tauri-agent/src/features/connections/ConnectionsPanel.tsx tauri-agent/src/lib/pi.ts
git commit -m "feat(sandbox): 连接面板 SandboxCard 状态 + 一键安装"
```

### 任务 15：端到端验证（手动，真 WSL2）

- [ ] `npm run build:sidecar`（tauri-agent）重建 sidecar，启动 app。
- [ ] 面板「沙箱」显示就绪；`/im` 显示无主人=沙箱可执行。
- [ ] 微信无主人发"列出当前目录并尝试读 C:\Windows\win.ini"：能列 workspace、读宿主敏感路径被拒、写 workspace 外被拒、网络默认不通。
- [ ] owner 直连仍完整能力。

---

## 自检

**1. 规格覆盖度：**
- SandboxAdapter/Spec/Result → 任务 1；NoopSandbox → 任务 5；WslSandbox → 任务 6；getSandbox 探测/缓存/降级 → 任务 7；winToWslPath → 任务 2；srt settings → 任务 3；detect → 任务 4；safety 桩迁移 → 任务 8。
- 消费者复用：code-exec → 任务 9；内置 bash/sandbox_sh → 任务 10；im-platforms → 任务 11；multi-agent → 任务 12；safety workspace 锁 → 任务 10/11（`SAFETY_READONLY`）。
- 配置：`SANDBOX_ENABLE`(任务 7) / `SANDBOX_DISTRO`(任务 7) / `SANDBOX_WRITABLE_ROOTS`、`SANDBOX_ALLOW_DOMAINS`(任务 12 注入、srt.ts 消费) / `SANDBOX_NET`（在任务 11/12 组 spec.network 时读取——实现时于消费者侧把 `SANDBOX_NET`/`SANDBOX_ALLOW_DOMAINS` 映射进 `SandboxSpec.network`）。
- 降级 + 安装：getSandbox 降级(任务 7) + Tauri/面板(任务 13/14)。
- 测试：任务 2-7 纯单测 + 任务 15 端到端。
- 风险/待验证：tool-override(任务 0/10) / `/mnt` 性能(YAGNI) / srt 安装(任务 0/13)。

**2. 占位符扫描：** 无 TODO/待补；任务 9/12/13 标注"以实际签名为准/遵循同目录风格"是对齐指令而非占位（核心 API 已在任务 1-7 定死）。

**3. 类型一致性：** `SandboxAdapter.{isAvailable,exec}`、`SandboxSpec.{cwd,writableRoots,network,timeoutMs}`、`SandboxResult.{stdout,stderr,code}`、`getSandbox(opts?)`、`buildSrtSettings(spec,wslCwd)`、`winToWslPath`、`parseWslDistros/pickDistro`、`WslSandbox({distro,run,writeSettings})` 全程一致。

## spike 结论（任务 0 回填，2026-06-19）

- **WSL2 环境**：已装 WSL 2.6.3.0（内核 6.6.87），默认发行版 **Debian（VERSION 2，Stopped）**。`pickDistro` 选它即可。
- **依赖现状**：Debian 内 `command -v srt bwrap socat` → **DEPS_MISSING**。即本机沙箱「未就绪」，应走优雅降级 + 引导安装（任务 13）。未擅自安装（需 sudo/网络、改用户环境）。
- **srt-in-WSL2 形态**：按官方 `@anthropic-ai/sandbox-runtime` README 确认：`srt [--settings <file>] <command>`；settings JSON = `{ filesystem: { denyRead, allowRead, allowWrite, denyWrite }, network: { allowedDomains, deniedDomains } }`（写默认拒、网络默认拒）。任务 3/6 据此实现。待装依赖后于任务 15 端到端复核。
- **tool-override**：pi 包未安装到 `cli/node_modules`（无法本地核验是否支持「override 返回结果」）。**采用保守 B 路**：沙箱模式禁内置 `bash` + 注册自有 `sandbox_sh`（任务 10）。后续若确认 override 可用可平滑切 A 路。

## 任务 15 端到端结论（2026-06-19，真 WSL2 Debian）

依赖装齐后（bubblewrap/socat/srt/**ripgrep**）走真实 `getSandbox()→WslSandbox→srt` 全链路验证通过：

```
isAvailable: true
HELLO_VIA_OUR_CODE        # 命令在沙箱内执行
NET_BLOCKED               # 网络默认禁（控制组 srt 外为 NET_OK）
WRITE_WS_OK               # 写 workspace（路径含空格 /mnt/d/OneDrive/Project Files/Pi）放行
ETC_BLOCKED               # 写 /etc（workspace 外）被拒
```

e2e 暴露并修复了 3 个会让沙箱完全失效的 bug（均已含在任务 15 提交）：

1. **缺 ripgrep 探测**：`srt` 运行时依赖 `rg`，原探测只查 `srt/bwrap/socat` → rg 缺失时误报可用、运行时炸。探测 + 安装均补 `ripgrep`。
2. **wslExec UTF-16 误解码**：`wsl.exe` 自身输出（`-l -v`）是 UTF-16LE，但子命令（`-d .. -- ..`）输出是 UTF-8；原代码一律按 UTF-16 解码 → deps 探测的 "OK" 成乱码 → 探测永远失败 → 永远降级。改为「剔 NUL 字节 + UTF-8 解码」，两者皆成立。
3. **wsl 吞位置参数 / 命令转义与超长**：`wsl -- bash -lc <script> a b c` 不会把 a/b/c 传给 `$1/$2`（实测为空）；内联命令还受 Windows 命令行长度上限与转义困扰。**最终方案：命令落盘为 `cmd.sh`**（settings 也落盘 temp），经登录 shell 执行 `bash -lc "srt --settings '<settings>' bash '<cmd.sh>'"`——登录 shell 解析 srt/node 的自定义 PATH，argv 只含无空格 tmp 路径，免转义、不超长（评审 `ebefa2cb` 收敛；早期曾试 base64 管道，已弃用）。

srt settings schema 经实测确认为全字段必填（`denyRead/allowWrite/denyWrite` + `allowedDomains/deniedDomains`），与 `buildSrtSettings` 产出一致。

## 实现落地说明（接口对齐，以代码为准）

任务 6/7 的最终接口相对上方 TDD 代码块有演进（经任务 15 e2e + 评审 `ebefa2cb`/`a534dcc3` 收敛）；上方代码块为历史草案，实际以实现文件为准：

- **任务 6（`wsl.ts`）**：`WslSandboxOpts` 注入点是 `prepare(spec, wslCwd, command)`（返回 `{settings, cmd, cleanup}`，settings 与命令各落盘 temp）而非 `writeSettings`。`exec()` 组 `wsl.exe -d <distro> --cd <wslCwd> -- bash -lc "srt --settings '<settings>' bash '<cmd.sh>'"`（登录 shell + 命令落盘），结束 `cleanup()` 清理；`wsl.test.ts` 据此断言。
- **任务 7（`index.ts`）**：探测命令为 `command -v srt bwrap socat rg`（含 **ripgrep**）；`wslExec` 剔 NUL + UTF-8 解码（非 `utf16le`）；缓存为 `{adapter, at}`——正缓存长期、负缓存 TTL 30s（装好依赖自愈）；导出 `resetSandboxCache()`（`__resetForTest` 为其别名）。
- **审批联动（任务 9-12）**：`getSandbox()` 在 `SANDBOX_ENABLE=off` 时返回 `NoopSandbox`；是否路由不再由消费者直接 `getSandbox().isAvailable()` 决定，而经 `_shared/sandbox-gate.ts` 的 `sandboxOn()`（owner 会话，策略感知）/ `sandboxAvailable()`（im-platforms / multi-agent，策略无关）裁决——详见审批策略设计 `2026-06-19-approval-policy-design.md` §3.4。code-exec 的沙箱路由抽到 `code-exec/sandbox-exec.ts` 的 `runCodeInSandbox()`。
