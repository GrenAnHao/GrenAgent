// In-process LLM access shared by the goal and session-memory
// extensions. Uses the current agent model (ctx.model) via pi-ai's
// completeSimple — no sub-process, no extra API key.
//
// `completeSimple` is imported lazily (dynamic import) so the pure helpers below
// (parseJsonLoose / resolveModel) can be unit-tested without loading the heavy
// pi-ai runtime. At sidecar build time bun bundles the dynamic import.
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type AskFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** Extract the first JSON value from possibly noisy / fenced LLM output. */
export function parseJsonLoose<T = unknown>(raw: string): T | undefined {
  const text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return undefined;
  // Walk to the matching closing bracket to tolerate trailing prose. Ignore
  // brackets inside strings and support mixed object/array nesting.
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const char = candidate[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as T;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Resolve the model to use: an override spec ("provider/id") resolved via the
 * registry, falling back to the current ctx.model. The env var that supplies
 * `override` (GOAL_MODEL / MEMORY_MODEL / SESSION_STATE_MODEL) is read by callers.
 *
 * 与 pi 的 `ExtensionContext.model: Model<any> | undefined` 对齐取 `Model<any>`；
 * 若写成 `Model<never>`（bottom type），每个调用方都得 `as never` 绕过。
 */
export function resolveModel(
  current: Model<any> | undefined,
  registry: Pick<ModelRegistry, "find">,
  override: string | undefined,
): Model<any> | undefined {
  const spec = override?.trim();
  if (spec && spec.includes("/")) {
    const slash = spec.indexOf("/");
    const found = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (found) return found;
  }
  return current;
}

/** Call the model with a system + user prompt; return concatenated assistant text. */
export async function askLlm(
  model: Model<any>,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const { completeSimple } = await import("@earendil-works/pi-ai/compat");
  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
  };
  // SimpleStreamOptions.reasoning 只声明到 ThinkingLevel（不含 "off"），但运行时
  // （pi-ai models.js 的 EXTENDED_THINKING_LEVELS）接受 "off"；仅对该字段做收窄断言。
  const msg = await completeSimple(model, context, {
    reasoning: "off" as SimpleStreamOptions["reasoning"],
    signal,
  });
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}
