export type ApiType =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export interface ProviderPreset {
  /** 与 Pi provider id 一致（如 'openai'） */
  id: string;
  /** 显示名（取自 Pi BUILT_IN_PROVIDER_DISPLAY_NAMES） */
  name: string;
  /** 自定义追加模型时的默认 api 类型（内置 provider 的 api 由 Pi registry 决定，此处仅作默认） */
  api: ApiType;
  /** Base URL 提示，仅用于旧配置迁移匹配（内置 provider 不允许改 Base URL） */
  baseUrlHint?: string;
}

/**
 * 内置供应商目录：与 Pi 内置 provider 对齐（来源 `BUILT_IN_PROVIDER_DISPLAY_NAMES`）。
 * 内置 provider 的模型 / baseUrl 由 Pi registry 提供，UI 仅让填 API Key（+ 可追加自定义模型）。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', api: 'openai-responses', baseUrlHint: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', api: 'anthropic-messages', baseUrlHint: 'https://api.anthropic.com' },
  { id: 'google', name: 'Google Gemini', api: 'google-generative-ai' },
  { id: 'deepseek', name: 'DeepSeek', api: 'openai-completions', baseUrlHint: 'https://api.deepseek.com' },
  { id: 'xai', name: 'xAI', api: 'openai-completions', baseUrlHint: 'https://api.x.ai/v1' },
  { id: 'groq', name: 'Groq', api: 'openai-completions', baseUrlHint: 'https://api.groq.com/openai/v1' },
  { id: 'openrouter', name: 'OpenRouter', api: 'openai-completions', baseUrlHint: 'https://openrouter.ai/api/v1' },
  { id: 'mistral', name: 'Mistral', api: 'openai-completions', baseUrlHint: 'https://api.mistral.ai/v1' },
  { id: 'moonshotai', name: 'Moonshot AI', api: 'openai-completions', baseUrlHint: 'https://api.moonshot.ai/v1' },
  { id: 'zai', name: 'ZAI', api: 'openai-completions' },
  { id: 'minimax', name: 'MiniMax', api: 'openai-completions' },
  { id: 'together', name: 'Together AI', api: 'openai-completions', baseUrlHint: 'https://api.together.xyz/v1' },
  { id: 'fireworks', name: 'Fireworks', api: 'openai-completions', baseUrlHint: 'https://api.fireworks.ai/inference/v1' },
  { id: 'cerebras', name: 'Cerebras', api: 'openai-completions', baseUrlHint: 'https://api.cerebras.ai/v1' },
  { id: 'nvidia', name: 'NVIDIA NIM', api: 'openai-completions', baseUrlHint: 'https://integrate.api.nvidia.com/v1' },
  { id: 'huggingface', name: 'Hugging Face', api: 'openai-completions' },
  { id: 'kimi-coding', name: 'Kimi For Coding', api: 'openai-completions' },
  { id: 'ant-ling', name: 'Ant Ling', api: 'openai-completions' },
  { id: 'opencode', name: 'OpenCode Zen', api: 'openai-completions' },
  { id: 'opencode-go', name: 'OpenCode Go', api: 'openai-completions' },
  { id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', api: 'openai-completions' },
  { id: 'amazon-bedrock', name: 'Amazon Bedrock', api: 'openai-completions' },
  { id: 'google-vertex', name: 'Google Vertex AI', api: 'google-generative-ai' },
  { id: 'azure-openai-responses', name: 'Azure OpenAI Responses', api: 'openai-responses' },
  { id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', api: 'openai-completions' },
  { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', api: 'openai-completions' },
  { id: 'moonshotai-cn', name: 'Moonshot AI (China)', api: 'openai-completions', baseUrlHint: 'https://api.moonshot.cn/v1' },
  { id: 'minimax-cn', name: 'MiniMax (China)', api: 'openai-completions' },
  { id: 'zai-coding-cn', name: 'ZAI Coding Plan (China)', api: 'openai-completions' },
  { id: 'xiaomi', name: 'Xiaomi MiMo', api: 'openai-completions' },
  { id: 'xiaomi-token-plan-cn', name: 'Xiaomi MiMo Token Plan (China)', api: 'openai-completions' },
  { id: 'xiaomi-token-plan-ams', name: 'Xiaomi MiMo Token Plan (Amsterdam)', api: 'openai-completions' },
  { id: 'xiaomi-token-plan-sgp', name: 'Xiaomi MiMo Token Plan (Singapore)', api: 'openai-completions' },
];
