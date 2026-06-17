# eval-js：常驻 JS 执行内核（js_run / js_reset）设计

- 日期：2026-06-17
- 状态：设计已批准（brainstorming 产出），待实现
- 主题：给 `code-exec` 扩展加 JS 常驻内核，对称现有 `py_run`/`py_reset` 新增 `js_run`/`js_reset`。对标 omp 的 `eval` 双内核（py+js）的 JS 侧。
- 上游对标：`oh-my-pi` 的 `eval`（py + js 双 backend）
- 路线图归属：`2026-06-17-oh-my-pi-parity-roadmap-design.md` 波1 #4
- 约束：纯扩展 / 零核心改动 / 零 fork；**不动现有 Python 路径**。

## 1. 背景与目标

### 现状
`code-exec` 仅有 Python 常驻内核（`py_run`/`py_reset`，`PythonKernel` + `runner.py`，NDJSON 行协议 `protocol.ts`）。无 JS 执行能力。

### omp 的做法
omp `eval` 支持 py + js 双 backend（`language: "py"|"js"`），js 为「persistent JS VM」，且有工具回灌桥（cell 内调 agent 工具）。

### 成功标准
1. `js_run` 在常驻 Node 内核执行 JS，变量跨调用持久（`var`/全局赋值）；返回 console 输出 + 末尾表达式值（`=>` 回显）。
2. `js_reset` 清空 JS 内核命名空间。
3. 复用现有 `protocol.ts`（语言无关）；不改 `PythonKernel`/`runner.py`/`py_run`/`py_reset`。
4. 异常被捕获、内核存活；超时/中断重启内核。

### 非目标
- top-level await（`vm.runInContext` 同步，第一版不支持，列后续）。
- 不统一成 `eval`（保持 `py_run`/`js_run` 分开）。
- 不做工具回灌桥（omp 的 tool re-entry，后续）。
- 顶层 `let/const` 跨 cell 持久（块级作用域所限，用 `var`/全局赋值；description 提示）。

## 2. 复用与新增

- 复用：`protocol.ts`（`encodeExec`/`encodeReset`/`parseMessage`/`ExecResult`/`LineBuffer`/`formatResult`）——语言无关。
- 新增 `runner.mjs`：常驻 Node 进程，`node:vm` 持久 context 执行 JS。
- 新增 `js-kernel.ts`：`JsKernel`，`spawn(process.execPath, [runner.mjs])`，逐条 exec、超时/中断重启（逻辑参考 `PythonKernel`；第一版独立类，后续可抽 `ProcessKernel` 合并 py/js）。
- 改 `index.ts`：加 `js_run`/`js_reset` 工具 + `jsKernels` map（按 cwd）+ `session_shutdown` 清理。

## 3. 执行模型（runner.mjs）

- `vm.createContext(sandbox)` 建持久上下文；每次 exec 把捕获用 `console` 注入 context。
- `vm.runInContext(code, context)` 返回 completion value（末尾表达式值）；`!== undefined` 则 `util.inspect` 回显。
- 持久：顶层 `var` 与隐式全局赋值挂 context，跨 cell 可见；顶层 `let/const` 块级不持久。
- `console.log/info/debug` → stdout；`console.warn/error` → stderr（`util.inspect` 格式化非字符串参数）。
- 异常：捕获 `e.stack` 返回 `error`，`ok=false`，context 不变（内核存活）。
- reset：`context = makeContext()`（新空上下文）。
- node 用 `process.execPath`（同一运行时，无需探测）。

## 4. 工具 schema（对称 py_*）

```
js_run:   { code: string, timeout_ms?: number }   // 默认 30000ms
js_reset: {}
```

## 5. 错误处理与降级
- runner 进程退出/超时/中断 → 重启内核（命名空间丢失，由 `formatResult`/上层提示）。
- vm 执行异常 → 捕获 stack，内核存活。
- 非协议 stdout 行 → `parseMessage` 忽略。

## 6. 测试（js-kernel 集成，spawn 真 node runner）
- 持久变量：`var x=10` → 下条 `x+5` 回显 `15`。
- console 捕获：`console.log('hi',42)` → stdout 含 `hi 42`。
- 异常不杀内核：`throw new Error('boom')` → `ok=false`；随后 `1+1` 仍 `=> 2`。
- reset 清空：`var y=99` → reset → `typeof y` 回显 `'undefined'`。
- `protocol.ts` 已有单测覆盖编码/解析/渲染。
