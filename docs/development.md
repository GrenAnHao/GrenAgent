# 开发指南

桌面端使用 Electron。以下命令都从仓库根目录执行。早期 Tauri 版见 Git 标签 `archive/tauri-agent`。

## 环境要求

- 建议使用 Node.js 24 和 pnpm 12.6.0，与 [macOS 构建流程](../.github/workflows/build-mac.yml) 一致。CLI 声明的 Node.js 最低版本为 22.19.0。

## 安装

根目录的依赖用于校验决策笔记。`extensions/`、`cli/` 和 `electron-agent/` 各有自己的锁文件，分别安装；桌面构建会用到另外两个子项目的依赖。

```sh
pnpm install --frozen-lockfile
pnpm --dir extensions install --frozen-lockfile
pnpm --dir cli install --frozen-lockfile
pnpm --dir electron-agent install --frozen-lockfile
```

## 启动

| 场景 | 命令 |
| --- | --- |
| 日常运行 | `pnpm --dir electron-agent start`：构建后启动，从本地文件加载界面 |
| 修改前端 | `pnpm --dir electron-agent dev`：通过 Vite 热更新前端，主进程或 preload 改动后需重启 |
| 复用已有的本机启动产物 | `pnpm --dir electron-agent start --skipBuild`：源码未改且已有可用产物时使用 |

Windows 开发服务使用 IPv4 回环，页面地址仍是 `http://localhost:31415`。首次启动后，在「设置 → 供应商」配置模型并测活。

## 测试与类型检查

日常改动优先跑相关测试文件。下表以会话行和工具提示词元数据为例。

| 用途 | 命令 |
| --- | --- |
| 跑单个桌面测试文件 | `pnpm --dir electron-agent exec vitest run src/features/sessions/SessionItem.test.tsx` |
| 跑桌面 Vitest 套件 | `pnpm --dir electron-agent test` |
| 验证真实 Electron 交互 | `pnpm --dir electron-agent ui:check session-row` |
| 跑扩展测试文件 | `pnpm --dir extensions exec vitest run prompt-metadata.test.ts` |
| 跑 CLI 测试 | `pnpm --dir cli test` |
| 检查 CLI 类型 | `pnpm --dir cli typecheck` |
| 检查主进程和宿主类型 | `pnpm --dir electron-agent exec tsc -p tsconfig.node.json --noEmit` |
| 校验决策笔记 | `pnpm run verify-notes` |

改了布局或交互时，按 [AGENTS.md](../AGENTS.md) 选择对应的 UI 场景。单独做类型检查时保留 `--noEmit`，避免在源码旁生成 JS 和声明文件。

## 测试约定

- 桌面端和扩展使用 Vitest，CLI 使用 Node.js 测试运行器。测试文件与源码同目录，命名 `*.test.ts` 或 `*.test.tsx`。
- 优先用 `vi.spyOn` 而非 `vi.mock`，尽量测试真实实现，不要把逻辑复制进测试。
- 涉及桌面能力时，mock `window.gren` 桥（契约见 `electron/ipc/contracts.ts`，渲染层入口为 `src/platform/runtime.ts`），不要 mock Electron 内部模块；无 bridge 时运行时会降级为 `browserPreviewBridge`。

## 代码风格

- **禁止 emoji**：源码、注释、UI 文案、文档和提交说明用文字、颜色或 lucide 图标表达状态。
- **图标**：统一用 `@lobehub/ui` 的 `Icon` 组件搭配 `lucide-react` 图标，不要用 emoji 充当图标。
- **样式**：优先用 `antd-style` 的 `createStaticStyles` 搭配 `cssVar.*`（零运行时）；确需运行时计算时再退回 `createStyles` 加 `token`。
- **状态管理**：使用轻量 vanilla store（非 Redux），通过 `requestAnimationFrame` 批量通知组件；流式更新用可变修改加 rAF flush，避免每帧不可变拷贝。
- **注释**：只解释非显而易见的意图、权衡或约束，不要逐行复述代码。

## 扩展开发

内置扩展位于 `extensions/`，由 `extensions/index.ts` 的 `allExtensions` 汇总，供 `agent-host` 和 `pi-worker` 加载。新增扩展时同步更新该文件的导入和工厂清单；`extensions/package.json` 的 `pi.extensions` 用于独立安装。

一个扩展通常这样注册能力：

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "……",
    promptSnippet: "一行工具说明",
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

扩展使用 `@earendil-works/pi-coding-agent` 的类型。新增或覆盖工具后，按 [工具提示词约定](../AGENTS.md#注册工具必须带官方提示词字段) 填写元数据并跑上表中的扩展测试。

## 构建与打包

先构建生产产物，再用 electron-builder 生成本机安装文件。以下命令不发布：

```sh
pnpm --dir electron-agent build
pnpm --dir electron-agent package --publish never
```

| 目录 | 用途 |
| --- | --- |
| `electron-agent/out/` | `dev` 和 `start` 的主进程及 preload |
| `electron-agent/dist/` | `start` 加载的渲染层 |
| `electron-agent/out-pkg/` | `build` 生成的生产产物，也是打包输入 |
| `electron-agent/release/` | 安装文件：Windows NSIS、macOS DMG、Linux AppImage |

打包配置会把生产产物映射回安装包内的 `out/` 和 `dist/`。不要用本机启动产物替代 `out-pkg/`。

## 提交与分支

- commit message 遵循约定式提交（Conventional Commits），用中文描述，例如 `fix(sessions): 修复项目在资源管理器中打开无效`。
- 不要提交 `node_modules/`、`out/`、`dist/`、`out-pkg/`、`release/` 或本地数据库。
