import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import { AddMcpModal } from './AddMcpModal';

// jsdom 下 @lobehub/ui Modal + antd-style 多次重渲染较慢，放宽超时避免误判。
vi.setConfig({ testTimeout: 20000 });

afterEach(cleanup);

const renderModal = (props: Partial<Parameters<typeof AddMcpModal>[0]> = {}) =>
  render(
    <ThemeProvider>
      <AddMcpModal
        open
        existingNames={[]}
        onSubmitForm={props.onSubmitForm ?? vi.fn()}
        onSubmitImport={props.onSubmitImport ?? vi.fn()}
        onClose={props.onClose ?? vi.fn()}
        editing={props.editing}
      />
    </ThemeProvider>,
  );

describe('AddMcpModal', () => {
  it('submits a STDIO form config', () => {
    const onSubmitForm = vi.fn();
    renderModal({ onSubmitForm });
    fireEvent.change(screen.getByTestId('mcp-name'), { target: { value: 'gh' } });
    fireEvent.change(screen.getByTestId('mcp-command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByTestId('mcp-submit'));
    expect(onSubmitForm).toHaveBeenCalledWith({ name: 'gh', config: { command: 'npx' } }, true);
  });

  it('shows validation error for empty name', () => {
    const onSubmitForm = vi.fn();
    renderModal({ onSubmitForm });
    fireEvent.click(screen.getByTestId('mcp-submit'));
    expect(onSubmitForm).not.toHaveBeenCalled();
    expect(screen.getByText(/名称不能为空/)).toBeTruthy();
  });

  it('switches to REMOTE and submits url + bearer', () => {
    const onSubmitForm = vi.fn();
    renderModal({ onSubmitForm });
    fireEvent.click(screen.getByTestId('mcp-type-remote'));
    fireEvent.change(screen.getByTestId('mcp-name'), { target: { value: 'r' } });
    fireEvent.change(screen.getByTestId('mcp-url'), { target: { value: 'https://x.com' } });
    fireEvent.click(screen.getByTestId('mcp-auth-bearer'));
    fireEvent.change(screen.getByTestId('mcp-token'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('mcp-submit'));
    expect(onSubmitForm).toHaveBeenCalledWith(
      { name: 'r', config: { url: 'https://x.com', headers: { Authorization: 'Bearer abc' } } },
      true,
    );
  });

  it('imports JSON with multiple servers', () => {
    const onSubmitImport = vi.fn();
    renderModal({ onSubmitImport });
    fireEvent.click(screen.getByTestId('mcp-tab-json'));
    fireEvent.change(screen.getByTestId('mcp-json'), {
      target: { value: '{"mcpServers":{"a":{"command":"npx"},"b":{"url":"https://y"}}}' },
    });
    fireEvent.click(screen.getByTestId('mcp-import'));
    expect(onSubmitImport).toHaveBeenCalledWith([
      { name: 'a', config: { command: 'npx' } },
      { name: 'b', config: { url: 'https://y' } },
    ]);
  });
});
