import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openUrl } from '../../platform/runtime';
import { McpServerCard } from './McpServerCard';

vi.mock('../../platform/runtime', () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

afterEach(cleanup);

describe('McpServerCard', () => {
  it('shows transport, cached tool count and wires actions', () => {
    const onToggle = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onReload = vi.fn();
    render(
      <McpServerCard
        name="gh"
        config={{ command: 'npx' }}
        enabled
        cachedTools={Array.from({ length: 12 }, (_, i) => `mcp__gh__t${i}`)}
        onToggle={onToggle}
        onEdit={onEdit}
        onDelete={onDelete}
        onReload={onReload}
      />,
    );
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('stdio');
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('12 工具');
    expect(screen.getByTestId('mcp-toggle-gh').getAttribute('aria-checked')).toBe('true');
    const reload = screen.getByTestId('mcp-reload-gh');
    expect(reload.getAttribute('title')).toBe('重载');
    fireEvent.click(reload);
    expect(onReload).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mcp-edit-gh'));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mcp-delete-gh'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('disables reload when the server is not enabled or connecting', () => {
    const onReload = vi.fn();
    const { rerender } = render(
      <McpServerCard
        name="gh"
        config={{ command: 'npx' }}
        enabled={false}
        onToggle={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReload={onReload}
      />,
    );
    expect((screen.getByTestId('mcp-reload-gh') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('mcp-reload-gh'));
    expect(onReload).not.toHaveBeenCalled();

    rerender(
      <McpServerCard
        name="gh"
        config={{ command: 'npx' }}
        enabled
        runtimeStatus="connecting"
        onToggle={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReload={onReload}
      />,
    );
    expect((screen.getByTestId('mcp-reload-gh') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a login button and the login url when the server needs login', () => {
    render(
      <McpServerCard
        name="gh"
        config={{ url: 'https://mcp.example/sse' }}
        enabled
        runtimeStatus="needs-login"
        loginUrl="https://auth.example/login"
        onToggle={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('https://auth.example/login');
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('需要登录');
  });

  it('shows exposure and the short auth label', () => {
    const { rerender } = render(
      <McpServerCard
        name="gh"
        config={{ url: 'https://mcp.example/sse' }}
        enabled
        exposure="direct"
        auth="oauth"
        onToggle={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('direct');
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('OAuth');

    rerender(
      <McpServerCard
        name="gh"
        config={{ url: 'https://mcp.example/sse' }}
        enabled
        exposure="codemode"
        auth="provider"
        onToggle={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('codemode');
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('供应商登录');
  });

  it('keeps the login url and shows copy when opening the url fails', async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('open failed'));
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(
      <McpServerCard
        name="gh"
        config={{ url: 'https://mcp.example/sse' }}
        enabled
        runtimeStatus="needs-login"
        loginUrl="https://auth.example/login"
        onToggle={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('button', { name: '复制' })).toBeTruthy();
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('https://auth.example/login');
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://auth.example/login'));
  });
});
