# 第三方来源与许可证说明

本仓库自身的许可见根目录 [LICENSE](../LICENSE)（PolyForm Noncommercial 1.0.0，商业用途需另行授权）。本文件说明随安装包分发的第三方组件及其许可义务，**不改变、也不限制**这些组件各自的许可。

安装包（`app.asar` 之外的 `resources/licenses/`）随附了每个生产依赖的许可原文与本仓库的许可文本，索引在该目录的 `INDEX.md`。该目录由 `electron-agent/scripts/collect-third-party-licenses.cjs` 从 `electron-agent/package-lock.json` 生成，逐包条目见 [third-party-dependencies.md](./third-party-dependencies.md)。

## 分发的许可类型

生产依赖共 875 个包（以 `electron-agent/package-lock.json` 中 `dev` 为假者计）。其中绝大多数是 MIT / ISC / Apache-2.0 / BSD 系列宽松许可，随附版权声明与许可文本即满足要求。需要单独说明的只有下面几项。

### EPL-2.0：elkjs

- 包：`elkjs@0.11.1`，许可证 Eclipse Public License 2.0。
- 引入路径：`@lobehub/ui` → `beautiful-mermaid@1.1.3` → `elkjs`；被 Vite 打进渲染进程的 `Mermaid-*.js` 分块，随安装包分发。
- 本仓库未修改 elkjs 源码，仅原样打包。
- EPL-2.0 第 3.1(a) 条要求分发二进制时同时使源代码可得，并告知获取方式。对应版本（`elkjs@0.11.1`，未修改）的源代码取自上游发布包：
  - https://registry.npmjs.org/elkjs/-/elkjs-0.11.1.tgz
  - 项目主页：https://github.com/kieler/elkjs
  许可原文随附于 `resources/licenses/elkjs/LICENSE.md` 与 [docs/licenses/EPL-2.0.txt](./licenses/EPL-2.0.txt)。需要以其他方式获取该源码，可通过仓库 issue 提出。
- EPL-2.0 第 3.1(b) 条允许以不同许可分发本程序，前提是保留接收方对 elkjs 源代码的权利并同样声明免责。本仓库的许可声明不覆盖 elkjs，也不削减上述权利。

### MPL-2.0 OR Apache-2.0：dompurify

- 包：`dompurify@3.4.15`，上游给出双许可。本项目按 **Apache-2.0** 使用，相应履行 Apache-2.0 义务（随附许可文本、保留版权声明、不改动其文件内声明）。
- 引入路径：`mermaid@11.17.2` → `dompurify`，同样打进渲染进程分块。

### OFL-1.1：Inter 字体

- 包：`@fontsource/inter@5.3.0`，字体本身是 SIL Open Font License 1.1（Copyright 2016 The Inter Project Authors）。
- 随包分发字体文件时附上 OFL 原文与版权行，不单独售卖字体，不使用 "Inter" 作为本项目字体产品的名称。

### BSD-3-Clause AND Apache-2.0：chroma-js

- 包：`chroma-js@3.2.0`，两许可同时适用，两项义务都履行：随附两份许可文本与版权声明。

### MIT AND ISC：victory-vendor

- 包：`victory-vendor@36.9.2`，其内部打包的多份 d3 模块分别按 MIT 与 ISC 授权，两种声明都随附。

### 包元数据缺 `license` 字段但实际为 MIT 的包

`khroma@2.1.0`、`@giscus/react@3.1.0` 的 `package.json` 没有 `license` 字段。`khroma` 随包附有 MIT 许可文件（Copyright 2019-present Fabio Spampinato, Andrew Maney），按 MIT 处理。`@giscus/react` 见下节，不从安装包分发。

## 已从安装包排除的组件

### @splinetool/runtime

- 包：`@splinetool/runtime@1.12.98`，由 `@lobehub/ui` 声明为依赖。上游没有 `license` 字段、包内没有许可文件，仅有 `© 2025 Spline, Inc.` 的版权标注。没有明确的授权声明意味着不能推定可以再分发。
- 本项目不使用 Spline：`node_modules/@lobehub/ui/es/awesome/Spline/`、`es/brand/LogoThree/LogoSpline.mjs` 都不在源码引用链上，生产渲染产物里没有 Spline 代码（已核对 `out-pkg/renderer/assets/*.js`）。
- 处理：`electron-agent/electron-builder.yml` 的 `files` 里以 `!node_modules/@splinetool/**` 把它排除出安装包。仓库与开发环境的 `node_modules` 里仍有该包（`@lobehub/ui` 的依赖声明拉进来的），但那不是分发。
- 残留项：`@lobehub/ui` 自身随包发布的分支文件 `es/awesome/Spline/Spine.mjs` 里有一行 `import { Application } from "@splinetool/runtime"`。这是 LobeHub 的引用，不含 Spline 代码；同目录的 `es/awesome/index.mjs` 也不在引用链上。若日后接入 LobeHub 的 Spline 组件，必须先解决该包的授权问题。

### giscus / @giscus/react

- 包：`giscus@1.6.0`（MIT）与 `@giscus/react@3.1.0`（元数据无 `license` 字段，源码仓库 `giscus/giscus-component` 为 MIT）。
- 同样只被 `@lobehub/ui` 的 `es/awesome/Giscus` 使用，本项目未引用，渲染产物中不含。处理方式同上：以 `!node_modules/giscus/**`、`!node_modules/@giscus/**` 排除出安装包。

## 逐字移植的第三方文本

### TencentDB Agent Memory（MIT）

- 项目：https://github.com/TencentCloud/TencentDB-Agent-Memory
- 许可证：MIT（Copyright Tencent）
- 用途：`electron-agent/electron/agent/memoryPrompts.ts` 中的 L1 记忆抽取系统提示词（`MEMORY_EXTRACT_WORK_SYSTEM_PROMPT`、`MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT`）为**逐字移植**，取自上游 `MemoryCore/src/core/prompts/l1-extraction.ts`。
- 上游版本锚点：HEAD `0468a2a5b50eaafc54758ed1e2e6609472e5b6ce`；该文件最后一次变更 `41444344ce11467a5b5ad6aa032f5e261da1f4d2`（2026-07-22，v2.0.0-beta.1）。
- 边界：仅移植提示词文本常量，未复制其运行时、存储层或调度实现。该文本按 MIT 授权，不受本仓库许可限制。

### GPT with Taste（MIT）

- 项目：https://github.com/NB-Corp/gpt-with-taste
- 许可证文件：`extensions/gpt-with-taste/LICENSE`（MIT，Copyright 2026 GPT with Taste contributors / X-T-E-R）。
- 用途：`extensions/gpt-with-taste/texts/` 下的行为文本。构建时由 `copyPiAdjacentAssets` 连同该 LICENSE 一起拷到 `out/main/texts/`，并随安装包分发（`resources/app.asar.unpacked/out/main/texts/LICENSE`）。

## 内置的运行时 SDK

### Pi（@earendil-works/pi-*）

- 包：`@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core`、`pi-codemode` 等，均为 MIT（Copyright 2025 Mario Zechner，https://github.com/earendil-works/pi）。
- 这些包的 npm 发布物里没有 LICENSE 文件（`files` 字段未包含），所以 `resources/licenses/` 下对应条目是 `LICENSE-MISSING.txt` 占位。MIT 的完整文本见 [docs/licenses/MIT.txt](./licenses/MIT.txt)，版权行取自上游仓库的 `LICENSE`。
- 主进程把 SDK 打进字节码产物（`externalizeDeps: false`），不是以独立目录分发。

### CodeGraph（@colbymchenry/codegraph）

- 包：`@colbymchenry/codegraph@1.6.2`，MIT。
- 用途：CodeGraph 资产模块通过内置 MCP client 调用其索引服务；工具协议沿用上游 `codegraph_*` 接口。
- 边界：本项目不复制或修改 CodeGraph 的 Rust 索引器；平台二进制随包提供（`asarUnpack`），许可为 MIT。

## 仅有设计参考、未分发代码的项目

### Hermes Agent

- 项目：https://github.com/nousresearch/hermes-agent
- 用途：Skill 资产管理参考其 Skill 发现与加载流程。
- 当前状态：Skill / 自定义 Agent 仅保留扩展接口，未复制其实现。

### LLM Wiki

- 资料：https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- 用途：Wiki RAG 将 Markdown 文档视为可持续维护的知识产物，并保留来源路径、标题分块和行号引用。

## 开发依赖

`electron-agent` 的 devDependencies（vitest、electron、electron-builder、sharp、lightningcss、caniuse-lite 等）不进入安装包，因此不在随包声明范围内。其中 sharp 附带 LGPL-3.0-or-later 组件、lightningcss 为 MPL-2.0、caniuse-lite 为 CC-BY-4.0，仅在本机构建时使用（`scripts/generate-icons.mjs` 与构建工具链）。

## 维护

新增、移除或升级依赖后，重新生成清单并提交：

```bash
cd electron-agent
node scripts/collect-third-party-licenses.cjs --report=../docs/third-party-dependencies.md
node scripts/collect-third-party-licenses.cjs --check   # 校验清单是否最新
```

打包时 `electron-builder.yml` 的 `beforePack` 会自动重跑收集，把 `resources/licenses/` 摊进安装包。
