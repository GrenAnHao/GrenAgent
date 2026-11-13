# Pi SDK 1.5.1 升级验收

2026-11-10：CLI、extensions、Electron 的直接 Pi 依赖从 **1.4.0 升至 1.5.1**。真实运行解析图、三份 pnpm 锁、三份 npm 锁均包含同版的八个 Pi 包（新增传递依赖 `pi-schema`）。CodeGraph 保持 **1.6.2**，与查询时 npm `latest` 和官方最新 release 一致。

## 修改与兼容性结论

- 三份 `package.json` 使用精确版本；锁只更新 Pi 和必需的传递依赖。npm 版本变动清单见 [npm-lock-version-diff.jsonl](npm-lock-version-diff.jsonl)。保留旧 `extensions/bun.lock`，当前 CI 使用的 pnpm/npm 锁同步维护。
- pnpm 12 为刚发布的八个 Pi 1.5.1 包自动添加精确 `minimumReleaseAgeExclude`，保留已有例外与 `allowBuilds`，没有放开命名空间或全局发布时间策略。见 `install-*.log`；三入口最终冻结锁安装均通过供应链校验。
- `enhancePrompt.ts` 从直接 `typebox` 依赖导入 `Type`，修复 1.5 移除 pi-ai 的 TypeBox re-export 后的模块加载失败。已有测试先复现 `Type.Object` undefined，修复后 39 例通过。
- `fable-behavior/index.ts` 用 `Type.String({ enum: TIER3_TOPICS })` 保留原字符串 enum JSON Schema 和单一枚举来源，恢复参数的静态 string 类型；没有宽泛断言或批量迁移 schema。
- 新增真实 SDK validator 覆盖 TypeBox、普通 MCP JSON Schema、根 `$defs` 引用、数字字符串/单值数组转换、错误字段拒绝和转录原对象不变。现有 session 集成继续覆盖私有工具刷新、cwd、preflight、请求头、流式投影、压缩和 JSONL 恢复。

官方变更来源：[1.5.1](https://github.com/earendil-works/pi/releases/tag/v1.5.1)、[coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.5.1/packages/coding-agent/CHANGELOG.md)、[pi-ai changelog](https://github.com/earendil-works/pi/blob/v1.5.1/packages/ai/CHANGELOG.md)、[CodeGraph 1.6.2](https://github.com/colbymchenry/codegraph/releases/tag/v1.6.2)。本目录保存本次相关版本的 changelog 段落。仓库工具未发现依赖 `Type.Refine`、`Format.Set` 等非 JSON Schema 校验，也未发现自定义 `GrepOperations.readFile`，所以不加推测性兼容层。

1.5.1 的无工具历史请求默认省略 `tools`、Anthropic message threads 和 idle cache warming 默认行为沿用官方；不修改用户模型或设置。未知旧代理如依赖空工具列表，应在对应模型显式设置官方 `compat.requiresToolsWithToolHistory`，没有全局添加此兼容开关。

## 已通过的检查

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 运行图与两种锁一致性 | 三入口 × 八包全部 1.5.1 | [dependency-graphs.log](dependency-graphs.log)、[可复跑脚本](verify-dependency-graphs.cjs) |
| pnpm 冻结锁安装 | 三入口 exit 0，供应链校验通过 | `frozen-*-online.log` |
| SDK/压缩/会话/headers/工具元数据定向组 | 基线和升级均 42 文件、288 例通过 | `baseline-extensions.log`、`upgraded-extensions.log` |
| 新 schema 校验 + Fable + 元数据 | 3 文件、18 例通过（含上述组的重叠用例） | [schema-compat.log](schema-compat.log) |
| Ultra 真实回环 SDK、MCP、batch search | 4 文件、56 例通过 | [upgraded-tools.log](upgraded-tools.log) |
| CLI 运行时与安装补丁 | 19 例通过，包括三入口补丁幂等及未知上游结构拒绝 | [upgraded-cli-tests.log](upgraded-cli-tests.log) |
| Electron session/事件/model/auth/资源定向组 | 11 文件、160 例通过 | [upgraded-electron-tests.log](upgraded-electron-tests.log) |
| 真实 SDK 会话偏好/Fast | 2 文件、16 例通过 | [sdk-preferences.log](sdk-preferences.log) |
| 提示词增强模块 | 先红，修复后 39 例通过 | `enhance-red.log`、`enhance-green.log` |
| CLI / Electron 生产构建 | 两者 exit 0，Electron 写入 out-pkg，不覆盖 dev/localrun 的 out | `build-cli.log`、`build-electron.log` |
| noEmit 类型诊断对照 | CLI 82 → 82；Electron Node 169 → 169；完整输出逐行无差异 | [types-comparison.json](types-comparison.json) |
| 决策笔记门禁 | exit 0，仅已有 warning | [verify-notes.log](verify-notes.log) |

各测试组有重叠，不相加为总用例数。Electron 首组命令中有两个未匹配到的 `electron/pi/` 文件过滤器，不算已执行；会话偏好/Fast 的完整独立组另行明确执行。所有测试只使用隔离临时数据、回环 SSE provider 或注入替身，没有请求真实供应商、登录/登出或读取用户凭据。

## 复跑命令

在仓库根目录先设置隔离 agentDir 和离线模式；真实 SDK 集成内部另外创建独立 fixture，HTTP 只连回环地址：

```powershell
$env:PI_CODING_AGENT_DIR = Join-Path $env:TEMP 'pi-sdk-upgrade-20261110/isolated-agent'
$env:PI_OFFLINE = '1'
node .agents/evidence/2026-11-10-pi-sdk-1.5.1-upgrade/verify-dependency-graphs.cjs .
npm run verify-notes

cd extensions
npx vitest run _shared/pi-sdk-compat.integration.test.ts _shared/tool-refresh-batch.test.ts _shared/session-cwd.test.ts header-placeholders compaction-policy session-memory working-directory prompt-metadata.test.ts
npx vitest run _shared/pi-sdk-compat.integration.test.ts fable-behavior/index.test.ts prompt-metadata.test.ts
npx vitest run multi-agent/ultra-sdk.integration.test.ts mcp/index.test.ts mcp/resultShape.test.ts batch-tools/search.test.ts --maxWorkers 2

cd ../cli
node --import tsx --test src/gren-runtime.test.ts src/pi-install-patches.test.ts
npm run build

cd ../electron-agent
npx vitest run electron/agent/workspaceHandle.test.ts electron/agent/sessionUiAdapter.test.ts electron/agent/streamingEvent.test.ts electron/pi/eventAdapter.test.ts electron/agent/modelRuntimeHost.test.ts electron/agent/runtimeConfigBootstrap.test.ts electron/app/providerService.test.ts electron/agent/codemodeWorkerBuild.test.ts electron/agent/copyPiAdjacentAssets.test.ts --maxWorkers 2
npx vitest run electron/app/sessionPreferences.integration.test.ts electron/app/fastMode.integration.test.ts
npx vitest run electron/app/enhancePrompt.test.ts
npm run build
```

三入口各运行 `pnpm install --frozen-lockfile`。类型检查分别是 CLI 的 `npx tsc --noEmit`，以及 Electron 的 `npx tsc -p tsconfig.node.json --noEmit --tsBuildInfoFile "$env:TEMP/pi-sdk-upgrade-20261110/final.tsbuildinfo"`；它们有上述既有诊断，退出非 0。

## 失败、环境与交付边界

- 全量类型检查仍失败；上表是与本次升级前基线完全相同的既有诊断，不是全仓类型通过。初次升级新增两条已修复，详见 `upgraded-*-types.log` 与 `final-*-types.log`。
- `pnpm install --frozen-lockfile --offline` 三入口均因镜像的 `@aws-sdk/xml-builder` 发布元数据未缓存而失败；允许联网后同一冻结锁检查通过，没有改锁或放宽供应链策略。离线复现需预热对应镜像元数据。
- 首次 Electron noEmit 错误使用 `--incremental false`，与 composite 项目不兼容；改为把独立 tsBuildInfoFile 写在临时目录，未产生源码输出。npm 锁更新提示宿主 Node 25 不在现有 jsdom 30 的引擎范围内；本次未改 jsdom 或 Node。
- 生产构建有 `import.meta` 转 CJS、Lobe 动态/静态同模块导入警告；没有将构建成功等同于最终安装包、真实 OAuth、Vertex ADC 或远程厂商兼容验收。
- 工作区开工时已有大量未提交改动及未跟踪 `.js` / `.d.ts`。只把三个会遮住本次 TypeScript 修改的旧生成 JS（enhancePrompt、Fable index、SDK 兼容测试）移到系统临时目录 `pi-sdk-upgrade-20261110/compat-preimage/` 备份，使测试和构建读取实际修改的 TS；其他旧生成文件未处理。原清单、锁、状态也保存在该临时目录。
- 没有修改 UI，所以未跑 UI-harness；没有重建真实 CodeGraph 索引、制作安装包、重启正式应用、提交、推送或发布。已安装应用需另行打包更新，本地运行需加载新构建。
