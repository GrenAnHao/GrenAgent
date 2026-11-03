import { beforeEach, describe, expect, it } from 'vitest';
import { registerModuleLeaveGuard, useModuleStore } from './moduleStore';

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

  it('keeps the only workspace view on chat', () => {
    useModuleStore.getState().setActiveWorkspaceView('chat');
    expect(useModuleStore.getState().activeWorkspaceView).toBe('chat');
  });

  it('protects Repo Wiki drafts until leaving is accepted and releases the guard on unmount', () => {
    useModuleStore.getState().setActiveModule('repoWiki');
    let accepted = false;
    let calls = 0;
    const release = registerModuleLeaveGuard('repoWiki', () => { calls++; return accepted; });
    useModuleStore.getState().setActiveModule('chat');
    expect(useModuleStore.getState().activeModule).toBe('repoWiki');
    useModuleStore.getState().setActiveModule('repoWiki');
    expect(calls).toBe(1);
    accepted = true;
    useModuleStore.getState().setActiveModule('chat');
    expect(useModuleStore.getState().activeModule).toBe('chat');
    release();
    accepted = false;
    useModuleStore.getState().setActiveModule('repoWiki');
    useModuleStore.getState().setActiveModule('settings');
    expect(useModuleStore.getState().activeModule).toBe('settings');
  });

  it('an older guard cleanup cannot clear a newer mounted guard', () => {
    useModuleStore.getState().setActiveModule('repoWiki');
    const stale = registerModuleLeaveGuard('repoWiki', () => true);
    const release = registerModuleLeaveGuard('repoWiki', () => false);
    stale();
    useModuleStore.getState().setActiveModule('chat');
    expect(useModuleStore.getState().activeModule).toBe('repoWiki');
    release();
  });
});
