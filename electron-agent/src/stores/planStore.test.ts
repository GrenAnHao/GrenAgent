import { beforeEach, describe, expect, it } from 'vitest';
import { isPlanEditable, parsePlanStatus, planIdFromRef, planKeyOf, usePlanStore } from './planStore';
import { readBlocked } from '../features/chat/input/actions/ModeAction';

const plan = {
  id: 'plan-1',
  title: 't',
  goal: 'g',
  steps: [{ text: '很长的一步'.repeat(20), done: false }],
  risks: ['r'],
  status: 'ready',
  rev: 2,
  createdAt: 1,
  updatedAt: 2,
  updatedBy: 'user',
};

beforeEach(() => usePlanStore.setState({ entries: {} }));

describe('parsePlanStatus', () => {
  it('reads the extension payload without truncating steps', () => {
    const parsed = parsePlanStatus(JSON.stringify({ plan, reason: 'created' }));
    expect(parsed?.reason).toBe('created');
    expect(parsed?.plan?.steps[0].text).toBe('很长的一步'.repeat(20));
    expect(parsed?.plan?.updatedBy).toBe('user');
  });
  it('null plan means the session has none; garbage is ignored', () => {
    expect(parsePlanStatus(JSON.stringify({ plan: null, reason: 'sync' }))).toEqual({ plan: null, reason: 'sync' });
    expect(parsePlanStatus('not json')).toBeNull();
    expect(parsePlanStatus(JSON.stringify({ plan: { kind: 'plan', todos: [] } }))).toBeNull();
  });
});

describe('planStore', () => {
  it('keys entries by owner session like the dock', () => {
    const owner = { sessionPath: 'C:\\Work\\a.jsonl', workspace: 'C:/work' };
    usePlanStore.getState().setPlan(owner, parsePlanStatus(JSON.stringify({ plan }))!.plan);
    expect(usePlanStore.getState().entries[planKeyOf({ sessionPath: 'c:/work/a.jsonl', workspace: 'x' })]?.plan?.id).toBe('plan-1');
  });
  it('only drafting / ready are editable', () => {
    expect(isPlanEditable({ ...parsePlanStatus(JSON.stringify({ plan }))!.plan!, status: 'executing' })).toBe(false);
    expect(isPlanEditable(parsePlanStatus(JSON.stringify({ plan }))!.plan)).toBe(true);
  });
  it('reads the plan id from the summary card text', () => {
    expect(planIdFromRef('[plan:plan-1] 已生成计划「t」')).toBe('plan-1');
    expect(planIdFromRef('{"kind":"plan"}')).toBeNull();
  });
});

describe('readBlocked', () => {
  it('recognises the host refusal and nothing else', () => {
    expect(readBlocked({ ok: false, blocked: 'PLAN_UNCONFIRMED', mode: 'plan', message: 'm' })).toEqual({ mode: 'plan', message: 'm' });
    expect(readBlocked({ ok: true, mode: 'agent' })).toBeNull();
    expect(readBlocked(undefined)).toBeNull();
  });
});
