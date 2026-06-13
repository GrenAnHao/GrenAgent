export type FieldType = 'text' | 'password' | 'number' | 'boolean';

export interface SettingField {
  key: string; // env 名
  label: string;
  type: FieldType;
  placeholder?: string;
}

export interface SettingCategory {
  id: string;
  title: string;
  fields: SettingField[];
}

export const SETTINGS_SCHEMA: SettingCategory[] = [
  {
    id: 'general',
    title: '通用 / 模型',
    fields: [
      { key: 'OPENAI_API_KEY', label: 'OpenAI API Key（全局兜底）', type: 'password', placeholder: 'sk-...' },
    ],
  },
  {
    id: 'knowledge',
    title: '知识库',
    fields: [
      { key: 'KB_AUTO_INJECT', label: '自动注入（1/0）', type: 'boolean' },
      { key: 'KB_AUTO_TOPK', label: '自动注入条数', type: 'number', placeholder: '3' },
      { key: 'KB_EMBED_API_KEY', label: 'Embedding API Key', type: 'password' },
      { key: 'KB_EMBED_BASE_URL', label: 'Embedding Base URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'KB_EMBED_MODEL', label: 'Embedding 模型', type: 'text', placeholder: 'text-embedding-3-small' },
    ],
  },
  {
    id: 'memory',
    title: '记忆',
    fields: [
      { key: 'MEMORY_AUTO_INJECT', label: '自动注入（1/0）', type: 'boolean' },
      { key: 'MEMORY_AUTO_TOPK', label: '自动召回条数', type: 'number', placeholder: '5' },
      { key: 'MEMORY_AUTO_CAPTURE', label: '捕获“记住：”（1/0）', type: 'boolean' },
      { key: 'MEMORY_EXTRACT', label: '对话提取记忆（1/0）', type: 'boolean' },
      { key: 'MEMORY_EMBED_API_KEY', label: 'Embedding API Key', type: 'password' },
      { key: 'MEMORY_EMBED_MODEL', label: 'Embedding 模型', type: 'text', placeholder: 'text-embedding-3-small' },
    ],
  },
  {
    id: 'image',
    title: '图像生成',
    fields: [
      { key: 'IMAGE_API_KEY', label: 'Image API Key', type: 'password' },
      { key: 'IMAGE_BASE_URL', label: 'Image Base URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'IMAGE_MODEL', label: '模型', type: 'text', placeholder: 'gpt-image-1' },
      { key: 'IMAGE_SIZE', label: '尺寸', type: 'text', placeholder: '1024x1024' },
    ],
  },
  {
    id: 'tts',
    title: '语音 TTS',
    fields: [
      { key: 'TTS_API_KEY', label: 'TTS API Key', type: 'password' },
      { key: 'TTS_BASE_URL', label: 'TTS Base URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'TTS_MODEL', label: '模型', type: 'text', placeholder: 'gpt-4o-mini-tts' },
      { key: 'TTS_VOICE', label: '音色', type: 'text', placeholder: 'alloy' },
      { key: 'TTS_FORMAT', label: '格式', type: 'text', placeholder: 'mp3' },
    ],
  },
  {
    id: 'web',
    title: '网页抓取 / 子代理',
    fields: [
      { key: 'FETCH_MAX_CHARS', label: '抓取最大字符', type: 'number', placeholder: '20000' },
      { key: 'FETCH_TIMEOUT_MS', label: '抓取超时(ms)', type: 'number', placeholder: '15000' },
      { key: 'SUBAGENT_TIMEOUT_MS', label: '子代理超时(ms)', type: 'number', placeholder: '120000' },
    ],
  },
];

/** 连接（im-gateway）字段单列，供 ConnectionsPanel 复用同一存储。 */
export const CONNECTION_FIELDS: SettingField[] = [
  { key: 'IM_GATEWAY', label: '启用网关（1/0）', type: 'boolean' },
  { key: 'IM_GATEWAY_PORT', label: '端口', type: 'number', placeholder: '8765' },
  { key: 'IM_GATEWAY_TOKEN', label: 'Token（可选）', type: 'password' },
];
