import { AudioLines, Bot, Cpu, Globe, Image, Palette, Settings2, ShieldCheck } from 'lucide-react';
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
  /** 条件显示：仅当同页另一字段(key)的当前值在 equals 内时才渲染（如模型选择仅在策略=选定时显示）。 */
  showWhen?: { key: string; equals: string[] };
  /** boolean 类型未落盘（值为空）时的默认显示态：'1'＝默认开。须与扩展侧 getConfig(...) ?? 默认 对齐，
   *  否则会出现「扩展默认开、面板却显示关」的错配。省略＝默认关（空值显示为关，沿用旧约定）。 */
  default?: '0' | '1';
  /** boolean 落盘格式：one-zero＝'1'/'0'（默认）；true-empty＝'true'/''（扩展侧仅认小写 true）。 */
  storeBoolean?: 'one-zero' | 'true-empty';
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
      {
        key: 'AUTO_TITLE',
        label: '自动生成对话标题',
        type: 'boolean',
        default: '1',
        description: '首轮对话结束后生成简短标题（默认开）',
      },
      {
        key: 'COMPACTION_PREVIEW',
        label: '压缩上下文前确认',
        type: 'boolean',
        default: '1',
        description:
          '上下文将满需压缩时先弹确认，可拒绝本次压缩（默认开）。压缩会把靠前的对话压成摘要，关闭则自动压缩、不打扰。',
      },
      {
        key: 'goal.autoContinueOnOpen',
        label: 'Goal 重开后自动继续',
        type: 'boolean',
        default: '0',
        description: '打开后，重启或打开已有进行中目标的会话时自动武装并续跑。默认关。仅写入 true 生效。',
        storeBoolean: 'true-empty',
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
    title: '网页 / 搜索',
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
    ],
  },
  {
    id: 'subagent',
    title: '子代理',
    group: '能力',
    icon: Bot,
    sections: [
      {
        title: '并发与上限',
        fields: [
          {
            key: 'SUBAGENT_MAX_PER_SESSION',
            label: '单会话最大子代理数',
            type: 'number',
            placeholder: '6',
            description: '一次对话累计可启动的子代理上限；默认 6，设 0＝不限。达到后主代理再 spawn 会被拒绝，可开新对话重置。',
          },
        ],
      },
      {
        title: '超时与回收',
        fields: [
          {
            key: 'SUBAGENT_TIMEOUT_MS',
            label: '子代理空闲超时(ms)',
            type: 'number',
            placeholder: '300000',
            description: '连续无输出超过此值才判卡死并终止；每段输出都会重置计时',
          },
          {
            key: 'SUBAGENT_STUCK_MS',
            label: '子代理卡死阈值(ms)',
            type: 'number',
            placeholder: '300000',
            description: '后台子代理无活动超过此时长判为卡死并自动终止',
          },
        ],
      },
      {
        title: '模型策略',
        fields: [
          {
            key: 'SUBAGENT_MODE',
            label: '子代理模型策略',
            type: 'select',
            placeholder: '继承父模型（默认）',
            description: '禁用子代理＝主代理不再 spawn；继承父模型＝子代理用主对话模型；选定模型＝用下方指定',
            options: [
              { value: 'inherit', label: '继承父模型' },
              { value: 'custom', label: '选定模型' },
              { value: 'disabled', label: '禁用子代理' },
            ],
          },
          {
            key: 'SUBAGENT_MODEL',
            label: '子代理模型',
            type: 'model',
            placeholder: '如 deepseek/deepseek-chat',
            description: '策略＝选定模型时生效，作为子代理默认模型（spawn 调用里显式指定的优先）',
            showWhen: { key: 'SUBAGENT_MODE', equals: ['custom', ''] },
          },
          {
            key: 'SUBAGENT_MODEL_CHEAP',
            label: '子代理便宜模型（档案别名 cheap）',
            type: 'model',
            placeholder: '如 deepseek/deepseek-chat',
            description: '能力档案 model:"cheap" 解析到此；留空回退「子代理模型」',
            showWhen: { key: 'SUBAGENT_MODE', equals: ['custom', ''] },
          },
          {
            key: 'SUBAGENT_MODEL_STRONG',
            label: '子代理强模型（档案别名 strong）',
            type: 'model',
            placeholder: '如 openai/gpt-4o',
            description: '能力档案 model:"strong" 解析到此；留空回退「子代理模型」',
            showWhen: { key: 'SUBAGENT_MODE', equals: ['custom', ''] },
          },
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

/** 微信（ilink/clawbot 官方 AI bot）接入字段。扫码登录 + 长轮询，无需公网/端口。
 *  连接在 sidecar 启动时建立，改动需「保存并重启」生效（restart 类）。 */
export const WECHAT_FIELDS: SettingField[] = [
  { key: 'WECHAT_OC_ENABLE', label: '启用微信(ilink 官方 bot)', type: 'boolean', description: '微信智能对话开放接口；扫码登录、长轮询收发，无需公网', effect: 'restart' },
  { key: 'WECHAT_OC_TOKEN', label: 'bot_token（留空则扫码登录）', type: 'password', description: '已有 token 可直接填；留空则启动后在通知中给出扫码链接', effect: 'restart' },
  { key: 'WECHAT_OC_OWNER', label: '主人 ilink_user_id（留空不限）', type: 'text', effect: 'restart' },
  { key: 'WECHAT_OC_BOT_TYPE', label: 'bot_type（默认 3）', type: 'text', placeholder: '3', effect: 'restart' },
  { key: 'WECHAT_OC_BASE_URL', label: 'API 基址（默认官方）', type: 'text', placeholder: 'https://ilinkai.weixin.qq.com', effect: 'restart' },
];

/** 通用 IM 网关（HTTP webhook，供 Slack / 飞书 / Telegram 等通过薄适配器转发）。 */
export const GATEWAY_FIELDS: SettingField[] = [
  { key: 'IM_GATEWAY', label: '启用网关', type: 'boolean', description: '开启后可经 im-gateway 接入外部 IM', effect: 'restart' },
  { key: 'IM_GATEWAY_PORT', label: '网关端口', type: 'number', placeholder: '8765', effect: 'restart' },
  { key: 'IM_GATEWAY_TOKEN', label: '网关 Token（可选）', type: 'password', effect: 'restart' },
];
