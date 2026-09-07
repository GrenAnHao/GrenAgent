import { describe, it, expect } from 'vitest';
import type { DisplayMessage } from '../chat/groupMessages';
import {
  findIndicatorPosition,
  getEmphasis,
  getFractionalPosition,
  getIndicatorWidth,
  getRailScrollTop,
  getReplyText,
  getTitleText,
  INDICATOR_PITCH,
  MAX_EMPHASIS,
  toPlainText,
} from './utils';

describe('toPlainText', () => {
  it('剥掉 markdown 标记只留可读文字', () => {
    const text = '# 标题\n\n**粗体** 与 `行内代码`，还有 [链接](https://example.com)';
    expect(toPlainText(text)).toBe('标题 粗体 与 行内代码，还有 链接');
  });

  it('丢掉围栏代码块与图片', () => {
    const text = '看这段：\n```ts\nconst a = 1;\n```\n以及 ![图](a.png) 结束';
    expect(toPlainText(text)).toBe('看这段： 以及 结束');
  });

  it('剥掉 pi:attachment 块，只留用户自己写的正文', () => {
    const text = [
      '帮我看下这个文件',
      '<pi:attachment type="file" path="a.ts" lines="2">',
      'const a = 1;',
      'const b = 2;',
      '</pi:attachment>',
      '有什么问题',
    ].join('\n');
    expect(toPlainText(text)).toBe('帮我看下这个文件 有什么问题');
  });

  it('空内容返回空串', () => {
    expect(toPlainText(undefined)).toBe('');
    expect(toPlainText('   \n  ')).toBe('');
  });
});

describe('getTitleText', () => {
  it('短文本原样返回，超过 60 字截断并加省略号', () => {
    expect(getTitleText('短消息')).toBe('短消息');
    const long = getTitleText('x'.repeat(80));
    expect(long).toHaveLength(61);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('getReplyText', () => {
  const turn = (id: string, ...texts: string[]): DisplayMessage => ({
    kind: 'turn',
    id,
    segments: [
      { kind: 'thinking', id: `${id}-think`, content: '推理过程不该出现', streaming: false },
      ...texts.map((content, i) => ({ kind: 'text' as const, id: `${id}-t${i}`, content, streaming: false })),
      { kind: 'tool', id: `${id}-tool`, toolCallId: 'c', toolName: 'read', args: {}, result: '', status: 'done' },
    ],
  });
  const user = (id: string, text: string): DisplayMessage => ({ kind: 'user', id, text });

  it('取紧随其后的 turn 正文段，跳过推理与工具', () => {
    const messages = [user('u1', '问'), turn('a1', '先看一下。', '结论是可以。'), user('u2', '再问')];
    expect(getReplyText(messages, 0)).toBe('先看一下。 结论是可以。');
  });

  it('遇到下一条用户消息即停，不会串到下一轮', () => {
    const messages = [user('u1', '问一'), turn('a1', '答一'), user('u2', '问二'), turn('a2', '答二')];
    expect(getReplyText(messages, 0)).toBe('答一');
    expect(getReplyText(messages, 2)).toBe('答二');
  });

  it('agent-answer 通知也算回复', () => {
    const messages: DisplayMessage[] = [
      user('u1', '问'),
      { kind: 'notice', id: 'n1', customType: 'agent-answer', content: '**最终答案**' },
    ];
    expect(getReplyText(messages, 0)).toBe('最终答案');
  });

  it('还没有回复时返回空串；超长回复截断到 140 字', () => {
    expect(getReplyText([user('u1', '问')], 0)).toBe('');
    const long = getReplyText([user('u1', '问'), turn('a1', 'y'.repeat(500))], 0);
    expect(long).toHaveLength(141);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('findIndicatorPosition / getFractionalPosition', () => {
  // 用户消息落在列表下标 0 / 3 / 5 / 10（中间夹着长短不一的助手回复）。
  const indicators = [{ listIndex: 0 }, { listIndex: 3 }, { listIndex: 5 }, { listIndex: 10 }];

  it('视口停在助手回复上时归到开启该轮的用户消息；还没到第一条时为 -1', () => {
    expect(findIndicatorPosition(indicators, 0)).toBe(0);
    expect(findIndicatorPosition(indicators, 2.7)).toBe(0);
    expect(findIndicatorPosition(indicators, 3)).toBe(1);
    expect(findIndicatorPosition(indicators, 9.9)).toBe(2);
    expect(findIndicatorPosition(indicators, 12)).toBe(3);
    expect(findIndicatorPosition([{ listIndex: 2 }], 1)).toBe(-1);
  });

  // 各条目起始像素：用户消息很矮（50px），助手回复长短不一，两条用户消息之间的像素跨度各不相同。
  const offsets = [0, 50, 250, 400, 450, 700, 750, 900, 1000, 1100, 1300, 1350, 1500];
  const offsetOf = (i: number) => offsets[i];

  it('两条刻度之间按像素距离插值，短问句与长回复不会走出同样的距离', () => {
    // 第 0 与第 1 条用户消息相距 400px：滚到 200px 正好一半。
    expect(getFractionalPosition(indicators, 1, 200, offsetOf)).toBeCloseTo(0.5);
    // 第 1 与第 2 条相距 300px：滚到 550px 一半；同样是「一半」但像素跨度不同。
    expect(getFractionalPosition(indicators, 4, 550, offsetOf)).toBeCloseTo(1.5);
    // 第 2 与第 3 条相距 600px：滚到 850px 只走了四分之一。
    expect(getFractionalPosition(indicators, 7, 850, offsetOf)).toBeCloseTo(2.25);
  });

  it('两端夹紧：还没到第一条为 0，过了最后一条停在末尾，估算偏差不会越界', () => {
    expect(getFractionalPosition([{ listIndex: 2 }, { listIndex: 4 }], 0, 0, offsetOf)).toBe(0);
    expect(getFractionalPosition(indicators, 10, 1300, offsetOf)).toBe(3);
    expect(getFractionalPosition(indicators, 12, 1500, offsetOf)).toBe(3);
    // 未测量条目的估算偏移可能让 scrollOffset 略超下一条刻度，夹到 1 而不是进位。
    expect(getFractionalPosition(indicators, 2, 420, offsetOf)).toBe(1);
    expect(getFractionalPosition([], 5, 0, offsetOf)).toBe(0);
  });

  it('两条刻度像素位置相同（退化）时不做除法，停在当前刻度', () => {
    expect(getFractionalPosition(indicators, 1, 100, () => 0)).toBe(0);
  });
});

describe('getRailScrollTop', () => {
  // 8 条刻度共 80px，rail 只露出 30px。
  const client = 30;
  const scroll = 8 * INDICATOR_PITCH;

  it('中段让当前刻度居中，两端夹紧到 0 与最大可滚距离', () => {
    expect(getRailScrollTop(0, client, scroll)).toBe(0);
    expect(getRailScrollTop(4, client, scroll)).toBe(4.5 * INDICATOR_PITCH - client / 2);
    expect(getRailScrollTop(7, client, scroll)).toBe(scroll - client);
  });

  it('rail 没有溢出时始终为 0', () => {
    expect(getRailScrollTop(3, 100, 80)).toBe(0);
  });
});

describe('getEmphasis / getIndicatorWidth', () => {
  it('没有悬停时全部为默认长度', () => {
    expect(getEmphasis(5, null)).toBe(0);
    expect(getIndicatorWidth(0)).toBe(8);
  });

  it('悬停那条最长，向两侧逐级缩短，两条之外回到默认', () => {
    const widths = [0, 1, 2, 3, 4, 5, 6].map((p) => getIndicatorWidth(getEmphasis(p, 3)));
    expect(widths).toEqual([8, 13, 18, 24, 18, 13, 8]);
    expect(getEmphasis(3, 3)).toBe(MAX_EMPHASIS);
  });
});
