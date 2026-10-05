import { afterEach, describe, expect, it } from 'vitest';
import {
  clearStashedUiRequestsForTest,
  dropStashedUiRequests,
  hasStashedUiRequests,
  parkVisibleUiRequests,
  restoreStashedUiRequests,
  stashUiPrompt,
} from './backgroundUiRequests';
import { useInlineQuestionStore } from './inlineQuestionStore';
import { useUiPromptStore } from './uiPromptStore';

const WS = '/ws';
const A = '/ws/a.jsonl';
const B = '/ws/b.jsonl';
const confirm = (id: string) => ({ id, method: 'confirm', title: id }) as never;

afterEach(() => {
  clearStashedUiRequestsForTest();
  useUiPromptStore.setState({ byWorkspace: {} });
  useInlineQuestionStore.setState({ byWorkspace: {} });
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

  it('已回答（已从画面清掉）的请求切走再切回不会复活', () => {
    useUiPromptStore.getState().setRequest({ workspace: WS, request: confirm('p3'), sessionPath: A });
    useUiPromptStore.getState().clear(WS, 'p3');
    parkVisibleUiRequests(WS, A);
    restoreStashedUiRequests(WS, A);
    expect(useUiPromptStore.getState().byWorkspace[WS]).toBeUndefined();
  });
});
