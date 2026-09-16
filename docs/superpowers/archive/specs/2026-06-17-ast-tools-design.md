# ast-tools：结构化代码查询与重写（ast_grep + ast_edit）设计

- 日期：2026-06-17
- 状态：已实现并通过测试（`extensions/ast-tools/`，7 任务 TDD，15 测试通过）。本文据 `@ast-grep/napi@0.43` 实测校准
- 主题：把 omp 的 `ast_grep`（结构化查询）/ `ast_edit`（结构化重写）以**纯扩展**形式移植进 Pi。底层改用 ast-grep 官方 `@ast-grep/napi`（omp 用自家 `@oh-my-pi/pi-natives`，Pi 够不到）。
- 上游对标：`oh-my-pi/packages/coding-agent/src/tools/ast-grep.ts`、`ast-edit.ts`
- 路线图归属：`2026-06-17-oh-my-pi-parity-roadmap-design.md` 波1 #1（第一个深入子项目）
- 约束：纯扩展 / 零核心改动 / 零 fork。

## 1. 背景与目标

### 现状
Pi 的搜索是文本级（核心 `grep`/`find` + `batch-tools` 的 `search`），编辑是行级（核心 `edit` + `hashline`）。缺「按语法结构」查询与批量重写的能力——例如「把所有 `console.log($A)` 改成 `logger.info($A)`」「找出所有 `await` 在循环里的调用」这类跨文件结构化操作，文本正则易误伤、难精确。

### omp 的做法
omp 提供 `ast_grep`（结构化查询，50+ tree-sitter 语法）与 `ast_edit`（结构化重写，dryRun 预览 → `resolve` 接受）。两者底层调 `@oh-my-pi/pi-natives` 的 `astGrep`/`astEdit`（Rust core，`ast-grep-core`）。

- `ast-grep.ts:37` schema：`{ pat, paths[], skip? }`
- `ast-edit.ts:43` schema：`{ ops:[{pat, out}], paths[] }`；`ast-edit.ts:34` 引 `queueResolveHandler`（预览→接受）

### 成功标准
1. `ast_grep` 按 ast-grep pattern 跨文件命中节点，返回路径/行列/code frame，支持 `skip` 分页。
2. `ast_edit` 按 `{pat, out}` 批量重写，**正确展开 `$VAR`/`$$$ARGS` 元变量**，返回每文件改动数；`dryRun` 只报告不写。
3. 全程纯扩展，依赖 `@ast-grep/napi`（prebuilt，跨平台），不引入 Rust core。
4. 缺依赖 / 解析失败 / 无匹配均 fail-soft，不阻断主流程。

### 非目标
- 不引入 omp 的 `pi-natives`/Rust core。
- 第一版 `paths` 仅本地文件/目录/glob，**不接 internal-urls**（`pr://` 等，归波2）。
- 第一版**不接 `resolve` 预览→接受**（用 `dryRun` 参数先顶，归波2）。
- 不做 `.BLK` 块级操作（hashline 二期范畴）。
- 不接管现有 `search`/`edit`/`hashline`（并存）。

## 2. @ast-grep/napi API 与关键限制（实现核对）

来源：ast-grep 官方 JS API 文档 / `crates/napi/types/api.d.ts`。

核心 API（`@ast-grep/napi@0.43` 实测）：
```
import { parse } from '@ast-grep/napi'
// 注意：0.43 的 Lang enum 运行时为空对象 {}，lang 用字符串字面量："JavaScript"/"TypeScript"/"Tsx"/"Css"/"Html"
const root = parse('TypeScript', source).root()
const nodes = root.findAll('console.log($A)')      // SgNode[]
const edits = nodes.map(n => n.replace(text))       // Edit{startPos,endPos,insertedText}
const newSource = root.commitEdits(edits)           // string
// 取元变量：n.getMatch('A')?.text() / n.getMultipleMatches('ARGS')
```

**关键限制（决定 ast_edit 实现）**：`@ast-grep/napi` 的 `node.replace(text)` **不会展开 `$VAR`**（与 CLI 不同）。官方原文：「Metavariable will not be replaced in the replace method. You need to create a string using getMatch(var_name)」。

因此 `ast_edit` 必须**自己实现模板展开**：对每个匹配 node，把 `out` 模板里的 `$VAR` 用 `getMatch('VAR').text()`、`$$$ARGS` 用 `getMultipleMatches('ARGS')` 首尾节点的 range 在源码上切片（实测多匹配含逗号等分隔符节点，故切片以保留原始分隔），再 `node.replace(展开后文本)`。

辅助：`findInFiles(lang, {paths, matcher}, cb)` 多文件并行（按单一 lang），`parseAsync` 异步解析。第一版可先用「自己遍历文件 + parse + findAll」，性能优化（findInFiles 按语言分组）留增强。

## 3. 包结构与依赖

- 新增依赖：`@ast-grep/napi@^0.43`（MIT，prebuilt napi）+ `tinyglobby`（glob 收集）。0.43 prebuilt 覆盖 win32-x64/ia32/arm64、darwin-x64/arm64、linux-x64/arm64(gnu/musl) 等。
- 语言（实测校准）：`@ast-grep/napi@0.43` 核心包**只内置 5 种**——JavaScript / TypeScript / Tsx / Css / Html（即 js/jsx/ts/tsx/css/html）。其余语言（Python/Go/Rust/Java/...）需 `registerDynamicLanguage` + 每平台 tree-sitter 动态库（@experimental），列为**后续增强**。第一版按扩展名映射到这 5 种。

## 4. 工具 schema（对齐 omp）

```
ast_grep:
  pat:   string          // ast-grep pattern
  paths: string[]        // 文件/目录/glob（>=1）
  skip?: number          // 跳过前 N 个匹配（分页），默认 0

ast_edit:
  ops:    { pat: string, out: string }[]   // 重写对（>=1）
  paths:  string[]                          // 文件/目录/glob（>=1）
  dryRun?: boolean                          // true=只报告不写，默认 false
```

## 5. 组件与数据流（`extensions/ast-tools/`）

- `index.ts` —— 注册 `ast_grep` + `ast_edit`；napi 用 **lazy `import()`**（在 execute 内）：原生加载失败时工具返回错误文本（fail-soft），不拖垮其他扩展加载。
- `lang.ts` —— 扩展名 → 语言字符串（`CoreLang` 字面量）映射 + `collectFiles`（`tinyglobby` 展开目录/glob）。
- `grep.ts` —— `ast_grep` 执行：收集文件 → 按 ext 定 lang → `parse` → `findAll(pat)` → 聚合排序 → 截断/skip → 格式化（路径 + 行列 + code frame）。
- `rewrite.ts` —— **metavariable 模板展开**：输入 node + `out`，输出展开后字符串（处理 `$VAR`、`$$$ARGS`、转义 `$$`）。
- `edit.ts` —— `ast_edit` 执行：收集文件 → `parse` → 对每个 op `findAll(pat)` → `rewrite` 展开 → `replace` → `commitEdits` → `dryRun?` 报告 : 写回 → 返回 `{file, replacements}[]` 摘要。
- `*.test.ts`。

数据流：
```
ast_grep: paths → 文件集 → {ext→lang} → parse → findAll(pat) → 排序+skip+截断 → 匹配列表(路径/行列/frame)
ast_edit: paths → 文件集 → parse → 各 op findAll(pat) → rewrite(out 展开 $VAR) → edits → commitEdits
          → dryRun ? 改动预览 : 写回磁盘 → {file, replacements} 摘要
```

## 6. 与现有工具关系
并存，不接管。`ast_grep` 是 `search` 的结构化补充（文本 vs 语法）；`ast_edit` 是 `hashline`/`edit` 的结构化批量补充（行锚定 vs 语法重写）。description 里点明各自适用场景，由模型按需选用。

## 7. 错误处理与降级（全 fail-soft）
- `@ast-grep/napi` 加载失败 → 两个工具都不注册 + 一次性提示。
- 不支持的扩展名 / 未知语言 → 跳过该文件并在结果里注明。
- 解析错误 → 记入 `parseErrors`，不阻断其他文件（可选 `failOnParseError`）。
- `pat`/`out` 非法（pattern 编译失败）→ 明确错误信息。
- `ast_edit` 无匹配 → 返回 `0 replacements`（非错误）。
- 元变量在 `out` 中引用但匹配里不存在 → 留空 + 警告，不崩。

## 8. 测试
- `lang.ts`：扩展名映射、目录/glob 文件收集。
- `ast_grep`：命中、`skip` 分页、空结果、多文件聚合排序。
- `rewrite.ts`：`$A` 单变量、`$$$ARGS` 多节点、`$$` 转义、缺失变量降级。
- `ast_edit`：应用写回、`dryRun` 不写、多文件、多 op、无匹配、parse-error 降级。
- 降级：napi 缺失不注册。
- jiti smoke：扩展加载无异常。

## 9. 后续衔接（波2）
- `paths` 接 internal-urls（`pr://` 等）—— 待 internal-urls 路由骨架。
- `ast_edit` 的「dryRun 预览」演进为 `resolve` 预览→接受机制 —— 待波2 `resolve`。
- 性能：改用 `findInFiles` 按语言分组并行。
