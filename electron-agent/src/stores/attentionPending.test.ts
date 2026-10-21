import { describe, expect, it } from 'vitest';
import { derivePending, type PendingSources } from './attentionPending';
import type { UiPromptItem } from './uiPromptStore';
import type { InlineQuestionItem } from './inlineQuestionStore';
import type { VisualEntry } from './visualStore';
import { sessionControlKey } from './modeStore';

const WS = 'D:/repo';
const A = 'D:/repo/.pi/a.jsonl';
const B = 'D:/repo/.pi/b.jsonl';
const key = sessionControlKey;

const prompt = (id: string, sessionPath?: string, extra: Record<string, unknown> = {}): UiPromptItem => ({
  workspace: WS,
  request: { id, method: 'confirm', title: `标题 ${id}`, ...extra },
  ...(sessionPath ? { sessionPath } : {}),
});
const inline = (sessionPath?: string): InlineQuestionItem => ({
  workspace: WS,
  id: 'q1',
  mode: 'live',
  data: { kind: 'questions', id: 'q1', questions: [{ id: 'x', title: '用哪个方案？', options: [] }] } as never,
  ...(sessionPath ? { sessionPath } : {}),
});
const visual = (sessionPath: string | null, pending: boolean): VisualEntry => ({
  sessionPath,
  workspace: WS,
  html: '<p></p>',
  mode: 'inline',
  rev: 1,
  pending,
  requestId: pending ? 'v1' : null,
});
const sources = (over: Partial<PendingSources>): PendingSources => ({
  prompts: [],
  inline: [],
  visual: [],
  stashed: [],
  ownerOf: () => undefined,
  ...over,
});

describe('derivePending', () => {
  it('maps prompts to approval and ask_user / visual to choice', () => {
    const out = derivePending(
      sources({ prompts: [prompt('p1', A)], inline: [inline(B)], visual: [visual('D:/repo/.pi/c.jsonl', true)] }),
    );
    expect(out[key(A)]).toEqual({ path: A, workspace: WS, kind: 'approval', title: '标题 p1' });
    expect(out[key(B)]).toEqual({ path: B, workspace: WS, kind: 'choice', title: '用哪个方案？' });
    expect(out[key('D:/repo/.pi/c.jsonl')]).toMatchObject({ kind: 'choice', title: '视觉设计等待确认' });
  });

  it('falls back to the request message when there is no title', () => {
    const out = derivePending(sources({ prompts: [prompt('p1', A, { title: undefined, message: '允许联网？' })] }));
    expect(out[key(A)].title).toBe('允许联网？');
  });

  it('lets approval win over choice in the same session', () => {
    const out = derivePending(sources({ inline: [inline(A)], prompts: [prompt('p1', A)] }));
    expect(out[key(A)]).toMatchObject({ kind: 'approval', title: '标题 p1' });
  });

  it('keeps the first approval title in queue order', () => {
    const out = derivePending(sources({ prompts: [prompt('head', A), prompt('next', A)] }));
    expect(out[key(A)].title).toBe('标题 head');
  });

  it('attributes requests without sessionPath to ownerOf', () => {
    const owned = derivePending(sources({ prompts: [prompt('p1')], visual: [visual(null, true)], ownerOf: () => A }));
    expect(owned[key(A)]).toMatchObject({ path: A, kind: 'approval' });
    const orphan = derivePending(sources({ prompts: [prompt('p1')], ownerOf: () => undefined }));
    expect(orphan).toEqual({});
  });

  it('includes stashed requests of background sessions', () => {
    const out = derivePending(
      sources({
        stashed: [
          { sessionPath: A, prompts: [prompt('s1', A)] },
          { sessionPath: B, inline: inline(B), prompts: [] },
        ],
      }),
    );
    expect(out[key(A)]).toMatchObject({ kind: 'approval', title: '标题 s1', workspace: WS });
    expect(out[key(B)]).toMatchObject({ kind: 'choice', title: '用哪个方案？', workspace: WS });
  });

  it('ignores visual entries that are not pending', () => {
    expect(derivePending(sources({ visual: [visual(A, false)] }))).toEqual({});
  });

  it('keys differently spelled paths as one session', () => {
    const out = derivePending(sources({ prompts: [prompt('p1', 'D:\\Repo\\.pi\\a.jsonl')], inline: [inline('d:/repo/.pi/a.jsonl')] }));
    expect(Object.keys(out)).toEqual([key(A)]);
  });
});
