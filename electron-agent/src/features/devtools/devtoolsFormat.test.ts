import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, oneLine, prettyJson, summarize } from './devtoolsFormat';

describe('formatBytes', () => {
  it('formats byte ranges with units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('falls back to a dash for non-finite input', () => {
    expect(formatBytes(undefined)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
  });
});

describe('formatDuration', () => {
  it('picks a readable unit per magnitude', () => {
    expect(formatDuration(0.42)).toBe('0.42ms');
    expect(formatDuration(12.4)).toBe('12ms');
    expect(formatDuration(2500)).toBe('2.50s');
  });
});

describe('summarize', () => {
  it('caps array length and reports the remainder', () => {
    const output = summarize({ list: Array.from({ length: 25 }, (_, i) => i) }, { maxItems: 3 }) as {
      list: unknown[];
    };
    expect(output.list.slice(0, 3)).toEqual([0, 1, 2]);
    expect(output.list[3]).toBe('… 其余 22 项已省略');
  });

  it('truncates long strings', () => {
    const output = summarize({ text: 'x'.repeat(50) }, { maxString: 10 }) as { text: string };
    expect(output.text.startsWith('xxxxxxxxxx…')).toBe(true);
    expect(output.text).toContain('共 50 字符');
  });

  it('breaks reference cycles instead of throwing', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    const output = summarize(node) as Record<string, unknown>;
    expect(output.name).toBe('root');
    expect(output.self).toBe('<循环引用>');
  });

  it('replaces functions with a placeholder so the value stays JSON-serializable', () => {
    const output = summarize({ handler: () => 1, value: 2 }) as Record<string, unknown>;
    expect(output.handler).toBe('<function>');
    expect(output.value).toBe(2);
    expect(() => JSON.stringify(output)).not.toThrow();
  });
});

describe('prettyJson', () => {
  it('pretty-prints plain values and survives circular input', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(prettyJson(circular)).toContain('循环引用');
  });

  it('truncates huge payloads', () => {
    const text = prettyJson({ blob: 'y'.repeat(100) }, 32);
    expect(text.length).toBeLessThan(200);
    expect(text).toContain('已截断');
  });
});

describe('oneLine', () => {
  it('produces a short single-line preview', () => {
    const preview = oneLine({ type: 'message_update', payload: 'z'.repeat(500) }, 40);
    expect(preview.includes('\n')).toBe(false);
    expect(preview.length).toBeLessThanOrEqual(41);
  });
});
