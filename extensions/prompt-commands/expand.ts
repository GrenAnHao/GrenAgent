import { buildCommandBlock, parseInvocation, renderPromptBody, resolveArgs, splitArgs } from "./syntax.js";
import type { PromptTemplate } from "./templates.js";

export type ExpandResult =
  | { kind: "pass" }
  | { kind: "missing"; name: string; missing: string[] }
  | { kind: "expanded"; text: string };

/** 只接管正文里有 {参数} 的模板；其余（包括 $1 写法）交回 Pi 原生展开。 */
export function expandInvocation(text: string, lookup: (name: string) => PromptTemplate | null): ExpandResult {
  const invocation = parseInvocation(text);
  if (!invocation) return { kind: "pass" };
  const template = lookup(invocation.name);
  if (!template || template.params.length === 0) return { kind: "pass" };
  const { args, rest } = splitArgs(invocation.argsText, template.params.length);
  const { values, missing } = resolveArgs(template.params, args);
  if (missing.length > 0) return { kind: "missing", name: invocation.name, missing };
  const block = buildCommandBlock(
    invocation.name,
    template.params.map((param) => ({ name: param.name, value: values[param.name] })),
    renderPromptBody(template.body, values),
  );
  return { kind: "expanded", text: rest ? `${block}\n\n${rest}` : block };
}
