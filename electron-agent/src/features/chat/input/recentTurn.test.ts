import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../stores/agentReducer';
import { formatRecentTurn, RECENT_TURN_MAX_CHARS } from './recentTurn';

function user(text: string, timestamp?: number): ChatMessage {
  return { kind: 'user', id: `u-${timestamp ?? text}`, text, timestamp };
}

function assistant(text: string, timestamp?: number, streaming = false): ChatMessage {
  return { kind: 'assistant', id: `a-${timestamp ?? text}`, text, thinking: '内部推理不该出现', streaming, timestamp };
}

describe('formatRecentTurn', () => {
  it('取最近一条助手正文和它前面的用户消息，不含思考和工具', () => {
    const text = formatRecentTurn(
      [
        user('先做登录', 1),
        assistant('登录方案是改 auth.ts', 2),
        { kind: 'tool', id: 't', toolCallId: 'c', toolName: 'read', args: {}, result: 'secret', status: 'done' },
        user('再补错误处理', 3),
        assistant('错误处理加在 save() 上', 4),
      ],
      new Set(),
    );
    expect(text).toBe('用户：\n再补错误处理\n\n助手：\n错误处理加在 save() 上');
    expect(text).not.toContain('内部推理');
    expect(text).not.toContain('secret');
  });

  it('没有助手正文时为空', () => {
    expect(formatRecentTurn([user('只有提问', 1)], new Set())).toBe('');
  });

  it('被移出上下文的那一轮不取，退回更早的一轮', () => {
    const text = formatRecentTurn(
      [user('旧问题', 1), assistant('旧回答', 2), user('新问题', 3), assistant('新回答', 4)],
      new Set([3, 4]),
    );
    expect(text).toBe('用户：\n旧问题\n\n助手：\n旧回答');
  });

  it('超长保留开头并注明截断', () => {
    const text = formatRecentTurn([user('问', 1), assistant('答'.repeat(RECENT_TURN_MAX_CHARS), 2)], new Set());
    expect(text.length).toBe(RECENT_TURN_MAX_CHARS);
    expect(text.endsWith('…（已截断）')).toBe(true);
    expect(text.startsWith('用户：\n问')).toBe(true);
  });
});
