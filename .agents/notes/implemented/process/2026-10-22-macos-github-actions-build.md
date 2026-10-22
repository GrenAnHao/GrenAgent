# Agent Note: macOS 安装包用 GitHub Actions 打，ad-hoc 签名，按架构各用原生 runner

Status: implemented

## Problem

本机是 Windows，打不了 macOS 的 dmg。`electron-builder.yml` 里早有 `mac` / `linux` 目标，但从没在 mac 上跑过：没有 CI 工作流，也没有 Apple 开发者证书。三个子项目（`electron-agent/`、`extensions/`、`cli/`）各自带锁文件和 `pnpm-workspace.yaml`，打包要先装齐三处依赖。

## Decision

`.github/workflows/build-mac.yml` 在 GitHub 托管的 macOS runner 上出 dmg：

- 触发：`workflow_dispatch`（可选 `arm64` / `x64` / `both`，默认 `arm64`）和推 `v*` 标签。不挂在每次 push 上。
- 每个架构用原生 runner：`arm64` 用 `macos-latest`，`x64` 用 `macos-15-intel`，各自 `pnpm install --frozen-lockfile`。`plan` 任务按输入拼 matrix。
- 步骤：`extensions`、`cli`、`electron-agent` 依次装依赖，`pnpm build`（tsc + electron-vite 生产构建），再 `electron-builder --mac dmg --<arch> --publish never`。产物作为 artifact 保留 14 天；标签触发时另附到草稿 release。
- 版本：Node 24，pnpm 12.6.0。`allowBuilds`、`minimumReleaseAgeExclude` 这些设置要 pnpm 11 以上才认。
- 签名：`electron-builder.yml` 的 `mac` 设 `identity: "-"`（ad-hoc）、`hardenedRuntime: false`、`gatekeeperAssess: false`，产物名 `${productName}-${version}-mac-${arch}.${ext}`。
- `extensions/pnpm-workspace.yaml` 与 `cli/pnpm-workspace.yaml` 里 pnpm 自动写入的占位值 `set this to true or false` 改成 `true`，与 `electron-agent/` 一致。

## Alternatives considered

- **在 mac 上不签名（`identity: null`）**。最强理由：不用管签名。不用：Apple Silicon 上 electron-builder 改过 Info.plist（asar 完整性）之后签名失效，应用会被报“已损坏”，连右键打开都不行。ad-hoc 签名至少能在系统设置里放行。
- **一个 universal 包（`--universal`）**。最强理由：用户只下一个文件。不用：codegraph 平台包、`@ast-grep/napi`、node-pty 预编译都是按架构各装一份，universal 需要把两份 `.node` 合并并配 `x64ArchFiles`，没验证过；分架构打包不需要这些。
- **在 arm64 runner 上交叉打 x64**。最强理由：只占一台 runner。不用：依赖只装宿主架构的原生包，`afterPack` 里的 `codegraph-darwin-x64` 找不到。
- **每次 push 都构建**。最强理由：能第一时间发现 mac 构建被改坏。不用：私有仓库的 macOS 分钟按 10 倍计费，一次约 6 分钟实际耗时，每次 push 都跑会很快用完额度。
- **买 Apple Developer 证书做正式签名和公证**。最强理由：用户装上直接用，没有拦截提示。当前没有账号，暂不做；有了之后把 `identity` 换成证书、`hardenedRuntime` 打开，并补 entitlements 和公证凭据。

## Consequences

- 能随时出 mac 的 dmg，不依赖本机。代价：ad-hoc 签名没有公证，用户首次打开要在“系统设置 - 隐私与安全性”里点“仍要打开”，或在终端执行 `xattr -dr com.apple.quarantine`。
- 私有仓库的 macOS 分钟按 10 倍计，一次 arm64 构建约 60 个计费分钟；`both` 约为两倍。
- 包里仍带着 Windows 专用文件（`pi-job-guard.exe`、`pi-sandbox-*.exe`），`copyPiAdjacentAssets` 无条件拷贝；mac 上不会被调用，只是多占体积。
- 运行时在 mac 上没有被本次验证覆盖：只验证了能构建出 dmg，没有在 mac 上启动过应用。Windows 是主要开发和验证平台。
- `x64` 的 runner 标签和构建本次没有跑过。

## Verification

- 本地：`npx vitest run electron/app/sourceCodeProtection.test.ts electron/agent/copyPiAdjacentAssets.test.ts`（在 `electron-agent/`），14 个测试通过（2026-10-22）。
- 实跑：手动触发 `Build macOS`（`arch=arm64`）。第一次（run 39735479511）在 `Install extensions` 失败，`ERR_PNPM_IGNORED_BUILDS`，原因是上面的占位值；修完后第二次（run 39735628734）成功，约 6 分钟，artifact `GrenAgent-mac-arm64` 约 315 MB，日志里 `signing identityName=-`、`building target=DMG arch=arm64 file=release/GrenAgent-0.3.0-mac-arm64.dmg`。
- 结果：arm64 构建通过；x64 构建未跑；dmg 未在 mac 上安装启动过。
- 证据：`.agents/evidence/2026-10-22-macos-github-actions-build/run-summary.txt`。
