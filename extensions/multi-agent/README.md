# pi-multi-agent

为 [Pi coding agent](https://github.com/earendil-works/pi) 写的**多 agent 编排扩展**。

给 agent 加上 `spawn_agent` 工具:把任务委派给**隔离的 pi 子进程**(各自独立上下文窗口),支持单个或并行多个,汇总结果。思路对齐官方 `examples/extensions/subagent/`(`pi --mode json -p --no-session`)。**零第三方依赖**。

## 能力

| 类型 | 名称 | 说明 |
|---|---|---|
| 工具(LLM 可调) | `spawn_agent` | `task`(单个)或 `tasks`(并行,最多 4 并发);可选 `model` |

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PI_BIN` | `pi`(走 PATH) | 子进程用的 pi 可执行;可设为绝对路径或包装脚本 |
| `SUBAGENT_TIMEOUT_MS` | `300000` | 单个子 agent **空闲**超时:连续无输出超过此值才判卡死 kill(每段输出都会重置计时,非固定总预算) |
| `SUBAGENT_STARTUP_MS` | `max(idle×2, 300000)` | **首字节/启动宽限**:收到第一个输出前用此更长超时(覆盖冷启动 + 连 MCP + 等 LLM 首 token),收到首字节后切回 `SUBAGENT_TIMEOUT_MS` |
| `SUBAGENT_STREAM_STALL_MS` | `120000` | **上游卡住**(进程内子代理):模型已经开始推流后,两次流事件之间安静超过此值,就在本地中断这次请求并补一句「继续」接着跑 |
| `SUBAGENT_FIRST_TOKEN_MS` | 同 `SUBAGENT_TIMEOUT_MS` | 同上,但用于请求发出后还没收到第一段输出的等待;长思考且不推送思考过程的模型可调大 |
| `SUBAGENT_STALL_RETRIES` | `2` | 上游卡住时自动中断并续跑的次数;用完还卡就按 `idle timeout` 结束;`0` 关闭续跑 |
| `SUBAGENT_QUIET_MS` | `60000` | **静默完成兜底**:已产出实质输出且不在工具执行中时,stdout 安静超过此值即按完成收尾(success),覆盖子代理跑完不发 agent_end/不退出的情况;设 `0` 禁用,跑超长工具可调大 |

> 子进程**继承当前环境变量**(包括 provider key),所以主进程能跑,子 agent 才能跑。

## 安装 / 用法

```bash
# 确保 pi 在 PATH,或设 PI_BIN 指向可执行
pi -e ./extensions/multi-agent/index.ts
# 会话里:
> 并行做三件事:1) 统计 src 行数 2) 列出 TODO 3) 找出最大的文件
  (agent 调 spawn_agent{tasks:[...]},并行跑 3 个子进程并汇总)
```

## 文件结构

```text
multi-agent/
├── index.ts       # spawn_agent 工具(single + parallel,并发上限 4)
├── runner.ts      # spawn pi --mode json -p,解析 JSON 事件流取最终输出
├── package.json
└── README.md
```

## 进阶扩展点

1. **链式(chain)**:像官方 subagent 那样支持 `chain`,把上一个输出 `{previous}` 注入下一个任务。
2. **命名 agent / 角色**:加载 `.pi/agents/*.md` 定义专家子 agent(systemPrompt + 工具集),`spawn_agent` 按名选用。
3. **成本/用量回传**:解析子进程 JSON 里的 usage,汇总 token/费用。
4. **流式进度**:用 `onUpdate` 把子 agent 的中间输出实时回传父会话。

## 注意

- 包名按官方新名 `@earendil-works/*` + `typebox`;旧包改 `index.ts` 顶部 import。
- 真实编排需要 pi 子进程能访问 LLM(provider key)。解析最终输出对 `pi --mode json` 的事件格式做了启发式处理 + 兜底返回 stdout 尾部;若你的 pi 版本事件结构不同,调 `runner.ts` 的 `extractFinalText` 即可。
