import { describe, expect, it } from 'vitest';
import { CUSTOM_OPTION_ID } from './constants';
import { formatAnswers, parseAskUserPayload, type QSData } from './answers';

const data: QSData = {
  kind: 'questions',
  id: 'q1',
  questions: [
    {
      id: 'q1',
      title: '选方案',
      options: [
        { id: 'o1', label: 'A' },
        { id: 'o2', label: 'B' },
      ],
      allowMultiple: true,
    },
    { id: 'q2', title: '确认', options: [{ id: 'y', label: '是' }] },
  ],
};

describe('formatAnswers', () => {
  it('joins multi-select with、and numbers questions', () => {
    expect(formatAnswers(data, { q1: ['o1', 'o2'], q2: ['y'] })).toBe('[我的选择]\n1. 选方案：A、B\n2. 确认：是');
  });
  it('renders custom text and extra note', () => {
    const d: QSData = {
      ...data,
      questions: [{ id: 'q1', title: '选方案', options: [{ id: CUSTOM_OPTION_ID, label: '其他' }], allowCustom: true }],
    };
    expect(formatAnswers(d, { q1: [CUSTOM_OPTION_ID] }, { q1: '我的方案' }, '看截图')).toBe(
      '[我的选择]\n1. 选方案：其他：我的方案\n补充说明：看截图',
    );
  });
  it('marks unanswered as (未选)', () => {
    expect(formatAnswers(data, { q2: ['y'] })).toBe('[我的选择]\n1. 选方案：(未选)\n2. 确认：是');
  });
});

describe('parseAskUserPayload', () => {
  it('returns data for the sentinel envelope', () => {
    const t = JSON.stringify({ __askUser: 1, data });
    expect(parseAskUserPayload(t)?.questions).toHaveLength(2);
  });
  it('returns null for plain input title', () => {
    expect(parseAskUserPayload('输入名称')).toBeNull();
    expect(parseAskUserPayload(undefined)).toBeNull();
  });
});
