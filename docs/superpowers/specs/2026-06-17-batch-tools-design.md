# batch-tools（批量读取 + 结构化检索）设计 / 规格

- 日期：2026-06-17
- 状态：设计已评审（用户确认方案 B、效果方向 → 待审查规格 → writing-plans）
- 主题：给主 agent 两个默认开启的批量工具 `read_files` / `search`，把「read/bash 调用堆积」从 N 条 toolResult 压扁成 1 条
- 载体：纯新扩展 `extensions/batch-tools/`，零核心改动、零 fork 维护成本
- 优先级：高（直击用户「对话里 read/bash 堆积」痛点，ROI 高且独立可落地）
- 上游总览：`docs/superpowers/specs/2026-06-16-pi-enhancement-roadmap-design.md`（§4.D 编码工具补全的同族延伸）

## 0. 实地核验要点（现状）

| 事实 | 锚点 / 依据 |
|---|---|
| Pi 核心默认只有 `read`/`write`/`edit`/`bash`，`grep`/`find`/`ls` 是「可启用」（默认不开） | `docs/pi/repository-overview.md:59` |
| 工具默认 **parallel** 执行，但每个工具结果仍是独立一条 toolResult，按原始 tool call 顺序写回上下文 | `docs/pi/architecture.md:106-109` |
| 主 agent 缺结构化检索时只能用 bash 跑 rg/grep/find/ls/cat（= bash 堆积根因）；read 一次一个文件（= read 堆积根因） | 现状推断 + 上一条 |
| `explore_context`（探索子代理）已完成、默认开、已引导主 agent | `extensions/code-intel/index.ts:10-12`、`extensions/code-intel/explorer.ts:74-77` |
| `code_search`（embedding 语义搜索）已实现、默认关 | `extensions/code-search/index.ts:14` |

**结论**：真正的缺口是「给主 agent 直接用的批量读取 + 结构化检索」。本设计补这一缺口。它与已完成的 `explore_context`（问答式定位、探索外包）正交互补——`explore_context` 负责「先去哪找」，`batch-tools` 负责主 agent 拿到目标后「一次性读多文件 / 一次性多模式检索」。

## 1. 目标与范围

### 1.1 MVP

- 工具 `read_files({ files, maxLinesPerFile? })`：一次读多个文件、每个可单独指定行范围，合并成一条结构化 toolResult。
- 工具 `search({ patterns, globs?, path?, ignoreCase?, literal?, contextLines?, maxResults? })`：一次多正则 pattern（OR）+ glob 过滤的纯 JS 检索，按文件分组合并成一条 toolResult。
- 两个工具默认开启，带 `promptGuidelines` 引导主 agent「批量优先 / 别用 bash 搜」。
- 全部 fail-soft：单文件 / 单 pattern 失败隔离，绝不阻断主流程。

### 1.2 成功标准

1. 一次 `read_files` 读 N 个文件 → 对话里只新增 1 条 toolResult（而非 N 条 read）。
2. 一次 `search` 多 pattern + glob → 替代多次 bash grep/find，结果合并 1 条。
3. 无 ripgrep / 无外部依赖也能工作（纯 JS，跨平台，含 Windows）。
4. 大仓有界：受 `SEARCH_MAX_FILES` / `SEARCH_MAX_RESULTS` / 单文件字节上限约束，不卡死。

### 1.3 不在范围（YAGNI / 增强）

- 一体化「搜+读」组合工具 `gather`（方案 C，易误用，暂缓）。
- `read_files` 支持 glob 直接展开读取（避免误读海量；先 `search` 定位再读具体文件）。
- ripgrep 后端（作为可选增强：检测到系统 `rg` 则用，否则纯 JS 降级）。
- `.gitignore` 精确解析（MVP 用固定 SKIP_DIRS 黑名单 + 隐藏目录跳过，与 `code-search/files.ts` 一致）。

## 2. 代码依据（实地核验，带锚点）

| 能力 | 锚点 |
|---|---|
| 工具注册签名 `registerTool({ name,label,description,promptGuidelines?,parameters,execute })` + 返回 `{content,details,isError?}` | `docs/pi/architecture.md:86-109`；范本 `extensions/web-fetch/index.ts:102-145` |
| `ctx.cwd` 可用 | `extensions/web-fetch/index.ts:115-143`、`extensions/code-search/index.ts:34` |
| 配置读取 `getConfig(key)` | `extensions/_shared/runtime-config.js`（用法 `extensions/code-search/index.ts:8,14`） |
| 递归文件枚举（跳过 node_modules/.git/.pi/dist 等 + 隐藏目录 + maxFiles 上限）—— `walk.ts` 在其基础上加 glob 过滤 | `extensions/code-search/files.ts:17-40` |
| 输出预算 / 截断 + 续读提示范式（head+tail，提示用 read offset 续读） | `extensions/web-fetch/index.ts:56-76` |
| 二进制检测参考（已知扩展名 + 非打印字符比例 > 0.3） | MiMo `packages/opencode/src/tool/read.ts:97-142` |
| 扩展汇总注册 `allExtensions` | `extensions/index.ts:66-95` |

## 3. 架构与组件

```
extensions/batch-tools/
├── index.ts        # 扩展入口：开关 + 注册 read_files / search + promptGuidelines；子代理守卫
├── read-files.ts   # read_files 工具壳：解析/去重 + 并行读 + 行范围切片 + 预算截断 + 二进制/错误隔离
├── search.ts       # search 工具壳：walk 枚举(glob) + 正则编译 + 逐行匹配(早停) + 分组合并
├── walk.ts         # 纯函数：文件枚举（泛化自 code-search/files.ts，支持轻量 glob：* ** ? 与扩展名）
├── format.ts       # 纯函数：read_files 段格式化（路径+行号+截断标记）/ search 命中分组格式化
├── read-files.test.ts / search.test.ts / walk.test.ts / format.test.ts / index.test.ts
└── package.json    # pi-extension 清单
```

设计原则：**I/O 壳薄、纯函数厚**。`walk` / `format` / 正则编译 / glob→regex 均为纯函数（易测）；`read-files.ts` / `search.ts` 仅承担文件读取与目录遍历的 I/O，并组合纯函数。单文件均控制在小而专注的规模。

## 4. 工具设计：read_files

### 参数（typebox）

```ts
Type.Object({
  files: Type.Array(
    Type.Union([
      Type.String({ description: "File path (relative to cwd or absolute)" }),
      Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number({ description: "1-indexed start line" })),
        limit: Type.Optional(Type.Number({ description: "Max lines from offset" })),
      }),
    ]),
    { description: "Files to read in one call; each may set its own offset/limit." },
  ),
  maxLinesPerFile: Type.Optional(Type.Number({ description: "Per-file line cap (default READ_FILES_MAX_LINES=400)" })),
})
```

### 行为

1. 归一化：`string` → `{ path }`；按 `(path, offset, limit)` 去重（避免重复读同一段）。
2. 路径解析：相对路径基于 `ctx.cwd` 解析为绝对路径。
3. 并行读取（`Promise.all`，工具内部并发）。每个文件：
   - 不存在 → 该段标 `error: "not found"`，继续其它。
   - 二进制（已知扩展名或非打印字符比例 > 0.3）→ 标 `skipped: binary`，不读内容。
   - 按 `offset`(默认 1) / `limit` 切片；超 `maxLinesPerFile` 或单文件字节上限（`READ_FILES_MAX_BYTES`，默认 50KB）→ 截断并提示续读。
4. 合并为一条 toolResult。

### 输出

```
===== src/auth/login.ts (lines 1-60 of 120) =====
 1: import { db } from "../db"
 2: ...
[truncated at 60 lines; use read with offset=61 for the rest]

===== src/auth/session.ts (lines 1-45) =====
 1: ...
```

`details: { files: [{ path, startLine, endLine, totalLines, truncated, error? }] }`

## 5. 工具设计：search

### 参数（typebox）

```ts
Type.Object({
  patterns: Type.Array(Type.String(), { description: "One or more regex patterns; a line matching ANY is a hit (OR)." }),
  globs: Type.Optional(Type.Array(Type.String(), { description: "Limit to files matching these globs, e.g. src/**/*.ts" })),
  path: Type.Optional(Type.String({ description: "Sub-directory to search (default: cwd)" })),
  ignoreCase: Type.Optional(Type.Boolean()),
  literal: Type.Optional(Type.Boolean({ description: "Treat patterns as literal strings, not regex" })),
  contextLines: Type.Optional(Type.Number({ description: "Lines of context around each match (default 0)" })),
  maxResults: Type.Optional(Type.Number({ description: "Max total matches (default SEARCH_MAX_RESULTS=100)" })),
})
```

### 行为

1. `walk(path ?? ctx.cwd, globs)` 枚举候选文件：复用 SKIP_DIRS 黑名单 + 隐藏目录跳过；`globs` 经轻量 glob→regex 过滤（`*`→`[^/]*`、`**`→`.*`、`?`→`[^/]`，匹配相对 `path` 的 POSIX 相对路径，Windows 反斜杠先归一化为 `/`）；跳过超过 `SEARCH_MAX_FILE_BYTES`（默认 1MB）的文件；`SEARCH_MAX_FILES`（默认 5000）上限。
2. 编译 `patterns`：`literal` 时转义；`ignoreCase` 加 `i` flag。非法正则 → 记入 `invalidPatterns` 并跳过该 pattern（不抛）。
3. 逐文件逐行匹配任一 pattern，收集 `{ file, line, text }`（带 `contextLines` 时附上下文）；命中数达 `maxResults` 早停。
4. 按文件分组合并为一条 toolResult。

### 输出

```
src/auth/login.ts
  12: export async function login(req)
  40:   session.create(user)
src/auth/session.ts
   8: import { login } from "./login"
(23 matches in 7 files; capped at 100)
```

`details: { matches: [{ file, line, text }], total, files, capped, invalidPatterns? }`

## 6. 数据流

```
read_files({files})  → 归一化/去重 → 解析 cwd → 并行读+切片+预算截断+二进制/错误隔离 → 合并 1 条 toolResult
search({patterns,globs,...}) → walk 枚举(glob 过滤/大小上限) → 编译正则(非法跳过) → 逐行匹配(maxResults 早停) → 分组合并 1 条 toolResult
无命中 / 全部 pattern 非法 / 无可读文件 → fail-soft 明确提示（details 带空集合）
```

## 7. 引导（promptGuidelines）

- `read_files`：
  - "要查看多个文件或多个片段时，用 read_files 一次性读取，不要连续单独调用 read。"
  - "可对每个文件单独指定 offset/limit，只取需要的行段。"
- `search`：
  - "要按关键词/正则搜代码、或按 glob 找文件时，用 search，不要用 bash 跑 grep/rg/find/ls。"
  - "可一次传多个 pattern（OR 命中）与多个 glob，结果合并返回。"

注：与 `explore_context` 的引导分工——仓库级 where/how/find 的「定位」仍优先 `explore_context`（探索外包、省上下文）；目标明确后的「批量读取 / 多模式精确检索」用 `batch-tools`。

## 8. 配置（getConfig，复用 `_shared/runtime-config`）

| 键 | 默认 | 含义 |
|---|---|---|
| `BATCH_TOOLS_ENABLED` | `1` | 总开关（`0` 关闭，不注册两个工具） |
| `READ_FILES_MAX_LINES` | `400` | read_files 每文件行数上限 |
| `READ_FILES_MAX_BYTES` | `51200` | read_files 每文件字节上限（50KB） |
| `SEARCH_MAX_RESULTS` | `100` | search 总命中上限（早停） |
| `SEARCH_MAX_FILES` | `5000` | search 枚举文件数上限 |
| `SEARCH_MAX_FILE_BYTES` | `1048576` | search 跳过超过此大小的文件（1MB） |

## 9. 错误处理（fail-soft）

- `read_files`：单文件不存在 / 二进制 / 读失败 → 该段标错并继续，整体不抛；全部失败也返回（每段带 error），`isError` 仅在参数非法（空 files）时置位。
- `search`：非法正则跳过该 pattern 并在结果尾部提示；无候选文件 / 无命中 → 返回明确空结果提示；遍历中单文件读失败跳过。
- 二者均不依赖外部二进制 / 网络 / key，无降级分支需求（纯 JS）。

## 10. 测试策略

- `walk.test.ts`（纯，临时目录）：glob 过滤（`* ** ?`、扩展名）、SKIP_DIRS / 隐藏目录跳过、maxFiles 上限、大文件跳过。
- `format.test.ts`（纯）：read_files 段头/行号/截断标记；search 分组与汇总尾行。
- `read-files.test.ts`（临时目录）：多文件合并、offset/limit 切片、超行/超字节截断提示、二进制跳过、单文件错误隔离、去重。
- `search.test.ts`（临时目录）：多 pattern OR、glob 过滤、literal vs regex、ignoreCase、contextLines、maxResults 早停、非法正则跳过。
- `index.test.ts`（smoke）：`BATCH_TOOLS_ENABLED=0` 不注册；默认注册 `read_files` + `search` 且带 promptGuidelines。
- jiti / bun 导入冒烟（与现有扩展一致）。

## 11. 实现文件清单

| 文件 | 职责 |
|---|---|
| `extensions/batch-tools/walk.ts` | 文件枚举 + 轻量 glob→regex（纯） |
| `extensions/batch-tools/format.ts` | read_files / search 输出格式化（纯） |
| `extensions/batch-tools/read-files.ts` | read_files 工具壳（I/O + 组合纯函数） |
| `extensions/batch-tools/search.ts` | search 工具壳（I/O + 组合纯函数） |
| `extensions/batch-tools/index.ts` | 入口：开关 + 注册 + promptGuidelines + 子代理守卫 |
| `extensions/batch-tools/package.json` | pi-extension 清单 |
| `extensions/batch-tools/*.test.ts` | 单测（walk/format/read-files/search/index） |
| 修改 `extensions/index.ts` | import 并把 `batchTools` 加入 `allExtensions` |

## 12. 顺带：已完成资产生效核验（默认值不动）

| 资产 | 现状 | 核验动作 |
|---|---|---|
| `explore_context` | `CODE_INTEL_EXPLORER` 默认开；promptGuidelines 已注入（`explorer.ts:74-77`） | build 后实跑 where/how 类问题，确认主 agent 调用且回紧凑引用；确认目标项目已 `codegraph init`（`.codegraph/` 存在），否则降级 grep/glob/read |
| `code_search` | `CODE_SEARCH_ENABLED` 默认关（`code-search/index.ts:14`） | 如需启用：配 `CODE_EMBED_PROVIDER`/`KB_EMBED_PROVIDER` + `/code-index rebuild`；本设计不改其默认值 |

## 13. 排序 / 分期

batch-tools 完全独立、零核心改动、纯扩展，可立即落地。建议落地顺序：`walk` + `format`（纯函数 TDD）→ `read_files` → `search` → 入口注册 + 引导 → 接入 `allExtensions` → 冒烟。ripgrep 后端、`gather` 组合工具、`.gitignore` 解析均为后续增强。

## 规格自检（2026-06-17）

- [x] 占位符扫描：无 TODO / 待定 / 空章节；§12「待 build 实跑核验」是诚实的验证项而非占位。
- [x] 内部一致性：六个配置键（BATCH_TOOLS_ENABLED / READ_FILES_MAX_LINES / READ_FILES_MAX_BYTES / SEARCH_MAX_RESULTS / SEARCH_MAX_FILES / SEARCH_MAX_FILE_BYTES）在 §4/§5/§8 用法一致；工具参数与输出 details 字段在 §4/§5 自洽。
- [x] 范围检查：两个工具 + 纯函数（walk/format），单一实现计划可覆盖。
- [x] 模糊性检查：已明确 glob 匹配口径（相对 POSIX 路径 + Windows 分隔符归一化）、去重键 (path,offset,limit)、截断双口径（行数 READ_FILES_MAX_LINES + 字节 READ_FILES_MAX_BYTES）、二进制判定（已知扩展名或非打印比 > 0.3）。
