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

  it('ignores Ctrl+P in a casual session', () => {
    runDockLauncherHotkey('file', {
      cwd: '/home/.pi/agent/works/u1',
      worksDir: '/home/.pi/agent/works',
      workspace: '/home/.pi/agent/works/u1',
    });
    expect(useDockStore.getState().tabs).toHaveLength(0);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
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
