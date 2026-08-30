import { describe, expect, it } from 'vitest';
import { CUSTOM_OPTION_ID } from '../../components/QuestionSelector/constants';
import { formatAnswers, parseQuestions } from './QuestionsCard';

describe('parseQuestions', () => {
  it('parses a well-formed questions payload', () => {
    const payload = {
      kind: 'questions',
      id: 'q-1',
      allowExtra: true,
      questions: [
        {
          id: 'q1',
          title: '选哪个？',
          options: [
            { id: 'o1', label: 'A' },
            { id: 'o2', label: 'B' },
          ],
          allowMultiple: false,
          allowCustom: true,
        },
      ],
    };
    expect(parseQuestions(JSON.stringify(payload))).toEqual({
      ...payload,
      allowExtraImages: true,
      extraPlaceholder: undefined,
    });
  });

  it('coerces missing fields and filters invalid questions', () => {
    const parsed = parseQuestions(
      JSON.stringify({ kind: 'questions', questions: [{ title: 'T', options: [{ label: 'x' }] }, { foo: 1 }] }),
    );
    expect(parsed).toEqual({
      kind: 'questions',
      id: '',
      allowExtra: false,
      allowExtraImages: true,
      questions: [{ id: 'q1', title: 'T', options: [{ id: 'o1', label: 'x' }], allowMultiple: false, allowCustom: false }],
    });
  });

  it('returns null for non-questions json or non-json', () => {
    expect(parseQuestions('not json')).toBeNull();
    expect(parseQuestions(JSON.stringify({ kind: 'plan' }))).toBeNull();
    expect(parseQuestions(JSON.stringify({ kind: 'questions', questions: [] }))).toBeNull();
  });
});

describe('formatAnswers', () => {
  const data = {
    kind: 'questions' as const,
    id: 'q-1',
    questions: [
      {
        id: 'q1',
        title: '选方案',
        options: [
          { id: 'o1', label: 'A' },
          { id: 'o2', label: 'B' },
          { id: CUSTOM_OPTION_ID, label: '其他（自定义）' },
        ],
        allowMultiple: true,
        allowCustom: true,
      },
      { id: 'q2', title: '确认', options: [{ id: 'y', label: '是' }], allowMultiple: false },
    ],
  };

  it('joins multiple selected labels', () => {
    expect(formatAnswers(data, { q1: ['o1', 'o2'], q2: ['y'] })).toBe('[我的选择]\n1. 选方案：A、B\n2. 确认：是');
  });

  it('formats custom answer text', () => {
    expect(formatAnswers(data, { q1: [CUSTOM_OPTION_ID] }, { q1: '我的方案' })).toBe(
      '[我的选择]\n1. 选方案：其他：我的方案\n2. 确认：(未选)',
    );
  });

  it('includes extra note and image count', () => {
    expect(formatAnswers(data, { q2: ['y'] }, {}, '请看截图', 2)).toBe(
      '[我的选择]\n1. 选方案：(未选)\n2. 确认：是\n补充说明：请看截图\n补充图片：2 张（见消息附件）',
    );
  });

  it('marks unselected questions', () => {
    expect(formatAnswers(data, { q1: ['o1'] })).toBe('[我的选择]\n1. 选方案：A\n2. 确认：(未选)');
  });
});
