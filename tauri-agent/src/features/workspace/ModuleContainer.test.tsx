import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModuleContainer } from './ModuleContainer';
import { useModuleStore } from '../../stores/moduleStore';

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
});

afterEach(() => {
  cleanup();
});

describe('ModuleContainer', () => {
  it('renders chat content when chat module is active', () => {
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('CHAT_CONTENT')).toBeTruthy();
  });

  it('renders placeholder with module title for non-chat modules', () => {
    useModuleStore.setState({ activeModule: 'knowledge' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    const panel = screen.getByTestId('placeholder-panel');
    expect(panel.textContent).toContain('知识库');
    expect(screen.queryByText('CHAT_CONTENT')).toBeNull();
  });
});
