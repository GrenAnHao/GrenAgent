import { afterEach, describe, expect, it } from 'vitest';
import {
  clearStashedUiRequestsForTest,
  dismissUiRequest,
  dropStashedUiRequests,
  hasStashedUiRequests,
  listStashedUiRequests,
  parkVisibleUiRequests,
  restoreStashedUiRequests,
  stashInlineQuestion,
  stashUiPrompt,
  useStashedUiRequestsVersion,
} from './backgroundUiRequests';
import { useInlineQuestionStore } from './inlineQuestionStore';
import { useUiPromptStore } from './uiPromptStore';

const WS = '/ws';
const A = '/ws/a.jsonl';
const B = '/ws/b.jsonl';
const confirm = (id: string) => ({ id, method: 'confirm', title: id }) as never;

afterEach(() => {
  clearStashedUiRequestsForTest();
  useUiPromptStore.setState({ byWorkspace: {}, waiting: {} });
  useInlineQuestionStore.setState({ byWorkspace: {} });
});

describe('backgroundUiRequests subscription', () => {
  const version = () => useStashedUiRequestsVersion.getState().version;

  it('bumps the version on every stash change and lists entries', () => {
    const v0 = version();
    stashUiPrompt(B, { workspace: WS, request: confirm('r1') });
    expect(version()).toBe(v0 + 1);
    expect(listStashedUiRequests()).toEqual([
      { sessionPath: B, prompts: [expect.objectContaining({ request: expect.objectContaining({ id: 'r1' }) })] },
    ]);
    dismissUiRequest('r1');
    expect(version()).toBe(v0 + 2);
    expect(listStashedUiRequests()).toEqual([]);
  });

  it('bumps after restored requests are back on screen', () => {
    stashUiPrompt(B, { workspace: WS, request: confirm('r9') });
    const seen: Array<string | undefined> = [];
    const unsub = useStashedUiRequestsVersion.subscribe(() => {
      seen.push(useUiPromptStore.getState().byWorkspace[WS]?.request.id);
    });
    restoreStashedUiRequests(WS, B);
    unsub();
    expect(seen).toEqual(['r9']);
  });

  it('bumps for inline stash, restore, drop and clear, but not for no-ops', () => {
    const inline = { workspace: WS, id: 'q1', data: { kind: 'questions', id: 'q1', questions: [] } as never, mode: 'live' as const };
    const v0 = version();
    stashInlineQuestion(A, inline);
    expect(version()).toBe(v0 + 1);
    restoreStashedUiRequests(WS, A);
    expect(version()).toBe(v0 + 2);
    restoreStashedUiRequests(WS, A);
    expect(version()).toBe(v0 + 2);
    stashUiPrompt(B, { workspace: WS, request: confirm('r2') });
    dropStashedUiRequests(B);
    expect(version()).toBe(v0 + 4);
    dropStashedUiRequests(B);
    dismissUiRequest('missing');
    expect(version()).toBe(v0 + 4);
    stashUiPrompt(B, { workspace: WS, request: confirm('r3') });
    clearStashedUiRequestsForTest();
    expect(version()).toBe(v0 + 6);
    expect(listStashedUiRequests()).toEqual([]);
  });
});

describe('backgroundUiRequests', () => {
  it('切走时收起画面上的请求，切回时放回', () => {
    useUiPromptStore.getState().setRequest({ workspace: WS, request: confirm('p1'), sessionPath: A });
    parkVisibleUiRequests(WS, A);
    expect(useUiPromptStore.getState().byWorkspace[WS]).toBeUndefined();
    expect(hasStashedUiRequests(A)).toBe(true);

    restoreStashedUiRequests(WS, A);
    expect(useUiPromptStore.getState().byWorkspace[WS]?.request.id).toBe('p1');
    expect(hasStashedUiRequests(A)).toBe(false);
  });

  it('不收起属于另一个会话的请求', () => {
    useUiPromptStore.getState().setRequest({ workspace: WS, request: confirm('pb'), sessionPath: B });
    parkVisibleUiRequests(WS, A);
    expect(useUiPromptStore.getState().byWorkspace[WS]?.request.id).toBe('pb');
  });

  it('会话这一轮结束后暂存的请求作废，切回时不再出现', () => {
    stashUiPrompt(B, { workspace: WS, request: confirm('p2') });
    dropStashedUiRequests(B);
    restoreStashedUiRequests(WS, B);
    expect(useUiPromptStore.getState().byWorkspace[WS]).toBeUndefined();
  });

  it('切走时排队中的请求也一起收起，切回时按原顺序排回去', () => {
    useUiPromptStore.getState().setRequest({ workspace: WS, request: confirm('a1'), sessionPath: A });
    useUiPromptStore.getState().setRequest({ workspace: WS, request: confirm('b1'), sessionPath: B });
    useUiPromptStore.getState().setRequest({ workspace: WS, request: confirm('a2'), sessionPath: A });
    parkVisibleUiRequests(WS, A);
    expect(useUiPromptStore.getState().byWorkspace[WS]?.request.id).toBe('b1');
    expect(useUiPromptStore.getState().waiting[WS]).toBeUndefined();

    useUiPromptStore.getState().clear(WS, 'b1');
    restoreStashedUiRequests(WS, A);
    expect(useUiPromptStore.getState().byWorkspace[WS]?.request.id).toBe('a1');
    expect(useUiPromptStore.getState().waiting[WS]?.map((i) => i.request.id)).toEqual(['a2']);
  });

  it('父会话这一轮结束时，子代理经它发来的审批不丢（它有自己的倒计时）', () => {
    const subagents = [{ agentId: 'sa-1', label: 'fix' }];
    stashUiPrompt(B, { workspace: WS, request: confirm('own') });
    stashUiPrompt(B, { workspace: WS, request: { id: 'child', method: 'select', options: ['拒绝'], subagents } as never });
    dropStashedUiRequests(B);
    restoreStashedUiRequests(WS, B);
    expect(useUiPromptStore.getState().byWorkspace[WS]?.request.id).toBe('child');
    expect(useUiPromptStore.getState().waiting[WS]).toBeUndefined();
  });

  it('会话进程退出时宿主已经不在，子代理的审批也一起丢掉', () => {
    const subagents = [{ agentId: 'sa-1', label: 'fix' }];
    stashUiPrompt(B, { workspace: WS, request: { id: 'child', method: 'select', options: ['拒绝'], subagents } as never });
    dropStashedUiRequests(B, { hostGone: true });
    expect(hasStashedUiRequests(B)).toBe(false);
  });

  it('宿主收回（dismiss）的请求从画面、队列和后台暂存里都摘掉', () => {
    useUiPromptStore.getState().setRequest({ workspace: WS, request: confirm('v1'), sessionPath: A });
    useUiPromptStore.getState().setRequest({ workspace: WS, request: confirm('v2'), sessionPath: A });
    stashUiPrompt(B, { workspace: WS, request: confirm('s1') });

    dismissUiRequest('v1');
    dismissUiRequest('s1');
    expect(useUiPromptStore.getState().byWorkspace[WS]?.request.id).toBe('v2');
    expect(hasStashedUiRequests(B)).toBe(false);
  });

  it('已回答（已从画面清掉）的请求切走再切回不会复活', () => {
    useUiPromptStore.getState().setRequest({ workspace: WS, request: confirm('p3'), sessionPath: A });
    useUiPromptStore.getState().clear(WS, 'p3');
    parkVisibleUiRequests(WS, A);
    restoreStashedUiRequests(WS, A);
    expect(useUiPromptStore.getState().byWorkspace[WS]).toBeUndefined();
  });
});
