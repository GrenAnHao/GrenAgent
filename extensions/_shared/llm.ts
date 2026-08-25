// In-process LLM access shared by the goal and session-memory
// extensions. Uses the current agent model (ctx.model) via pi-ai's
// completeSimple — no sub-process, no extra API key.
//
// `completeSimple` is imported lazily (dynamic import) so the pure helpers below
// (parseJsonLoose / resolveModel) can be unit-tested without loading the heavy
// pi-ai runtime. At sidecar build time bun bundles the dynamic import.
import type { Context, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type AskFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** Extract the first JSON value from possibly noisy / fenced LLM output. */
export function parseJsonLoose<T = unknown>(raw: string): T | undefined {
  const text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return undefined;
  // Walk to the matching closing bracket to tolerate trailing prose.
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === open) depth++;
    else if (candidate[i] === close) {
      depth--;
      if (depth === 0) {
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
 */
export function resolveModel(
  current: Model<never> | undefined,
  registry: Pick<ModelRegistry, "find">,
  override: string | undefined,
): Model<never> | undefined {
  const spec = override?.trim();
  if (spec && spec.includes("/")) {
    const slash = spec.indexOf("/");
    const found = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (found) return found as Model<never>;
  }
  return current;
}

/** Call the model with a system + user prompt; return concatenated assistant text. */
export async function askLlm(
  model: Model<never>,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const { completeSimple } = await import("@earendil-works/pi-ai/compat");
  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
  };
  const msg = await completeSimple(model, context, { reasoning: "off", signal } as never);
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}
