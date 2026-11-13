# Changelog

## [1.5.1] - 2026-11-09

### Breaking Changes

- `openai-completions` no longer sends `"tools": []` when a request has no tools but the conversation contains tool calls or tool results; the field is omitted. This fixes 400 errors (`tools must not be an empty array`) from vLLM 0.20+, also behind LiteLLM. Proxies that require `tools` once the history has tool calls, such as older LiteLLM versions in front of Anthropic, now reject these requests; set `compat.requiresToolsWithToolHistory: true` on those models to send the empty array again ([#11843](https://github.com/earendil-works/pi/issues/11843))

### Added

- Anthropic requests with a `sessionId` (and `cacheRetention` not `"none"`) now use message threads (`message-threads-2026-08-12` beta): the server continues from the previous reply and pi sends only the new messages instead of the whole conversation. When anything earlier in the request changed, or the server can't continue the thread, the full request is sent. Token counts and prompt caching are unchanged. On by default only for the `anthropic` provider on `api.anthropic.com`; set `compat.supportsMessageThreads` to change that, for example for gateways that forward the `thread` field. Call `cleanupSessionResources(sessionId)` when a session ends to free the per-session state ([#11545](https://github.com/earendil-works/pi/pull/11545))
- Added `StreamOptions.disableContinuation`, which keeps a request from using or replacing server-side continuation state such as Anthropic message threads. Set it on requests that repeat an earlier one, such as cache warming ([#11545](https://github.com/earendil-works/pi/pull/11545))
- Added the prompt cache warming policy as shared helpers, so every host warms the same way: `getPromptCacheTtlMs()`, `getCacheWarmingDelayMs()`, `isCacheWarmingReplayable()`, `getCacheWarmingRequestOptions()`, `evaluateCacheWarming()` and the `CACHE_WARMING_*` constants (moved from pi-coding-agent's cache warmer)
- Added `@earendil-works/pi-ai/lazy-oauth` (`registerLazyOAuthFlows()`) and `@earendil-works/pi-ai/lazy-bedrock-provider` (`registerLazyBedrockProvider()`, built on the new `setBedrockProviderLoader()`) for Node bundles that split at dynamic imports: the OAuth login flows and Bedrock load through literal dynamic imports, so the bundler keeps them inside the bundle as chunks that load on first use, instead of through the variable-specifier imports that load pi-ai's own files at runtime. Nothing changes without calling them.
- Added Claude Fable 5.2 (`claude-fable-5-2`) to the `anthropic` provider ($8/$40 per million input/output tokens, 1M context, 128K output). Like Fable 5.1 it uses per-message effort and mid-conversation system messages; requests its safety classifiers refuse before any output are answered by Claude Opus 5 through server-side fallback and billed at Opus 5's price. Claude Fable 5.2 and Mythos 5.2 on other providers, such as OpenRouter's `anthropic/claude-fable-5.2`, get the same per-message effort support
- Added `Provider.refreshModelsAuth`. Set it to `"configured"` for providers whose `refreshModels()` reads a catalog that needs no provider credential, such as pi.dev: `Models.refresh()` then still skips unconfigured providers, but no longer refreshes an expired OAuth token first, so a stale login (`invalid_grant`) no longer fails that provider's catalog refresh. `context.credential` is undefined in that network phase.
- Added the `qwen-token-plan-individual-cn` provider for Qwen Token Plan Individual on the China endpoint, using `QWEN_TOKEN_PLAN_CN_API_KEY` ([#7989](https://github.com/earendil-works/pi/pull/7989) by [@bigoldcat123](https://github.com/bigoldcat123))
- Added Microsoft-Decision-1 classifier support through GitHub Copilot, including codemode `models.classify()` ([#11679](https://github.com/earendil-works/pi/pull/11679) by [@Marvae](https://github.com/Marvae))
- Added `compat.promptCacheKeyMode` (`"auto"`, `"enabled"`, or `"disabled"`) to enable prompt cache keys for compatible proxies or omit them for endpoints that reject them. Set it in `models.json` when using pi ([#9442](https://github.com/earendil-works/pi/pull/9442) by [@dannote](https://github.com/dannote))
- Added `compat.requiresNonNullAssistantContent` for OpenAI-compatible endpoints that require an empty string instead of `null` in assistant messages containing only tool calls. Set it in `models.json` when using pi ([#8118](https://github.com/earendil-works/pi/pull/8118) by [@gaoyk19](https://github.com/gaoyk19))
- Added GLM 5.3 to the Qwen Token Plan Individual model allowlist ([#11658](https://github.com/earendil-works/pi/issues/11658))

### Changed

- Renamed the "OpenAI Codex (legacy)" provider back to "OpenAI Codex"

### Fixed

- Azure OpenAI models now keep OpenAI's long-context price tier, so requests above 272K input tokens are costed at Azure's long-context rates ([#11948](https://github.com/earendil-works/pi/issues/11948))
- Fixed tool arguments for `Type.BigInt()` and `Type.Undefined()` parameters being rejected: they convert as TypeBox converted them (`"42"` and `42` to `42n`, `null` to `undefined`), now that pi-schema supports both types. `Type.Void()` still rejects every JSON argument.
- Fixed OpenCode Go Claude Haiku 5.5 failing with a 400 (`Invalid signature in thinking block ... bound to a different conversation`) after the tool list, system prompt, or earlier history changed, which left the session failing on every retry. OpenCode Go and Zen Claude 5.5 models, Opus 5, and Fable 5.1 now use per-message effort and send `thinking.block_binding: drop_block`, like the Anthropic provider ([#10954](https://github.com/earendil-works/pi/issues/10954))
- Fixed Anthropic non-strict tool schemas dropping root `$defs` and `definitions`, which left property `$ref`s pointing at nothing. Claude then produced wrong arguments for such tools (common in MCP servers), for example a JSON string instead of an object, and some Anthropic-compatible gateways rejected the request outright ([#9557](https://github.com/earendil-works/pi/issues/9557))
- Fixed OpenRouter rejecting requests with a 400 (`This endpoint's maximum context length is ...`) for models whose output limit is close to the context window, such as DeepSeek flash. OpenRouter counts the input with its own tokenizer, which can be several percent higher than the provider's count, and pi left only 4,096 tokens spare. pi then treated the 400 as a context overflow and compacted the session, even at around 20% of the window. The default output limit now leaves 15% of the estimated input unused, and near a full window at most 32,768 output tokens are requested ([#10497](https://github.com/earendil-works/pi/issues/10497))
- Fixed Azure GPT-6 Astra, Luna, Sol, GPT-6.1 Sol, and GPT-6.1 Terra using a 272K context window instead of the 1,050,000 tokens Azure Foundry deploys them with ([#11742](https://github.com/earendil-works/pi/issues/11742))
- Fixed Anthropic and Bedrock sending `strict: "prefer"` tools strict again on every request after Claude rejected them for exceeding its strict tool limits, which cost a rejected request (400) per turn. Later requests with the same `sessionId` now send those tools non-strict right away, until `cleanupSessionResources(sessionId)` ([#11626](https://github.com/earendil-works/pi/issues/11626))
- Fixed dropped provider streams reported as "cut short after the reply had begun" not triggering automatic retries ([#11879](https://github.com/earendil-works/pi/issues/11879))
- Fixed lazy OAuth and Bedrock imports resolving relative to a bundle's location instead of the module URL when pi-ai is bundled.
- Fixed Claude Sonnet 5 requests sending an unsupported temperature parameter ([#7961](https://github.com/earendil-works/pi/pull/7961) by [@jingtao-wisdomgraph](https://github.com/jingtao-wisdomgraph))
- Fixed OpenAI Responses requests sending `session_id` instead of the documented `session-id` affinity header ([#11639](https://github.com/earendil-works/pi/issues/11639))
- Fixed cancellation during lazy provider loading or authentication being reported as an error instead of an abort ([#8635](https://github.com/earendil-works/pi/pull/8635) by [@Mallikarjun-0](https://github.com/Mallikarjun-0))
- Fixed provider connection errors hiding their underlying cause, such as connection refusal or certificate errors, behind generic messages ([#11695](https://github.com/earendil-works/pi/issues/11695))
- Fixed OpenAI Codex SSE retries retaining abort listeners after each backoff, causing listener buildup on repeated retries ([#11708](https://github.com/earendil-works/pi/issues/11708))

## [1.5.0] - 2026-11-02

### Breaking Changes

- The main entry no longer re-exports TypeBox (`Type`, `Static`, `TSchema`), and `typebox` is no longer a dependency. `Tool.parameters` is any JSON Schema object (`Tool<TParameters extends object>`): `@earendil-works/pi-schema`'s builders, which also type the arguments through pi-schema's `Static`, TypeBox schemas, or plain objects. `validateToolCall()`/`validateToolArguments()` validate with pi-schema (`compile(schema, { coerce: true }).parse()`): every schema gets the same coercion, the superset of TypeBox's `Value.Convert` rules (which only applied to TypeBox-built schemas) and pi-ai's own, so plain JSON Schema tools (MCP tools) now also get, for example, `null` to `"null"` for a required string, `"3.5"` to 3 for an integer and a single value wrapped into an array. The error text lists pi-schema's messages (`- edits.0.oldText: missing`, `- limit: expected number, got string`) instead of TypeBox's. `StringEnum()` returns a pi-schema `Schema<T>` with the same JSON (`{ type: "string", enum }`). The model and compat schemas (`providers/model-schema`, `providers/compat-schema`) are built with pi-schema, with the same JSON Schema, and their types come from pi-schema's `Static`; `ProviderCompat` is exported. Migration:

  ```ts
  // Before
  import { Type, type Static, StringEnum } from "@earendil-works/pi-ai";
  const params = Type.Object({ path: Type.String(), mode: StringEnum(["a", "b"]) });
  type Params = Static<typeof params>;

  // After: pi-schema builders (closed objects; pass { open: true } to allow other properties)
  import { StringEnum } from "@earendil-works/pi-ai";
  import { obj, type Static, str } from "@earendil-works/pi-schema";
  const params = obj({ path: str(), mode: StringEnum(["a", "b"]) });
  type Params = Static<typeof params>;

  // Or keep TypeBox, imported from typebox itself (its schemas are JSON Schema)
  import { Type, type Static } from "typebox";
  ```
- Tool arguments are validated as JSON Schema only; nothing runs through TypeBox's own validator any more, so TypeBox features outside JSON Schema no longer apply to tool arguments:
  - `Type.Refine()` refinements are not run: arguments they would reject are accepted.
  - `Type.BigInt()`, `Type.Undefined()` and `Type.Void()` reject every JSON argument (TypeBox converted to them).
  - Codecs (`Type.Codec()`) do not decode: the tool receives the encoded JSON value.
  - Formats registered with TypeBox's `Format.Set()` are not checked; the standard formats plus `url` and `json-pointer-uri-fragment` are.
  - Property names are names, not regular expressions: `"a.b"` no longer also converts the argument `axb`.
  - `additionalProperties` converts only undeclared properties; TypeBox also converted declared ones with it when an object had more than one property.
- A `$ref` that names nothing (a missing definition, an external document) rejects only arguments at its place (`- t: unresolved reference #/definitions/Missing`) instead of failing every call of the tool, as TypeBox's rejection did before.
- `appendGrammarToolInputJsonDelta()` (`api/constrained-sampling`) takes the input delta instead of the whole input so far and no longer closes the input; close it with the new `closeGrammarToolInputJson()` ([#9265](https://github.com/earendil-works/pi/issues/9265))

### Added

- Added optional `openBrowserOnConfirm` and `copyCodeOnConfirm` to `device_code` auth events and `OAuthDeviceCodeInfo`. Both default to `true`; set them to `false` to stop clients from offering to open the verification page or copy the code ([#9282](https://github.com/earendil-works/pi/issues/9282), [#9301](https://github.com/earendil-works/pi/pull/9301))
- Added `StreamingJsonParser`, an incremental, tolerant parser for JSON text that arrives in pieces (each piece is read once; snapshots of the partial value never change once returned), and `ToolCallArgumentsStream`, which every provider now uses for streamed tool-call arguments; its `append()` also returns the changes each piece made (`JsonChange`: a value set at a path, or text appended to a string), for writers that keep their own copy ([#9265](https://github.com/earendil-works/pi/issues/9265))
- Added GPT-6.1 Terra to the OpenAI, Azure OpenAI Responses, and OpenAI Codex providers with official pricing ($1 input, $0.05 cached input, $1.25 cache writes, $5 output, long-context tier above 272k), tool search, and mid-conversation effort changes. Unlike GPT-6.1 Sol it supports `off` (reasoning effort `none`); Codex serves it with a 500K context window
- Added `Usage.cost.totalFromProvider` to distinguish provider-reported billed totals from catalog estimates. Missing or `false` means an estimate; combined usage is marked provider-reported only when every part is ([#11178](https://github.com/earendil-works/pi/pull/11178))
- Added `responseModel` to pi-messages terminal events, preserving the concrete model reported by providers such as Radius when a virtual model is requested ([#11265](https://github.com/earendil-works/pi/pull/11265))

### Changed

- The faux provider streams partial tool-call arguments, so `toolcall_delta` partials show growing arguments as real providers do ([#9265](https://github.com/earendil-works/pi/issues/9265))
- The built-in model catalog is generated from models.dev's v2 catalog, and its per-provider rules moved from `scripts/generate-models.ts` into one TypeScript definition per provider under `catalog/`. Models that models.dev types as realtime or image models (`gpt-realtime-2.1`, `gemini-3.1-flash-live-preview`, `gemini-3.1-flash-lite-image`) are no longer offered as chat models, and models.dev's newer OpenAI and Google chat models (`chat-latest`, `gpt-5.6-cyber`, `gemini-robotics-er-2-preview`) are now included

### Fixed

- Fixed Claude models that accept mid-conversation system messages rejecting a session with a 400 (`role 'system' must precede an 'assistant' message`) when a system update was followed by an assistant reply with nothing to send to Anthropic, such as an empty reply or another model's reasoning-only reply ([#11091](https://github.com/earendil-works/pi/issues/11091))
- Fixed Claude models with mid-conversation effort failing with `Invalid effort level` on accounts whose organization caps effort below `high`, even at `low` or `medium` thinking, by sending a fixed `low` top-level effort ([#10063](https://github.com/earendil-works/pi/issues/10063))
- Fixed streamed tool-call arguments being re-parsed in full on every delta, which made CPU time and memory grow quadratically with the size of a tool call (a 90 KB `write` on Anthropic peaked at about 140 MB of heap; a 500 KB one took minutes). Every provider and the pi-messages client now read each delta once, and keep the raw argument text and their other stream state (`partialJson`, `partialArgs`, `index`, `customInput`, `streamIndex`, Bedrock's encrypted reasoning bytes) off the content blocks, so it no longer reaches partial messages or transcripts of failed streams ([#9265](https://github.com/earendil-works/pi/issues/9265))
- Fixed grammar (custom) tool input streaming copying the whole input so far on every delta ([#9265](https://github.com/earendil-works/pi/issues/9265))
- Fixed bounded error texts (telemetry span messages, truncated provider error bodies, pi-messages diagnostics, Radius gateway errors) keeping the whole text they were cut from alive ([#9265](https://github.com/earendil-works/pi/issues/9265))
- Fixed Kimi K3.1 Pro and K3.1 Pro Highspeed on Kimi Coding, Moonshot, and OpenCode Go using Kimi K2 request settings. They now send `reasoning_effort` (low/high/max), return earlier reasoning, accept tools added mid-conversation, and report Moonshot rates on Kimi Coding. Kimi Coding `k3-256k` now reports Kimi K3 rates.
- Fixed OAuth logins opening server-supplied URLs that are not `http:` or `https:` URLs. Radius now checks its browser authorization endpoint and device verification URI, and GitHub Copilot, Kimi Coding, and Meta share one check
- Fixed pi-messages streams accepting a `contentIndex` that is not the next or an existing content block, such as `__proto__` or a huge index
- Fixed `pi-ai` CLI auth file being readable by other users. It is now written with mode `0600`
- Fixed OpenCode DeepSeek V4.1 Flash sending `prompt_cache_retention`, which the OpenCode gateway rejects, with long cache retention
- Fixed GPT-5.4 and GPT-5.5 failing with `Missing namespace for function_call` after switching from another model that called tools. On the OpenAI and OpenCode providers they now declare their tools in the top-level tool list instead of loading them through `additional_tools` or tool search ([#11415](https://github.com/earendil-works/pi/issues/11415))
- Fixed Bedrock requests failing when `strict: "prefer"` tools exceed Claude's strict tool limits, such as more than 16 optional parameters across all strict tools; requests now retry once with preferred tools non-strict while keeping `strict: "require"` tools strict, as the Anthropic provider already does ([#11416](https://github.com/earendil-works/pi/issues/11416))
- Fixed OpenRouter's `~anthropic/claude-*-latest` aliases losing Claude's earlier thinking after each tool call. They used the Chat Completions API, where pi dropped the thinking signature, and OpenRouter then ignored the unsigned thinking. They now use the Anthropic Messages API with adaptive thinking, like the versioned Claude models ([#9534](https://github.com/earendil-works/pi/issues/9534))
- Fixed OpenRouter cost totals using catalog estimates instead of reported billing for Chat Completions and Anthropic Messages. BYOK totals include both OpenRouter charges and reported upstream costs; component costs remain catalog estimates ([#9980](https://github.com/earendil-works/pi/issues/9980))
- Fixed OpenCode Zen and OpenCode Go requests using shared endpoints instead of their protocol-specific OpenAI, Anthropic, Google, and System One endpoints ([#11434](https://github.com/earendil-works/pi/pull/11434) by [@vimtor](https://github.com/vimtor))
- Fixed Zhipu/Z.ai usage-limit errors (code `1308`) being treated as transient HTTP 429 errors, causing automatic retries that cannot succeed until the usage cap resets ([#11537](https://github.com/earendil-works/pi/issues/11537))
- Fixed LiteLLM's `ContextWindowExceededError` not being recognized as context overflow ([#11492](https://github.com/earendil-works/pi/issues/11492))
- Fixed Gemini tool schemas sending unsupported `const` keywords. They are now converted to single-value `enum` schemas without rewriting literal data in defaults, examples, or enum values, or losing properties named `__proto__` ([#11308](https://github.com/earendil-works/pi/issues/11308))
- Fixed the faux provider counting simulated cache-write tokens as both input and cache writes

