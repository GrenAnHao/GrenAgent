# GrenAgent — agent sidecar

把 pi + 8 个 extension 编译成 **GrenAgent 的 agent sidecar(RPC 模式)**:Tauri(Rust)后端 spawn 这个进程,前端通过 pi 的 **JSONL RPC 协议**(stdin/stdout)与它通信。**没有 TUI**(桌面 UI 是你的 Tauri 前端),extension **编译进 sidecar**(无需 `-e` / `pi install`)。

> 目录名暂用 `cli/`,实际是 GrenAgent 的 sidecar;集成时把它放进你的 GrenAgent 仓库(或作为依赖)。

## 原理

- `../extensions/index.ts` 聚合 8 个 factory(`allExtensions`)。
- `src/main.ts`:`createAgentSessionRuntime` + `createAgentSessionServices({ resourceLoaderOptions: { extensionFactories: allExtensions } })` → **`runRpcMode(runtime)`**。
- `runRpcMode` 接管 stdout、从 stdin 读 JSONL 命令、把 agent 事件以 JSONL 输出。
- `esbuild --bundle` 把 extension(含 store/embedding/typebox)打进 `dist/main.js`,pi 作为运行时外部依赖。

## 构建

```bash
cd cli
npm install
npm run build      # → dist/main.js(自带 8 extension 的 RPC sidecar)
```

可选:用 `bun build --compile` 或 `pkg` 把 `dist/main.js` 打成单文件二进制,放进 `src-tauri/binaries/`(Tauri sidecar 约定),实现零运行时依赖分发。

## Tauri 集成(Rust 后端 spawn)

```rust
// 伪代码:spawn sidecar,走 stdin/stdout JSONL
let mut child = std::process::Command::new("node")      // 或打包的二进制路径
    .arg(sidecar_main_js)                                // dist/main.js
    .arg("--mode").arg("rpc")
    .current_dir(workspace_dir)                          // 决定 .pi/ 存储位置
    .env("OPENAI_API_KEY", key)                          // 语义/记忆/图像/语音需要
    .stdin(Stdio::piped()).stdout(Stdio::piped())
    .spawn()?;

// 发命令(每行一个 JSON):
// {"id":"1","type":"prompt","message":"..."}
// 读事件(每行一个 JSON):assistant text / tool 调用 / 状态
```

> 你之前的 `tauri-agent/` 就是「Tauri + pi --mode rpc sidecar」的形态;把它 spawn 的 `pi` 换成这个 sidecar(`dist/main.js`),即可让 GrenAgent 自带这 8 个功能。RPC 协议(`prompt`/`steer`/`follow_up`/`abort`/`set_model`/`new_session`/`fork`/`get_state`/`get_messages` 等)与官方 pi 一致。

## 关键约定

- **cwd 决定存储位置**:knowledge/memory/reviews 的 `.pi/*.db` 建在 sidecar 的工作目录下;spawn 时用 `current_dir` 指定项目工作区。
- **key**:`image-gen`/`tts` 必需;语义检索/记忆 embedding 可选;其余不需要。通过 spawn 的 `env` 传入。
- **node:sqlite**:需 Node ≥ 22.5(或打包二进制时用对应 runtime)。

## 改名

把 `package.json` 的 `name`/`bin` 改成你的最终命名即可;sidecar 内部逻辑与命名无关。

## 升级 pi 时

`src/main.ts` 基于 pi 0.78.x 的 `createAgentSessionRuntime` + `runRpcMode`。升级后请 diff `packages/coding-agent/src/main.ts` 的 `--mode rpc` 分支,核对 `createAgentSessionServices` 的选项(`settingsManager`/`agentDir`/`modelRegistry` 等)与 `runRpcMode` 签名。

## 包含的 8 个 extension

knowledge-rag · long-term-memory · web-fetch · image-gen · code-review · multi-agent · tts · im-gateway
(9 工具 + 4 命令,详见 `../extensions/<name>/README.md`)
