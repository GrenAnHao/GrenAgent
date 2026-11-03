import { describe, expect, it } from 'vitest';
import { validateRequest } from '../../vendor/repo-wiki/packages/contracts/src/index';
describe('host knowledge public contracts', () => {
  it('accepts state reads and revision-bound actions without exposing publisher authority', () => {
    expect(() => validateRequest('knowledge', { project_id: 'project', target: 'wiki' })).not.toThrow();
    expect(() => validateRequest('action', { project_id: 'project', task_id: 'task-1', action: 'pause', expected_revision: 3, request_id: 'request-1' })).not.toThrow();
    expect(() => validateRequest('action', { project_id: 'project', task_id: 'task-1', action: 'pause', expected_revision: 3, request_id: 'r', fence: {} })).toThrow();
    expect(() => validateRequest('drafts', { project_id: 'project', task_id: 'task-1' })).not.toThrow();
  });
});
