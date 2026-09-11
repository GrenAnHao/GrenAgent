import { describe, expect, it } from 'vitest';
import { formatStructuredMessageText } from './structuredMessageText';

describe('formatStructuredMessageText', () => {
  it('普通对话走 markdown', () => {
    expect(formatStructuredMessageText('你好，世界')).toEqual({ mode: 'markdown', text: '你好，世界' });
  });

  it('把 SystemWorker 提示拆成可读预格式化文本', () => {
    const raw = [
      'Extract durable memory as strict JSON. Return JSON only.',
      'Task kind: memory_extract',
      'Input: {"delta":"user: 你是什么模型?"}',
    ].join('\n');
    const formatted = formatStructuredMessageText(raw);
    expect(formatted.mode).toBe('pre');
    expect(formatted.text).toContain('Task kind: memory_extract');
    expect(formatted.text).toContain('\n  "delta"');
    expect(formatted.text).toContain('你是什么模型?');
  });

  it('把整段 JSON 助手回复缩进，避免被 Markdown 收成一行', () => {
    const formatted = formatStructuredMessageText(
      '{"l1":{"PI_MODEL":"claude-opus-5"},"l2":"用户询问模型身份"}',
    );
    expect(formatted.mode).toBe('pre');
    expect(formatted.text).toContain('\n  "l1"');
    expect(formatted.text).toContain('claude-opus-5');
  });
});
