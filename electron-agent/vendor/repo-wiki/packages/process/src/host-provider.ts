/** A child-side adapter for GrenAgent's existing main.model.complete short-call broker. */
import { createHash } from "node:crypto";
import type { ModelCompletionInput } from "../../contracts/src/index.js";
import {
  PROMPT_VERSION,
  ProviderError,
  generationSystemPrompt,
  sourceLines,
  validateProviderOutput,
  type Provider,
  type PageContext,
  type PageOutput,
  type GenerateOptions,
} from "../../core/src/providers.js";
export type HostComplete = (
  input: ModelCompletionInput,
  signal?: AbortSignal,
) => Promise<string>;
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProviderError(
      "Generation was canceled. A host request already sent may still incur charges.",
    );
}
export class HostModelProvider implements Provider {
  readonly name = "real";
  readonly cache_key: string;
  constructor(
    private complete: HostComplete,
    modelCacheKey: string,
  ) {
    if (!modelCacheKey)
      throw new ProviderError("Host model cache identity is required");
    this.cache_key =
      "host-shortcall-v2:" +
      createHash("sha256")
        .update(JSON.stringify([modelCacheKey, PROMPT_VERSION, 8192, 1600]))
        .digest("hex");
  }
  async generate_page(
    context: PageContext,
    options: GenerateOptions = {},
  ): Promise<PageOutput> {
    checkAbort(options.signal);
    const kind = context.kind === "card" ? "card" : "wiki";
    // Keep content for the host's existing broker contract; numbered excerpts
    // give both adapters identical source-line semantics. The complete payload
    // is measured after numbering, not just before escaping/metadata overhead.
    const user = JSON.stringify({
      ...context,
      kind,
      files: (context.files ?? []).map((file) => ({
        ...file,
        content_with_lines: sourceLines(file.content)
          .map((line, i) => `${i + 1}: ${line}`)
          .join("\n"),
      })),
    });
    if (user.length > 600_000)
      throw new ProviderError("Host model context exceeds budget");
    let text: string;
    try {
      text = await this.complete(
        {
          systemPrompt: generationSystemPrompt({ kind }),
          user,
          maxTokens: kind === "card" ? 1600 : 8192,
        },
        options.signal,
      );
    } catch {
      checkAbort(options.signal);
      throw new ProviderError(
        "Host model request failed. Provider details were withheld; no page was overwritten.",
      );
    }
    checkAbort(options.signal);
    if (typeof text !== "string" || text.length > 2_000_000)
      throw new ProviderError(
        "Host model response exceeds budget or is not text",
      );
    let value: unknown;
    try {
      value = JSON.parse(
        text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
      );
    } catch {
      throw new ProviderError(
        "Host model returned invalid page JSON. No page was overwritten.",
      );
    }
    // Same card bounds and strict source-reference shape as HTTP adapter;
    // engine subsequently validates every file/range against supplied evidence.
    return validateProviderOutput(value, kind);
  }
}
