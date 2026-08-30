import { describe, expect, it } from 'vitest';
import { parsePlan } from './PlanCard';

describe('parsePlan', () => {
  it('parses a well-formed plan card payload', () => {
    const payload = {
      kind: 'plan',
      id: 'plan-x',
      title: '重构鉴权层',
      summary: '抽出中间件',
      todos: [
        { text: '步骤一', done: false },
        { text: '步骤二', done: true },
      ],
      planFile: '.pi/plans/plan-x.md',
      status: 'draft',
    };
    expect(parsePlan(JSON.stringify(payload))).toEqual(payload);
  });

  it('coerces missing optional fields', () => {
    const parsed = parsePlan(JSON.stringify({ kind: 'plan', title: 'T', todos: [{}] }));
    expect(parsed).toEqual({
      kind: 'plan',
      id: '',
      title: 'T',
      summary: '',
      todos: [{ text: '', done: false }],
      planFile: '',
      status: undefined,
    });
  });

  it('returns null for non-plan json or non-json', () => {
    expect(parsePlan('not json')).toBeNull();
    expect(parsePlan(JSON.stringify({ kind: 'notice', title: 'x' }))).toBeNull();
    expect(parsePlan(JSON.stringify({ kind: 'plan', title: 'x' }))).toBeNull();
  });
});
