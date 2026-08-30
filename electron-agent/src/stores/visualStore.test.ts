import { describe, it, expect, beforeEach } from 'vitest';
import { useVisualStore } from './visualStore';

describe('visualStore', () => {
  beforeEach(() => {
    useVisualStore.setState({ html: null, mode: null, pending: false, sessionId: 0, requestId: null });
  });

  it('setVisual 更新 html/mode/sessionId，不改变 pending', () => {
    useVisualStore.getState().setVisual('<h2>Test</h2>', 'inline');
    const s = useVisualStore.getState();
    expect(s.html).toBe('<h2>Test</h2>');
    expect(s.mode).toBe('inline');
    expect(s.sessionId).toBe(1);
    // setVisual 不改变 pending
    expect(s.pending).toBe(false);
  });

  it('setPending 更新 pending 和 requestId', () => {
    useVisualStore.getState().setPending(true, 'req-123');
    const s = useVisualStore.getState();
    expect(s.pending).toBe(true);
    expect(s.requestId).toBe('req-123');
  });

  it('clearVisual 重置所有状态', () => {
    useVisualStore.getState().setVisual('<h2>Test</h2>', 'panel');
    useVisualStore.getState().setPending(true, 'req-1');
    useVisualStore.getState().clearVisual();
    const s = useVisualStore.getState();
    expect(s.html).toBeNull();
    expect(s.pending).toBe(false);
    expect(s.requestId).toBeNull();
  });

  it('sessionId 每次 setVisual 递增', () => {
    useVisualStore.getState().setVisual('a', 'inline');
    useVisualStore.getState().setVisual('b', 'panel');
    expect(useVisualStore.getState().sessionId).toBe(2);
  });
});
