# github：精简只读 GitHub 工具 设计

- 日期：2026-06-17
- 状态：设计已批准（brainstorming 产出），待实现
- 主题：以**纯扩展**形式提供精简只读 `github` 工具，封装系统 `gh` CLI（GitHub CLI）的核心只读操作，结构化返回。对标 omp 的 `github` 工具（`gh.ts` 3653 行重型版）的精简子集。
- 上游对标：`oh-my-pi/packages/coding-agent/src/tools/gh.ts`
- 路线图归属：`2026-06-17-oh-my-pi-parity-roadmap-design.md` 波1 #2
- 约束：纯扩展 / 零核心改动 / 零 fork。

## 1. 背景与目标

### 现状
Pi 仅有 `web-search` 的 `fetch_github_readme`（只读 README）。无法查 PR/issue/repo 详情、列表或代码搜索。

### omp 的做法
`github` 工具（`gh.ts` 3653 行）：封装 `gh` CLI，含缓存（`github-cache`）、JSON 字段降级 fallback、PR/issue/repo/actions 多命令、worktree 关联。重型。另有 `pr://`/`issue://` 协议（`internal-urls/issue-pr-protocol.ts`）让 `read pr://N` 像读文件。

### 成功标准
1. `github` 工具支持 7 个只读 action：`pr_view`、`pr_diff`、`issue_view`、`repo_view`、`pr_list`、`issue_list`、`code_search`。
2. 通过 `gh` CLI 取数据，view/list 用 `--json` + 结构化格式化；`pr_diff`/`code_search` 返回原始文本。
3. 纯扩展，无新 npm 依赖（`node:child_process` shell out）。
4. `gh` 未安装/未登录/失败 → fail-soft，返回明确提示。

### 非目标
- 不做写操作（pr create/comment/merge、issue create）。
- 不做缓存（omp 的 `github-cache` 略）。
- `pr://`/`issue://` read 解析推**波2**（随 internal-urls 骨架）。
- 不做 actions run-watch（omp 有）。

## 2. 工具 schema

```
github:
  action:  "pr_view"|"pr_diff"|"issue_view"|"repo_view"|"pr_list"|"issue_list"|"code_search"
  repo?:   string   // owner/name，默认当前仓库（gh 自动探测）
  number?: number   // pr_view/pr_diff/issue_view 必填
  query?:  string   // code_search 必填
  state?:  "open"|"closed"|"merged"|"all"  // pr_list/issue_list，默认 open
  limit?:  number   // list/search 条数，默认 30
```

## 3. gh 命令映射（`buildGhArgs`）

| action | gh 命令 |
|---|---|
| pr_view | `pr view <number> [--repo R] --json <PR_FIELDS>` |
| pr_diff | `pr diff <number> [--repo R]`（原始 diff）|
| issue_view | `issue view <number> [--repo R] --json <ISSUE_FIELDS>` |
| repo_view | `repo view [R] --json <REPO_FIELDS>` |
| pr_list | `pr list [--repo R] --state <state> --limit <n> --json <PR_LIST_FIELDS>` |
| issue_list | `issue list [--repo R] --state <state> --limit <n> --json <ISSUE_LIST_FIELDS>` |
| code_search | `search code <query> --limit <n>`（原始文本）|

字段集：
- PR_FIELDS：`number,title,state,author,body,createdAt,updatedAt,url,baseRefName,headRefName,isDraft,labels`
- ISSUE_FIELDS：`number,title,state,author,body,createdAt,updatedAt,url,labels`
- REPO_FIELDS：`nameWithOwner,description,url,stargazerCount,forkCount,primaryLanguage,defaultBranchRef,updatedAt`
- PR_LIST_FIELDS / ISSUE_LIST_FIELDS：`number,title,state,author,updatedAt`

`number` 缺失（view/diff）或 `query` 缺失（code_search）→ 抛明确错误。

## 4. 组件与数据流（`extensions/github/`）

- `args.ts` —— `buildGhArgs(action, params): string[]`（纯，可测）。
- `format.ts` —— `formatResult(action, raw): string`：view/list 走 `JSON.parse` + 格式化；`pr_diff`/`code_search` 原样返回（纯，可测）。
- `gh.ts` —— `runGh(args, cwd, signal, exec?)`：`exec` 默认 `spawn("gh", ...)`，可注入便于测试；`code !== 0` 抛 `stderr`。
- `index.ts` —— 注册 `github` 工具；execute：`buildGhArgs` → `runGh` → `formatResult`；捕获 `gh` 缺失/失败返回提示（fail-soft）。

数据流：
```
github(action, params) → buildGhArgs → runGh(spawn gh) → (json? formatResult : 原样) → 文本
                                          └ gh 缺失/非0 → 错误提示（fail-soft）
```

## 5. 错误处理与降级（fail-soft）
- `gh` 未安装（spawn ENOENT）→「未找到 gh CLI，请安装 GitHub CLI 并 `gh auth login`」。
- `gh` 非 0 退出 → 返回 `stderr`（含未登录/无权限/网络错误等明确信息）。
- JSON 解析失败 → 返回原始输出。
- 必填参数缺失 → 明确错误。

## 6. 测试
- `args.ts`：各 action 的参数数组（含 repo/state/limit/number/query 组合，必填缺失抛错）。
- `format.ts`：pr/issue/repo/list 的 JSON → 文本（断言含关键字段）；pr_diff/code_search 原样；JSON 解析失败回退。
- `gh.ts`：注入 mock exec —— 成功返回 stdout；`code!==0` 抛 stderr；ENOENT 友好提示。
- `index.ts`：smoke 注册 `github`。

## 7. 后续衔接（波2）
- `read pr://N` / `issue://N` 解析 —— 随 internal-urls 路由骨架。
- 缓存（对标 omp `github-cache`）—— 按需。
- 写操作、actions run-watch —— 按需。
