import { describe, expect, it } from 'vitest';
import { isSystemWorkerSessionLines } from './systemWorkerSession';

const EXTRACT_TEXT = [
  'Extract durable memory as strict JSON with optional keys l1 (object), l2 (string), and l3 (string). Return JSON only.',
  'Task kind: memory_extract',
  'Input: {"delta":"user: 你是什么模型?"}',
].join('\n');

describe('isSystemWorkerSessionLines', () => {
  it('识别 memory_extract 短调用会话', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'extract', cwd: 'C:/work' }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: EXTRACT_TEXT }] },
      }),
    ];
    expect(isSystemWorkerSessionLines(lines)).toBe(true);
  });

  it('普通用户消息不是系统短调用', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'chat', cwd: 'C:/work' }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: '测试工具调用' }] },
      }),
    ];
    expect(isSystemWorkerSessionLines(lines)).toBe(false);
  });
});
