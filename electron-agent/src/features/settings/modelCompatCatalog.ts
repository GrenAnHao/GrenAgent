import type { ApiType } from './providerPresets';

export type CompatGroupId = 'thinking' | 'message' | 'cache' | 'routing' | 'anthropic';

export interface FieldDoc {
  key: string;
  label: string;
  en: string;
  help: string;
}

export interface BoolCompatField extends FieldDoc {
  kind: 'bool';
  group: CompatGroupId;
  apis: readonly ApiType[];
}

export interface SelectCompatField extends FieldDoc {
  kind: 'select';
  group: CompatGroupId;
  apis: readonly ApiType[];
  options: { value: string; label: string }[];
  emptyLabel: string;
}

export interface ScalarCompatField extends FieldDoc {
  kind: 'text' | 'number';
  group: CompatGroupId;
  apis: readonly ApiType[];
  placeholder?: string;
}

export type CompatField = BoolCompatField | SelectCompatField | ScalarCompatField;

const OPENAI_COMPLETIONS: ApiType[] = ['openai-completions'];
const OPENAI_BOTH: ApiType[] = ['openai-completions', 'openai-responses'];
const ANTHROPIC: ApiType[] = ['anthropic-messages'];

export const THINKING_FORMAT_OPTIONS: { value: string; label: string; chip: string }[] = [
  { value: 'openai', label: 'OpenAI 标准 · 只发 reasoning_effort', chip: 'OpenAI' },
  { value: 'zai', label: '智谱 / GLM · 同时发 thinking 和 reasoning_effort', chip: '智谱格式' },
  { value: 'qwen', label: '通义千问 · 发 enable_thinking', chip: '千问格式' },
  { value: 'deepseek', label: 'DeepSeek · 发 thinking.type', chip: 'DeepSeek' },
  { value: 'openrouter', label: 'OpenRouter · 发 reasoning.effort', chip: 'OpenRouter' },
  { value: 'together', label: 'Together · 发 reasoning.enabled', chip: 'Together' },
  { value: 'baseten', label: 'Baseten · 走 chat_template_args', chip: 'Baseten' },
  { value: 'qwen-chat-template', label: 'Qwen 本地模板 · chat_template_kwargs.enable_thinking', chip: 'Qwen 模板' },
  { value: 'chat-template', label: '通用聊天模板 · 自定义 chat_template_kwargs', chip: '聊天模板' },
  { value: 'string-thinking', label: '字符串思考 · 顶层 thinking 字符串', chip: '字符串思考' },
  { value: 'ant-ling', label: 'Ant Ling · 按映射发 reasoning.effort', chip: 'Ant Ling' },
];

export const THINKING_LEVEL_ROWS: { level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; label: string }[] = [
  { level: 'off', label: '关闭' },
  { level: 'minimal', label: '最低' },
  { level: 'low', label: '低' },
  { level: 'medium', label: '中' },
  { level: 'high', label: '高' },
  { level: 'xhigh', label: '很高' },
  { level: 'max', label: '最高' },
];

export const COMPAT_GROUPS: { id: CompatGroupId; title: string }[] = [
  { id: 'thinking', title: '思考与推理兼容' },
  { id: 'message', title: '消息、角色与工具' },
  { id: 'cache', title: '缓存与会话亲和' },
  { id: 'routing', title: '路由与高级' },
  { id: 'anthropic', title: 'Anthropic 协议专用' },
];

export const COMPAT_FIELDS: CompatField[] = [
  {
    key: 'supportsReasoningEffort', kind: 'bool', group: 'thinking', apis: OPENAI_COMPLETIONS,
    label: '发送推理强度', en: 'supportsReasoningEffort',
    help: '打开：请求里带推理档位。关掉：服务商不认这个参数时用，避免 400。',
  },
  {
    key: 'requiresThinkingAsText', kind: 'bool', group: 'thinking', apis: OPENAI_COMPLETIONS,
    label: '思考当纯文本回放', en: 'requiresThinkingAsText',
    help: '有的代理不接受「思考块」，只能把思考当成普通文字再发给模型。',
  },
  {
    key: 'requiresReasoningContentOnAssistantMessages', kind: 'bool', group: 'thinking', apis: OPENAI_COMPLETIONS,
    label: '助手消息必须带思考字段', en: 'requiresReasoningContentOnAssistantMessages',
    help: '开启思考后，回放历史时每条助手消息都带上思考字段；缺了会 400。',
  },
  {
    key: 'supportsThinkingTokenBudget', kind: 'bool', group: 'thinking', apis: OPENAI_COMPLETIONS,
    label: '限制思考 token 上限', en: 'supportsThinkingTokenBudget',
    help: '给思考过程单独设 token 预算。vLLM / 部分 Qwen 网关才需要。',
  },
  {
    key: 'thinkingTokenBudgetField', kind: 'select', group: 'thinking', apis: OPENAI_COMPLETIONS,
    label: '思考预算字段名', en: 'thinkingTokenBudgetField',
    help: '告诉 Pi 用哪个字段名去限制思考长度。一般不用填。',
    emptyLabel: '不发送',
    options: [
      { value: 'thinking_token_budget', label: 'thinking_token_budget（vLLM）' },
      { value: 'thinking_budget', label: 'thinking_budget（Qwen / SGLang）' },
      { value: 'thinking_budget_tokens', label: 'thinking_budget_tokens（llama.cpp）' },
    ],
  },
  {
    key: 'supportsDeveloperRole', kind: 'bool', group: 'message', apis: OPENAI_BOTH,
    label: '使用 developer 角色', en: 'supportsDeveloperRole',
    help: '打开：系统提示走 developer。本地 Ollama / 多数中转站应关掉，改发 system。',
  },
  {
    key: 'supportsUsageInStreaming', kind: 'bool', group: 'message', apis: OPENAI_COMPLETIONS,
    label: '流式返回用量', en: 'supportsUsageInStreaming',
    help: '打开：流式请求里要 token 用量。代理不支持时关掉，避免报错。',
  },
  {
    key: 'supportsFinishReason', kind: 'bool', group: 'message', apis: OPENAI_COMPLETIONS,
    label: '流式带结束原因', en: 'supportsFinishReason',
    help: '关掉后，Pi 会自己判断是说完了还是在调工具。',
  },
  {
    key: 'supportsStore', kind: 'bool', group: 'message', apis: OPENAI_COMPLETIONS,
    label: '保存对话到服务商', en: 'supportsStore',
    help: '是否发送 store。多数中转站不支持，保持关闭。',
  },
  {
    key: 'requiresToolResultName', kind: 'bool', group: 'message', apis: OPENAI_COMPLETIONS,
    label: '工具结果必须带名称', en: 'requiresToolResultName',
    help: '有的接口要求 tool 回传消息带 name，缺了会报错。',
  },
  {
    key: 'requiresAssistantAfterToolResult', kind: 'bool', group: 'message', apis: OPENAI_COMPLETIONS,
    label: '工具结果后补一条助手消息', en: 'requiresAssistantAfterToolResult',
    help: '少数接口要求 tool 结果后面必须再跟一条助手消息，才能继续聊。',
  },
  {
    key: 'supportsStrictMode', kind: 'bool', group: 'message', apis: OPENAI_BOTH,
    label: '严格 JSON 工具', en: 'supportsStrictMode',
    help: '工具参数按严格 JSON Schema 校验。服务商不支持时关掉。',
  },
  {
    key: 'supportsOpenAIGrammarTools', kind: 'bool', group: 'message', apis: OPENAI_BOTH,
    label: 'OpenAI 语法工具', en: 'supportsOpenAIGrammarTools',
    help: '是否支持 Lark/正则语法约束的工具。不支持时 Pi 会退化成普通函数工具。',
  },
  {
    key: 'supportsAdditionalTools', kind: 'bool', group: 'message', apis: ['openai-responses'],
    label: '额外工具类型', en: 'supportsAdditionalTools',
    help: 'Responses API 是否接受额外工具类型。',
  },
  {
    key: 'supportsToolSearch', kind: 'bool', group: 'message', apis: ['openai-responses'],
    label: '工具搜索', en: 'supportsToolSearch',
    help: 'Responses API 是否支持工具搜索。',
  },
  {
    key: 'supportsMaxOutputTokens', kind: 'bool', group: 'message', apis: ['openai-responses'],
    label: '发送最大输出', en: 'supportsMaxOutputTokens',
    help: 'Responses API 是否接受 max_output_tokens。',
  },
  {
    key: 'maxTokensField', kind: 'select', group: 'message', apis: OPENAI_COMPLETIONS,
    label: '最大输出字段名', en: 'maxTokensField',
    help: '有的接口要 max_completion_tokens，老接口只要 max_tokens。',
    emptyLabel: '默认',
    options: [
      { value: 'max_completion_tokens', label: 'max_completion_tokens（新）' },
      { value: 'max_tokens', label: 'max_tokens（旧）' },
    ],
  },
  {
    key: 'deferredToolsMode', kind: 'select', group: 'message', apis: OPENAI_COMPLETIONS,
    label: '延迟工具模式', en: 'deferredToolsMode',
    help: '目前只有 Kimi 的 OpenAI 兼容格式需要选 kimi。',
    emptyLabel: '不使用',
    options: [{ value: 'kimi', label: 'kimi' }],
  },
  {
    key: 'supportsLongCacheRetention', kind: 'bool', group: 'cache', apis: [...OPENAI_BOTH, ...ANTHROPIC],
    label: '支持长缓存', en: 'supportsLongCacheRetention',
    help: '是否接受更长的提示缓存时间。代理不认这个字段时关掉。',
  },
  {
    key: 'sendSessionAffinityHeaders', kind: 'bool', group: 'cache', apis: [...OPENAI_COMPLETIONS, ...ANTHROPIC],
    label: '发送会话亲和头', en: 'sendSessionAffinityHeaders',
    help: '打开缓存时，把会话 ID 放到请求头，尽量打到同一台机器，提高缓存命中。',
  },
  {
    key: 'sessionAffinityFormat', kind: 'select', group: 'cache', apis: OPENAI_BOTH,
    label: '会话亲和头格式', en: 'sessionAffinityFormat',
    help: '各家请求头名字不一样。不确定就保持自动检测。',
    emptyLabel: '自动检测',
    options: [
      { value: 'openai', label: 'openai' },
      { value: 'openai-nosession', label: 'openai-nosession' },
      { value: 'openrouter', label: 'openrouter' },
    ],
  },
  {
    key: 'cacheControlFormat', kind: 'select', group: 'cache', apis: OPENAI_COMPLETIONS,
    label: '缓存标记格式', en: 'cacheControlFormat',
    help: '有的 OpenAI 兼容代理用 Anthropic 那种 cache_control 来做提示缓存。',
    emptyLabel: '不使用',
    options: [{ value: 'anthropic', label: 'anthropic 风格' }],
  },
  {
    key: 'vllmPriority', kind: 'number', group: 'routing', apis: OPENAI_COMPLETIONS,
    label: 'vLLM 优先级', en: 'vllmPriority',
    help: '只对 vLLM 有意义。数字越大越优先排队。普通中转站不用填。',
    placeholder: '可选数字',
  },
  {
    key: 'openRouterRouting', kind: 'text', group: 'routing', apis: OPENAI_COMPLETIONS,
    label: 'OpenRouter 路由', en: 'openRouterRouting',
    help: '只走 OpenRouter 时才填。用来指定只用哪些上游、是否允许降级。',
    placeholder: '例如 only: anthropic, amazon-bedrock',
  },
  {
    key: 'vercelGatewayRouting', kind: 'text', group: 'routing', apis: OPENAI_COMPLETIONS,
    label: 'Vercel 网关路由', en: 'vercelGatewayRouting',
    help: '走 Vercel AI Gateway 时指定上游顺序。其它供应商忽略。',
    placeholder: '例如 only: fireworks, novita',
  },
  {
    key: 'chatTemplateKwargs', kind: 'text', group: 'routing', apis: OPENAI_COMPLETIONS,
    label: '聊天模板参数', en: 'chatTemplateKwargs / chatTemplateArgs',
    help: '思考协议选「通用聊天模板」或 Baseten 时才需要。用来把思考开关塞进模板参数。',
    placeholder: '一般不用填',
  },
  {
    key: 'forceAdaptiveThinking', kind: 'bool', group: 'anthropic', apis: ANTHROPIC,
    label: '自适应思考', en: 'forceAdaptiveThinking',
    help: '打开：发 thinking.type=adaptive 和 effort。老 Claude（3.7 / 4.0 / 4.5）要关掉，改走预算思考。',
  },
  {
    key: 'supportsMidConvoEffort', kind: 'bool', group: 'anthropic', apis: ANTHROPIC,
    label: '对话中途改推理强度', en: 'supportsMidConvoEffort',
    help: '仅忠实 Anthropic 传输上的新 Claude 需要。仿 Messages 的中转站不要开。',
  },
  {
    key: 'supportsEagerToolInputStreaming', kind: 'bool', group: 'anthropic', apis: ANTHROPIC,
    label: '工具输入流式', en: 'supportsEagerToolInputStreaming',
    help: '代理拒绝 eager_input_streaming 时关掉，改走旧的细粒度工具流式头。',
  },
  {
    key: 'supportsCacheControlOnTools', kind: 'bool', group: 'anthropic', apis: ANTHROPIC,
    label: '工具定义可带缓存标记', en: 'supportsCacheControlOnTools',
    help: '工具 JSON 上能否写 cache_control。不支持时关掉。',
  },
  {
    key: 'allowEmptySignature', kind: 'bool', group: 'anthropic', apis: ANTHROPIC,
    label: '允许空思考签名', en: 'allowEmptySignature',
    help: '有的兼容站会吐空签名还要求回放。真 Anthropic 会拒，不要随便开。',
  },
  {
    key: 'supportsStrictTools', kind: 'bool', group: 'anthropic', apis: ANTHROPIC,
    label: '严格工具 Schema', en: 'supportsStrictTools',
    help: '是否接受严格 JSON Schema 工具定义。内置 Anthropic 模型默认开，自定义要自己勾。',
  },
  {
    key: 'supportsTemperature', kind: 'bool', group: 'anthropic', apis: ANTHROPIC,
    label: '发送温度', en: 'supportsTemperature',
    help: '该 Anthropic 兼容接口是否接受 temperature。',
  },
  {
    key: 'supportsToolReferences', kind: 'bool', group: 'anthropic', apis: ANTHROPIC,
    label: '工具引用', en: 'supportsToolReferences',
    help: '是否支持工具引用语法。多数中转站保持关闭。',
  },
];

const ANTHROPIC_ONLY = new Set(COMPAT_FIELDS.filter((f) => f.group === 'anthropic').map((f) => f.key));

export function thinkingFormatChip(format: string | undefined): string | undefined {
  if (!format) return undefined;
  return THINKING_FORMAT_OPTIONS.find((o) => o.value === format)?.chip ?? format;
}

export function showsThinkingFormat(api: string | undefined): boolean {
  return api === 'openai-completions';
}

export function fieldsForApi(api: string | undefined): CompatField[] {
  if (!api) return [];
  return COMPAT_FIELDS.filter((f) => f.apis.includes(api as ApiType));
}

export function groupsForApi(api: string | undefined): { id: CompatGroupId; title: string; fields: CompatField[] }[] {
  const fields = fieldsForApi(api);
  return COMPAT_GROUPS
    .map((g) => ({ ...g, fields: fields.filter((f) => f.group === g.id) }))
    .filter((g) => g.fields.length > 0);
}

/** 设置页展示：当前协议字段 + Anthropic 专用（非 anthropic 时只展示不落盘）。 */
export function groupsForEditor(api: string | undefined): { id: CompatGroupId; title: string; fields: CompatField[] }[] {
  const current = fieldsForApi(api);
  const extra = api === 'anthropic-messages' ? [] : COMPAT_FIELDS.filter((f) => f.group === 'anthropic');
  const fields = [...current, ...extra];
  return COMPAT_GROUPS
    .map((g) => ({
      ...g,
      title:
        g.id === 'anthropic' && api !== 'anthropic-messages'
          ? 'Anthropic 协议专用（当前 API 不是 anthropic-messages 时不会写入）'
          : g.title,
      fields: fields.filter((f) => f.group === g.id),
    }))
    .filter((g) => g.fields.length > 0);
}

export function isAnthropicOnlyKey(key: string): boolean {
  return ANTHROPIC_ONLY.has(key);
}

export function allowedCompatKeys(api: string | undefined): Set<string> {
  const keys = new Set(fieldsForApi(api).map((f) => f.key));
  if (showsThinkingFormat(api)) keys.add('thinkingFormat');
  return keys;
}
