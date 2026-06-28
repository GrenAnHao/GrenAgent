import { describe, it, expect, vi } from 'vitest';
import type { DisplayMessage } from './groupMessages';
import * as subagentUtils from '../panels/subagentUtils';
import { computeSubAgentUnits, computeAnsweredQuestions } from './messagePrecompute';

const tool = (id: string, toolName: string): DisplayMessage =>
  ({ kind: 'tool', id, toolCallId: `${id}-c`, toolName, args: {}, result: {}, status: 'done' }) as DisplayMessage;
const user = (id: string): DisplayMessage => ({ kind: 'user', id, text: 'hi' }) as DisplayMessage;
const questions = (id: string): DisplayMessage =>
  ({ kind: 'notice', id, customType: 'agent-questions', content: '{}' }) as DisplayMessage;

describe('computeSubAgentUnits', () => {
  it('assigns continuous #N across multiple spawn_agent messages, skips non-spawn', () => {
    // 用 spy 控制每个 spawn 展开的子代理条数，验证连号跨调用累加。
    vi.spyOn(subagentUtils, 'expandSubAgents')
      .mockReturnValueOnce([{ task: 'a' }, { task: 'b' }] as never) // m1 → 2 个
      .mockReturnValueOnce([{ task: 'c' }] as never); // m2 → 1 个
    const map = computeSubAgentUnits([tool('m1', 'spawn_agent'), tool('x', 'read'), tool('m2', 'spawn_agent')]);
    expect(map.get('m1')!.map((u) => u.no)).toEqual([1, 2]);
    expect(map.get('m2')!.map((u) => u.no)).toEqual([3]);
    expect(map.has('x')).toBe(false);
  });
});

describe('computeAnsweredQuestions', () => {
  it('marks a questions notice as answered when a user message follows it', () => {
    const set = computeAnsweredQuestions([questions('q1'), user('u1'), questions('q2')]);
    expect(set.has('q1')).toBe(true); // 其后有 user
    expect(set.has('q2')).toBe(false); // 其后无 user（最后一张可交互）
  });
});
