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

  it('clears the previous card while loading, and opens restored only once with the real draft', async () => {
    const draft = {
      toolCallId: 'tc1',
      selected: { q1: ['o1'] },
      customTexts: {},
      extraText: 'note',
      extraImages: [],
    };
    let resolveDraft!: (value: typeof draft) => void;
    readAskUserDraft.mockReturnValue(
      new Promise<typeof draft>((resolve) => {
        resolveDraft = resolve;
      }),
    );

    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'old-tc',
      data,
      mode: 'restored',
      toolCallId: 'old-tc',
      sessionPath: '/s/old.jsonl',
    });

    restoreInlineQuestionOnLoad('/ws', pendingMsgs, '/s/a.jsonl');
    await vi.waitFor(() => expect(readAskUserDraft).toHaveBeenCalledWith('/ws', 'tc1'));

    const mid = useInlineQuestionStore.getState().byWorkspace['/ws'];
    // 旧卡已清；草稿未就绪前不得出现同 toolCallId 且 draft:null 的中间 restored。
    expect(mid?.id).not.toBe('old-tc');
    expect(
      mid != null && mid.id === 'tc1' && mid.mode === 'restored' && mid.draft === null,
    ).toBe(false);
    expect(mid).toBeUndefined();

    resolveDraft(draft);
    await vi.waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toMatchObject({
        id: 'tc1',
        mode: 'restored',
        toolCallId: 'tc1',
        sessionPath: '/s/a.jsonl',
        draft,
      });
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

  it('drops a stale restore when a newer restore starts while the draft is still loading', async () => {
    let resolveFirst!: (value: null) => void;
    readAskUserDraft.mockImplementation((_ws: string, toolCallId: string) => {
      if (toolCallId === 'tc1') {
        return new Promise<null>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(null);
    });

    restoreInlineQuestionOnLoad('/ws', pendingMsgs, '/s/a.jsonl');
    await vi.waitFor(() => expect(readAskUserDraft).toHaveBeenCalledWith('/ws', 'tc1'));

    const laterMsgs = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc2',
            name: 'ask_user',
            arguments: {
              questions: [{ question: '第二题', options: ['丙'] }],
            },
          },
        ],
      },
    ];
    restoreInlineQuestionOnLoad('/ws', laterMsgs, '/s/b.jsonl');
    await vi.waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toMatchObject({
        id: 'tc2',
        mode: 'restored',
        sessionPath: '/s/b.jsonl',
      });
    });

    resolveFirst(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toMatchObject({
      id: 'tc2',
      mode: 'restored',
      sessionPath: '/s/b.jsonl',
    });
  });

  it('clears a non-live overlay when questions cannot be normalized', async () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'old',
      data,
      mode: 'restored',
      toolCallId: 'old',
    });

    const badMsgs = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc-bad',
            name: 'ask_user',
            arguments: { questions: [{ question: '   ', options: [] }] },
          },
        ],
      },
    ];
    restoreInlineQuestionOnLoad('/ws', badMsgs, '/s/a.jsonl');
    await Promise.resolve();

    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toBeUndefined();
  });

  it('keeps a live overlay when questions cannot be normalized', async () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'live-3',
      data,
      mode: 'live',
    });

    const badMsgs = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc-bad',
            name: 'ask_user',
            arguments: { questions: [{ question: '', options: [] }] },
          },
        ],
      },
    ];
    restoreInlineQuestionOnLoad('/ws', badMsgs, '/s/a.jsonl');
    await Promise.resolve();

    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toMatchObject({
      id: 'live-3',
      mode: 'live',
    });
  });
});
