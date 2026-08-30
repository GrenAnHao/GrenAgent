import { beforeEach, describe, expect, it } from 'vitest';
import { useInlineQuestionStore } from './inlineQuestionStore';
import type { QSData } from '../components/QuestionSelector/answers';

const data: QSData = { kind: 'questions', id: 'q1', questions: [] };

beforeEach(() => useInlineQuestionStore.setState({ byWorkspace: {} }));

describe('inlineQuestionStore', () => {
  it('stores one request per workspace and clears by matching id', () => {
    useInlineQuestionStore.getState().setRequest({ workspace: '/ws', id: 'u1', data });
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']?.id).toBe('u1');

    // 不同 id 不清
    useInlineQuestionStore.getState().clear('/ws', 'other');
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']?.id).toBe('u1');

    // 匹配 id 才清
    useInlineQuestionStore.getState().clear('/ws', 'u1');
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toBeUndefined();
  });

  it('new request overrides the previous one per workspace', () => {
    useInlineQuestionStore.getState().setRequest({ workspace: '/ws', id: 'u1', data });
    useInlineQuestionStore.getState().setRequest({ workspace: '/ws', id: 'u2', data });
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']?.id).toBe('u2');
  });
});
