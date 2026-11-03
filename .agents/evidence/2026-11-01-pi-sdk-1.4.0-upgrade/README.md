# Pi SDK 1.4.0 升级验收

CLI、extensions、Electron 三入口的真实依赖图及各自 pnpm/npm 锁，以下七包均已从正式版 1.3.0 更新到 **1.4.0**：`pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-codemode`、`pi-mcp`、`pi-tui`、`pi-telemetry`（命名空间均为 `@earendil-works/`）。见 [运行图与锁](dependency-graphs-1.4.json)、[检查脚本](verify-dependency-graphs.cjs)。未引入 Chord、pi-schema 或未发布 API。CLI 顶层未声明的旧 core 目录未进入实际运行图；旧 bun 锁保留，release-age/allowBuilds 配置未改。

## 修改范围

- 三个 `package.json` 的直接 Pi 版本和六份锁文件。
- CLI 两份补丁脚本支持显式目标项目；extensions/Electron 增加 `postinstall`。三副本统一保留 shell 查找增强和五行显示 diff，保留官方 Store alias、WSL 等修复以及四行统一 patch。新增缺失 SystemRoot/WINDIR 回归并修正路径转义。
- 新增 `cli/src/pi-install-patches.test.ts`、`extensions/_shared/pi-sdk-compat.integration.test.ts`；更新 SDK 导出入口版本注释、执行计划与决策笔记。没有修改会话/模型/知识服务业务实现。
- Electron npm 锁原本落后于已有清单；除 Pi 七包外的既有项变化仅为匹配任务开始时清单中的 `diff=8.0.2`、`dompurify=3.4.17`、`ignore=7.0.5`，并补入已有依赖的缺失传递包。未修改这些清单版本。

开工 HEAD 为 `310e57280b58766ad1f67cd5b2ff7e5d61667ee2`，已有 614 条 dirty 记录。任务前快照留在 `.tmp-pi-sdk-1.4/`。执行期间另有用户对 knowledgeKernel `contracts.test.ts`、`modelRequests.ts`、`runtimeBridge.ts` / `.test.ts`、`store.ts` 的预算/转录估算并发修改，均保留，未归入本次 SDK 实现。

## 实际通过

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 真实依赖图与 pnpm/npm 锁 | 三入口七包均 1.4.0 | [dependency-graphs.log](dependency-graphs.log) |
| pnpm 冻结锁离线安装 | 3/3 exit 0 | `install-*-frozen.log` |
| 实际 postinstall / 幂等 / 空 PATH Git Bash | 三副本全部通过 | [补丁报告](patches-report.md) |
| 安装补丁回归 | 11/11 | [patches-green-final.log](patches-green-final.log) |
| SDK / 会话 / 私有 hook / 压缩 / headers | 238/238 | [兼容报告](compat-report.md) |
| 配置/auth 路径离线测试 | 62/62 | [upgraded-config-auth-offline.log](upgraded-config-auth-offline.log) |
| 工具提示词元数据门禁 | 4/4 | [upgraded-prompt-metadata.log](upgraded-prompt-metadata.log) |
| 知识与 Repo Wiki 最终当前代码原组串行回归 | 34 文件，183/183 | [knowledge-final-1.4.log](knowledge-final-1.4.log) |
| 生产资源定向测试 | 6 suites，29/29 | [resources-tests-localtemp.log](resources-tests-localtemp.log) |
| 资源断言 | 首轮 61 项、最终重建 35 项通过 | [最终断言](resources-final-build-assertions.json) |
| CLI / Electron 最终生产构建 | 均 exit 0；Electron 89 个字节码 chunk | [CLI](build-cli.log)、[Electron](build-electron-final.log) |
| Repo Wiki 专用类型检查 | exit 0 | `upgraded-repo-wiki-types.log` |

真实 SDK fixture 使用隔离 agentDir/auth/models/JSONL 和 127.0.0.1 SSE provider，覆盖 services/fromServices、绑定扩展、批量 `_refreshToolRegistry`、`_cwd`/runner、preflight、真实 SessionUiAdapter 与事件投影、默认/自定义压缩、压缩后继续对话和磁盘回放。1.4 摘要输出改用模型输出上限，`reserveTokens` 保留上下文余量；回环 HTTP 测试验证此官方变化，没有本地业务覆写。

知识组覆盖真实官方 Agent 工具循环、双 OS 子进程、共享调度、排队/运行取消、同模型配置指纹、ACK 恢复、脏模块增量、部分失败修复和独立打包布局。不是只读取模型配置或只用 mock 的证据。各分报告包含选定文件与可复跑命令。

生产烟测：字节码 Agent Host 的隔离工作区/MCP 热停启/命令/关闭/守卫 15 项通过；最终 Repo Wiki host 完成 ready → IPC shutdown → exit 0；最终 codemode 字节码 worker 显式传入真实 QuickJS WASM 后执行 `text(6 * 7)` 得到 42。[资源报告](resources-report.md)、[烟测](resources-agent-host-smoke.log)、[运行探针](resources-runtime-probe.log)。正式应用 main 窗口没有启动。

## 失败与验证边界

- 全量 Electron Node typecheck 保留 **129** 条既有诊断，CLI **82** 条，[最终路径规范化对照](final-types-comparison.json)没有新增/减少。早期快照捕获新增测试编写中间态的两条错误，最终基线已排除并以最终测试类型日志佐证。知识 strict 保留完全相同 **4** 条，[逐行对照](knowledge-typecheck-diff.txt)。未声称全仓类型全绿。
- 知识首次并发组遇到 Git 5 秒超时，以及用户预算夹具落地时差的一项暂时失败。未改 timeout 或业务代码；聚焦复跑和最终原组串行均通过。比 1.3 基线增加 3 项来自用户新增测试。[知识报告](knowledge-report.md)。
- 默认沙箱曾限制真实路径、Vite TEMP rename、回环 HTTP 或 Git Bash MSYS；同命令隔离 fixture 获自动审核批准后在沙箱外通过，未改安全设置。完整 CLI 测试误启动后中止，不计入验收；只报告完成的定向组。
- 生产烟测 stderr 出现 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`，已定位 `pi-ai/dist/env-api-keys.js` 对 `node:fs/os/path` 的变量导入；1.3/1.4 源文件逐字节相同。可能影响 Vertex ADC 文件探测，属于既有字节码边界；本轮没有扩大重构，烟测 exit 0 不代表 stderr 干净。
- OAuth 登录/刷新/真实握手及真实供应商联网未执行；配置测试只验证隔离 JSON 路径/格式和注入 auth availability。
- 未制作 NSIS/最终 asar。裸 out-pkg 的默认 `quickjs-wasi/quickjs.wasm` 顶层解析未通过；本轮验证生产 worker 与显式真实 WASM 兼容，以及资源/asarUnpack 配置。最终扁平收集、OAuth/Bedrock 懒加载、Vertex ADC、图片转换仍未端到端验证。
- 未提交、推送、发布、调用付费模型、改真实凭据/项目文档或重启正式应用。现有运行实例不会热替换 SDK；之后需使用新构建，已安装版需另行打包更新。

最终 `npm run verify-notes` 通过，仅保留旧笔记 warning，见 `verify-notes-final.log`。未改 UI，没有扩展到其他 UI-harness 场景。

归档探针可从仓库根复跑：`node .agents/evidence/2026-11-01-pi-sdk-1.4.0-upgrade/verify-dependency-graphs.cjs .` 与 `node .agents/evidence/2026-11-01-pi-sdk-1.4.0-upgrade/resources-runtime-probe.cjs .`。后者首次移植时错误假定 codemode 是顶层依赖，已改为从实际 coding-agent 解析 WASM；保留失败日志，修正后重新执行，不归因于产品 SDK。
