import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceTabs } from './WorkspaceTabs';
import { useModuleStore } from '../../stores/moduleStore';

beforeEach(() => {
  useModuleStore.setState({ activeWorkspaceView: 'chat' });
});

afterEach(() => {
  cleanup();
});

describe('WorkspaceTabs', () => {
  it('renders all workspace view tabs', () => {
    render(<WorkspaceTabs />);
    for (const id of ['chat', 'knowledge']) {
      expect(screen.getByTestId(`workspace-tab-${id}`)).toBeTruthy();
    }
  });

  it('does not render memory as a workspace tab (memory is global)', () => {
    render(<WorkspaceTabs />);
    expect(screen.queryByTestId('workspace-tab-memory')).toBeNull();
  });

  it('switches the active workspace view on click', () => {
    render(<WorkspaceTabs />);
    fireEvent.click(screen.getByTestId('workspace-tab-knowledge'));
    expect(useModuleStore.getState().activeWorkspaceView).toBe('knowledge');
  });

  it('marks the active view with aria-pressed', () => {
    useModuleStore.setState({ activeWorkspaceView: 'knowledge' });
    render(<WorkspaceTabs />);
    expect(screen.getByTestId('workspace-tab-knowledge').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('workspace-tab-chat').getAttribute('aria-pressed')).toBe('false');
  });
});
