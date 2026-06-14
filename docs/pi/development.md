# Pi 开发与维护指南

> 来源仓库：`https://github.com/earendil-works/pi.git`  
> 本地路径：`pi/`  
> 整理基准：`main` / `9ccfcd7c`

## 环境要求

- Node.js `>=22.19.0`
- npm workspaces
- TypeScript / `tsgo`
- Bash-like shell 用于部分脚本

Windows 用户需要注意终端输入差异。上游 `packages/coding-agent/docs/windows.md`、`terminal-setup.md` 提供了平台细节。

## 安装与构建

从仓库根目录：

```bash
npm install --ignore-scripts
npm run build
```

`--ignore-scripts` 是上游推荐安装方式，符合仓库供应链 hardening 策略。

构建顺序：

```text
packages/tui
packages/ai
packages/agent
packages/coding-agent
```

## 本地运行

从源码运行：

```bash
./pi-test.sh
```

该脚本可从任意目录执行，Pi 会保留调用者的 cwd。

一次性运行：

```bash
pi -p "Summarize this repository"
```

RPC 集成调试：

```bash
pi --mode rpc --no-session
```

## 验证命令

推荐顺序：

```bash
npm run build
npm run check
./test.sh
```

Root scripts 说明：

- `npm run build`：构建所有 workspace 包。
- `npm run check`：Biome、pinned deps、TypeScript relative import、coding-agent shrinkwrap、`tsgo --noEmit`、browser smoke。
- `npm run test`：运行 workspace tests。
- `./test.sh`：运行不依赖 LLM API key 的测试。
- `npm run release:local`：构建、pack，并在仓库外做 npm/Bun 本地安装 smoke test。

包级测试：

- `packages/ai`：`vitest --run`
- `packages/agent`：`vitest --run`，另有 harness config
- `packages/coding-agent`：`vitest --run`
- `packages/tui`：`node --test test/*.test.ts`

## 配置文件

Pi 使用 JSON settings：

| 路径 | 作用域 |
| --- | --- |
| `~/.pi/agent/settings.json` | 全局配置 |
| `.pi/settings.json` | 项目配置，覆盖全局 |

常见配置项：

- `defaultProvider`
- `defaultModel`
- `defaultThinkingLevel`
- `theme`
- `compaction`
- `retry`
- `steeringMode`
- `followUpMode`
- `transport`
- `sessionDir`
- `enabledModels`
- `packages`
- `extensions`
- `skills`
- `prompts`
- `themes`

Project settings 只有在项目被 trust 后才会生效。非交互模式可用 `--approve` 或 `--no-approve` 对一次运行覆盖 trust 决策。

## 项目资源加载

Pi 会从 cwd 向上查找并拼接：

- `AGENTS.md`
- `CLAUDE.md`

可通过 `--no-context-files` 禁用。

可替换系统 prompt：

- `.pi/SYSTEM.md`
- `~/.pi/agent/SYSTEM.md`

可追加系统 prompt：

- `APPEND_SYSTEM.md`

可加载资源：

- extensions
- skills
- prompt templates
- themes
- pi packages

资源来源包括用户目录、项目 `.pi/`、`.agents/`、显式 CLI 参数和 Pi package。

## 开发 extension

最小 extension：

```typescript
import { Type } from "@earendil-works/pi-coding-agent";

export default function (pi) {
  pi.registerTool({
    name: "hello",
    label: "Hello",
    description: "Return a greeting",
    parameters: Type.Object({
      name: Type.String(),
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: `Hello ${params.name}` }] };
    },
  });
}
```

放置位置：

- `~/.pi/agent/extensions/`
- `.pi/extensions/`
- Pi package 的 `extensions` manifest
- CLI `-e` / `--extension`

开发时要根据 `ctx.mode` 判断能力：

- `tui`：可使用 custom component、header、footer、editor component。
- `rpc`：支持 dialog 和 fire-and-forget UI，但 TUI component 能力降级。
- `json` / `print`：不应假定有交互 UI。

## 新增 provider

在 `packages/ai` 新增 provider 通常需要：

1. 在 `src/types.ts` 添加 API/provider 类型。
2. 在 `src/providers/` 新增 provider implementation。
3. 在 `src/providers/register-builtins.ts` 注册 lazy loader。
4. 更新 package subpath exports。
5. 更新 env API key 检测。
6. 更新 model generation scripts。
7. 添加 streaming、token、abort、overflow、image/tool result、cross-provider handoff 等测试。
8. 更新 README 和 changelog。
9. 更新 `packages/coding-agent` 的 default model、CLI help 和 README。

如果只是接入内部代理或 OpenAI-compatible endpoint，优先用 custom model 或 extension `registerProvider()`，不要直接改 `packages/ai`。

## 会话和调试

会话文件默认在：

```text
~/.pi/agent/sessions/
```

`/session` 可查看当前 session id、文件、消息数、token、cost 等信息。

隐藏 `/debug` 命令会写入：

```text
~/.pi/agent/pi-debug.log
```

内容包括：

- 渲染后的 TUI 行和 ANSI code。
- 最近发送给 LLM 的 messages。

TUI 原始输出调试：

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log npx tsx test/chat-simple.ts
```

## 安全与隔离

默认情况下，Pi 以启动用户权限执行：

- 内置 tools
- `!` / `!!` shell command
- extension tools
- package 安装和执行逻辑

需要更强边界时：

- 用 OpenShell 运行整个 `pi`。
- 用 Gondolin extension 将内置工具和 shell 命令路由到 micro-VM。
- 用 Docker 运行整个 `pi`。

第三方 Pi package、extension、skills 都应视作可执行代码或可影响模型行为的输入，安装前需要审查。

## 贡献规则

上游 `CONTRIBUTING.md` 的核心要求是：

- 必须理解自己的代码，能解释变更如何影响系统。
- 新贡献者 issue/PR 默认 auto-close，维护者后续人工筛选。
- 提交 PR 前必须通过：

```bash
npm run check
./test.sh
```

- 不要自行编辑 `CHANGELOG.md`，由维护者处理。
- 影响 `packages/ai` provider 的改动需要特别完整的测试。

## 维护建议

- 改动 `coding-agent` 前先确认是否应该作为 extension，而不是扩进 core。
- 改动 RPC 时同步更新 `packages/coding-agent/docs/rpc.md` 和相关类型。
- 改动 session entry 或 message type 时同步考虑旧 session migration。
- 改动 TUI 组件时检查行宽、ANSI reset、IME、paste 和终端兼容。
- 改动 provider 时优先用 faux provider 做确定性测试，避免依赖真实 LLM。
- dependency 或 lockfile 变更按代码审查处理，不要顺手提交无关 lockfile churn。
