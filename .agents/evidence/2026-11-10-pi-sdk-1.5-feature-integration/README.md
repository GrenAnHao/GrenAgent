# Pi 1.5 新能力接入验收

## 已接入的入口

1. **供应商 → 展开模型 → 兼容设置**：新增 `requiresNonNullAssistantContent`、`requiresToolsWithToolHistory`、`promptCacheKeyMode`、`supportsMessageThreads`。布尔项可选择跟随 SDK、开启、关闭；默认不覆盖，保存/重载保留显式 false，按 API 过滤。详见 [模型兼容字段](model-compat/README.md)。
2. **通用与模型 → 缓存预热**：关闭 / 仅运行中 / 运行中与空闲。读写 Pi 全局 settings.json，只有显式修改才保存；复用原有配置热更新和官方 SDK setter 同步活会话并取消旧预热。说明预热可能产生费用及空闲 30 分钟范围。详见 [缓存预热](cache-warming/README.md)。
3. **CLI、桌面主进程、agent-host / pi-worker 的 Node 运行时**：注册官方 lazy-oauth 与 lazy-bedrock-provider，保持真实实现按需加载；生产 CJS 分块启用 strictExecutionOrder，修复实际入口初始化循环。实际字节码入口可触达 9 项 OAuth 实现及 Bedrock，实现加载前不在 require.cache。详见 [懒加载验收](lazy-providers/README.md) 和 `electron-agent/scripts/smoke-pi-node-providers.mjs`。

没有新增依赖、重写认证协议、发起真实登录或调用真实付费模型。CodeGraph 版本不变；终端专属更新 UI 和分类器产品入口不属于本轮三项接入。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 模型配置 adapter 与 ProvidersSettings | 2 文件、44 例通过 | model-compat/adapter-green.log |
| UI 序列化 → 真实 SDK 请求 | 6 例通过，fetch 截断，无远程请求 | model-compat/sdk-payload.log |
| 模型兼容 UI-harness | 50/50，保存/重挂/默认还原/深浅/窄屏 | model-compat/ui-final.log |
| 缓存设置 schema/表单/service/IPC | 4 文件、38 例通过 | cache-warming/unit-green.log |
| 真实 SDK 预热取消与跨会话热同步 | CLI 10 例通过；包含官方 CacheWarmer 和相同内容原子更新通知 | cache-warming/runtime-green.log、unit-green.log |
| 缓存预热 UI-harness | 25/25，三模式、手动保存/重挂、费用说明与深浅主题 | cache-warming/ui-check.log |
| 实际生产入口与懒加载 | agent-host / pi-worker 均通过，9 项 OAuth + Bedrock，网络强制禁止 | lazy-providers/production-smoke-strict.log |
| 懒加载入口定向回归 | CLI 6/6；Electron 4 文件、46/46 | lazy-providers/README.md 中的命令和日志 |
| CLI / Electron 生产构建 | exit 0；CLI dist/main.js --help 正常 | lazy-providers/cli-build.log、cli-help.log、electron-build-strict.log |
| noEmit 类型诊断 | CLI 82、Electron Node 169，归一化行号后与前一轮基线完全一致 | types-comparison.json |
| 决策笔记门禁 | npm run verify-notes 通过，仅既有 warning | verify-notes.log |

只运行本次 `model-compat`、`cache-warming` 两个 UI 场景，未运行其余 43 个场景或全量套件。两个 owner 已查看实际深浅/窄屏截图；模型截图由主代理另外查看，标签、控件、说明和滚动区域完整。

独立只读审查未发现 P1/P2；审查者没有参与实现，也没有重复执行构建或测试。

## 关键失败与修正

- 模型字段测试先复现保存时丢失新字段，加入目录后通过；新布尔控件使用三态而不是把缺省误当显式关闭。
- UI 首轮失败来自 probe 未展开折叠组、重挂后未把按钮滚进可点击区域，以及 antd testid 不是 select 外壳。按真实 DOM 修正 probe，没有改变产品默认展开状态来迁就测试。
- 生产分割 bundle 原先找不到 OAuth meta.ts；注册官方 loader 后独立 bundle 回归通过。正式字节码入口又暴露 CJS 分块循环：virtual-modules 在 IMAGE_MODELS 初始化前使用它。使用 Rolldown 的 strictExecutionOrder 后实际入口通过，没有把构建 exit 0 当作运行通过。
- 为 bytecode-loader 注入 vm.Script 动态 import 回调的方案曾被考虑；严格初始化顺序下实际消费者已经通过，因此未修改 loader。其他动态导入路径没有被本次烟测覆盖。
- 新 Node 集成测试直接静态引入纯渲染 adapter 曾触发 composite include 诊断；改为测试边界动态加载，不扩大生产 tsconfig，不改变被测实现。

## 交付与边界

生产产物位于 `electron-agent/out-pkg` 和 `cli/dist`。没有制作或安装最终安装包、重启正式应用、提交、推送或发布；使用已安装版本仍需另行打包更新。正式 OAuth 登录、令牌刷新和远程厂商请求未执行。

全量类型检查仍以既有诊断退出非 0；本次没有新增诊断。生产构建保留 import.meta/CJS、Lobe 动态/静态同模块导入等警告；CLI --help 保留已有 ultra-rules.md 资源警告，详见对应日志。

已有 dirty 文件不归本轮清理。会遮挡本轮 TS 修改的旧生成 JS 仅按模块备份到系统临时目录（pi-sdk-features-20261110、pi-cache-warming-20261110，以及 lazy owner 记录的快照目录），没有全仓清理；恢复位置见各子报告。
