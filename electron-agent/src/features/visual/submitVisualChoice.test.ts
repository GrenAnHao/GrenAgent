import { beforeEach, describe, expect, it, vi } from 'vitest';

const { respond } = vi.hoisted(() => ({ respond: vi.fn(() => Promise.resolve()) }));
vi.mock('../../lib/pi', () => ({ extensionUiRespond: respond }));

import { useVisualStore, visualKeyOf, type VisualOwner } from '../../stores/visualStore';
import { parseVisualChoiceMessage, submitVisualChoice } from './submitVisualChoice';

const A: VisualOwner = { sessionPath: 'C:/ws/a.jsonl', workspace: 'C:/ws' };
const B: VisualOwner = { sessionPath: 'C:/other/b.jsonl', workspace: 'C:/other' };

function seed(owner: VisualOwner, requestId: string) {
  useVisualStore.getState().setVisual(owner, '<p/>', 'panel');
  useVisualStore.getState().setPending(owner, true, requestId);
  return useVisualStore.getState().entries[visualKeyOf(owner)]!;
}

describe('submitVisualChoice', () => {
  beforeEach(() => {
    respond.mockClear();
    useVisualStore.setState({ entries: {}, seq: 0, submittedIds: new Set() });
  });

  it('writes back to the session that started the design (its workspace + request id), whatever is in front', () => {
    const a = seed(A, 'req-a');
    const b = seed(B, 'req-b'); // 另一个项目里的会话也在等确认

    expect(submitVisualChoice(a, { choice: 'ok', text: '可以' })).toBe(true);

    expect(respond).toHaveBeenCalledTimes(1);
    const calls = respond.mock.calls as unknown as Array<[string, { id: string; type: string; value: string }]>;
    const [workspace, response] = calls[0];
    expect(workspace).toBe('C:/ws');
    expect(response).toMatchObject({ type: 'extension_ui_response', id: 'req-a' });
    expect(JSON.parse(response.value)).toMatchObject({ choice: 'ok', text: '可以' });

    const { entries, submittedIds } = useVisualStore.getState();
    expect(entries[visualKeyOf(A)]?.pending).toBe(false);
    expect(submittedIds.has(a.rev)).toBe(true);
    // 另一个会话的等待不受影响
    expect(entries[visualKeyOf(B)]).toMatchObject({ pending: true, requestId: 'req-b' });
    expect(submittedIds.has(b.rev)).toBe(false);
  });

  it('does nothing when the design is not waiting for an answer', () => {
    useVisualStore.getState().setVisual(A, '<p/>', 'panel');
    const a = useVisualStore.getState().entries[visualKeyOf(A)]!;
    expect(submitVisualChoice(a, { choice: 'ok', text: '可以' })).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });

  it('carries an optional supplement and omits it when blank', () => {
    const a = seed(A, 'req-a');
    submitVisualChoice(a, { choice: '', text: '未选择（已跳过）', supplement: '  标题再大一点  ' });
    const calls = respond.mock.calls as unknown as Array<[string, { value: string }]>;
    expect(JSON.parse(calls[0][1].value)).toMatchObject({ choice: '', supplement: '标题再大一点' });

    const b = seed(B, 'req-b');
    submitVisualChoice(b, { choice: 'x', text: 'X', supplement: '   ' });
    expect(JSON.parse(calls[1][1].value)).not.toHaveProperty('supplement');
  });
});

describe('parseVisualChoiceMessage', () => {
  it('accepts an empty choice (optional selection) but not a missing one', () => {
    expect(parseVisualChoiceMessage({ type: 'visual-choice', choice: '', text: '未选择（已跳过）' })).toEqual({
      choice: '',
      text: '未选择（已跳过）',
    });
    expect(parseVisualChoiceMessage({ type: 'visual-choice' })).toBeNull();
    expect(parseVisualChoiceMessage({ type: 'other', choice: 'a' })).toBeNull();
    expect(parseVisualChoiceMessage(null)).toBeNull();
  });

  it('keeps a non-blank supplement', () => {
    expect(parseVisualChoiceMessage({ type: 'visual-choice', choice: 'a', text: 'A', supplement: '备注' })).toEqual({
      choice: 'a',
      text: 'A',
      supplement: '备注',
    });
  });
});
