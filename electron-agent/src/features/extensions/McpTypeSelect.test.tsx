import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpTypeSelect } from './McpTypeSelect';

afterEach(cleanup);

describe('McpTypeSelect', () => {
  it('renders both options and fires onChange', () => {
    const onChange = vi.fn();
    render(<McpTypeSelect value="stdio" onChange={onChange} />);
    expect(screen.getByTestId('mcp-type-stdio')).toBeTruthy();
    expect(screen.getByTestId('mcp-type-remote')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mcp-type-remote'));
    expect(onChange).toHaveBeenCalledWith('remote');
  });
});
