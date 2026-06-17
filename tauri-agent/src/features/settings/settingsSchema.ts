import { AudioLines, BookOpen, Brain, Cpu, Globe, Image, Palette, Settings2, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type FieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'model' | 'capability';
export type SettingGroup = '核心' | '能力' | '联网' | '扩展与安全';

export const SETTING_GROUPS: SettingGroup[] = ['核心', '能力', '联网', '扩展与安全'];

export interface SelectOption {
  value: string;
  label: string;
}

/** 生效方式：instant=App 后端实时读；hot=扩展运行时读(改完即生效)；restart=需重启 sidecar。省略＝hot。 */
export type SettingEffect = 'instant' | 'hot' | 'restart';

export interface SettingField {
  key: string; // env 名（不变）；capability 类型时此为「供应商」env 名
  label: string;
  type: FieldType;
  description?: string;
  placeholder?: string;
  options?: SelectOption[];
  effect?: SettingEffect; // 省略＝hot
  /** capability 类型：模型 env 名（供应商存 key、模型存 modelKey） */
  modelKey?: string;
  /** capability 类型：能力种类，决定模型建议清单 */
  capability?: 'image' | 'embedding' | 'tts';
}

export interface SettingSection {
  title: string;
  fields: SettingField[];
}

export interface SettingCategory {
  id: string;
  title: string;
  group: SettingGroup;
  icon: LucideIcon;
  fields?: SettingField[];
  sections?: SettingSection[];
}

/** 字段生效方式，省略时默认 hot（扩展运行时读，改完即生效）。 */
export function fieldEffect(field: SettingField): SettingEffect {
  return field.effect ?? 'hot';
}

export const SETTINGS_SCHEMA: SettingCategory[] = [
  {
    id: 'general',
    title: '通用与模型',
    group: '核心',
    icon: Settings2,
    fields: [
      {
        key: 'titleModel',
        label: '对话标题模型',
        type: 'model',
        placeholder: '如 anthropic/claude-haiku',
        description: 'provider/id；留空＝自动选轻量模型',
        effect: 'instant',
      },
    ],
  },
  {
    // 供应商管理：由 SettingsPanel 特判渲染 ProvidersSettings（读写 ~/.pi/agent/models.json + auth.json）。
    id: 'providers',
    title: '供应商',
    group: '核心',
    icon: Cpu,
    fields: [],
  },
  {
    // 外观为前端主题设置（themeStore，非后端 config），由 SettingsPanel 特判渲染 AppearanceSettings。
    id: 'appearance',
    title: '外观',
    group: '核心',
    icon: Palette,
    fields: [],
  },
  {
    id: 'knowledge',
    title: '知识库',
    group: '能力',
    icon: BookOpen,
    fields: [
      { key: 'KB_AUTO_INJECT', label: '自动注入', type: 'boolean', description: '检索到的知识自动注入上下文' },
      { key: 'KB_AUTO_TOPK', label: '自动注入条数', type: 'number', placeholder: '3', description: '每次注入的知识块上限' },
      {
        key: 'KB_EMBED_PROVIDER',
        modelKey: 'KB_EMBED_MODEL',
        capability: 'embedding',
        type: 'capability',
        label: 'Embedding 模型',
        description: '供应商 + 模型；密钥取自供应商库',
      },
    ],
  },
  {
    id: 'memory',
    title: '记忆',
    group: '能力',
    icon: Brain,
    sections: [
      {
        title: '记忆召回',
        fields: [
          {
            key: 'MEMORY_AUTO_INJECT',
            label: '自动注入记忆',
            type: 'boolean',
            description: '每次提问自动召回相关记忆并注入上下文',
          },
          { key: 'MEMORY_AUTO_TOPK', label: '自动召回条数', type: 'number', placeholder: '5', description: '每次注入的记忆条数上限' },
          {
            key: 'MEMORY_AUTO_CAPTURE',
            label: '捕获“记住”指令',
            type: 'boolean',
            description: '用户说“记住：…”时自动保存',
          },
          {
            key: 'MEMORY_EMBED_PROVIDER',
            modelKey: 'MEMORY_EMBED_MODEL',
            capability: 'embedding',
            type: 'capability',
            label: '记忆 Embedding 模型',
            description: '供应商 + 模型；留空则降级关键词召回',
          },
        ],
      },
      {
        title: '记忆维护',
        fields: [
          {
            key: 'MEMORY_SMART',
            label: '智能合并',
            type: 'boolean',
            description: '由 LLM 决策新增/更新/删除，自动消解重复与矛盾',
          },
          {
            key: 'MEMORY_MODEL',
            label: '记忆模型',
            type: 'model',
            placeholder: '如 openai/gpt-4o-mini',
            description: '智能合并/提取所用模型；留空＝继承当前对话模型',
          },
          {
            key: 'MEMORY_EXTRACT',
            label: '对话提取记忆',
            type: 'boolean',
            description: '每轮对话后抽取要点入库（会多一次 LLM 调用，默认关）',
          },
          { key: 'MEMORY_SMART_NOTICE', label: '合并时提示', type: 'boolean', description: '记忆被更新或删除时在对话里提示' },
        ],
      },
    ],
  },
  {
    id: 'image',
    title: '图像生成',
    group: '能力',
    icon: Image,
    fields: [
      {
        key: 'IMAGE_PROVIDER',
        modelKey: 'IMAGE_MODEL',
        capability: 'image',
        type: 'capability',
        label: '图像模型',
        description: '供应商 + 模型；密钥取自供应商库',
      },
      { key: 'IMAGE_SIZE', label: '尺寸', type: 'text', placeholder: '1024x1024' },
    ],
  },
  {
    id: 'tts',
    title: '语音 TTS',
    group: '能力',
    icon: AudioLines,
    fields: [
      {
        key: 'TTS_PROVIDER',
        modelKey: 'TTS_MODEL',
        capability: 'tts',
        type: 'capability',
        label: '语音模型',
        description: '供应商 + 模型；密钥取自供应商库',
      },
      { key: 'TTS_VOICE', label: '音色', type: 'text', placeholder: 'alloy' },
      { key: 'TTS_FORMAT', label: '格式', type: 'text', placeholder: 'mp3' },
    ],
  },
  {
    id: 'web',
    title: '网页 / 搜索 / 子代理',
    group: '联网',
    icon: Globe,
    sections: [
      {
        title: '网页抓取',
        fields: [
          { key: 'FETCH_MAX_CHARS', label: '抓取最大字符', type: 'number', placeholder: '20000' },
          { key: 'FETCH_TIMEOUT_MS', label: '抓取超时(ms)', type: 'number', placeholder: '15000' },
        ],
      },
      {
        title: '搜索',
        fields: [
          {
            key: 'WEB_SEARCH_PROVIDER',
            label: '搜索引擎',
            type: 'text',
            placeholder: 'bing',
            description: '留空且无 key 时自动 bing；失败按引擎链回退',
          },
          {
            key: 'WEB_SEARCH_ENGINES',
            label: '搜索引擎链',
            type: 'text',
            placeholder: 'bing,sogou,baidu',
            description: '逗号分隔，如 bing,sogou,baidu,csdn,juejin',
          },
          { key: 'TAVILY_API_KEY', label: 'Tavily API Key', type: 'password', placeholder: 'tvly-...' },
          { key: 'BRAVE_API_KEY', label: 'Brave Search API Key', type: 'password' },
        ],
      },
      {
        title: '子代理',
        fields: [
          { key: 'SUBAGENT_TIMEOUT_MS', label: '子代理超时(ms)', type: 'number', placeholder: '120000' },
          {
            key: 'SUBAGENT_STUCK_MS',
            label: '子代理卡死阈值(ms)',
            type: 'number',
            placeholder: '300000',
            description: '后台子代理无活动超过此时长判为卡死并自动终止',
          },
          {
            key: 'SUBAGENT_MODEL',
            label: '子代理模型',
            type: 'model',
            placeholder: '如 deepseek/deepseek-chat',
            description: '留空＝继承主代理默认',
          },
          {
            key: 'SUBAGENT_MODEL_CHEAP',
            label: '子代理便宜模型（档案别名 cheap）',
            type: 'model',
            placeholder: '如 deepseek/deepseek-chat',
            description: '能力档案 model:"cheap" 解析到此；留空回退「子代理模型」',
          },
          {
            key: 'SUBAGENT_MODEL_STRONG',
            label: '子代理强模型（档案别名 strong）',
            type: 'model',
            placeholder: '如 openai/gpt-4o',
            description: '能力档案 model:"strong" 解析到此；留空回退「子代理模型」',
          },
          { key: 'PI_BIN', label: '子代理可执行文件', type: 'text', description: '留空＝复用本体 sidecar' },
        ],
      },
    ],
  },
  {
    id: 'safety',
    title: '安全',
    group: '扩展与安全',
    icon: ShieldCheck,
    fields: [
      { key: 'SAFETY_BASH_CONFIRM', label: '危险命令前确认', type: 'boolean', description: '执行危险 bash 命令前弹确认（默认开）' },
      {
        key: 'SAFETY_PROTECT_PATHS',
        label: '保护敏感路径',
        type: 'boolean',
        description: '阻断写 .env/.git/node_modules/密钥（默认开）',
      },
    ],
  },
];

/** 连接（im-gateway）字段单列，供 ConnectionsPanel 复用同一存储。 */
export const CONNECTION_FIELDS: SettingField[] = [
  { key: 'IM_GATEWAY', label: '启用网关', type: 'boolean', description: '开启后可经 im-gateway 接入外部 IM' },
  { key: 'IM_GATEWAY_PORT', label: '端口', type: 'number', placeholder: '8765' },
  { key: 'IM_GATEWAY_TOKEN', label: 'Token（可选）', type: 'password' },
];
