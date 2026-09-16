# Hashline：按内容哈希锚定的编辑工具 设计

- 日期：2026-06-17
- 状态：设计待评审（来自 oh-my-pi 借鉴评估，5 项之一；用户首选）
- 主题：把 omp 的招牌 `hashline` 编辑语言移植进 Pi，替代"重打整行/字符串"的 `edit`。模型用**行号 + 内容快照哈希(#TAG)** 锚定要改的位置，只给新内容、不重抄旧行；改 stale 文件时锚点对不上即**拒绝**，避免误改。omp 实测 Grok 4 Fast 同样工作省 61% 输出 token、弱模型通过率翻倍。

## 1. 背景与目标

### 现状
Pi 用上游内置 `edit`（基于 `str_replace`/diff）：模型要把"旧串/旧行"原样抄一遍再给新串，长行/重复行/缩进易触发 "string not found" 重试循环，token 高、首次命中率低。

### omp 的做法
`@oh-my-pi/hashline`：一套紧凑的"行锚定 patch 语言 + applier"。`read`/`search` 输出每个文件段带 `[PATH#TAG]` 头（TAG=4-hex 内容快照哈希）与 `LINE:TEXT` 行；编辑只点行号范围 + 新内容；TAG 过期→拒绝补丁。`.BLK` 系列用 tree-sitter 解析"整个语法块"的边界。

### 成功标准
1. 模型按 hashline 语法产出补丁，`hl_edit` 应用成功率显著高于 `str_replace`，输出 token 下降。
2. `hl_read` 输出带 `[PATH#TAG]` 与 `LINE:TEXT`，作为编辑锚点来源；TAG 失配则拒绝并提示重读。
3. 接管内置 `read`/`edit`（隐藏，暴露 `hl_read`/`hl_edit`），对模型形成自洽闭环。
4. 行级操作（`SWAP`/`DEL`/`INS.*`/`INS.HEAD`/`INS.TAIL`）一期可用；`.BLK`(tree-sitter) 二期。

### 非目标
- 不引入 omp 的 Rust `pi-ast`/`pi-natives`；`.BLK` 用 wasm tree-sitter 或暂缓。
- 不改 `write`（建新文件仍走 `write`；hashline 只改已存在文件，与 omp 一致）。

## 2. hashline 语法速览（来自上游 `prompt.md`）

- 文件段头：`[PATH#TAG]`，TAG 必填，来自最近一次 `hl_read`/`search`。
- 操作：
  - `SWAP N.=M:` 替换原始第 N..M 行（含 M），下方 `+TEXT` 为新内容。
  - `DEL N.=M` 删除，无 body。单行 `SWAP N.=N:` / `DEL N`。
  - `INS.PRE N:` / `INS.POST N:` 在第 N 行前/后插入。
  - `INS.HEAD:` / `INS.TAIL:` 文件首/尾插入。
  - `SWAP.BLK N:` / `DEL.BLK N` / `INS.BLK.POST N:`（tree-sitter 定块边界，二期）。
- body 行只有 `+TEXT`（字面新增），没有 `-old`/上下文行——"range 负责删，body 是最终内容"。
- 行号指**原始文件**、本次调用内不随补丁偏移；每次应用后 mint 新 TAG 并重新编号。

## 3. 包结构与依赖（移植评估）
`@oh-my-pi/hashline`（MIT，纯 TS）核心模块：`parser`(语法)、`apply`/`patcher`(应用)、`snapshots`(快照/TAG)、`mismatch`(stale 检测)、`recovery`(容错修复)、`stream`(流式解析)、`tokenizer`、`fs`(**pluggable IO**)、`diff-preview`、`normalize`、`prefixes`、`block`(块操作，需 AST)。
- 依赖：`diff`（上游 pi-coding-agent 已带 `8.0.4`，对齐即可）、`lru-cache`（需新增）。
- `fs` 抽象可注入：用 Pi 的 `node:fs` 后端即可，无需改包内核。

**移植方式**：把 `src` vendored 到 `extensions/hashline/vendor/`（保留 MIT 头与 LICENSE），或抽到 `extensions/_shared/hashline/`。`block`（tree-sitter）部分一期排除。

## 4. 架构总览

```
extensions/hashline/
  vendor/…           移植的 hashline applier（parser/apply/snapshots/mismatch/recovery）
  snapshots.ts       path → {content, tag} 的 LRU；mint/校验 4-hex TAG
  read.ts            hl_read：读文件 → 维护快照 → 渲染 [PATH#TAG] + LINE:TEXT（含截断/选择器）
  edit.ts            hl_edit：解析补丁 → 校验 TAG → apply → 写回 → mint 新 TAG → 回新快照
  prompt.ts          hashline 语法 system prompt（移植 prompt.md）
  index.ts           注册 hl_read/hl_edit；setActiveTools 隐藏内置 read/edit；注入 prompt
```

闭环：`hl_read` 出 TAG → 模型据 TAG 出补丁 → `hl_edit` 校验+应用+回新 TAG → 下一次编辑用新 TAG。

## 5. 快照与 #TAG
- TAG = `hash(文件绝对路径 + 当前内容)` 取 4 hex（碰撞概率低且短）。
- `snapshots`：`LRUCache<path, {content, tag, lineCount}>`，`hl_read` 写入、`hl_edit` 读取校验并更新。
- stale 判定：补丁头 TAG ≠ 当前快照 TAG → 拒绝，回 `mismatch` 提示"文件已变，请重新 hl_read"。
- 应用后内容变 → 重算 TAG 并把"新内容 + 新 TAG + 重新编号"作为 `hl_edit` 结果返回，省去模型再 read。

## 6. 工具接口
```ts
hl_read({ path, offset?, limit?, ... })
  → 文本：`[rel/path#A1B2]\n  1:line\n  2:line\n…`（与上游 read 选项对齐：行窗口/截断）

hl_edit({ patch: string })   // patch 为 hashline 文本（可含多个 [PATH#TAG] 段）
  → { applied: [{path, tag}], rejected?: [{path, reason}], preview?: diff }
```

## 7. pi 端改动
- 接管内置：`session_start` 时 `setActiveTools` 用"全量工具 − {read, edit} + {hl_read, hl_edit}"。`agent-mode` 已证明可隐藏内置工具（Ask 模式隐藏 write/edit/bash）。
- 与 `agent-mode` 协同：Ask/Plan 只读模式只放行 `hl_read`（不放 `hl_edit`）。
- prompt：`before_agent_start` 注入 hashline 语法（移植 `prompt.md`，去掉 omp 特有的 `.BLK` 段直到二期）。
- 前端：`hl_edit` 结果走既有 diff 预览（`renderDiff` 已存在）；卡片展示 applied/rejected。

## 8. 拆解（分阶段）
| 阶段 | 范围 | 依赖 |
|---|---|---|
| 1 行级 MVP | 移植 parser/apply/snapshots/mismatch；`hl_read`+`hl_edit`（SWAP/DEL/INS.*/HEAD/TAIL）；隐藏内置；prompt；纯逻辑单测 | 无 |
| 2 容错 | 移植 `recovery`（off-by-one 关键行修复、近邻锚点）+ `diff-preview` | 1 |
| 3 `.BLK` | wasm tree-sitter（web-tree-sitter）按语言加载，支持 `SWAP.BLK/DEL.BLK/INS.BLK.POST` | 1 |
| 4 流式 | `stream` 解析（边出边校验，提早报错） | 1 |

## 9. 关键决策
- **D1 接管 vs 并存**：接管（隐藏内置 read/edit）——避免两套 edit 让模型混淆；风险是 hl_read 必须是 read 的功能超集。
- **D2 .BLK 依赖**：一期不做；二期用 `web-tree-sitter`(wasm) 而非 Rust，按需下载语法。无 AST 时 `.BLK` 优雅降级为提示"请用行级 SWAP"。
- **D3 TAG 算法**：短哈希(4hex)对齐 omp；冲突时回退按内容全等校验。
- **D4 与 checkpoint/diff**：`hl_edit` 写文件后照常触发 `checkpoint` 快照与前端 diff 卡。

## 10. 风险与注意
- **模型遵循度**：hashline 语法比 str_replace 复杂，弱模型可能出错——prompt 要含 omp 的反例段；`recovery` + 清晰拒绝信息是关键护栏。
- **hl_read 必须完全替代 read**：否则隐藏内置 read 会丢能力（图片读取、二进制、选择器等）——一期需对齐上游 read 的主要选项，复杂能力可临时仍走内置（白名单保留 read 给特定场景）。
- **行号/快照一致性**：截断显示（`…`/折叠行）区域不可作为锚点——`hl_read` 要明确标注省略区，applier 拒绝落在省略区的补丁。
- **许可**：vendored 代码保留 MIT 与版权声明。
