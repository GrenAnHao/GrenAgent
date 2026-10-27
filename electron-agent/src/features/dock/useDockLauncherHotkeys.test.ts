import { beforeEach, describe, expect, it } from 'vitest';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { runDockLauncherHotkey } from './useDockLauncherHotkeys';

function reset() {
  localStorage.clear();
  useDockStore.setState({ tabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
}

describe('runDockLauncherHotkey', () => {
  beforeEach(reset);

  it('opens a right browser tab for a project session', () => {
    runDockLauncherHotkey('browser', {
      cwd: '/repo',
      worksDir: '/home/.pi/agent/works',
      workspace: '/repo',
    });
    const tabs = useDockStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: 'browser', region: 'right' });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('opens the file tab on the conversation directory for Ctrl+P in a casual session', () => {
    runDockLauncherHotkey('file', {
      cwd: '/home/.pi/agent/works/u1',
      worksDir: '/home/.pi/agent/works',
      workspace: '/home/.pi/agent/works/u1',
    });
    const tabs = useDockStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      kind: 'file',
      region: 'right',
      payload: { workspace: '/home/.pi/agent/works/u1' },
    });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('ignores Ctrl+P when there is no directory', () => {
    runDockLauncherHotkey('file', { cwd: null, worksDir: '/home/.pi/agent/works', workspace: '' });
    expect(useDockStore.getState().tabs).toHaveLength(0);
  });

  it('ignores review in a casual session', () => {
    runDockLauncherHotkey('review', {
      cwd: '/home/.pi/agent/works/u1',
      worksDir: '/home/.pi/agent/works',
      workspace: '/home/.pi/agent/works/u1',
    });
    expect(useDockStore.getState().tabs).toHaveLength(0);
  });
});
