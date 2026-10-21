import { describe, expect, it } from 'vitest';
import {
  ATTENTION_LABEL,
  attentionCount,
  attentionTooltip,
  needsAction,
  resolveRowStatus,
  summarizeGroup,
  type SessionAttentionState,
  type UnreadEntry,
} from './attentionView';
import type { PendingEntry } from './attentionPending';

const P = 'D:/s/a.jsonl';
const approval: PendingEntry = { path: P, workspace: 'D:/r', kind: 'approval', title: '执行 npm publish？' };
const choice: PendingEntry = { path: P, workspace: 'D:/r', kind: 'choice', title: '用哪个方案？' };
const unread = (over: Partial<UnreadEntry>): UnreadEntry => ({ path: P, workspace: 'D:/r', ...over });
const failed = unread({ outcome: { kind: 'failed', message: '429 rate limited', seq: 1 } });
const done = unread({ outcome: { kind: 'done', seq: 1 } });
const blockedOnly = unread({ blocked: { message: '缺少 API Key' } });

describe('resolveRowStatus', () => {
  it.each<[SessionAttentionState | undefined, boolean, string | undefined]>([
    [{ pending: approval, unread: failed }, true, 'approval'],
    [{ pending: choice }, true, 'choice'],
    [{ unread: failed }, true, 'running'],
    [{ unread: { ...failed, blocked: {} } }, false, 'failed'],
    [{ unread: blockedOnly }, false, 'blocked'],
    [{ unread: { ...done, blocked: {} } }, false, 'blocked'],
    [{ unread: done }, true, 'running'],
    [{ unread: done }, false, 'done'],
    [undefined, true, 'running'],
    [undefined, false, undefined],
  ])('case %#', (state, running, kind) => {
    expect(resolveRowStatus(state, running)).toBe(kind);
  });
});

describe('attentionTooltip', () => {
  it('writes tooltips with details', () => {
    expect(attentionTooltip('approval', { pending: approval })).toBe('等待批准：执行 npm publish？');
    expect(attentionTooltip('choice', { pending: choice })).toBe('等待你选择：用哪个方案？');
    expect(attentionTooltip('failed', { unread: failed })).toBe('失败：429 rate limited');
    expect(attentionTooltip('blocked', { unread: blockedOnly })).toBe('Goal 受阻：缺少 API Key');
    expect(attentionTooltip('done', { unread: done })).toBe('已完成，未查看');
  });

  it('falls back when details are missing', () => {
    expect(attentionTooltip('approval', { pending: { ...approval, title: undefined } })).toBe('等待批准：有操作等待批准');
    expect(attentionTooltip('choice', { pending: { ...choice, title: undefined } })).toBe('等待你选择：有问题等你回答');
    expect(attentionTooltip('failed', { unread: unread({ outcome: { kind: 'failed', seq: 1 } }) })).toBe('失败：回合出错');
    expect(attentionTooltip('blocked', { unread: unread({ blocked: {} }) })).toBe('Goal 受阻：需要你处理');
  });

  it('truncates long errors at 60 chars', () => {
    const long = '错'.repeat(61);
    expect(attentionTooltip('failed', { unread: unread({ outcome: { kind: 'failed', message: long, seq: 1 } }) })).toBe(
      `失败：${'错'.repeat(60)}…`,
    );
    const exact = '错'.repeat(60);
    expect(attentionTooltip('failed', { unread: unread({ outcome: { kind: 'failed', message: exact, seq: 1 } }) })).toBe(
      `失败：${exact}`,
    );
  });
});

describe('labels and counts', () => {
  it('names every kind', () => {
    expect(ATTENTION_LABEL).toEqual({ approval: '等待批准', choice: '需要你选择', failed: '失败', blocked: '任务受阻', done: '已完成' });
  });

  it('counts approval, choice, failed and blocked but not done', () => {
    expect(needsAction({ unread: done })).toBe(false);
    expect(needsAction(undefined)).toBe(false);
    const states: Array<[string, SessionAttentionState]> = [
      ['a', { pending: approval }],
      ['b', { pending: choice }],
      ['c', { unread: failed }],
      ['d', { unread: blockedOnly }],
      ['e', { unread: done }],
    ];
    expect(attentionCount(states)).toBe(4);
  });

  it('counts only listed sessions', () => {
    const states: Array<[string, SessionAttentionState]> = [
      ['a', { pending: approval }],
      ['b', { unread: failed }],
    ];
    expect(attentionCount(states, new Set(['b']))).toBe(1);
  });

  it('summarizes a group by top priority and action count', () => {
    expect(
      summarizeGroup([
        { state: undefined, running: true },
        { state: { unread: failed }, running: false },
        { state: { unread: done }, running: false },
      ]),
    ).toEqual({ kind: 'running', count: 1 });
    expect(
      summarizeGroup([
        { state: { unread: failed }, running: true },
        { state: { pending: choice }, running: false },
      ]),
    ).toEqual({ kind: 'choice', count: 2 });
    expect(summarizeGroup([{ state: { unread: done }, running: false }])).toEqual({ kind: 'done', count: 0 });
    expect(summarizeGroup([{ state: undefined, running: false }])).toBeUndefined();
    expect(summarizeGroup([])).toBeUndefined();
  });
});
