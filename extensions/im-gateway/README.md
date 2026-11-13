# pi-im-gateway

为 [Pi coding agent](https://github.com/earendil-works/pi) 写的**IM 网关扩展**(骨架)。

在 pi 进程内起一个**轻量 HTTP webhook**,让各 IM 平台(Slack / 飞书 / Telegram / 企业微信…)通过一个薄 adapter 把消息转发进来,agent 的回复再 POST 回去。**零依赖**(Node 内置 `http` + `fetch`),Bearer token 鉴权,默认关闭(开端口需显式启用)。

GrenAgent 桌面端不加载此扩展。下文是独立 Pi 手动加载的接口；桌面接回见 [IM 接入说明](../../docs/im-reintroduction.md)。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/message` | body `{ text, replyUrl? }`(可带 `Authorization: Bearer <token>`)→ 注入 `sendUserMessage` |
| `GET` | `/health` | `{ ok: true }` |
| 命令 | `/imgateway` | 查看网关状态 |

收到 `/message` 后,**下一条 assistant 消息**会被 POST 到 `replyUrl`(body `{ text }`),供 adapter 发回 IM。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `IM_GATEWAY` | `0`(关闭) | 设 `1` 启用(会监听端口) |
| `IM_GATEWAY_HOST` | `127.0.0.1` | 非回环地址必须设置 token，否则强制监听回环 |
| `IM_GATEWAY_PORT` | `8765` | 监听端口 |
| `IM_GATEWAY_TOKEN` | (空) | 设置后 `/message` 需带 `Bearer` |

## 安装 / 用法

```bash
IM_GATEWAY=1 IM_GATEWAY_TOKEN=secret pi -e ./extensions/im-gateway/index.ts
# 另一端(IM adapter / 测试):
curl -X POST localhost:8765/message -H "Authorization: Bearer secret" \
  -H "content-type: application/json" \
  -d '{"text":"列出 src 下的 ts 文件","replyUrl":"https://your-adapter/callback"}'
```

## 文件结构

```text
im-gateway/
├── index.ts       # 启动网关 + sendUserMessage 注入 + 回复回调 + /imgateway 命令
├── gateway.ts     # node:http webhook server(/message、/health、token 鉴权)
├── package.json
└── README.md
```

## 进阶扩展点(做成完整 IM 接入)

1. **平台 adapter**:为 Slack(Events API + 签名校验)、飞书(事件订阅 + 加解密)、Telegram(Bot webhook)各写一个把平台事件 → `POST /message` 的转发层。
2. **会话映射**:把 IM 的 channel/user 映射到不同 pi session(多路复用),而非单一 pending reply。
3. **流式回复**:用 `message_update` 增量回推(打字机效果),而非只在 `message_end` 回一次。
4. **富消息**:回复带工具调用卡片 / 代码块格式化。

## 注意

- 这是**平台无关骨架**:它不直接连任何 IM,而是提供统一 webhook,真正的平台对接由 adapter 完成(参考 lobehub 的 chat-adapter-*)。
- `sendUserMessage` 在 agent 流式中会自动改用 `followUp` 投递;高并发/多会话需扩展会话映射。
- 仅监听明确配置的端口;生产环境请放在反向代理后并设 `IM_GATEWAY_TOKEN`。
