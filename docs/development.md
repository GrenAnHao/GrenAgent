# 开发指南

本文介绍本地开发环境搭建、常用命令、测试与代码风格约定。

## 环境要求

- Node.js >= 22.5（sidecar 在 `cli/package.json` 中声明 `engines.node >= 22.5.0`）
- Rust 工具链：构建桌面端（Tauri 2）时需要，参见 Tauri 官方环境要求
- pnpm 与 npm：均可用于安装依赖；注意 `tauri.conf.json` 的 `beforeDevCommand` 与 `beforeBuildCommand` 配置为 `pnpm dev` / `pnpm build`，因此 `npm run tauri dev` 会在内部调用 pnpm

## 安装

```bash
cd tauri-agent
npm install
```

`cli/` 与 `extensions/` 各自维护依赖，按需在对应目录执行 `npm install`。

## 常用命令

以下命令在 `tauri-agent/` 目录执行：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 前端开发服务器 |
| `npm run tauri dev` | 启动桌面端（Tauri + Rust，内部触发 pnpm） |
| `npm run build` | 前端构建（`tsc && vite build`） |
| `npm run build:sidecar` | 构建 Agent sidecar 二进制（`binaries/pi`） |
| `npm run build:codegraph` | 构建 CodeGraph 二进制 |
| `npm run test` | 运行前端测试（`vitest --run`） |
| `npx tsc --noEmit` | 前端类型检查 |

sidecar（`cli/`）的相关命令：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 以 `--mode rpc` 直接运行 sidecar（`tsx`） |
| `npm run typecheck` | 类型检查（`tsc --noEmit`） |
| `npm run build` | 用 esbuild 打包为单文件 |

## 验证

提交前建议至少跑通类型检查与相关测试：

```bash
cd tauri-agent
npx tsc --noEmit
npx vitest run <改动涉及的测试文件>
```

跑单个测试文件比全量快很多，例如：

```bash
npx vitest run src/features/sessions/SessionItem.test.tsx
```

## 测试约定

- 使用 Vitest，测试文件与源文件同目录，命名 `*.test.ts` 或 `*.test.tsx`。
- 优先用 `vi.spyOn` 而非 `vi.mock`，尽量测试真实实现，不要把逻辑复制进测试。
- 涉及 Tauri 接口时，mock `@tauri-apps/api`、`@tauri-apps/plugin-*` 等模块。

## 代码风格

- **禁止 emoji**：源码、注释、UI 文案、文档、commit message 等任何产出均不得使用 emoji（见 `.cursor/rules/no-emoji.mdc`）。需要表达状态或强调时，用文字、颜色或 lucide 图标。
- **图标**：统一用 `@lobehub/ui` 的 `Icon` 组件搭配 `lucide-react` 图标，不要用 emoji 充当图标。
- **样式**：优先用 `antd-style` 的 `createStaticStyles` 搭配 `cssVar.*`（零运行时）；确需运行时计算时再退回 `createStyles` 加 `token`。
- **状态管理**：使用轻量 vanilla store（非 Redux），通过 `requestAnimationFrame` 批量通知组件；流式更新用可变修改加 rAF flush，避免每帧不可变拷贝。
- **注释**：只解释非显而易见的意图、权衡或约束，不要逐行复述代码。

## 扩展开发

内置扩展位于 `extensions/`，由 `extensions/index.ts` 的 `allExtensions` 汇总后编入 sidecar（当前 36 个）。`extensions/package.json` 的 `pi.extensions` 字段仅用于独立安装时的元数据，新增扩展时需同时改 `index.ts` 的 import 与 `allExtensions` 数组。

一个扩展通常这样注册能力：

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "……",
    parameters: Type.Object({ /* ... */ }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // ctx.cwd / ctx.modelRegistry / ctx.ui 等
      return { content: [{ type: "text", text: "done" }] };
    },
  });

  pi.registerCommand("mycmd", {
    description: "……",
    handler: async (args, ctx) => { /* ... */ },
  });
}
```

扩展直接由 Pi 运行时以 TypeScript 加载，没有独立的 tsconfig；类型以 `@earendil-works/pi-coding-agent` 为准。

## 构建产物

- `binaries/pi`：sidecar 单文件二进制，由 `npm run build:sidecar` 生成。
- `binaries/codegraph/`：CodeGraph 二进制，由 `npm run build:codegraph` 生成，并在 `tauri.conf.json` 的 `resources` 中打包。

## 本地向量服务（embedding，独立模块）

`embedding/` 是一个独立的本地向量服务，目前尚未集成进 sidecar 或桌面应用，可单独构建与运行。它在本地 CPU 上用 `@huggingface/transformers` 跑 `Xenova/bge-small-zh-v1.5`，对外暴露 OpenAI 兼容 `POST /v1/embeddings`（512 维），并可用 Node.js SEA 打成单文件可执行程序。

以下命令在 `embedding/` 目录执行：

| 命令 | 说明 |
| --- | --- |
| `npm start` | 先 esbuild 打包再用 Node 运行（`build:bundle` 后跑 bundle） |
| `npm run typecheck` | 类型检查 |
| `npm run build:bundle` | esbuild 打包为单文件 CommonJS bundle |
| `npm run build:sea` | 用 Node v25.5+ 的 `--build-sea` 生成单文件可执行程序 |

注意事项：

- SEA 打包需要 Node >= 25.5.0。
- 首次运行会下载模型权重；国内网络可设 `HF_ENDPOINT=https://hf-mirror.com`。
- `onnxruntime-node` 是原生 `.node` 插件，需作为 external 保留，运行时仍依赖磁盘上的 `node_modules/onnxruntime-node/` 与 `.models/`。
- 更多实现细节见 `embedding/README.md`。

## 提交与分支

- commit message 遵循约定式提交（Conventional Commits），用中文描述，例如 `fix(sessions): 修复项目在资源管理器中打开无效`。
- 不要提交 `node_modules`、`.codegraph`、构建产物等（已在 gitignore 中）。
