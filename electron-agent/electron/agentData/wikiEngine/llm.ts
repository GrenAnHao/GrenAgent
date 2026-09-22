// Ported from TencentDB-Agent-Memory MemoryKnowledge (MIT).
/**
 * llm.ts — wiki ingest LLM adapter.
 * Calls an injected complete(system, prompt, label); does not read process.env
 * and does not import the `ai` package.
 */

export type CompleteFn = (
  system: string,
  prompt: string,
  label?: string,
) => Promise<string>;

/** Upstream raw config (shape retained for parity; unused by the adapter). */
export interface RawLlmConfig {
  protocol?: 'openai' | 'anthropic';
  provider?: string;
  apiKey?: string;
  model?: string;
  customEndpoint?: string;
  maxContextSize?: number;
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  stream?: boolean;
}

export interface NormalizedLlmConfig {
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  stream: boolean;
}

const DEFAULT_MODEL = 'Memory-Model';
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 1_200_000;

export function normalizeLlmConfig(raw: RawLlmConfig | undefined): NormalizedLlmConfig {
  const cfg = raw ?? {};
  return {
    protocol: cfg.protocol ?? 'openai',
    baseUrl: cfg.baseUrl || cfg.customEndpoint || '',
    apiKey: cfg.apiKey || '',
    model: cfg.model || DEFAULT_MODEL,
    maxTokens: cfg.maxTokens ?? cfg.maxContextSize ?? DEFAULT_MAX_TOKENS,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stream: cfg.stream ?? false,
  };
}

export interface ChatParams {
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  label?: string;
}

export interface LlmClient {
  chat(params: ChatParams): Promise<string>;
  readonly config: NormalizedLlmConfig;
}

/**
 * Build an LlmClient that forwards chat() to the injected complete callback.
 */
export function createLlmClient(
  complete: CompleteFn,
  raw: RawLlmConfig = {},
): LlmClient {
  const config = normalizeLlmConfig(raw);
  return {
    config,
    async chat(params: ChatParams): Promise<string> {
      const text = await complete(params.system, params.prompt, params.label);
      return (text ?? '').trim();
    },
  };
}
