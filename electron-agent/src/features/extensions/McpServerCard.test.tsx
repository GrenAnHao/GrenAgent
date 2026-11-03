import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openUrl } from '../../platform/runtime';
import { McpServerCard } from './McpServerCard';

vi.mock('../../platform/runtime', () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

afterEach(cleanup);

describe('McpServerCard', () => {
  it.each(['connected', 'connecting', 'needs-login'] as const)('uses the live %s empty state instead of an obsolete probe error', (runtimeStatus) => {
    render(<McpServerCard detail name="fs" config={{ command: 'node' }} enabled runtimeStatus={runtimeStatus} runtimeToolNames={[]} probeError="obsolete error" onToggle={() => {}} onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByTestId('mcp-server-fs')).not.toHaveTextContent('obsolete error');
  });

  it('keeps tool permissions visible in the selected server detail', () => {
    const onPermChange = vi.fn();
    render(
      <McpServerCard
        detail
        name="fs"
        config={{ command: 'npx' }}
        enabled
        cachedTools={['mcp__fs__read_file']}
        onToggle={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onPermChange={onPermChange}
      />,
    );
    expect(screen.getByTestId('mcp-tool-mcp__fs__read_file')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-expand-fs')).toBeNull();
    fireEvent.click(screen.getByText('需审批'));
    expect(onPermChange).toHaveBeenCalledWith('mcp__fs__read_file', 'needs_approval');
  });

  it('detail: labelled reload and delete, no edit, no duplicated config labels', () => {
    const onReload = vi.fn();
    const onDelete = vi.fn();
    render(
      <McpServerCard detail name="fs" config={{ command: 'npx' }} enabled scope="project" runtimeStatus="connected" runtimeToolNames={['mcp__fs__a']}
        onToggle={() => {}} onEdit={() => {}} onDelete={onDelete} onReload={onReload} />,
    );
    const card = screen.getByTestId('mcp-server-fs');
    expect(screen.getByTestId('mcp-reload-fs')).toHaveTextContent('重载');
    expect(screen.getByTestId('mcp-delete-fs')).toHaveTextContent('删除');
    expect(screen.queryByTestId('mcp-edit-fs')).toBeNull();
    expect(card).not.toHaveTextContent('服务器连接');
    expect(card).not.toHaveTextContent('默认策略');
    expect(card).toHaveTextContent('项目配置');
    expect(screen.getByTestId('mcp-status-fs')).toHaveTextContent('已连接 · 1 工具');
    fireEvent.click(screen.getByTestId('mcp-reload-fs'));
    expect(onReload).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mcp-delete-fs'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('detail: sets every tool permission in one call', () => {
    const onPermChangeMany = vi.fn();
    const tools = ['mcp__fs__a', 'mcp__fs__b'];
    render(<McpServerCard detail name="fs" config={{ command: 'npx' }} enabled cachedTools={tools} onToggle={() => {}} onEdit={() => {}} onDelete={() => {}} onPermChangeMany={onPermChangeMany} />);
    fireEvent.click(screen.getByTestId('mcp-perm-all-disabled'));
    expect(onPermChangeMany).toHaveBeenCalledTimes(1);
    expect(onPermChangeMany).toHaveBeenCalledWith(tools, 'disabled');
  });

  it('detail: filters a long tool list by short name', () => {
    const tools = Array.from({ length: 10 }, (_, i) => `mcp__fs__tool_${i}`);
    render(<McpServerCard detail name="fs" config={{ command: 'npx' }} enabled cachedTools={tools} onToggle={() => {}} onEdit={() => {}} onDelete={() => {}} />);
    const filter = screen.getByTestId('mcp-tool-filter-fs');
    fireEvent.change(filter, { target: { value: 'tool_3' } });
    expect(screen.getByTestId('mcp-tool-mcp__fs__tool_3')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-tool-mcp__fs__tool_4')).toBeNull();
  });

  it('detail: marks tool permissions of a disabled server', () => {
    render(<McpServerCard detail name="fs" config={{ command: 'npx' }} enabled={false} cachedTools={['mcp__fs__a']} onToggle={() => {}} onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByTestId('mcp-disabled-hint-fs')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-status-fs')).toHaveTextContent('未启用');
  });

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
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('缓存 · 12 工具');
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

  it('shows login, the url host and a copy button when the server needs login', () => {
    render(
      <McpServerCard
        name="gh"
        config={{ url: 'https://mcp.example/sse' }}
        enabled
        runtimeStatus="needs-login"
        loginUrl="https://auth.example/login?state=abc"
        onToggle={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getAllByRole('button', { name: '登录' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '复制链接' })).toBeTruthy();
    const row = screen.getByTestId('mcp-login-gh');
    expect(row).toHaveTextContent('auth.example');
    expect(row).not.toHaveTextContent('state=abc');
    expect(row.querySelector('[title="https://auth.example/login?state=abc"]')).not.toBeNull();
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

  it('says the browser could not open and still copies the full login url', async () => {
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
    await waitFor(() => expect(screen.getByTestId('mcp-login-gh')).toHaveTextContent('无法打开浏览器'));
    fireEvent.click(screen.getByRole('button', { name: '复制链接' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://auth.example/login'));
  });
});
