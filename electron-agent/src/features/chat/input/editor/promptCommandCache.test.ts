// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listPromptCommands } = vi.hoisted(() => ({ listPromptCommands: vi.fn() }));
vi.mock('../../../../lib/promptLibraryIo', () => ({ listPromptCommands }));

import { findParamTemplate, getCachedPromptCommands, invalidatePromptCommands, loadPromptCommands } from './promptCommandCache';

const refactor = { name: 'refactor', description: '', body: '{file}', params: [{ name: 'file' }], path: '/p/refactor.md' };
const review = { name: 'review', description: '', body: 'x', params: [], path: '/p/review.md' };

beforeEach(() => {
  invalidatePromptCommands();
  listPromptCommands.mockReset();
});

describe('promptCommandCache', () => {
  it('并发只请求一次，加载后同步可读', async () => {
    listPromptCommands.mockResolvedValue([refactor, review]);
    await Promise.all([loadPromptCommands(), loadPromptCommands()]);
    expect(listPromptCommands).toHaveBeenCalledTimes(1);
    expect(getCachedPromptCommands()).toHaveLength(2);
    expect(findParamTemplate('refactor')).toBe(refactor);
    expect(findParamTemplate('review')).toBeUndefined();
  });

  it('请求失败返回空列表，不抛错', async () => {
    listPromptCommands.mockRejectedValue(new Error('boom'));
    expect(await loadPromptCommands()).toEqual([]);
  });

  it('invalidate 后重新请求', async () => {
    listPromptCommands.mockResolvedValue([review]);
    await loadPromptCommands();
    invalidatePromptCommands();
    await loadPromptCommands();
    expect(listPromptCommands).toHaveBeenCalledTimes(2);
  });
});
