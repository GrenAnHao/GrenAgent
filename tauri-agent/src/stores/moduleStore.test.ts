import { beforeEach, describe, expect, it } from 'vitest';
import { useModuleStore } from './moduleStore';

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
});

describe('moduleStore', () => {
  it('defaults to chat module', () => {
    expect(useModuleStore.getState().activeModule).toBe('chat');
  });

  it('setActiveModule switches the active module', () => {
    useModuleStore.getState().setActiveModule('knowledge');
    expect(useModuleStore.getState().activeModule).toBe('knowledge');
  });
});
