# 模型兼容字段接入

## 使用入口与存储

设置 → 供应商 → 展开模型 →「消息、角色与工具」「缓存与会话亲和」或「Anthropic 协议专用」。新增字段：

| 字段 | 协议 | 行为 |
| --- | --- | --- |
| requiresNonNullAssistantContent | openai-completions | 工具调用消息无正文时发送空字符串而不是 null |
| requiresToolsWithToolHistory | openai-completions | 无可用工具、但历史有工具时保留 tools: []，供要求此字段的旧代理使用 |
| promptCacheKeyMode | openai-completions / openai-responses | auto / enabled / disabled；未设置时跟随 SDK |
| supportsMessageThreads | anthropic-messages | 启用/关闭增量消息线程；未设置时由 SDK 按端点判断 |

新布尔字段用三态选择，明确区分「跟随 SDK / 开启 / 关闭」。保存不为所有模型补默认值；显式 false 保存和重载保持，回到默认会删除覆盖。沿用原有 adapter 的协议过滤，不改变思考映射、价格或认证存储。

## 实际证据

- `cd electron-agent; npx vitest run src/features/settings/providerConfigAdapter.test.ts` 新增测试先复现两项失败，证据 adapter-red.log。
- 加入字段后 `npx vitest run src/features/settings/providerConfigAdapter.test.ts src/features/settings/ProvidersSettings.test.tsx`：2 文件 44 例通过，adapter-green.log。
- `npx vitest run electron/app/modelCompat.integration.test.ts`：6 例通过，sdk-payload.log。实际调用 UI adapter 序列化并保存/重载，真实 ModelRuntime 读取 models.json 后由 SDK 构造请求；fetch 在传输边界截断且返回固定 400，不连接远程。已断言空正文/空工具列表/缓存键开关、Anthropic thread create 开关和 Responses 缓存键开关。
- `npm run ui:check -- model-compat`：50 passed / 0 failed，只跑该场景；保存、重挂恢复、默认还原、协议字段、深浅色、1000×740 窄屏通过，ui-final.log。已人工检查三个实际截图，选择器与说明完整、无横向溢出。

截图在系统临时目录 `grenagent-ui-shots`：model-compat-threads-dark.png、model-compat-cache-light.png、model-compat-cache-narrow.png。

## 失败处理与范围

早期 probe 没打开兼容字段折叠组，也没有在重挂后把模型展开按钮滚入可点击区域；实际 DOM 证据确认不是字段缺失，probe 修正后原操作链全通过。未借此改动既有分组默认开合，不跑已定档的拖拽/价格等无关场景。

Node composite 类型检查不包含渲染目录；SDK 请求集成测试在测试边界动态加载纯渲染 adapter，保持原生产 tsconfig 范围，不扩大 include。模型字段生产实现只有目录条目与三态控件，不新增依赖。

测试不代表真实代理或 Anthropic 服务端增量续传已联网验收；本次验证的是产品控制正确保存并到达真实 SDK 请求。底层协议实现由 SDK 提供。
