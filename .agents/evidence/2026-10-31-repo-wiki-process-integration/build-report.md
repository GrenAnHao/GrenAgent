# RepoWiki 构建、依赖与许可证报告

## 结果

- 最终 `cd electron-agent; npm run build` 退出码 0；实际先跑 `tsc -p tsconfig.repo-wiki.json`，再构建 main / preload / renderer。
- `out/main/repo-wiki-host.cjs` 与 `out-pkg/main/repo-wiki-host.cjs` 均已生成，单文件 CJS，173,523 bytes；生产文件 SHA256 为 `6480FF3371E8FA8BC0308404FD94202D763C64FDE7ED5629DAD2483A24646102`。
- child 的 esbuild metafile 中所有 external imports 均为 `node:*`（含 `node:sqlite`），没有外置 npm 包或共享 chunk。
- 4 个构建/许可证定向测试文件共 21 条通过；两个临时开发/生产布局都从无 node_modules 的临时 ESM 应用实际 fork IPC child，收到独立 PID 与 shutdown 成功回执，并退出 0。未调用模型。
- `node scripts/collect-third-party-licenses.cjs --check` 通过；生成清单覆盖 914 个条目，RepoWiki MIT 与 THIRD_PARTY_NOTICES.md 已拷到 `build/licenses/repo-wiki/`。

## 实现

- `electron/agent/repoWikiHostBuild.ts` 导出 `buildRepoWikiHost(appDir, mainOutDir)`、`repoWikiHostBuildOptions` 和 `REPO_WIKI_HOST_ENTRY`。入口为 vendor 的 `packages/process/src/child.ts`，target Node 22，独立 esbuild bundle，不进入 electron-vite 的 mainInput / 字节码图。
- `electron.vite.config.ts` 的 main closeBundle await 同一构建函数；mainOutDir 继续遵守 dev `out/main`、production `out-pkg/main`。
- `electron-builder.yml` asarUnpack 增加 `out-pkg/main/repo-wiki-host.cjs`，现有 files 映射会令它落到 `resources/app.asar.unpacked/out/main/`。
- `tsconfig.repo-wiki.json` 真实覆盖 child 所有 packages/src、宿主 repoWikiService、RepoWikiWorkspace、专用 runtimeFixture 和构建 helper。`--listFilesOnly` 证明该工程有 589 个输入文件。新配置接入 build；另有 `typecheck:repo-wiki` 脚本。`tsconfig.node.json` 最小补充 vendor packages/src include，避免 composite 缺少文件列表的 TS6307。
- `test:repo-wiki` 脚本为 `node --import tsx scripts/test-repo-wiki.mjs`；runner 由 root 负责。electron-agent 单独声明 devDependency `tsx@4.23.15`，支持 Node 22.13 基线加载 TS helper。

## 依赖与许可

新增固定运行依赖：`diff@8.0.2`、`ignore@7.0.5`、`fflate@0.8.2`、`dompurify@3.4.17`、`react-markdown@10.1.0`、`remark-gfm@4.0.1`、`remark-parse@11.0.0`、`unified@11.0.5`、`shiki@4.4.3`。Shiki 复用原安装版本；旧 standalone 路由未进入嵌入面板的引用链，无需新增 react-router-dom。

root 与 electron-agent 有各自独立 pnpm workspace；只改 electron-agent/package.json 和 pnpm-lock.yaml，root lock 与历史 npm lock 未动。与 HEAD YAML 比较，所有既有 packages 元数据均未变，React/Mermaid/Zustand/Pi 等旧版本保持。特别保留 Mermaid 的 DOMPurify 3.4.14，RepoWiki 使用 3.4.17。新增 tsx 导致 Vite 系列 optional-peer snapshots 重新编号，但没有升级其包版本；tsx 自己带开发用 esbuild 0.28.2，宿主原 esbuild 0.27.7 不变。

原 license 脚本仅读陈旧 package-lock 且忽略嵌套版本，不能覆盖本次 pnpm 依赖。现从已安装生产依赖闭包读取实际元数据，跟随 pnpm 的真实路径，包含传递、已安装 peer / optional 依赖，排除 dev-only peer，保留 builder 排除清单。按 name/version 去重；同名多个版本分别收集到 `<name>/<version>`，单一版本沿用 `<name>`。vendor MIT 与来源声明单独纳入清单，原文件未改。

`docs/third-party-notices.md` 保留原有用户改动，仅更新依赖清单来源、DOMPurify 实际版本并补 RepoWiki 来源。`docs/third-party-dependencies.md` 已重生成。

许可证测试曾因新增多版本断言额外重复计算整个 inventory 而超过原 5 秒限制。profiling 显示单次图约 1.9 秒，完整 collect 约 3.9 秒；去掉断言中的冗余整图计算后，原超时阈值下 21 条全部通过。尝试过遍历缓存，但 pnpm 虚拟目录使收益很小，已撤回，没有保留额外缓存，也没有增加 timeout。

## 证据与限制

- 完整最终构建日志：`.tmp-repowiki-source/electron-build.log`。
- 最终 21 条测试日志：`.tmp-repowiki-source/build-tests.log`。
- 产物信息：`.tmp-repowiki-source/artifact-summary.json`。
- 定向类型工程的实际文件列表：`.tmp-repowiki-source/repo-wiki-typecheck-files.txt`。
- 额外尝试把真实 UI harness 整体壳纳入类型检查：`.tmp-repowiki-source/harness-typecheck.tsconfig.json` / `harness-typecheck.log`。它经 ModuleContainer 导入旧模块，仍有 AgentData SQLite、mcpConfig、SettingCard、agentData 调用等既有类型错误；未将这些跨模块修复混入本次任务。专用 RepoWiki 生产工程通过，完整 UI 场景的运行验收由 frontend / root 汇总。
- 实际 `tsconfig.node.json --noEmit` 同样发现大量既有 AgentData、MCP、历史测试类型错误；没有宣称整个旧工程 typecheck 通过。
- 完整构建保留既有 Pi `EMPTY_IMPORT_META` 和 lobe-theme `INEFFECTIVE_DYNAMIC_IMPORT` 警告。
- 本分工未运行安装包发布，也未提交或推送；真实 Electron 22 子进程全套测试、打包形式路径 smoke 与 verify-notes 由 root 汇总执行。

## 笔记待 root 同步的事实

将原提案的构建条目更新为上面的单文件 CJS closeBundle 方案及 asarUnpack。记录不选 mainInput 字节码的原因：child 需要 `node:sqlite` 且必须独立运行，不应把 engine / scanner 合并进主进程或依赖解包共享 chunk。记录定向真实 typecheck 门禁和 pnpm 实际依赖图许可证收集；备选是直接沿用 npm-lock 清单，优势为最少变动，但它无法包含新增 pnpm 依赖并会遗漏多版本，因此不用。
