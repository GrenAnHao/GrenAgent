# 持久代码执行（Python/JS REPL + 工具回调）设计

- 日期：2026-06-17
- 状态：设计待评审（来自 oh-my-pi 借鉴评估，5 项之一）
- 主题：给 Pi 增加一个**常驻**的代码执行内核（先 Python，后可选 JS/Bun），变量/导入跨调用保留；进阶让内核能**回调 agent 自身的工具**（read/search 等）形成"取数→计算→产图"的单会话闭环。对标 omp 的 "Code execution w/ tool-calling"。

## 1. 背景与目标

### 现状
Pi 只有上游内置 `bash` 工具：每次调用是**一次性子进程**，无法在多次调用间保留 Python 变量、已加载的 DataFrame、已 import 的库。做数据分析/多步计算时，模型只能反复把整段脚本重写重跑，token 浪费且易错。

### omp 的做法（参考）
omp 跑**常驻 Python** + 一个 **Bun worker**，两个 kernel 都能通过 loopback bridge 回调 agent 的 `read`/`search`/`task` 工具——"在 Python 里 `tool.read` 加载 CSV，再到 JS 里画图，全程不离开当前 cell"。

### 成功标准
1. 一个 `py_run(code)` 工具：在**常驻 Python 进程**里执行代码，变量/导入跨调用保留。
2. 捕获 stdout/stderr/返回值/异常 traceback；支持超时与中断（复用 `ctx.signal`）。
3. 可重置内核（`py_reset`）；进程随会话生命周期管理，按 `cwd` 隔离。
4. （进阶）内核内可 `pi.read(path)` / `pi.search(q)` 回调 agent 工具。

### 非目标
- 不内置 Jupyter 全套 UI；不做 notebook 持久化（`.ipynb`）。
- 第一期不做 Bun/JS 内核（留二期）。
- 不替代 `bash`；定位是"有状态的计算 cell"。

## 2. 现状盘点

| 关注点 | 现状 | 备注 |
|---|---|---|
| 执行能力 | 上游 `bash`（一次性） | `extensions` 无持久 REPL |
| 扩展进程能力 | 扩展是 Node 进程，可 `child_process.spawn` 常驻子进程 | 见 `mcp`/`debug-tools` 已 spawn 外部进程 |
| 工具注册 | `pi.registerTool({name,label,description,parameters(typebox),execute})` | `image-gen` 等为范例 |
| 取消信号 | `execute(_id, params, signal, _onUpdate, ctx)` 第 3 参 `signal` | 可接 abort |
| 工作目录 | `ctx.cwd` | 内核 cwd 与会话一致 |

## 3. 架构总览

```
extensions/code-exec/
  index.ts        注册 py_run / py_reset 工具，管理常驻内核（按 ctx.cwd）
  kernel.ts       PythonKernel：spawn 常驻 python，写入代码、读回结构化结果
  protocol.ts     宿主↔内核的行协议（NDJSON）：{type:'exec',id,code} / {type:'result',...}
  runner.py       （随扩展分发）常驻执行器：读 stdin 指令、exec 到持久 globals、回传结果
  bridge.ts       (进阶) loopback：内核 stdout 里的 tool-call 请求 → 调 pi 工具 → 回写
```

执行器 `runner.py` 在一个持久 `globals` 字典里 `exec`，每条指令复用同一命名空间 → 变量保留。stdout/stderr 重定向捕获，最后一个表达式的值用 `repr` 回传。

## 4. 工具接口

```ts
// py_run：在常驻 Python 内核执行代码，变量跨调用保留。
py_run({ code: string, timeout_ms?: number })
  → { stdout, stderr, result?, error?, duration_ms }

// py_reset：丢弃当前命名空间，重启内核（清空已加载数据/import）。
py_reset({})
  → { ok: true }
```

宿主↔`runner.py` 行协议（NDJSON over stdin/stdout）：
```
→ {"type":"exec","id":"e1","code":"import pandas as pd; df=pd.read_csv('a.csv')"}
← {"type":"result","id":"e1","stdout":"","stderr":"","value":null,"ok":true}
→ {"type":"exec","id":"e2","code":"df.describe()"}
← {"type":"result","id":"e2","stdout":"...table...","value":"<DataFrame repr>","ok":true}
```

## 5. 内核生命周期
- **懒启动**：首次 `py_run` 时 spawn `python -u runner.py`（`-u` 无缓冲），写入 `cwd`。
- **隔离**：`Map<cwd, PythonKernel>`，多会话/子代理互不串。
- **健康**：进程退出→标记失效，下次 `py_run` 重启并提示"命名空间已重置"。
- **超时/中断**：每条 exec 带 `timeout_ms`（默认 30s）；`ctx.signal` abort → 向内核发中断（`SIGINT`/协议 `{type:'interrupt'}`），仍卡死则 kill+重启。
- **关闭**：`session_shutdown`/扩展卸载时优雅结束子进程（`ps` 风格清理后代）。

## 6. 工具回调桥（进阶，二期）
`runner.py` 暴露 `pi.read(path)` / `pi.search(query)`：内核把请求作为 `{"type":"tool","id","tool":"read","args":{...}}` 写到 stdout；`bridge.ts` 截获→调用对应 pi 工具→把结果 `{"type":"tool_result",...}` 写回内核 stdin，内核侧阻塞等待返回。需要一个内核内的同步 RPC 等待（线程或 selector）。第一期**不做**，先纯执行。

## 7. pi 端改动
- 新扩展包 `extensions/code-exec/`（`package.json` 声明 `typebox`）。
- 注册到扩展加载链（与其它扩展一致，`pi.extensions` 字段）。
- `runner.py` 作为资源随扩展分发，路径用 `import.meta`/`__dirname` 定位。
- Windows 兼容：`python` 解析顺序 `py -3`→`python3`→`python`；换行统一 `\n`；进程组 kill 用 `ps` 扩展同款实现。

## 8. 拆解（分阶段）
| 阶段 | 范围 | 依赖 |
|---|---|---|
| 1 | `py_run`/`py_reset` + 常驻内核 + 行协议 + 超时/中断 + 测试（protocol/kernel 纯逻辑） | 无 |
| 2 | loopback 工具回调（pi.read/pi.search in-kernel） | 1 |
| 3 | JS/Bun 内核（同协议，`node --input-type` 或 worker） | 1 |
| 4 | 前端：执行结果卡片（stdout/表格/图片 base64）渲染 | 1 |

## 9. 关键决策
- **D1 Python 发现**：优先系统 `python3`/`py -3`；找不到则工具返回友好提示（让用户装或配 `PI_PYTHON`）。不自带运行时。
- **D2 结果大小**：stdout 截断（默认 64KB，可配），尾部省略并提示；大对象只回 `repr` 摘要。
- **D3 安全**：`py_run` 等同 `bash` 的执行权限，受 `safety`/项目信任约束；在 Ask/Plan 只读模式下**禁用**（不入只读白名单）。
- **D4 图像**：matplotlib 等产图 → 存 `.pi/images/` 并在结果里回路径（复用 image 展示链路）。

## 10. 风险与注意
- 常驻进程泄漏：必须在 shutdown/异常时清理后代进程（参考 omp `ps` crate 的 process-tree kill，用 Node 侧实现）。
- 阻塞：内核执行死循环 → 超时 kill 兜底。
- 跨平台编码：统一 UTF-8（`PYTHONIOENCODING=utf-8`），避免 Windows GBK 控制台乱码（本次研究中已踩到该坑）。
- 与 `bash` 职责重叠：prompt 里界定"需要保留状态/多步分析用 `py_run`，一次性命令用 `bash`"。
