# Agent Note: 许可改为 PolyForm Noncommercial，并把第三方许可证真正随包分发

Status: implemented

## Problem

2026-10-22 的许可提交（146bb18b）把仓库改成「保留所有权利」并删掉了扩展 `package.json` 的 MIT 声明。这留下三处没人处理的问题。

**第一，许可模型与真实意图不符。** 用户要的是「非商业免费、商业需授权」，「保留所有权利」连个人学习都没授权，等于把所有潜在使用者都挡在门外。

**第二，安装包里在分发一份没有授权声明的作品。** `@lobehub/ui@5.32.7` 把 `@splinetool/runtime@1.12.98` 声明为依赖，而该包没有 `license` 字段、没有 LICENSE 文件，只有 `© 2025 Spline, Inc.` 的版权标注。它被 Electron 默认的 node_modules 收集塞进 `app.asar`（11 个文件），随安装包一起发出去。没有授权声明就意味着不能推定可以再分发。`giscus@1.6.0` 与 `@giscus/react@3.1.0` 同理被打包，但本项目并不使用它们。

**第三，许可义务没有落到分发物上。** 生产依赖 875 个包里，MIT/ISC/Apache-2.0/BSD 都要求分发二进制时附带版权声明与许可文本；`elkjs`（EPL-2.0，经 `beautiful-mermaid` 引入并被 Vite 打进渲染分块）还要求同时使源代码可得；`@fontsource/inter`（OFL-1.1）要求随附字体许可。但 asar 对最终用户不透明，声明只写在仓库里等于没有履行。另外 `docs/third-party-notices.md` 只列了四个「设计参考」项目，既没有 MIT/Apache/EPL/OFL 原文，也漏掉了 `@earendil-works/pi-*`（MIT，但 npm 发布物的 `files` 字段不含 LICENSE）。

## Decision

### 主许可用 PolyForm Noncommercial License 1.0.0

`LICENSE` 正文逐字取自上游 `polyformproject/polyform-licenses` 的 `1.0.0` tag（diff 校验与上游一致），前置一段本仓库自己的说明：非商业免费并可修改分发、商业用途需单独书面授权、第三方组件各自守其原许可，外加 PolyForm 要求的 `Required Notice` 行。选它而不是自拟条款，是因为标准文本已被广泛阅读、边界（个人使用、非营利组织、公平使用、违约宽限期）写清楚了，而自拟条款在法律上不成熟。

`COMMERCIAL.md` 单独列「不需要授权 / 需要授权」的用途与申请流程，README 的许可证段落改为指向它。

四个 `package.json`（根、`electron-agent`、`cli`、`extensions`）加 `license: "PolyForm-Noncommercial-1.0.0"`。该标识符在 SPDX 中有登记（`isOsiApproved: false`，本来就不是 OSI 许可），`pnpm licenses list` 能正常解析。

### 新增 `scripts/collect-third-party-licenses.cjs`

从 `package-lock.json` 取全部非 dev 依赖，逐包复制 `LICENSE` / `LICENCE` / `COPYING` / `NOTICE` 等文件到 `build/licenses/<包名>/`，再把本仓库 `LICENSE` 与 `docs/third-party-notices.md` 一并放进去，最后生成 `INDEX.md`（分布统计 + 特殊条目 + 全量清单）。上游没带许可文件的包（103 个）留 `LICENSE-MISSING.txt` 占位，写明声明的许可证标识与出处，便于人工核对。

排除面与打包面同源：脚本读 `electron-builder.yml` 的 `files` 里以 `!` 开头的项，声明和实际打包不会分叉。`--check` 校验已提交的 `docs/third-party-dependencies.md` 是否最新。

### 把 `@splinetool` 与 `giscus` 排除出安装包

`electron-builder.yml` 的 `files` 加 `!node_modules/@splinetool/**`、`!node_modules/giscus/**`、`!node_modules/@giscus/**`。

这三个包都不在源码引用链上（已核对 `out-pkg/renderer/assets/*.js` 与 `out-pkg/main/*.js`：没有 `splinecode`、`@splinetool`、`giscus-frame` 等特征串），只是 `@lobehub/ui` 的依赖声明把它们拉了进来。排除后开发环境的 `node_modules` 仍有它们，不影响构建，但不再随安装包分发。

### 许可文本放 asar 之外

`extraResources: [{ from: build/licenses, to: licenses }]` + `beforePack: ./scripts/collect-third-party-licenses.cjs`。装完后是 `resources/licenses/`，最终用户能直接打开看，也符合 EPL-2.0 告知源代码获取方式的要求。`build/licenses/` 加进 `.gitignore`（每次打包重新生成）。

### `docs/third-party-notices.md` 重写

按许可义务分节：EPL-2.0（ elkjs 的源码获取途径与 3.1(b) 允许不同许可分发的条件）、MPL-2.0 OR Apache-2.0（dompurify 按 Apache 履行）、OFL-1.1（Inter 字体的版权行与 RFN 约束）、双许可包（chroma-js、victory-vendor）、元数据缺 `license` 但实为 MIT 的 khroma。另列已排除的 Spline 与 giscus、逐字移植的两份 MIT 文本、内置的 Pi SDK 与 CodeGraph、仅作设计参考的项目、不进包的开发依赖（sharp 的 LGPL、lightningcss 的 MPL、caniuse-lite 的 CC-BY）。

`docs/licenses/*.txt` 存 11 份 SPDX 权威许可正文，供无法从 npm 包内取到原文时引用。

## Alternatives considered

- **选 MIT/Apache-2.0 双许可，靠「商用请付费」的道德劝说**。最强理由：生态最友好，零摩擦。不用：开源许可一旦授予就不可撤回，收不回商业授权，与「需要授权才可以商用」直接冲突。
- **选 Business Source License (BSL 1.1)**。最强理由：业内认可，带 Change Date 自动转开源，Databricks/HashiCorp 用过。不用：BSL 允许生产使用（正是要限制的），只是限制「提供竞争性服务」；且要指定 Change License 与日期，对个人项目是额外承诺。
- **选 PolyForm Small Business 1.0.0**。最强理由：小公司（按收入划线）可免费商用，生态更开放。不用：用户要的是「商用需授权」，不打算留收入门槛。
- **自拟中英双语短条款**。最强理由：一句话说清，好读。不用：条款不成熟，边界（什么算商业、衍生作品怎么算）没有判例与共识支撑。
- **直接删掉 `@lobehub/ui`，或给 `@splinetool` 打补丁**。最强理由：一劳永逸。不用：`@lobehub/ui` 是这个 UI 的地基（面板、Markdown、CodeDiff 全靠它），不能为了一个未使用的传递依赖拆掉；打补丁要在 `node_modules` 里改别人的包，`pnpm install` 就丢，维护成本高于收益。排除即可，因为本来就不用。
- **把许可文本放进 asar**。最强理由：asrar 内自动跟着 `files` 走，不用配置 `extraResources`。不用：asar 里的文件用户看不到，MIT 的「shall be included」与 EPL 的「告知获取方式」都要求接收方能实际读到。
- **手写 `docs/third-party-dependencies.md`**。最强理由：可控，能挑重点写。不用：875 个包手写必然腐化；脚本生成 + `--check` 才能跟锁文件同步。人工判断的部分保留在 `third-party-notices.md` 里。
- **把 EPL 的 elkjs 换成别的布局引擎**。最强理由：彻底去掉弱 copyleft 义务。不用：布局引擎由 `beautiful-mermaid` 的打包形态决定（`elk.bundled.js` 内联），换引擎要 fork 或替换整个 Mermaid 渲染链，代价远超「随附许可 + 给源码链接」。
- **不排除 giscus，只排除 Spline**。最强理由：giscus 是 MIT。不用：项目不用它，多打包只会让体积和声明都更难对齐；且有 `@giscus/react` 元数据缺 `license` 的干扰项，统一排除更干净。

## Consequences

- 非商业用户可以自由克隆、修改、分发；商业用户需要单独签约。这是行为约束的变化，不再是无差别禁止。
- asar 小了约 6.5MB（从 Spline 与 giscus 的排除而来），安装包多出 3.8MB 的 `resources/licenses/`。
- 仍有两个残留项需要知悉：`@lobehub/ui` 自己发布的 `es/awesome/Spline/Spine.mjs` 里有一行 `import { Application } from "@splinetool/runtime"`（源码文件，随 `@lobehub/ui` 分发，但不含 Spline 代码、不在引用链上）；开发机 `node_modules` 里仍有 `@splinetool/runtime`，只是不再分发。日后若要接入 LobeHub 的 Spline 组件，必须先解决该包授权。
- 依赖变更后必须重跑 `node scripts/collect-third-party-licenses.cjs --report=../docs/third-party-dependencies.md`，否则 `thirdPartyLicenses.test.ts` 的同步断言会红。
- `build/licenses/` 每次打包重新生成，不入库；离开 `scripts/` 目录手工点 `pnpm package` 也不会漏，因为 `beforePack` 挂在配置里。
- 这份声明不构成法律意见。商业授权合同、跨司法辖区的可执行性需要律师看。

## Verification

- 单测：`cd electron-agent && npx vitest run electron/app/sourceCodeProtection.test.ts electron/app/thirdPartyLicenses.test.ts electron/agent/copyPiAdjacentAssets.test.ts` —— 3 个文件 21 个测试通过（2026-10-29）。新增断言覆盖：`beforePack` 与 `extraResources` 存在、三个排除 glob 与打包面同源、许可目录里 elkjs/Inter/dompurify 的原文与 Pi SDK 的占位、已提交的报告与锁文件一致。
- 实跑打包：`pnpm exec electron-builder --config electron-builder.yml --dir --publish never` 成功（exit 0），日志里有 `third-party licenses: 872 个包，其中 103 个上游未附带许可文本`，入口检查通过（`out/main/main.js` 在 asar 内）。
- 打包产物核对：`app.asar` 内 `@splinetool` 与 `giscus` 均为 0 个文件，`elkjs` 7 个、`@fontsource/inter` 418 个、`dompurify` 22 个仍在（它们确实要分发）；`resources/licenses/` 580 个顶层条目，elkjs 原文、Inter 字体许可、Pi SDK 占位都在。
- 清单一致性：`node scripts/collect-third-party-licenses.cjs --check` 输出 `ok: docs/third-party-dependencies.md 与锁文件一致`。
- 未验证：没有在 Windows 10/11 上安装新安装包并启动走一遍；mac 的 dmg 没重新打，`build-mac.yml` 走同一份配置理论上是同一个结果但没有实跑。授权条款的效力没有经过法律审查。
- 证据：`.agents/evidence/2026-10-29-noncommercial-license-and-third-party-compliance/`（`vitest-green.txt`、`report-check.txt`、`package-inspection.txt`）。
