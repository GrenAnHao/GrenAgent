import { describe, expect, it } from 'vitest';
import { CUSTOM_OPTION_ID } from './constants';
import { encodeAskUserAnswer, formatAnswers, parseAnswerBlock, parseAskUserPayload, type QSData } from './answers';

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

describe('encodeAskUserAnswer', () => {
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
