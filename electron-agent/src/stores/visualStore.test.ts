import { describe, it, expect, beforeEach } from 'vitest';
import { settleVisualOnTurnEnd, useVisualStore, visualKeyOf, type VisualOwner } from './visualStore';

const A: VisualOwner = { sessionPath: 'C:/ws/.sessions/a.jsonl', workspace: 'C:/ws' };
const B: VisualOwner = { sessionPath: 'C:/ws/.sessions/b.jsonl', workspace: 'C:/other' };

describe('visualStore pending lifecycle', () => {
  beforeEach(() => {
    useVisualStore.setState({ entries: {}, seq: 0, submittedIds: new Set() });
  });
  const pending = (o: VisualOwner) => useVisualStore.getState().entries[visualKeyOf(o)];
  const end = (sessionPath: string | undefined, extra: Record<string, unknown> = {}, event: Record<string, unknown> = { type: 'agent_end', messages: [] }) =>
    settleVisualOnTurnEnd({ workspace: 'C:/ws', sessionPath, event, ...extra } as never);

  it('settles pending when the owning session ends its turn', () => {
    useVisualStore.getState().setVisual(A, '<p>x</p>', 'panel');
    useVisualStore.getState().setPending(A, true, 'v1');
    useVisualStore.getState().setPending(B, true, 'v2');
    end('C:\\WS\\.sessions\\A.jsonl', {}, { type: 'agent_end', messages: [], willRetry: true });
    end(A.sessionPath!, { source: 'goal' });
    end(undefined);
    expect(pending(A)).toMatchObject({ pending: true, requestId: 'v1' });
    end('C:\\WS\\.sessions\\A.jsonl');
    expect(pending(A)).toMatchObject({ pending: false, requestId: null, html: '<p>x</p>' });
    expect(pending(B)).toMatchObject({ pending: true });
  });

  it('settles on agent_settled and for a draft owner of the same workspace', () => {
    const draft: VisualOwner = { sessionPath: null, workspace: 'C:/ws' };
    useVisualStore.getState().setPending(draft, true, 'v3');
    end(A.sessionPath!, {}, { type: 'agent_settled' });
    expect(pending(draft)).toMatchObject({ pending: false });
  });

  it('dismissRequest clears pending by request id', () => {
    useVisualStore.getState().setPending(A, true, 'v1');
    useVisualStore.getState().setPending(B, true, 'v2');
    useVisualStore.getState().dismissRequest('v2');
    expect(pending(B)).toMatchObject({ pending: false, requestId: null });
    expect(pending(A)).toMatchObject({ pending: true });
    const before = useVisualStore.getState().entries;
    useVisualStore.getState().dismissRequest('missing');
    expect(useVisualStore.getState().entries).toBe(before);
  });
});

describe('visualStore', () => {
  beforeEach(() => {
    useVisualStore.setState({ entries: {}, seq: 0, submittedIds: new Set() });
  });

  it('setVisual 记在发起会话名下，rev 递增，不改变 pending', () => {
    useVisualStore.getState().setVisual(A, '<h2>Test</h2>', 'inline');
    const e = useVisualStore.getState().entries[visualKeyOf(A)];
    expect(e).toMatchObject({ html: '<h2>Test</h2>', mode: 'inline', rev: 1, pending: false, workspace: 'C:/ws' });
  });

  it('setPending 记 pending 和 requestId，并保留页面', () => {
    useVisualStore.getState().setVisual(A, '<p>x</p>', 'panel');
    useVisualStore.getState().setPending(A, true, 'req-123');
    expect(useVisualStore.getState().entries[visualKeyOf(A)]).toMatchObject({
      html: '<p>x</p>',
      pending: true,
      requestId: 'req-123',
    });
  });

  it('请求先于页面到达时先占位，页面随后补上且不丢请求', () => {
    useVisualStore.getState().setPending(A, true, 'req-early');
    expect(useVisualStore.getState().entries[visualKeyOf(A)]).toMatchObject({ html: '', pending: true });
    useVisualStore.getState().setVisual(A, '<p>late</p>', 'panel');
    expect(useVisualStore.getState().entries[visualKeyOf(A)]).toMatchObject({
      html: '<p>late</p>',
      pending: true,
      requestId: 'req-early',
    });
  });

  it('两个会话的视觉设计并存，互不覆盖（含不同工作区）', () => {
    const s = useVisualStore.getState();
    s.setVisual(A, '<p>A</p>', 'panel');
    s.setPending(A, true, 'req-a');
    s.setVisual(B, '<p>B</p>', 'panel');
    s.setPending(B, true, 'req-b');
    const { entries } = useVisualStore.getState();
    expect(entries[visualKeyOf(A)]).toMatchObject({ html: '<p>A</p>', requestId: 'req-a', workspace: 'C:/ws' });
    expect(entries[visualKeyOf(B)]).toMatchObject({ html: '<p>B</p>', requestId: 'req-b', workspace: 'C:/other' });
  });

  it('路径写法不同（大小写 / 斜杠）仍是同一个会话', () => {
    expect(visualKeyOf({ sessionPath: 'C:\\ws\\.sessions\\A.jsonl', workspace: 'C:/ws' })).toBe(
      visualKeyOf({ sessionPath: 'c:/ws/.sessions/a.jsonl', workspace: 'C:/ws' }),
    );
  });

  it('clearVisual 只清自己的条目', () => {
    const s = useVisualStore.getState();
    s.setVisual(A, 'a', 'panel');
    s.setVisual(B, 'b', 'panel');
    s.clearVisual(A);
    const { entries } = useVisualStore.getState();
    expect(entries[visualKeyOf(A)]).toBeUndefined();
    expect(entries[visualKeyOf(B)]?.html).toBe('b');
  });

  it('rev 每次 setVisual 全局递增', () => {
    const s = useVisualStore.getState();
    s.setVisual(A, 'a', 'inline');
    s.setVisual(B, 'b', 'panel');
    s.setVisual(A, 'a2', 'inline');
    expect(useVisualStore.getState().entries[visualKeyOf(A)]?.rev).toBe(3);
    expect(useVisualStore.getState().seq).toBe(3);
  });
});
