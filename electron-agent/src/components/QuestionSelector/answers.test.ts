import { describe, expect, it } from 'vitest';
import { CUSTOM_OPTION_ID } from './constants';
import { encodeAskUserAnswer, formatAnswers, parseAnswerBlock, parseAskUserPayload, selectedVisualReview, type QSData } from './answers';

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
  it('retains multiple preset answers and the custom text separately from supplement', () => {
    const d: QSData = {
      ...data,
      questions: [{ id: 'q1', title: '方案', options: [{ id: 'a', label: 'A' }, { id: CUSTOM_OPTION_ID, label: '其他' }], allowMultiple: true, allowCustom: true }],
    };
    expect(formatAnswers(d, { q1: ['a', CUSTOM_OPTION_ID] }, { q1: '自拟路径' }, '理由')).toBe(
      '[我的选择]\n1. 方案：A、其他：自拟路径\n补充说明：理由',
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
  it('does not add a new default to restored historical cards', () => {
    const legacy = JSON.stringify({ __askUser: 1, data });
    const parsed = parseAskUserPayload(legacy);
    expect(parsed?.questions[0].options).toEqual(data.questions[0].options);
    expect(parsed?.questions[0].allowCustom).toBeUndefined();
    expect(parseAskUserPayload(JSON.stringify({ __askUser: 1, data: { ...data, questions: [{ ...data.questions[0], allowCustom: false }] } }))?.questions[0].allowCustom).toBe(false);
  });
  it('returns null for plain input title', () => {
    expect(parseAskUserPayload('输入名称')).toBeNull();
    expect(parseAskUserPayload(undefined)).toBeNull();
  });
});

describe('parseAnswerBlock', () => {
  it('keeps the chosen option when extra note is also present', () => {
    expect(
      parseAnswerBlock(
        '[我的选择]\n1. 选项卡已弹出。你想让我接下来做什么？：只是测试选项卡能不能正常显示\n补充说明：你能看到图片吗',
      ),
    ).toEqual({
      choices: ['只是测试选项卡能不能正常显示'],
      extraNote: '你能看到图片吗',
    });
  });

  it('does not split at a colon inside the title (（推荐：…）)', () => {
    const text =
      '[我的选择]\n1. 流水粒度（推荐：每条回复一条扣点流水）：每条回复一条（推荐）\n2. 备注：其他：自己填的';
    expect(parseAnswerBlock(text).choices).toEqual(['每条回复一条（推荐）', '其他：自己填的']);
  });

  it('cuts by the known title when titles are given, even with a bare colon in it', () => {
    const text = '[我的选择]\n1. 部署方式：同机还是分机：同机，只听 127.0.0.1\n补充说明：先这样';
    expect(parseAnswerBlock(text, ['部署方式：同机还是分机'])).toEqual({
      choices: ['同机，只听 127.0.0.1'],
      extraNote: '先这样',
    });
  });

  it('splits extra note and image count from numbered answers', () => {
    expect(
      parseAnswerBlock(
        formatAnswers(data, { q1: ['o1', 'o2'], q2: ['y'] }, undefined, '请看截图', 2),
      ),
    ).toEqual({
      choices: ['A、B', '是'],
      extraNote: '请看截图',
      imageCount: 2,
    });
  });
});

describe('visual review answer IDs', () => {
  const reviewData: QSData = { ...data, visualReview: { previewId: 'visual-1' }, questions: [
    { id: 'visual-review', title: '批准？', options: [{ id: 'approve', label: '通过' }, { id: 'redo', label: '打回' }], allowCustom: false },
  ] };
  it('takes only one closed stable selection, not text or supplement', () => {
    expect(selectedVisualReview(reviewData, { 'visual-review': ['approve'] })).toEqual({ previewId: 'visual-1', outcome: 'approved' });
    expect(selectedVisualReview(reviewData, { 'visual-review': ['redo'] })).toEqual({ previewId: 'visual-1', outcome: 'redo' });
    expect(selectedVisualReview(reviewData, { 'visual-review': [] })).toBeUndefined();
    expect(selectedVisualReview(reviewData, { 'visual-review': ['approve', 'redo'] })).toBeUndefined();
    expect(selectedVisualReview(reviewData, { 'visual-review': ['custom'] })).toBeUndefined();
  });
});

describe('encodeAskUserAnswer', () => {
  it('wraps a review selection even without images', () => {
    expect(JSON.parse(encodeAskUserAnswer('[我的选择]\\n1. 批准？：通过', [], { previewId: 'visual-1', outcome: 'approved' }))).toEqual({
      __askUserAnswer: 1, text: '[我的选择]\\n1. 批准？：通过', images: [], review: { previewId: 'visual-1', outcome: 'approved' },
    });
  });
  it('returns plain text when there are no images', () => {
    expect(encodeAskUserAnswer('[我的选择]\n1. T：乙')).toBe('[我的选择]\n1. T：乙');
  });

  it('wraps text plus images so the tool result can carry vision parts', () => {
    expect(
      encodeAskUserAnswer('[我的选择]\n1. T：乙\n补充说明：看图', [
        { mimeType: 'image/png', data: 'abc' },
      ]),
    ).toBe(
      JSON.stringify({
        __askUserAnswer: 1,
        text: '[我的选择]\n1. T：乙\n补充说明：看图',
        images: [{ mimeType: 'image/png', data: 'abc' }],
      }),
    );
  });
});
