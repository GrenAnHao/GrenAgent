# 缓存预热接入证据

## 当前决定

- UI 位于「通用与模型」，三项 `off` / `streaming` / `idle`，通过 `get_cache_warming` 读取 SDK 当前有效值；无表单默认值、无「空值映射 idle」。
- 只有用户实际改变该字段并保存，才调用 `set_cache_warming`。`PI_CACHE_WARMING` 仅为表单字段标识，保存应用设置时剥离，不进入应用 settings、runtime-settings 或环境配置。
- 模式唯一来源为 Pi 全局 `settings.json`。服务每次新建 SDK SettingsManager 读取最新磁盘值；写入使用官方 `setCacheWarmingMode`、`flush` 和错误检查。
- 写盘后调用既有 `mergeRuntimeSettingsFile(runtimePath, {})` 触发配置通知，不增加假配置键。真实 fs.watch 集成测试确认内容相同的连续原子替换仍触发通知；两个既有会话均同步。
- gren-runtime 订阅既有 watchConfig，读取 canonical 模式后仅在变化时调用官方 AgentSession.setCacheWarmingMode；dispose 退订。预热请求、经济判断、安全时间窗、取消均由 SDK 自己维护。

## 不采用的方案

- 独立 runtime env 覆盖可直接复用旧配置表单，但它制造第二份真相源，且 Pi 的 applyOverrides 不影响只读 globalSettings 的缓存设置。
- 四项「跟随 / 关闭 / 运行中 / 空闲」配 getter/setter 劫持可以不修改 SDK 原偏好，但需要抑制持久化与恢复方法；三项官方 canonical 路径更小、更可维护，已由 root 决定采用。

## 验证

- `cd cli; node --import tsx --test src/cache-warming-control.test.ts src/gren-runtime.test.ts`：10 例通过，见 runtime-green.log。使用真实 SDK SettingsManager、AgentSession.prototype.setCacheWarmingMode 和 CacheWarmer；确认 off 清理排程且 abort controller，idle→streaming 取消已有空闲预热。没有发出模型请求。
- `cd electron-agent; npx vitest run src/features/settings/settingsSchema.test.ts src/features/settings/useSettingsForm.test.ts electron/app/cacheWarmingSettings.test.ts electron/ipc/cacheWarming.test.ts`：4 文件 38 例通过，见 unit-green.log。覆盖三模式保存、最新磁盘回显、默认不写盘、非法模式与写盘失败、其他设置不写模式、失败可重试、真实热更新通知和 IPC。
- 红灯记录：schema-red.log、form-service-red.log、runtime-red.log。
- Node noEmit 检查未发现本功能诊断；全项目仍有既有及其他并行改动诊断，见 node-types.log，由 root 统一对照。
- `cd electron-agent; npm run ui:check -- cache-warming`：25/25，通过；仅运行 1/45 个场景，其余 44 个未运行。见 ui-check.log。深浅截图 cache-warming-dark.png / cache-warming-light.png 已实际检查，字段、三项菜单、费用与 30 分钟说明完整，布局沿用既有设置。
- UI 首轮产品操作已成功；probe 错把 antd 内部 testid 当成 select 外壳导致文本读取失败，按现有 provider-diagnostics 的 `.closest('.ant-select')` 规则修正后全部通过。首轮日志 ui-check-first.log 留存。

## 文件与恢复

新增 `cli/src/cache-warming-control.{ts,test.ts}`、`electron-agent/electron/app/cacheWarmingSettings{.ts,.test.ts}`、`electron-agent/electron/ipc/cacheWarming.test.ts`、`ui-harness/scenarios/cache-warming.tsx` 和 `probes/cache-warming.mjs`。其余只修改设置 schema/表单、pi.ts、IPC 注册、main 服务装配、gren-runtime 工厂；旧 ultra-mode fixture 仅补新 getter 的返回值，不重跑已定档场景。

会遮挡本次源码的 7 个未跟踪旧生成 JS 已移至 `%TEMP%/pi-cache-warming-20261110` 对应路径：cli/src/gren-runtime.js，electron-agent/src/features/settings/{settingsSchema,useSettingsForm,SettingsPanel}.js，electron-agent/src/lib/pi.js，electron-agent/electron/ipc/register.js，electron-agent/electron/main.js。其余旧生成文件保留。
