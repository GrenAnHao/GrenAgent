import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readAskUserDraft } = vi.hoisted(() => ({
  readAskUserDraft: vi.fn(),
}));

vi.mock('../lib/pi', () => ({
  pi: { readAskUserDraft },
}));

import { useInlineQuestionStore } from './inlineQuestionStore';
import { restoreInlineQuestionOnLoad } from './restoreInlineQuestionOnLoad';
import type { QSData } from '../components/QuestionSelector/answers';

const data: QSData = {
  kind: 'questions',
  id: 'q1',
  questions: [{ id: 'q1', title: '选哪个', options: [{ id: 'o1', label: '甲' }] }],
};

const pendingMsgs = [
  {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: 'tc1',
        name: 'ask_user',
        arguments: {
          questions: [{ question: '选哪个', options: ['甲', '乙'] }],
          allowExtra: true,
        },
      },
    ],
  },
];

beforeEach(() => {
  useInlineQuestionStore.setState({ byWorkspace: {} });
  readAskUserDraft.mockReset();
});

describe('restoreInlineQuestionOnLoad', () => {
  it('opens a restored overlay with draft when pending ask_user exists', async () => {
    const draft = {
      toolCallId: 'tc1',
      selected: { q1: ['o1'] },
      customTexts: {},
      extraText: 'note',
      extraImages: [],
    };
    readAskUserDraft.mockResolvedValue(draft);

    restoreInlineQuestionOnLoad('/ws', pendingMsgs, '/s/a.jsonl');
    await vi.waitFor(() => {
      const item = useInlineQuestionStore.getState().byWorkspace['/ws'];
      expect(item).toMatchObject({
        id: 'tc1',
        mode: 'restored',
        toolCallId: 'tc1',
        sessionPath: '/s/a.jsonl',
        draft,
      });
      expect(item?.data.kind).toBe('questions');
      expect(item?.data.questions[0]?.title).toBe('选哪个');
    });
    expect(readAskUserDraft).toHaveBeenCalledWith('/ws', 'tc1');
  });

  it('does not overwrite a live waiting overlay', async () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'live-1',
      data,
      mode: 'live',
    });
    readAskUserDraft.mockResolvedValue(null);

    restoreInlineQuestionOnLoad('/ws', pendingMsgs, '/s/a.jsonl');
    await Promise.resolve();
    await Promise.resolve();

    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toMatchObject({
      id: 'live-1',
      mode: 'live',
    });
    expect(readAskUserDraft).not.toHaveBeenCalled();
  });

  it('does not replace a live request that arrives while the draft is still loading', async () => {
    let resolveDraft!: (value: null) => void;
    readAskUserDraft.mockReturnValue(
      new Promise<null>((resolve) => {
        resolveDraft = resolve;
      }),
    );

    restoreInlineQuestionOnLoad('/ws', pendingMsgs, '/s/a.jsonl');
    await vi.waitFor(() => expect(readAskUserDraft).toHaveBeenCalled());

    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'live-2',
      data,
      mode: 'live',
    });

    resolveDraft(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toMatchObject({
      id: 'live-2',
      mode: 'live',
    });
  });

  it('clears a non-live overlay when there is no pending ask_user', async () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'old',
      data,
      mode: 'restored',
      toolCallId: 'old',
    });

    restoreInlineQuestionOnLoad('/ws', [{ role: 'user', content: 'hi' }], '/s/a.jsonl');
    await Promise.resolve();

    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toBeUndefined();
  });

  it('still opens the overlay when draft read fails or sessionPath is empty', async () => {
    readAskUserDraft.mockRejectedValue(new Error('boom'));

    restoreInlineQuestionOnLoad('/ws', pendingMsgs, '/s/a.jsonl');
    await vi.waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toMatchObject({
        id: 'tc1',
        mode: 'restored',
        draft: null,
      });
    });

    useInlineQuestionStore.setState({ byWorkspace: {} });
    restoreInlineQuestionOnLoad('/ws', pendingMsgs, null);
    await vi.waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toMatchObject({
        id: 'tc1',
        mode: 'restored',
        draft: null,
        sessionPath: undefined,
      });
    });
    expect(readAskUserDraft).toHaveBeenCalledTimes(1);
  });
});
