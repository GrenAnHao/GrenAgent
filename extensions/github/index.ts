// github：精简只读 GitHub 工具，封装系统 gh CLI（GitHub CLI）。
// view/list 用 --json + 结构化格式化；pr_diff/code_search 返回原始文本。gh 缺失/失败 fail-soft。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type GhAction, buildGhArgs } from "./args.js";
import { formatResult } from "./format.js";
import { runGh } from "./gh.js";

const ACTIONS: GhAction[] = [
  "pr_view",
  "pr_diff",
  "issue_view",
  "repo_view",
  "pr_list",
  "issue_list",
  "code_search",
];

export default function (pi: ExtensionAPI) {
  console.error("[github] extension loaded");

  pi.registerTool({
    name: "github",
    label: "GitHub",
    description:
      "只读 GitHub（经 gh CLI）：pr_view/pr_diff/issue_view/repo_view/pr_list/issue_list/code_search。" +
      "repo 默认当前仓库；pr/issue 的 view/diff 需 number；code_search 需 query。需系统装 gh 并 `gh auth login`。",
    promptSnippet: "Read GitHub via gh (PRs, issues, repos, code search).",
    parameters: Type.Object({
      action: Type.Union(
        ACTIONS.map((a) => Type.Literal(a)),
        { description: "操作类型" },
      ),
      repo: Type.Optional(Type.String({ description: "owner/name，默认当前仓库" })),
      number: Type.Optional(Type.Number({ description: "PR/issue 号（view/diff 必填）" })),
      query: Type.Optional(Type.String({ description: "code_search 关键词" })),
      state: Type.Optional(Type.String({ description: "list 过滤：open/closed/merged/all，默认 open" })),
      limit: Type.Optional(Type.Number({ description: "list/search 条数，默认 30" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const args = buildGhArgs(params.action, params);
        const raw = await runGh(args, ctx.cwd, signal ?? undefined);
        return { content: [{ type: "text", text: formatResult(params.action, raw) }], details: undefined };
      } catch (err) {
        return { content: [{ type: "text", text: `github 失败：${(err as Error).message}` }], details: undefined };
      }
    },
  });
}
