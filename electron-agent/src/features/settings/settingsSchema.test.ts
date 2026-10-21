import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, validateSettingValues } from './settingsSchema';
import { NOTIFY_SETTING_DEFAULTS, type NotifySettingKey } from '../../../electron/app/attentionContract';

describe('SETTINGS_SCHEMA notifications', () => {
  it('核心组在外观之后有「通知」分类，六个开关的默认值与主进程一致', () => {
    const ids = SETTINGS_SCHEMA.filter((c) => c.group === '核心').map((c) => c.id);
    expect(ids.indexOf('notifications')).toBe(ids.indexOf('appearance') + 1);
    const category = SETTINGS_SCHEMA.find((c) => c.id === 'notifications')!;
    expect(category.title).toBe('通知');
    const fields = category.fields!;
    expect(fields.map((f) => [f.key, f.label, f.type, f.default, f.effect])).toEqual([
      ['notify.done', '会话完成', 'boolean', '0', 'instant'],
      ['notify.choice', '需要选择或批准', 'boolean', '1', 'instant'],
      ['notify.blocked', '任务受阻', 'boolean', '1', 'instant'],
      ['notify.failed', '失败', 'boolean', '1', 'instant'],
      ['notify.sound', '提示音', 'boolean', '1', 'instant'],
      ['notify.taskbar', '任务栏闪烁与待处理数', 'boolean', '1', 'instant'],
    ]);
    for (const f of fields) expect(f.default).toBe(NOTIFY_SETTING_DEFAULTS[f.key as NotifySettingKey]);
  });
});

describe('SETTINGS_SCHEMA general', () => {
  it('在标题模型后提供默认开启的自动标题开关', () => {
    const fields = SETTINGS_SCHEMA.find((category) => category.id === 'general')?.fields ?? [];
    const autoTitle = fields.find((field) => field.key === 'AUTO_TITLE');

    expect(autoTitle).toMatchObject({
      label: '自动生成对话标题',
      type: 'boolean',
      default: '1',
      description: '关闭后侧栏用首条消息作标题（默认开）',
    });
    expect(fields.map((field) => field.key)).toEqual([
      'defaultSessionModel',
      'titleModel',
      'enhancePromptModel',
      'enhancePromptUseProjectContext',
      'AUTO_COMPACT_PERCENT',
      'AUTO_TITLE',
      'goal.autoContinueOnOpen',
    ]);
  });

  it('在增强提示词之后提供自动压缩触发值，范围 5 到 90，留空按 80', () => {
    const fields = SETTINGS_SCHEMA.find((category) => category.id === 'general')?.fields ?? [];
    expect(fields.find((field) => field.key === 'AUTO_COMPACT_PERCENT')).toMatchObject({
      label: '自动压缩触发值',
      type: 'slider',
      min: 5,
      max: 90,
      default: '80',
    });
    expect(validateSettingValues({})).toBeUndefined();
    expect(validateSettingValues({ AUTO_COMPACT_PERCENT: '' })).toBeUndefined();
    expect(validateSettingValues({ AUTO_COMPACT_PERCENT: '5' })).toBeUndefined();
    expect(validateSettingValues({ AUTO_COMPACT_PERCENT: '90' })).toBeUndefined();
    expect(validateSettingValues({ AUTO_COMPACT_PERCENT: '4' })).toMatch(/5 到 90/);
    expect(validateSettingValues({ AUTO_COMPACT_PERCENT: '91' })).toMatch(/5 到 90/);
    expect(validateSettingValues({ AUTO_COMPACT_PERCENT: '80.5' })).toMatch(/5 到 90/);
  });

  it('在标题模型后提供增强提示词模型与实验开关', () => {
    const fields = SETTINGS_SCHEMA.find((category) => category.id === 'general')?.fields ?? [];
    expect(fields.find((field) => field.key === 'enhancePromptModel')).toMatchObject({
      label: '增强提示词模型',
      type: 'model',
      placeholder: '留空＝当前会话模型',
      description: '输入框「增强提示词」使用的模型；留空＝当前会话模型',
      effect: 'instant',
    });
    expect(fields.find((field) => field.key === 'enhancePromptUseProjectContext')).toMatchObject({
      label: '增强提示词结合项目（实验）',
      type: 'boolean',
      default: '0',
      description: '打开后允许查阅会话目标、wiki/记忆和代码图；更慢，且依赖索引。默认关',
    });
  });

  it('把新会话默认模型放在通用与模型的第一项', () => {
    const fields = SETTINGS_SCHEMA.find((category) => category.id === 'general')?.fields ?? [];
    expect(fields[0]).toMatchObject({
      key: 'defaultSessionModel',
      label: '新会话默认模型',
      type: 'model',
      placeholder: '如 anthropic/claude-sonnet',
      description: '进入空白草稿时使用；留空＝上次选过的，没有再用列表第一项',
      effect: 'instant',
    });
  });

  it('提供 Goal 重开后自动继续开关（true-empty 存储）', () => {
    const fields = SETTINGS_SCHEMA.find((category) => category.id === 'general')?.fields ?? [];
    const goalAutoContinue = fields.find((field) => field.key === 'goal.autoContinueOnOpen');

    expect(goalAutoContinue).toMatchObject({
      key: 'goal.autoContinueOnOpen',
      label: 'Goal 重开后自动继续',
      type: 'boolean',
      default: '0',
      description: '打开后，重启或打开已有进行中目标的会话时自动武装并续跑。默认关。仅写入 true 生效。',
      storeBoolean: 'true-empty',
    });
  });
});

describe('subagent model selection keys', () => {
  const all = () => SETTINGS_SCHEMA.flatMap((c) => [...(c.fields ?? []), ...(c.sections ?? []).flatMap((s) => s.fields)]);
  it('has the switch and the allowlist, the latter shown only when the switch is 1', () => {
    const sw = all().find((f) => f.key === 'SUBAGENT_MODEL_SELECTION');
    const list = all().find((f) => f.key === 'SUBAGENT_MODEL_ALLOWLIST');
    expect(sw?.type).toBe('boolean');
    expect(list?.type).toBe('model-list');
    expect(list?.showWhen).toEqual({ key: 'SUBAGENT_MODEL_SELECTION', equals: ['1'] });
  });
});

describe('loop guard settings', () => {
  const fields = () => SETTINGS_SCHEMA.find((category) => category.id === 'safety')?.sections?.find((section) => section.title === '循环保护')?.fields ?? [];

  it('把循环保护放在安全页，开关默认开，次数与预览留空走扩展默认', () => {
    expect(fields().map((field) => field.key)).toEqual([
      'LOOP_GUARD',
      'LOOP_GUARD_THRESHOLDS',
      'LOOP_GUARD_INCLUDE',
      'LOOP_GUARD_EXCLUDE',
      'LOOP_GUARD_ARGUMENTS_PREVIEW',
    ]);
    expect(fields().find((field) => field.key === 'LOOP_GUARD')).toMatchObject({ type: 'boolean', default: '1' });
    expect(fields().find((field) => field.key === 'LOOP_GUARD_THRESHOLDS')?.placeholder).toBe('3,5,8');
    expect(fields().find((field) => field.key === 'LOOP_GUARD_ARGUMENTS_PREVIEW')).toMatchObject({ type: 'number', min: 1, placeholder: '500' });
  });

  it('留空可通过，非法次数在保存前被拒绝', () => {
    expect(validateSettingValues({})).toBeUndefined();
    expect(validateSettingValues({ LOOP_GUARD_THRESHOLDS: '8,3,5' })).toBeUndefined();
    expect(validateSettingValues({ LOOP_GUARD_THRESHOLDS: '1,3' })).toMatch(/>= 2/);
    expect(validateSettingValues({ LOOP_GUARD_THRESHOLDS: '3,3' })).toMatch(/重复/);
    expect(validateSettingValues({ LOOP_GUARD_ARGUMENTS_PREVIEW: '0' })).toMatch(/>= 1/);
    expect(validateSettingValues({ LOOP_GUARD_THRESHOLDS: ',' })).toMatch(/不能为空/);
  });
});

describe('subagent stall settings', () => {
  const fields = () =>
    SETTINGS_SCHEMA.find((category) => category.id === 'subagent')?.sections?.find((section) => section.title === '超时与回收')?.fields ?? [];

  it('在超时与回收里紧跟空闲超时提供上游卡住的三项，留空走扩展默认', () => {
    expect(fields().map((field) => field.key)).toEqual([
      'SUBAGENT_TIMEOUT_MS',
      'SUBAGENT_STREAM_STALL_MS',
      'SUBAGENT_FIRST_TOKEN_MS',
      'SUBAGENT_STALL_RETRIES',
      'SUBAGENT_STUCK_MS',
    ]);
    expect(fields().find((field) => field.key === 'SUBAGENT_STREAM_STALL_MS')).toMatchObject({
      type: 'number',
      min: 10000,
      placeholder: '120000',
    });
    expect(fields().find((field) => field.key === 'SUBAGENT_FIRST_TOKEN_MS')).toMatchObject({
      type: 'number',
      min: 10000,
      placeholder: '同空闲超时',
    });
    expect(fields().find((field) => field.key === 'SUBAGENT_STALL_RETRIES')).toMatchObject({
      type: 'number',
      min: 0,
      max: 10,
      placeholder: '2',
    });
  });

  it('续跑次数允许 0，判定时长太短或非整数在保存前拒绝', () => {
    expect(validateSettingValues({ SUBAGENT_STALL_RETRIES: '0', SUBAGENT_STREAM_STALL_MS: '', SUBAGENT_FIRST_TOKEN_MS: '' })).toBeUndefined();
    expect(validateSettingValues({ SUBAGENT_STREAM_STALL_MS: '180000', SUBAGENT_FIRST_TOKEN_MS: '600000' })).toBeUndefined();
    expect(validateSettingValues({ SUBAGENT_STREAM_STALL_MS: '5000' })).toMatch(/10000 到 3600000/);
    expect(validateSettingValues({ SUBAGENT_FIRST_TOKEN_MS: '1.5' })).toMatch(/10000 到 3600000/);
    expect(validateSettingValues({ SUBAGENT_STALL_RETRIES: '11' })).toMatch(/0 到 10/);
  });
});

describe('subagent max depth', () => {
  it('exposes SUBAGENT_MAX_DEPTH as a number with default 2', () => {
    const all = SETTINGS_SCHEMA.flatMap((c) => [...(c.fields ?? []), ...(c.sections ?? []).flatMap((s) => s.fields)]);
    expect(all.find((f) => f.key === 'SUBAGENT_MAX_DEPTH')).toMatchObject({ type: 'number', default: '2' });
  });
});

describe('AgentData settings', () => {
  const category = () => SETTINGS_SCHEMA.find((item) => item.id === 'agentData');
  const fields = () => category()?.sections?.flatMap((section) => section.fields) ?? [];

  it('在能力分组提供记忆开关、模型和 Wiki 抽取设置', () => {
    expect(category()).toMatchObject({ title: 'AgentData', group: '能力' });
    expect(category()?.sections?.map((section) => section.title)).toEqual(['记忆', '模型', 'Wiki 抽取']);
    expect(fields().map((field) => field.key)).toEqual([
      'MEMORY_AUTO_INJECT',
      'MEMORY_AUTO_CAPTURE',
      'MEMORY_EXTRACT',
      'agentDataModel',
      'KNOWLEDGE_WIKI_INGEST_MODE',
      'KNOWLEDGE_WIKI_INGEST_CONCURRENCY',
      'KNOWLEDGE_LLM_GLOBAL_CONCURRENCY',
    ]);
  });

  it('记忆开关默认开，模型留空走应用默认模型', () => {
    expect(fields().find((field) => field.key === 'MEMORY_AUTO_INJECT')).toMatchObject({
      type: 'boolean',
      default: '1',
      label: '自动注入记忆',
    });
    expect(fields().find((field) => field.key === 'MEMORY_AUTO_CAPTURE')).toMatchObject({ type: 'boolean', default: '1' });
    expect(fields().find((field) => field.key === 'MEMORY_EXTRACT')).toMatchObject({
      type: 'boolean',
      default: '1',
      description: expect.stringContaining('仍保存原文'),
    });
    expect(fields().find((field) => field.key === 'agentDataModel')).toMatchObject({
      type: 'model',
      effect: 'instant',
      description: expect.stringContaining('留空'),
    });
  });

  it('抽取模式默认两段式，并发留空合法、越界在保存前拒绝', () => {
    expect(fields().find((field) => field.key === 'KNOWLEDGE_WIKI_INGEST_MODE')).toMatchObject({
      type: 'select',
      default: 'two-stage',
      effect: 'instant',
      options: [
        { value: 'two-stage', label: '两段式' },
        { value: 'single-stage', label: '单段式' },
      ],
    });
    expect(fields().find((field) => field.key === 'KNOWLEDGE_WIKI_INGEST_CONCURRENCY')).toMatchObject({
      type: 'number',
      min: 1,
      max: 10,
      placeholder: '3',
      effect: 'instant',
    });
    expect(fields().find((field) => field.key === 'KNOWLEDGE_LLM_GLOBAL_CONCURRENCY')).toMatchObject({
      type: 'number',
      min: 1,
      max: 20,
      placeholder: '5',
      effect: 'instant',
    });
    expect(validateSettingValues({})).toBeUndefined();
    expect(validateSettingValues({ KNOWLEDGE_WIKI_INGEST_CONCURRENCY: '10', KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '1' })).toBeUndefined();
    expect(validateSettingValues({ KNOWLEDGE_WIKI_INGEST_CONCURRENCY: '0' })).toMatch(/1 到 10/);
    expect(validateSettingValues({ KNOWLEDGE_WIKI_INGEST_CONCURRENCY: '11' })).toMatch(/1 到 10/);
    expect(validateSettingValues({ KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '21' })).toMatch(/1 到 20/);
    expect(validateSettingValues({ KNOWLEDGE_WIKI_INGEST_MODE: 'batch' })).toMatch(/两段式|单段式/);
  });
});
