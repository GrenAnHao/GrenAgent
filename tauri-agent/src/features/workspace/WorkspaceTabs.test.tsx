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
    for (const id of ['chat']) {
      expect(screen.getByTestId(`workspace-tab-${id}`)).toBeTruthy();
    }
  });

  it('does not render retired knowledge or memory workspace tabs', () => {
    render(<WorkspaceTabs />);
    expect(screen.queryByTestId('workspace-tab-knowledge')).toBeNull();
    expect(screen.queryByTestId('workspace-tab-memory')).toBeNull();
  });

  it('keeps chat as the active workspace view', () => {
    render(<WorkspaceTabs />);
    fireEvent.click(screen.getByTestId('workspace-tab-chat'));
    expect(useModuleStore.getState().activeWorkspaceView).toBe('chat');
  });

  it('marks the active view with aria-pressed', () => {
    useModuleStore.setState({ activeWorkspaceView: 'chat' });
    render(<WorkspaceTabs />);
    expect(screen.getByTestId('workspace-tab-chat').getAttribute('aria-pressed')).toBe('true');
  });
});
