import { describe, expect, it, vi } from 'vitest';
import {
  buildExtractionWindow, conversationTurns, MAX_BACKGROUND_MESSAGES, MAX_MESSAGE_CHARS, MAX_NEW_MESSAGES, shouldExtract, splitTranscript,
  tailConversationTurns,
} from './memoryExtractionWindow';

/** 确定性伪随机，测试不用真随机数。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** 混合角色、工具输出、被过滤的消息、行中间的「user: 」，尽量覆盖合并与过滤的分支。 */
function randomTranscript(seed: number, minChars: number): string {
  const rand = lcg(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const parts: string[] = [];
  let size = 0;
  for (let n = 0; size < minChars; n += 1) {
    const role = pick(['user', 'assistant', 'assistant', 'toolResult', 'toolResult', 'custom']);
    let body: string;
    if (role === 'toolResult') body = 'x'.repeat(Math.floor(rand() * 800));
    else if (role === 'custom') body = '## Relevant memory';
    else if (role === 'user') body = pick([`问题${n} note user: inline`, `问题${n}`, '/compact']);
    else body = pick([`回复${n} note assistant: inline`, `回复${n}\n\n第二段`, '```x\nCODE_ONLY\n```']);
    const part = `${role}: ${body}`;
    parts.push(part);
    size += part.length + 1;
  }
  return parts.join('\n');
}

describe('splitTranscript', () => {
  it('按 pi 的角色行切分，正文里的冒号不算新消息', () => {
    expect(splitTranscript('user: 看看 a: b\nassistant: 好\ntoolResult: out\ncustom: memo')).toEqual([
      { role: 'user', content: '看看 a: b' },
      { role: 'assistant', content: '好' },
      { role: 'toolResult', content: 'out' },
      { role: 'custom', content: 'memo' },
    ]);
  });

  it('正文中间有大量连续换行时不触发正则的二次复杂度', () => {
    const body = `开头\n${'\n'.repeat(200_000)}尾部\n`;
    const start = performance.now();
    const result = splitTranscript(`user: ${body}assistant: 回复`);
    const elapsed = performance.now() - start;
    expect(result).toEqual([
      { role: 'user', content: `开头\n${'\n'.repeat(200_000)}尾部` },
      { role: 'assistant', content: '回复' },
    ]);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('shouldExtract', () => {
  it('保留以路径开头但非命令的消息，只丢真正的斜杠命令', () => {
    expect(shouldExtract('/api/v1/foo 报错了')).toBe(true);
    expect(shouldExtract('/new')).toBe(false);
    expect(shouldExtract('/compact')).toBe(false);
  });

  it('纯符号过滤只认非字母数字，保留 Cyrillic 等文字', () => {
    expect(shouldExtract('Да')).toBe(true);
    expect(shouldExtract('!!')).toBe(false);
    expect(shouldExtract('？？')).toBe(false);
  });
});

describe('conversationTurns', () => {
  it('丢掉工具输出和自定义消息，同一轮里被工具调用隔开的 assistant 文本合成一条', () => {
    const text = 'user: 帮我查日志\nassistant: 我先看看\ntoolResult: HUGE_TOOL_OUTPUT\nassistant: 结论是磁盘满了\ncustom: ## Relevant memory';
    expect(conversationTurns(text)).toEqual([
      { role: 'user', content: '帮我查日志' },
      { role: 'assistant', content: '我先看看\n\n结论是磁盘满了' },
    ]);
  });

  it('被过滤掉的 user 段会断开 assistant 的合并', () => {
    expect(conversationTurns('user: 开始\nassistant: A\nuser: /compact\nassistant: B')).toEqual([
      { role: 'user', content: '开始' },
      { role: 'assistant', content: 'A' },
      { role: 'assistant', content: 'B' },
    ]);
  });

  it('被过滤的 user 段后面跟着被过滤的 assistant 纯代码块，A 和 B 仍不合并', () => {
    const text = 'assistant: A\nuser: /compact\nassistant: ```x\nCODE_ONLY\n```\nassistant: B';
    expect(conversationTurns(text)).toEqual([
      { role: 'assistant', content: 'A' },
      { role: 'assistant', content: 'B' },
    ]);
  });

  it('custom 段夹在两条 assistant 中间时仍合并，被过滤的 assistant 也不打断', () => {
    expect(conversationTurns('assistant: A\ncustom: ## Relevant memory\nassistant: B')).toEqual([
      { role: 'assistant', content: 'A\n\nB' },
    ]);
    expect(conversationTurns('assistant: A\nassistant: ```x\nCODE_ONLY\n```\nassistant: B')).toEqual([
      { role: 'assistant', content: 'A\n\nB' },
    ]);
  });

  it('toolResult 等非对话段不打断同一轮 assistant 的合并', () => {
    expect(conversationTurns('assistant: A\ntoolResult: x\nassistant: B')).toEqual([
      { role: 'assistant', content: 'A\n\nB' },
    ]);
  });

  it('assistant 去掉代码块和内联图片，user 保留代码块', () => {
    const text = 'user: 改成这样\n```ts\nconst a = 1;\n```\nassistant: 已改好\n```ts\nconst a = 2;\n```\n说明在上面 data:image/png;base64,AAAA';
    expect(conversationTurns(text)).toEqual([
      { role: 'user', content: '改成这样\n```ts\nconst a = 1;\n```' },
      { role: 'assistant', content: '已改好\n\n说明在上面' },
    ]);
  });

  it('按上游 shouldExtractL1 过滤空消息、斜杠命令、纯符号和纯问号', () => {
    expect(conversationTurns('user: /new\nuser: ？？\nuser: !!\nuser: ok\nassistant:   ')).toEqual([{ role: 'user', content: 'ok' }]);
  });

  it(`单条超过 ${MAX_MESSAGE_CHARS} 字时截断并标注`, () => {
    const [turn] = conversationTurns(`user: ${'字'.repeat(MAX_MESSAGE_CHARS + 10)}`);
    expect(turn.content).toHaveLength(MAX_MESSAGE_CHARS + '…（已截断）'.length);
    expect(turn.content.endsWith('…（已截断）')).toBe(true);
  });
});

describe('tailConversationTurns', () => {
  it('count 不大于 0 时返回空', () => {
    expect(tailConversationTurns('user: a', 0)).toEqual([]);
  });

  it.each([1, 7, 64, 500, 4000])('初始窗口 %i 字符时，结果与全量解析的末尾完全一致', (windowChars) => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const text = randomTranscript(seed, 6_000);
      for (const count of [1, 3, 5]) {
        expect(tailConversationTurns(text, count, windowChars)).toEqual(conversationTurns(text).slice(-count));
      }
    }
  });

  it('窗口从一组合并的 assistant 中间切开时，多取一条或放大窗口，不会把后半截当成完整的一条', () => {
    const text = 'user: q\nassistant: A\ntoolResult: t\nassistant: B\ntoolResult: t\nassistant: C';
    const start = text.indexOf('assistant: B');
    expect(tailConversationTurns(text, 1, text.length - start)).toEqual([{ role: 'assistant', content: 'A\n\nB\n\nC' }]);
  });

  it('窗口起点落在行中间的「user: 」上时，不把它当成角色行', () => {
    const text = 'assistant: P\ntoolResult: out user: 假的角色行\nassistant: Q';
    const from = text.indexOf('user: 假的');
    expect(tailConversationTurns(text, 1, text.length - from)).toEqual([{ role: 'assistant', content: 'P\n\nQ' }]);
  });
});

describe('buildExtractionWindow', () => {
  const turns = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${i % 2 === 0 ? 'user' : 'assistant'}: ${prefix}${i}`).join('\n');
  const contents = (list: Array<{ content: string }>) => list.map((item) => item.content);

  it(`新消息最多 ${MAX_NEW_MESSAGES} 条，背景最多 ${MAX_BACKGROUND_MESSAGES} 条，窗口外的 delta 消息并入背景候选`, () => {
    const window = buildExtractionWindow(turns('d', 14), turns('b', 6), 1_000);
    expect(window.newMessages.map((m) => m.content)).toEqual(['d4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11', 'd12', 'd13']);
    expect(window.backgroundMessages.map((m) => m.content)).toEqual(['b5', 'd0', 'd1', 'd2', 'd3']);
  });

  it('背景用 b 前缀、新消息用 m 前缀编号，时间戳先背景后新消息递增', () => {
    const window = buildExtractionWindow('user: new', 'user: old', 1_000);
    expect(window.backgroundMessages).toEqual([{ id: 'b0', role: 'user', content: 'old', timestamp: 1_000 }]);
    expect(window.newMessages).toEqual([{ id: 'm0', role: 'user', content: 'new', timestamp: 2_000 }]);
  });

  it('delta 只有工具输出时新消息为空', () => {
    expect(buildExtractionWindow('toolResult: x', 'user: old').newMessages).toEqual([]);
  });

  it('delta 只有工具输出时不取 background', () => {
    const background = vi.fn(() => 'user: old');
    expect(buildExtractionWindow('toolResult: x', background)).toEqual({ newMessages: [], backgroundMessages: [] });
    expect(background).not.toHaveBeenCalled();
  });

  it('delta 自己窗口外的消息已经填满背景时不取 background', () => {
    const background = vi.fn(() => 'user: old');
    const window = buildExtractionWindow(turns('d', MAX_NEW_MESSAGES + MAX_BACKGROUND_MESSAGES), background);
    expect(contents(window.backgroundMessages)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
    expect(background).not.toHaveBeenCalled();
  });

  it('需要背景时只取一次，并和直接传字符串结果一致', () => {
    const background = vi.fn(() => turns('b', 6));
    const lazy = buildExtractionWindow(turns('d', 3), background, 1_000);
    expect(background).toHaveBeenCalledTimes(1);
    expect(lazy).toEqual(buildExtractionWindow(turns('d', 3), turns('b', 6), 1_000));
  });

  it.each([
    { seed: 42, deltaTurns: 1 },
    { seed: 43, deltaTurns: 3 },
    { seed: 44, deltaTurns: 12 },
  ])('background 超过 1 MB 时，背景消息与全量解析一致（seed $seed，delta $deltaTurns 条）', ({ seed, deltaTurns }) => {
    const background = randomTranscript(seed, 1_200_000);
    expect(background.length).toBeGreaterThan(1_000_000);
    const delta = turns('d', deltaTurns);
    const fresh = conversationTurns(delta);
    const expected = [...conversationTurns(background), ...fresh.slice(0, Math.max(0, fresh.length - MAX_NEW_MESSAGES))].slice(-MAX_BACKGROUND_MESSAGES);
    expect(expected).toHaveLength(MAX_BACKGROUND_MESSAGES);
    expect(contents(buildExtractionWindow(delta, background).backgroundMessages)).toEqual(expected.map((turn) => turn.content));
  });

  it('尾部被超大工具输出隔开时窗口逐级放大，结果仍与全量解析一致', () => {
    const huge = (size: number) => `toolResult: ${'x'.repeat(size)}`;
    const background = [
      randomTranscript(7, 50_000),
      'user: 倒数第三', huge(300_000), 'assistant: 倒数第二前半', huge(300_000), 'assistant: 倒数第二后半', huge(1_200_000), 'user: 最后一问',
    ].join('\n');
    const expected = conversationTurns(background).slice(-MAX_BACKGROUND_MESSAGES).map((turn) => turn.content);
    expect(expected.slice(-3)).toEqual(['倒数第三', '倒数第二前半\n\n倒数第二后半', '最后一问']);
    expect(contents(buildExtractionWindow('user: new', background).backgroundMessages)).toEqual(expected);
  });
});
