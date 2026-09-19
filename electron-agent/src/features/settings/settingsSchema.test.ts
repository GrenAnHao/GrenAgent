import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA } from './settingsSchema';

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
      'AUTO_TITLE',
      'COMPACTION_PREVIEW',
      'goal.autoContinueOnOpen',
    ]);
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

describe('subagent max depth', () => {
  it('exposes SUBAGENT_MAX_DEPTH as a number with default 2', () => {
    const all = SETTINGS_SCHEMA.flatMap((c) => [...(c.fields ?? []), ...(c.sections ?? []).flatMap((s) => s.fields)]);
    expect(all.find((f) => f.key === 'SUBAGENT_MAX_DEPTH')).toMatchObject({ type: 'number', default: '2' });
  });
});
