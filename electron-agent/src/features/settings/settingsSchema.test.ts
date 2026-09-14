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
      description: '首轮对话结束后生成简短标题（默认开）',
    });
    expect(fields.map((field) => field.key)).toEqual([
      'titleModel',
      'AUTO_TITLE',
      'COMPACTION_PREVIEW',
      'goal.autoContinueOnOpen',
    ]);
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
