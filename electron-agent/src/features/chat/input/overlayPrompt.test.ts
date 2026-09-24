import { afterEach, describe, expect, it, vi } from 'vitest';

const { respond, completeAskUser, deleteAskUserDraft, resolvePermission } = vi.hoisted(() => ({
  respond: vi.fn(() => Promise.resolve()),
  completeAskUser: vi.fn(() => Promise.resolve('ok' as const)),
  deleteAskUserDraft: vi.fn(() => Promise.resolve()),
  resolvePermission: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../lib/pi', () => ({
  extensionUiRespond: respond,
  completeAskUser,
  deleteAskUserDraft,
  pi: { resolvePermission, completeAskUser, deleteAskUserDraft },
}));

import { useInlineQuestionStore } from '../../../stores/inlineQuestionStore';
import { useUiPromptStore } from '../../../stores/uiPromptStore';
import {
  appendUiPromptReceipt,
  cancelPendingOverlay,
  parseUiPromptReceipt,
  shouldRenderUiPromptInOverlay,
} from './overlayPrompt';

afterEach(() => {
  respond.mockClear();
  completeAskUser.mockClear();
  deleteAskUserDraft.mockClear();
  resolvePermission.mockClear();
  useInlineQuestionStore.setState({ byWorkspace: {} });
  useUiPromptStore.setState({ byWorkspace: {} });
});

describe('shouldRenderUiPromptInOverlay', () => {
  it('excludes permission and approval selects', () => {
    expect(shouldRenderUiPromptInOverlay({ id: '1', method: 'select', source: 'permission', options: ['允许', '拒绝'] })).toBe(false);
    expect(shouldRenderUiPromptInOverlay({ id: '2', method: 'select', options: ['允许', '拒绝'] })).toBe(false);
    expect(shouldRenderUiPromptInOverlay({ id: '3', method: 'select', options: ['红', '蓝'] })).toBe(true);
    expect(shouldRenderUiPromptInOverlay({ id: '4', method: 'confirm', title: '删？' })).toBe(true);
    expect(shouldRenderUiPromptInOverlay({ id: '5', method: 'input', title: '名' })).toBe(true);
  });
});

describe('parseUiPromptReceipt', () => {
  it('parses answered and cancelled payloads', () => {
    expect(parseUiPromptReceipt(JSON.stringify({ outcome: 'answered', title: '选', value: '红' }))).toEqual({
      outcome: 'answered',
      title: '选',
      value: '红',
    });
    expect(parseUiPromptReceipt(JSON.stringify({ outcome: 'cancelled', title: '选' }))).toEqual({
      outcome: 'cancelled',
      title: '选',
    });
    expect(parseUiPromptReceipt('not-json')).toBeNull();
  });
});

describe('appendUiPromptReceipt', () => {
  it('appends a local notice with local- id', () => {
    const messages: Array<{ kind: string; id: string; customType?: string; content?: string }> = [];
    const setState = (fn: (s: { messages: typeof messages }) => { messages: typeof messages }) => {
      const next = fn({ messages });
      messages.splice(0, messages.length, ...next.messages);
    };
    appendUiPromptReceipt(setState, { outcome: 'confirmed', title: '信任', value: '确定' });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe('notice');
    expect(messages[0]?.customType).toBe('ui-prompt-receipt');
    expect(messages[0]?.id.startsWith('local-')).toBe(true);
    expect(JSON.parse(messages[0]!.content!)).toEqual({ outcome: 'confirmed', title: '信任', value: '确定' });
  });
});

describe('cancelPendingOverlay', () => {
  it('returns idle when nothing pending', async () => {
    expect(await cancelPendingOverlay('/ws')).toBe('idle');
    expect(respond).not.toHaveBeenCalled();
  });

  it('cancels ask_user and clears the store', async () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: { kind: 'questions', id: 'q1', questions: [] },
      mode: 'live',
    });
    expect(await cancelPendingOverlay('/ws')).toBe('cancelled');
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u1', cancelled: true });
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toBeUndefined();
  });

  it('completes restored ask_user without extensionUiRespond', async () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'q1',
      data: { kind: 'questions', id: 'q1', questions: [] },
      mode: 'restored',
      toolCallId: 'q1',
      sessionPath: '/tmp/s.jsonl',
    });
    expect(await cancelPendingOverlay('/ws')).toBe('cancelled');
    expect(completeAskUser).toHaveBeenCalledWith('/ws', 'q1', undefined, true);
    expect(respond).not.toHaveBeenCalled();
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toBeUndefined();
  });

  it('cancels overlay select and ignores approval', async () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'a1', method: 'select', options: ['允许', '拒绝'] },
    });
    expect(await cancelPendingOverlay('/ws')).toBe('idle');

    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 's1', method: 'select', title: '色', options: ['红', '蓝'] },
    });
    expect(await cancelPendingOverlay('/ws')).toBe('cancelled');
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 's1', cancelled: true });
  });

  it('cancels confirm with confirmed: false', async () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'c1', method: 'confirm', title: '删？' },
    });
    expect(await cancelPendingOverlay('/ws')).toBe('cancelled');
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'c1', confirmed: false });
  });

  it('returns failed and keeps the store when respond rejects', async () => {
    respond.mockRejectedValueOnce(new Error('down'));
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 's2', method: 'input', title: '名' },
    });
    expect(await cancelPendingOverlay('/ws')).toBe('failed');
    expect(useUiPromptStore.getState().byWorkspace['/ws']?.request.id).toBe('s2');
  });
});
