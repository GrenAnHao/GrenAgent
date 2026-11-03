import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpWorkbench } from './McpWorkbench';

afterEach(cleanup);

function Servers() {
  const [entries, setEntries] = useState([
    { name: 'alpha', config: { command: 'node' }, enabled: true, scope: 'settings' as const },
    { name: 'beta', config: { command: 'node' }, enabled: true, scope: 'settings' as const },
  ]);
  return <McpWorkbench
    workspace="/ws" entries={entries} runtimeServers={[]} toolsCache={{}} probing={new Set()} policyRaw={{}}
    onToggle={(entry, enabled) => setEntries((current) => current.map((item) => item.name === entry.name ? { ...item, enabled } : item).sort((a, b) => Number(b.enabled) - Number(a.enabled)))}
    onEdit={() => {}} onDelete={() => {}} onReload={() => {}} onPermChange={() => {}} onOpenRules={() => {}}
  />;
}

describe('McpWorkbench', () => {
  it('keeps a malformed file configuration readable without rendering object children', () => {
    render(<McpWorkbench workspace="/ws" entries={[{ name: 'broken', scope: 'global', enabled: false, config: { command: { bad: true } } as never }]} runtimeServers={[]} toolsCache={{}} probing={new Set()} policyRaw={{}} onToggle={() => {}} onEdit={() => {}} onDelete={() => {}} onReload={() => {}} onPermChange={() => {}} onOpenRules={() => {}} />);
    expect(screen.getByTestId('mcp-server-broken')).toBeInTheDocument();
    expect(screen.getByText('格式无效')).toBeInTheDocument();
  });

  it('uses the same status text in the directory and the detail, and edits from the config section', () => {
    const onEdit = vi.fn();
    render(<McpWorkbench
      workspace="/ws" entries={[{ name: 'fs', scope: 'global', enabled: true, config: { command: 'node' } }]}
      runtimeServers={[{ name: 'fs', status: 'connected', toolNames: ['mcp__fs__a', 'mcp__fs__b'] } as never]}
      toolsCache={{}} probing={new Set()} policyRaw={{}}
      onToggle={() => {}} onEdit={onEdit} onDelete={() => {}} onReload={() => {}} onPermChange={() => {}} onOpenRules={() => {}}
    />);
    expect(screen.getByTestId('mcp-select-fs')).toHaveTextContent('已连接 · 2 工具');
    expect(screen.getByTestId('mcp-status-fs')).toHaveTextContent('已连接 · 2 工具');
    const config = screen.getByRole('region', { name: '连接配置' });
    expect(config).not.toHaveTextContent('只读摘要');
    expect(config).not.toHaveTextContent('连接方式');
    expect(config).not.toHaveTextContent('配置来源');
    fireEvent.click(within(config).getByTestId('mcp-edit-fs'));
    expect(onEdit).toHaveBeenCalled();
    expect(screen.getByTestId('mcp-directory')).not.toHaveTextContent('即时生效');
  });

  it('shows the full connection config and hides env and header values', () => {
    const noop = () => {};
    const { rerender } = render(<McpWorkbench workspace="/ws" entries={[{ name: 'fs', scope: 'global', enabled: true, config: { command: 'npx', args: ['-y', 'pkg', 'C:/My Files'], cwd: '/repo', env: { API_KEY: 'sk-secret' } } }]} runtimeServers={[]} toolsCache={{}} probing={new Set()} policyRaw={{}} onToggle={noop} onEdit={noop} onDelete={noop} onReload={noop} onPermChange={noop} onOpenRules={noop} />);
    let config = screen.getByRole('region', { name: '连接配置' });
    expect(config).toHaveTextContent('npx -y pkg "C:/My Files"');
    expect(config).toHaveTextContent('/repo');
    expect(config).toHaveTextContent('API_KEY');
    expect(config).not.toHaveTextContent('sk-secret');
    rerender(<McpWorkbench workspace="/ws" entries={[{ name: 'web', scope: 'global', enabled: true, config: { url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer abc' } } }]} runtimeServers={[]} toolsCache={{}} probing={new Set()} policyRaw={{}} onToggle={noop} onEdit={noop} onDelete={noop} onReload={noop} onPermChange={noop} onOpenRules={noop} />);
    config = screen.getByRole('region', { name: '连接配置' });
    expect(config).toHaveTextContent('https://mcp.example/sse');
    expect(config).toHaveTextContent('Authorization');
    expect(config).not.toHaveTextContent('Bearer abc');
  });

  it('keeps the default selected server when disabling it reorders the directory', () => {
    render(<Servers />);
    fireEvent.click(screen.getByTestId('mcp-toggle-alpha'));
    expect(screen.getByTestId('mcp-server-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-select-alpha')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('mcp-toggle-alpha')).toHaveAttribute('aria-checked', 'false');
  });
});
