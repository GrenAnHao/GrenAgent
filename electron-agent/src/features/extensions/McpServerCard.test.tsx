import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServerCard } from './McpServerCard';

afterEach(cleanup);

describe('McpServerCard', () => {
  it('shows transport, cached tool count and wires actions', () => {
    const onToggle = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onProbe = vi.fn();
    render(
      <McpServerCard
        name="gh"
        config={{ command: 'npx' }}
        enabled
        cachedTools={Array.from({ length: 12 }, (_, i) => `mcp__gh__t${i}`)}
        onToggle={onToggle}
        onEdit={onEdit}
        onDelete={onDelete}
        onProbe={onProbe}
      />,
    );
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('stdio');
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('12 工具');
    expect(screen.getByTestId('mcp-toggle-gh').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('mcp-probe-gh'));
    expect(onProbe).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mcp-edit-gh'));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mcp-delete-gh'));
    expect(onDelete).toHaveBeenCalled();
  });
});
