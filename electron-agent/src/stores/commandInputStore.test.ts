import { afterEach, describe, expect, it } from 'vitest';
import { useCommandInputStore } from './commandInputStore';

afterEach(() => {
  useCommandInputStore.setState({ bySession: {} });
});

describe('commandInputStore', () => {
  it('append 后按 session 分桶，dropSession 后消失', () => {
    useCommandInputStore.getState().append('s1', { command: '/goal', rest: '写完' });

    const rows = useCommandInputStore.getState().list('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'command-input',
      command: '/goal',
      rest: '写完',
    });
    expect(rows[0].id).toBeTruthy();
    expect(useCommandInputStore.getState().list('other')).toEqual([]);

    useCommandInputStore.getState().dropSession('s1');
    expect(useCommandInputStore.getState().list('s1')).toEqual([]);
  });

  it('两次 append 的 id 非空且不重复', () => {
    useCommandInputStore.getState().append('s1', { command: '/goal', rest: '写完' });
    useCommandInputStore.getState().append('s1', { command: '/goal', rest: '再写' });
    const rows = useCommandInputStore.getState().list('s1');
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBeTruthy();
    expect(rows[1].id).toBeTruthy();
    expect(rows[0].id).not.toBe(rows[1].id);
  });
});
