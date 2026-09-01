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
    ]);
  });
});
