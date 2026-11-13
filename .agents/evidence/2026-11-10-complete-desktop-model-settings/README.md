# 桌面模型设置验收

当前实现对应 `complete-desktop-model-settings`。生产源码已稳定，OpenSpec 20/20、all_done；其余 change 的最终整合由 root 接续。

## 已通过

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| renderer / service / 实际 SDK 定向测试 | 13 文件，155 用例 | `targeted-tests-final.log` |
| 预算接入后的嵌入 / 冷恢复状态机 | 2 文件，83 用例 | `subagent-budget-adjacent-tests.log` |
| 原百分比、续跑与取消策略 | 10 用例 | `compaction-policy-regression.log` |
| CLI runtime / 缓存预热邻接 | 10 用例 | `runtime-factory.log` |
| CLI 模型目录安全快照 | 7 用例 | `probe-metadata-red.log` 记录红灯；最终通过见任务记录与定向执行 |
| UI 高级模型 / 模型预算 | 35 + 26 项；只跑 2/52 场景，其他 50 未运行 | `ui-check-final.log` |
| 最终支持边界文案校准 | advanced 场景 4 项；其他 51 场景未运行 | `ui-copy-calibration.log` |
| 第三生产候选 main / host / worker | 19 项通过，含真实全 owner 聚合 | `production-aggregate-final.log`、`production-results.json` |
| CLI / Node noEmit 增量 | 82 → 82、169 → 169，新增诊断均为空 | `cli-types-comparison.json`、`node-types-comparison.json` |

第三统一生产构建日志由 root 保存于 `../2026-11-10-complete-desktop-package-updates/integrated-cli-build-third.log` 与 `integrated-electron-build-third.log`。`AGENTS.md` 已有两新增场景说明。

UI 实际截图在 `ui/`：已查看高级配置浅色 / 窄屏、预算深色 / 窄屏与最终来源说明，未发现遮挡、横向溢出或不可操作的控件。

## 生产探针怎么跑

在仓库根目录运行：

```powershell
node electron-agent/scripts/smoke-model-settings.mjs
```

默认消费 `electron-agent/out-pkg/main` 的实际 CJS / `.jsc`，使用项目 Electron 38 执行字节码。需要消费另一产物目录时：

```powershell
$env:MODEL_SETTINGS_PRODUCT = 'D:\absolute\candidate\main'
node electron-agent/scripts/smoke-model-settings.mjs
Remove-Item Env:MODEL_SETTINGS_PRODUCT
```

脚本自行建立临时 HOME / USERPROFILE / APPDATA / agentDir / settings / JSONL，仅继承启动所需的系统变量；`PI_WORKER_ENTRY` 指向当前候选的真实 `pi-worker.js`。所有凭据均为 fixture 字符串。测试结束只清理自身验证过的临时目录。

- **main**：加载实际 `main.jsc` 并走真实初始化注册链；窗口和其他 child transport 用测试桩阻止正式界面 / 无关服务启动。实际 `gren:invoke` handler 调用真实预算 IPC、Services、SDK 和临时文件，不是仅构造服务类。
- **host**：走实际 `pi.openWorkspace` / `pi.send` / `pi.syncModelCompactionBudgets` RPC；公开 child opener 无 prompt 建一个嵌入子会话和一个真实 worker，检查三个 owner 的实际预算、单项失败 / 其他成功、只重试同步及 dispose 卸载。
- **worker**：使用真实入口 open / resume RPC；测试包装器只在公开 SettingsManager.applyOverrides 后读取公开 getter，核对既有 / 新建 / 冷恢复的有效值，不写私有字段。

成功必须退出 0，末尾为 `PASS isolated production model settings 19`。`production-results.json` 中 `facts` 应有 19 项，特别包括：

- `real host sync receipt includes main, embedded and worker owners`
- `all three live owner receipts show actual new effective budgets`
- `embedded failure is explicit while main and worker successes remain`
- `retry sync recovers embedded without restarting any owner`
- `disposed embedded and worker owners leave the sync registry`
- 三入口的高级模型字段以及 worker 热更新 / 冷恢复。

## 真实 SDK 边界

- TTL 省略=继承；显式值是有限正数秒，允许小数。SDK 拒绝 null 的原始错误见 `ttl-schema-error.json`，没有补 SDK 或建立影子 TTL。
- 数量 / 字节原本只有元数据；原生 AgentSession 反例见 `image-preflight-boundary.json`。桌面仅执行 models.json **显式**配额，目录原生未编辑 metadata 不增加拒绝。
- OpenAI Completions / Responses、Azure Responses、Anthropic HTTP，以及调用方显式 Codex SSE 支持最终 HTTP body 预检。统计 UTF-8 未压缩 JSON 字节，不含 HTTP 头；原 onPayload 和原 fetch 保留。真实 Anthropic thread 测试证明被服务器续传省略的历史图片不计入。
- Google 仅支持图数。Google bytes、Codex 自动 / WS、未知协议与自定义 client 携带对应显式限制时，在网络前拒绝，不自动换传输。界面禁用这些字段并提供显式清除入口。
- 用户仅编辑模型不改认证；明确修改 / 清空内置 Key 才清旧 inline 副本。SDK canonical OAuth / API Key 优先，auth 删除后 legacy inline 回退属于既有独立现状，本轮不扩 logout 语义。见 `inline-auth-existing-priority.json`。

## 范围与后续

没有验证真实供应商 / 登录 / 付费预热、正式安装包或正式应用重启，没有提交 / 推送。调试曾误用不存在的 agent.streamFn 而使 fixture.invalid 连接失败；已改为公开 streamFunction，最终测试只走注入 fetch / 临时数据，生产探针阻断远程出口，不调用真实模型。

修改前目标快照在 `preimage/`，原工作区状态在 `baseline-status.txt`；只有遮挡消费的对应生成 JS 被移到 temp，位置见 `generated-backups.txt`。当前实际改动清单与剩余 JS sibling 见 `changed-files.json`。没有全仓清理。

最终任务 / 命令 / owner 接续条件见 `HANDOFF.md`。
