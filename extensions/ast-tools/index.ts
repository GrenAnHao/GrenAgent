// ast-tools：结构化代码查询(ast_grep) 与重写(ast_edit)，底层 @ast-grep/napi。
// 第一版支持核心 5 语言（js/jsx/ts/tsx/css/html）；其他语言需 registerDynamicLanguage（后续）。
// napi 用 lazy import：原生加载失败时只让工具返回错误文本（fail-soft），不拖垮其他扩展的加载。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  console.error("[ast-tools] extension loaded");

  pi.registerTool({
    name: "ast_grep",
    label: "AST Search",
    description:
      "按语法结构跨文件查询（ast-grep pattern，如 `console.log($A)`、`foo($$$ARGS)`），比文本 grep 精确。" +
      "paths 支持文件/目录/glob；skip 分页。仅 js/jsx/ts/tsx/css/html。结构化重写用 ast_edit。",
    parameters: Type.Object({
      pat: Type.String({ description: "ast-grep pattern（元变量 $VAR / $$$ARGS）" }),
      paths: Type.Array(Type.String(), { description: "文件/目录/glob（>=1）", minItems: 1 }),
      skip: Type.Optional(Type.Number({ description: "跳过前 N 个匹配，默认 0" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { runAstGrep } = await import("./grep.js");
        const res = await runAstGrep({ pat: params.pat, paths: params.paths, skip: params.skip ?? 0, cwd: ctx.cwd });
        const lines = res.matches.map((m) => `${m.rel}:${m.line}:${m.column}  ${m.text.split("\n")[0]}`);
        const head =
          `${res.totalMatches} 个匹配（${res.filesSearched} 文件）` +
          (res.matches.length < res.totalMatches ? `，显示 ${res.matches.length}` : "");
        const errs = res.parseErrors.length ? `\n解析问题：\n- ${res.parseErrors.join("\n- ")}` : "";
        const body = res.totalMatches === 0 ? "无匹配" : [head, ...lines].join("\n");
        return { content: [{ type: "text", text: body + errs }], details: { totalMatches: res.totalMatches } };
      } catch (err) {
        return {
          content: [{ type: "text", text: `ast_grep 不可用：${(err as Error).message}（可能缺 @ast-grep/napi prebuilt）` }],
          details: undefined,
        };
      }
    },
  });

  pi.registerTool({
    name: "ast_edit",
    label: "AST Edit",
    description:
      "按语法结构批量重写：ops 每项 {pat, out}，out 模板用 $VAR/$$$ARGS 引用 pat 捕获的内容。" +
      "默认直接写盘；dryRun=true 只报告不写。paths 支持文件/目录/glob；仅 js/jsx/ts/tsx/css/html。",
    parameters: Type.Object({
      ops: Type.Array(Type.Object({ pat: Type.String(), out: Type.String() }), {
        description: "重写对：pat 匹配，out 替换模板（$VAR/$$$ARGS）",
        minItems: 1,
      }),
      paths: Type.Array(Type.String(), { description: "文件/目录/glob（>=1）", minItems: 1 }),
      dryRun: Type.Optional(Type.Boolean({ description: "true=只报告不写，默认 false" })),
      maxFiles: Type.Optional(Type.Number({ description: "命中文件数上限，默认 50；超出则拒绝改写" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { runAstEdit } = await import("./edit.js");
        const res = await runAstEdit({
          ops: params.ops,
          paths: params.paths,
          dryRun: params.dryRun ?? false,
          cwd: ctx.cwd,
          maxFiles: params.maxFiles,
        });
        const verb = res.applied ? "已改写" : "预览（未写盘）";
        const lines = res.files.map((f) => `${f.rel}: ${f.replacements}`);
        const errs = res.parseErrors.length ? `\n解析问题：\n- ${res.parseErrors.join("\n- ")}` : "";
        const body =
          res.totalReplacements === 0 ? "0 replacements（无匹配）" : `${verb}：共 ${res.totalReplacements} 处\n${lines.join("\n")}`;
        return {
          content: [{ type: "text", text: body + errs }],
          details: { totalReplacements: res.totalReplacements, applied: res.applied },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `ast_edit 不可用：${(err as Error).message}（可能缺 @ast-grep/napi prebuilt）` }],
          details: undefined,
        };
      }
    },
  });
}
