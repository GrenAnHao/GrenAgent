import { AudioLines, Bot, Cpu, Database, Globe, Image, Palette, Settings2, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { parseRepeatGuardConfig } from '@extensions/loop-guard/chain';

export type FieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'model' | 'capability' | 'model-list' | 'slider';
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
  default?: string;
  /** boolean 落盘格式：one-zero＝'1'/'0'（默认）；true-empty＝'true'/''（扩展侧仅认小写 true）。 */
  storeBoolean?: 'one-zero' | 'true-empty';
  /** number 类型的下限。 */
  min?: number;
  /** number 类型的上限。 */
  max?: number;
  /** 保存前校验。返回错误文案则拒绝落盘；空字符串表示这一项合法。 */
  validate?: (value: string) => string | undefined;
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

function guardConfigError(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validateLoopGuardThresholds(value: string): string | undefined {
  return guardConfigError(() => {
    parseRepeatGuardConfig({ thresholds: value });
  });
}

function validateLoopGuardPreview(value: string): string | undefined {
  return guardConfigError(() => {
    parseRepeatGuardConfig({ argumentsPreviewChars: value });
  });
}

function validateBoundedInt(min: number, max: number): (value: string) => string | undefined {
  return (value: string) => {
    const raw = value.trim();
    if (!raw) return undefined;
    if (!/^\d+$/.test(raw)) return `须为 ${min} 到 ${max} 的整数`;
    const n = Number(raw);
    if (n < min || n > max) return `须为 ${min} 到 ${max} 的整数`;
    return undefined;
  };
}

function validateWikiIngestMode(value: string): string | undefined {
  const raw = value.trim();
  if (!raw || raw === 'two-stage' || raw === 'single-stage') return undefined;
  return '抽取模式只能是两段式或单段式';
}

export function allSettingFields(categories: SettingCategory[] = SETTINGS_SCHEMA): SettingField[] {
  return categories.flatMap((category) => [...(category.fields ?? []), ...(category.sections ?? []).flatMap((section) => section.fields)]);
}

/** 保存前跑每个字段的 validate。返回第一条错误文案。 */
export function validateSettingValues(values: Record<string, string>): string | undefined {
  for (const field of allSettingFields()) {
    const message = field.validate?.(values[field.key] ?? '');
    if (message) return message;
  }
  return undefined;
}

export const SETTINGS_SCHEMA: SettingCategory[] = [
  {
    id: 'general',
    title: '通用与模型',
    group: '核心',
    icon: Settings2,
    fields: [
      {
        key: 'defaultSessionModel',
        label: '新会话默认模型',
        type: 'model',
        placeholder: '如 anthropic/claude-sonnet',
        description: '进入空白草稿时使用；留空＝上次选过的，没有再用列表第一项',
        effect: 'instant',
      },
      {
        key: 'titleModel',
        label: '对话标题模型',
        type: 'model',
        placeholder: '如 anthropic/claude-haiku',
        description: 'provider/id；留空＝自动选轻量模型',
        effect: 'instant',
      },
      {
        key: 'enhancePromptModel',
        label: '增强提示词模型',
        type: 'model',
        placeholder: '留空＝当前会话模型',
        description: '输入框「增强提示词」使用的模型；留空＝当前会话模型',
        effect: 'instant',
      },
      {
        key: 'enhancePromptUseProjectContext',
        label: '增强提示词结合项目（实验）',
        type: 'boolean',
        default: '0',
        description: '打开后允许查阅会话目标、wiki/记忆和代码图；更慢，且依赖索引。默认关',
      },
      {
        key: 'AUTO_COMPACT_PERCENT',
        label: '自动压缩触发值',
        type: 'slider',
        min: 5,
        max: 90,
        default: '80',
        description: '上下文占用达到这个百分比时自动压缩。未填写按 80。单个会话可在上下文面板里单独设置，范围 5 到 90。',
        validate: validateBoundedInt(5, 90),
      },
      {
        key: 'AUTO_TITLE',
        label: '自动生成对话标题',
        type: 'boolean',
        default: '1',
        description: '关闭后侧栏用首条消息作标题（默认开）',
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
            description: '留空且无 key 时自动 bing。填 devin 时先走 Devin，失败再回退 Bing、搜狗、百度。登录不会自动刷新。',
          },
          {
            key: 'WEB_SEARCH_ENGINES',
            label: '搜索引擎链',
            type: 'text',
            placeholder: 'bing,sogou,baidu',
            description: '逗号分隔，如 devin,bing,sogou,baidu。留空且已登录 Devin 时，默认先试 devin 再回退 Bing 链。',
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
          {
            key: 'SUBAGENT_BACKEND',
            label: '子代理运行位置',
            type: 'select',
            placeholder: '进程内（默认）',
            description:
              '进程内：和主 agent 共用 agent-host 进程，启动快、省内存。独立 worker 进程：每个子代理一个进程，死循环、内存耗尽、原生模块崩溃不连累主 agent，启动慢、内存高。两种都能续聊和 fork；命名角色的 backend 字段优先于这里。',
            options: [
              { value: 'in-process', label: '进程内' },
              { value: 'worker', label: '独立 worker 进程' },
            ],
          },
          {
            key: 'SUBAGENT_MAX_WORKERS',
            label: 'worker 进程上限',
            type: 'number',
            default: '2',
            placeholder: '2',
            description: '同时运行的子代理 worker 进程数；超出的子代理排队，等有进程结束再起。只对走 worker 的子代理生效。',
            validate: validateBoundedInt(1, 16),
          },
          {
            key: 'SUBAGENT_MAX_ACTIVE',
            label: '同时运行的子代理上限',
            type: 'number',
            default: '8',
            placeholder: '8',
            description: '所有会话加起来同时在跑的子代理数（进程内和 worker 都算）；超出的排队。子代理再派的孙代理只计数不排队，避免互相等名额卡死。',
            validate: validateBoundedInt(1, 64),
          },
          {
            key: 'SUBAGENT_MAX_RESIDENT',
            label: '空闲子代理驻留数',
            type: 'number',
            default: '8',
            placeholder: '8',
            description: '进程内的可续聊子代理结束后先不释放，续聊时不用重新加载；超过这个数按最久未用释放。设 0 关闭驻留，每次续聊都从会话日志恢复。',
            validate: validateBoundedInt(0, 64),
          },
          {
            key: 'SUBAGENT_APPROVAL_TIMEOUT_MS',
            label: '子代理审批等待（毫秒）',
            type: 'number',
            default: '60000',
            placeholder: '60000',
            description: '子代理要做需要批准的操作时，请求出现在派它的会话的输入框上方，最多等这么久，没人批准按拒绝处理。设 0 不转发，子代理需要批准的操作一律自动拒绝。',
            validate: validateBoundedInt(0, 600000),
          },
          {
            key: 'SUBAGENT_MAX_DEPTH',
            label: '委派深度上限',
            type: 'number',
            default: '2',
            placeholder: '2',
            description: '顶层为 0，子代理为 1，孙代理为 2。设为 1 即禁止子代理再委派',
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
            description: '连续没有任何动静超过此值才判卡死并终止；每段输出都会重置计时。工具在跑、等模型回复时不计，分别由工具自己的超时和下面的上游卡住判定处理',
          },
          {
            key: 'SUBAGENT_STREAM_STALL_MS',
            label: '上游卡住判定(ms)',
            type: 'number',
            min: 10000,
            max: 3600000,
            placeholder: '120000',
            description:
              '模型开始输出后，两段输出之间安静超过此值，就在本地中断这次请求并自动续跑。留空＝120000。模型会在输出中途长时间不推送内容时调大',
            validate: validateBoundedInt(10000, 3600000),
          },
          {
            key: 'SUBAGENT_FIRST_TOKEN_MS',
            label: '首段输出等待(ms)',
            type: 'number',
            min: 10000,
            max: 3600000,
            placeholder: '同空闲超时',
            description:
              '请求发出后等第一段输出的最长时间，超过就中断这次请求并自动续跑。留空＝与空闲超时相同。用不推送思考过程的长思考模型时调大',
            validate: validateBoundedInt(10000, 3600000),
          },
          {
            key: 'SUBAGENT_STALL_RETRIES',
            label: '卡住后自动续跑次数',
            type: 'number',
            min: 0,
            max: 10,
            placeholder: '2',
            description: '上游卡住时最多自动续跑几次，用完还卡就按空闲超时结束。留空＝2，0＝不续跑',
            validate: validateBoundedInt(0, 10),
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
          {
            key: 'SUBAGENT_MODEL_SELECTION',
            label: '允许模型为子代理自选路由',
            type: 'boolean',
            description: '开启后 spawn_agent 可显式指定模型，只能选下方白名单，以及上面配的 cheap / strong 别名；开关本身对之后新建的会话生效，白名单增删对已打开的会话也立即生效',
          },
          {
            key: 'SUBAGENT_MODEL_ALLOWLIST',
            label: '可自选的路由白名单',
            type: 'model-list',
            description: '至少勾一条才算开启；cheap / strong 对应的模型不用在这里重复勾；不在当前目录里的条目会标「不可用」，可手动移除',
            showWhen: { key: 'SUBAGENT_MODEL_SELECTION', equals: ['1'] },
          },
        ],
      },
    ],
  },
  {
    id: 'agentData',
    title: 'AgentData',
    group: '能力',
    icon: Database,
    sections: [
      {
        title: '记忆',
        fields: [
          {
            key: 'MEMORY_AUTO_INJECT',
            label: '自动注入记忆',
            type: 'boolean',
            default: '1',
            description: '对话开始时把相关记忆放进上下文。默认开。',
          },
          {
            key: 'MEMORY_AUTO_CAPTURE',
            label: '自动捕获对话',
            type: 'boolean',
            default: '1',
            description: '对话结束后保存原文。默认开。',
          },
          {
            key: 'MEMORY_EXTRACT',
            label: '对话后提炼记忆',
            type: 'boolean',
            default: '1',
            description: '在捕获之上调用模型生成记忆。关闭后仍保存原文，只是不提炼。默认开。',
          },
        ],
      },
      {
        title: '模型',
        fields: [
          {
            key: 'agentDataModel',
            label: 'AgentData 模型',
            type: 'model',
            effect: 'instant',
            placeholder: '留空＝应用默认模型',
            description: '记忆提炼与 Wiki 抽取共用。留空＝应用默认模型。',
          },
        ],
      },
      {
        title: 'Wiki 抽取',
        fields: [
          {
            key: 'KNOWLEDGE_WIKI_INGEST_MODE',
            label: '抽取模式',
            type: 'select',
            effect: 'instant',
            default: 'two-stage',
            description: '两段式先分析再生成。单段式少一次模型调用。默认两段式。',
            options: [
              { value: 'two-stage', label: '两段式' },
              { value: 'single-stage', label: '单段式' },
            ],
            validate: validateWikiIngestMode,
          },
          {
            key: 'KNOWLEDGE_WIKI_INGEST_CONCURRENCY',
            label: '抽取并发',
            type: 'number',
            effect: 'instant',
            min: 1,
            max: 10,
            placeholder: '3',
            description: '单个知识库抽取阶段的并行数。留空＝3，范围 1 到 10。',
            validate: validateBoundedInt(1, 10),
          },
          {
            key: 'KNOWLEDGE_LLM_GLOBAL_CONCURRENCY',
            label: '模型并发',
            type: 'number',
            effect: 'instant',
            min: 1,
            max: 20,
            placeholder: '5',
            description: '抽取与合并共用的模型调用并行上限。留空＝5，范围 1 到 20。下一次抽取生效。',
            validate: validateBoundedInt(1, 20),
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
    sections: [
      {
        title: '工具安全',
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
      {
        title: '循环保护',
        fields: [
          {
            key: 'LOOP_GUARD',
            label: '重复调用提醒',
            type: 'boolean',
            default: '1',
            description: '同一工具、相同参数连续重复时，在该次结果后追加提醒，不拦截调用。默认开。保存后下一次工具调用即生效',
          },
          {
            key: 'LOOP_GUARD_THRESHOLDS',
            label: '提醒次数',
            type: 'text',
            placeholder: '3,5,8',
            description: '逗号分隔，每一项是 >= 2 的整数且不能重复。第一次到档是轻提醒，其后是详细提醒。留空＝3,5,8',
            validate: validateLoopGuardThresholds,
          },
          {
            key: 'LOOP_GUARD_INCLUDE',
            label: '只跟踪这些工具',
            type: 'text',
            placeholder: '留空＝全部',
            description: '逗号分隔，支持 * 通配，如 grep,mcp_*。留空＝跟踪全部工具',
          },
          {
            key: 'LOOP_GUARD_EXCLUDE',
            label: '不跟踪这些工具',
            type: 'text',
            placeholder: '如 todo*',
            description: '逗号分隔，支持 * 通配。这些调用不计数，也不打断前后相同调用的连续次数',
          },
          {
            key: 'LOOP_GUARD_ARGUMENTS_PREVIEW',
            label: '参数预览字数',
            type: 'number',
            min: 1,
            placeholder: '500',
            description: '详细提醒里引用的参数最多多少字。留空＝500。是否算同一次调用仍比较完整参数',
            validate: validateLoopGuardPreview,
          },
        ],
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
