# 子项目 D.2：诊断反馈（diagnostics）实现计划

> **面向 AI 代理的工作者：** 必需子技能：superpowers:executing-plans。步骤用复选框跟踪。

**目标：** 新增纯扩展 `extensions/diagnostics/`：工具 `diagnostics({paths?})` 运行项目 check 命令（tsc/eslint），把输出解析成 `{file,line,col?,severity,message,source}[]` 结构化返回。

**架构：** `node:child_process.execFile`（现网 `code-review/git.ts:3-20` 同款）跑命令；纯函数 `parseTsc`/`parseEslintJson` 解析；`resolveCommands(cwd)` 从 `.pi/settings.json` 自定义键或自动探测。零核心改动。

**技术栈：** TypeScript（Pi 扩展，ESM `.js`）、node:child_process/fs、typebox、Vitest。

**规格依据：** `docs/superpowers/specs/2026-06-16-diagnostics-design.md`

## 关键约束
1. exec 用 `node:child_process.execFile`，`cwd=ctx.cwd`、传 `signal`、Windows 用 `shell:true` 让 `npx` 可解析；非零退出仍读 stdout/stderr。
2. settings 直读 `<cwd>/.pi/settings.json`（`runtime-config` 不覆盖 settings）。
3. 工具签名/返回见现网 `web-fetch/index.ts:102-144`；`Type.Object` 参数。
4. 测试 `cd extensions && bunx vitest run diagnostics/<file>`；禁 emoji；提交 `git commit -- extensions/diagnostics extensions/index.ts`。

## 文件结构
| 文件 | 职责 |
|---|---|
| `extensions/diagnostics/package.json` | Pi 包清单 |
| `extensions/diagnostics/parsers.ts` | `parseTsc`/`parseEslintJson`（纯函数） |
| `extensions/diagnostics/config.ts` | `resolveCommands(cwd)`（settings/探测） |
| `extensions/diagnostics/runner.ts` | `runChecks`（execFile 封装） |
| `extensions/diagnostics/index.ts` | 工厂：`diagnostics` 工具 |
| `*.test.ts` | 单测（parsers/config/runner/index） |
| 修改 `extensions/index.ts` | 接入 `diagnostics` |

## 任务（TDD）
1. parsers.ts + parsers.test.ts（tsc/eslint 样例 → 结构化；garbage → []）。
2. config.ts + config.test.ts（settings 优先；tsconfig→tsc 探测；无 → []）。
3. runner.ts + runner.test.ts（`node --version` 验证 stdout 捕获）。
4. index.ts + index.test.ts（注册 diagnostics 工具 smoke）。
5. 接入 allExtensions（`codeReview,` 之后）+ bun 导入冒烟（22 true）+ lint + 提交。

> 完整源码见实现产出的各文件（与本计划同次提交）。关键解析正则：
> - tsc：`/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/`
> - eslint：`-f json` → `[{filePath, messages:[{line,column,severity(1|2),message,ruleId}]}]`

## 自检
- 规格覆盖：§1.1 工具+命令来源（settings/探测）→ config+index；§5 解析（tsc/eslint）→ parsers；§6 fail-soft（无命令/ENOENT/解析空）→ index+runner。
- 占位符：无。
- 类型一致：`Diagnostic`（parsers，index 复用）；`CheckCommand=string[]`（config，runner/index 复用）；`RawCheck`（runner，index 复用）。
- LSP/自动回灌为增强，不在 MVP。
