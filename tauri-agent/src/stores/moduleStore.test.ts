import { beforeEach, describe, expect, it } from 'vitest';
import { useModuleStore } from './moduleStore';

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat', activeWorkspaceView: 'chat' });
});

describe('moduleStore', () => {
  it('defaults to chat module and chat workspace view', () => {
    expect(useModuleStore.getState().activeModule).toBe('chat');
    expect(useModuleStore.getState().activeWorkspaceView).toBe('chat');
  });

  it('setActiveModule switches the active global module', () => {
    useModuleStore.getState().setActiveModule('settings');
    expect(useModuleStore.getState().activeModule).toBe('settings');
  });

  it('setActiveWorkspaceView switches the active workspace view', () => {
    useModuleStore.getState().setActiveWorkspaceView('knowledge');
    expect(useModuleStore.getState().activeWorkspaceView).toBe('knowledge');
  });
});
