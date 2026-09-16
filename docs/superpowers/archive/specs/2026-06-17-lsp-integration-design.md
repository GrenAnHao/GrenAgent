# LSP 集成扩展 设计

- 日期：2026-06-17
- 状态：设计待评审（来自 oh-my-pi 借鉴评估，5 项之一）
- 主题：给 Pi 增加一个 `lsp` 扩展：按语言 spawn 语言服务器（typescript-language-server / pyright / rust-analyzer / gopls…），通过 LSP（JSON-RPC over stdio）向模型暴露"定义/引用/悬停/诊断/符号/重命名"等精确语义操作。对标 omp 的 "LSP wired into every write"（14 ops，rename 走 `workspace/willRenameFiles` 联动重导出/桶文件）。

## 1. 背景与目标

### 现状
Pi 已有 `code-intel`（codegraph：tree-sitter 静态预索引，sub-ms 查询、全局符号/边）+ `code-search`（文本/符号搜索）。这是**静态**视角：快、离线、无类型推断。缺**实时语义**：跨文件类型感知、精确定义跳转、安全重命名（含别名/重导出）、编译诊断。

### omp 的做法
进程内/外接语言服务器，rename 经 `workspace/willRenameFiles` 让"re-exports、barrel files、aliased imports 在文件移动前更新"。"Everything your IDE knows, the agent knows。"

### 成功标准
1. `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_diagnostics` / `lsp_document_symbols` / `lsp_workspace_symbols` 可用。
2. `lsp_rename`：跨文件安全重命名（应用 `WorkspaceEdit`），含 `willRenameFiles` 联动。
3. 按文件类型自动选/启服务器；服务器缺失时友好提示安装（不自带）。
4. 与 `code-intel` 互补：静态用 codegraph，精确/类型相关用 lsp。

### 非目标
- 不做编辑器级补全/inlay（面向 agent 工具，非交互 UI）。
- 不自带语言服务器二进制（探测系统 + 提示安装）。

## 2. 现状盘点
| 关注点 | 现状 |
|---|---|
| 静态索引 | `code-intel`(codegraph) MCP/工具 |
| 进程能力 | 扩展可 spawn 常驻服务器（同 `mcp`/`debug-tools`） |
| 文件读写 | 上游 read/write/edit；LSP 需 `textDocument/didOpen` 同步内容 |
| 取消 | `execute` 的 `signal` |

## 3. 架构总览
```
extensions/lsp/
  client.ts      LspClient：Content-Length 帧 + JSON-RPC（initialize/请求/通知），按 stdio
  servers.ts     语言→服务器命令映射 + 探测（which）+ 项目根识别
  manager.ts     LspManager：按 (root, language) 复用 client；didOpen/didChange 同步
  convert.ts     LSP 位置/范围 ↔ 工具友好（path:line:col）；WorkspaceEdit → 文件改动
  tools.ts       注册 lsp_* 工具
  index.ts       装配 + 生命周期（session_shutdown 关服务器）
```
LSP 协议本身简单（`Content-Length: N\r\n\r\n{json}`）；可自实现轻量 client，或引 `vscode-jsonrpc`。倾向**自实现**（零额外重依赖，便于跨平台与打包）。

## 4. 工具接口
```ts
lsp_definition({ path, line, column })        → [{path,line,column,preview}]
lsp_references({ path, line, column, includeDeclaration? }) → [{path,line,column,preview}]
lsp_hover({ path, line, column })             → { markdown }
lsp_diagnostics({ path? })                    → [{path,range,severity,message,source}]
lsp_document_symbols({ path })                → 符号树
lsp_workspace_symbols({ query })              → [{name,kind,path,line}]
lsp_rename({ path, line, column, newName })   → { changes:[{path,edits}], applied:boolean }
```
位置统一用 1-based `line`/`column`（与 `hl_read` 行号对齐），内部转 LSP 0-based。

## 5. 服务器管理
- 探测顺序（示例）：
  - TS/JS：`typescript-language-server --stdio`
  - Python：`pyright-langserver --stdio` / `pylsp`
  - Rust：`rust-analyzer`
  - Go：`gopls`
- 根识别：就近 `tsconfig.json`/`package.json`/`pyproject.toml`/`Cargo.toml`/`go.mod`。
- 复用：`Map<root+lang, client>`；首次用到该语言时 `initialize` + `initialized`。
- 文档同步：调用前 `didOpen`（或 `didChange` 用最新磁盘内容），保证服务器看到当前文件。
- 关闭：`session_shutdown`/卸载时 `shutdown`+`exit`，清理子进程。

## 6. rename 联动
1. `textDocument/rename` 拿 `WorkspaceEdit`。
2. 若服务器支持 `workspace/willRenameFiles`（文件改名场景）先发，合并其返回的 edit。
3. 把 `WorkspaceEdit`（`changes`/`documentChanges`）应用到磁盘（按行列改），逐文件写回 → 触发 checkpoint/diff。
4. 返回受影响文件清单 + 预览。

## 7. pi 端改动
- 新扩展 `extensions/lsp/`（`typebox`）。
- 只读类（definition/references/hover/diagnostics/symbols）进 Ask/Plan 白名单；`lsp_rename`（写）不进只读白名单。
- 与 `agent-mode` 工具 gate 协同。
- 前端（可选）：diagnostics 以卡片/侧栏列出；rename 走既有 diff 预览。

## 8. 拆解（分阶段）
| 阶段 | 范围 | 依赖 |
|---|---|---|
| 1 | LspClient + TS/Python 探测 + definition/references/hover/diagnostics/symbols + 单测(帧编解码/位置转换) | 无 |
| 2 | `lsp_rename`（WorkspaceEdit 应用 + willRenameFiles） | 1 |
| 3 | 多语言（Rust/Go/…）+ `.pi/lsp.jsonc` 自定义服务器 | 1 |
| 4 | 前端诊断面板 | 1 |

## 9. 关键决策
- **D1 client 实现**：自实现轻量 JSON-RPC（避免 vscode-jsonrpc 的体积/打包问题），仅实现用到的子集。
- **D2 文档同步策略**：每次工具调用前用磁盘内容 `didOpen`/`didChange`（无脏缓冲），简化一致性。
- **D3 与 codegraph 分工**：prompt 指引"全局结构/快速用 code-intel；类型/精确定义/安全重命名用 lsp"。
- **D4 服务器缺失**：返回明确"未找到 X 语言服务器，请 `npm i -g typescript-language-server` 等"，不阻断其它工具。

## 10. 风险与注意
- **启动延迟**：大项目 rust-analyzer/tsserver 索引慢——首调可能等待；加"正在索引"提示 + 超时。
- **跨平台**：Windows 下服务器可执行名（`.cmd`）与路径解析；统一探测逻辑。
- **资源占用**：多语言多根会起多个服务器——LRU 关闭闲置 client。
- **位置错位**：UTF-16 列偏移（LSP 默认）vs UTF-8——需正确换算多字节字符列。
