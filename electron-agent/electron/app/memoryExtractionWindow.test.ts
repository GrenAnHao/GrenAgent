import { describe, expect, it } from 'vitest';
import {
  buildExtractionWindow, conversationTurns, MAX_BACKGROUND_MESSAGES, MAX_MESSAGE_CHARS, MAX_NEW_MESSAGES, shouldExtract, splitTranscript,
} from './memoryExtractionWindow';

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

describe('buildExtractionWindow', () => {
  const turns = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${i % 2 === 0 ? 'user' : 'assistant'}: ${prefix}${i}`).join('\n');

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
});
