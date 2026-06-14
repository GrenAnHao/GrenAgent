import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyValueEditor, type KvPairs } from './KeyValueEditor';

afterEach(cleanup);

describe('KeyValueEditor', () => {
  it('adds, edits and removes rows', () => {
    const value: KvPairs = [['A', '1']];
    const onChange = vi.fn();
    const { rerender } = render(<KeyValueEditor value={value} onChange={onChange} />);

    fireEvent.change(screen.getByTestId('kv-val-0'), { target: { value: '2' } });
    expect(onChange).toHaveBeenLastCalledWith([['A', '2']]);

    fireEvent.click(screen.getByTestId('kv-add'));
    expect(onChange).toHaveBeenLastCalledWith([['A', '1'], ['', '']]);

    rerender(<KeyValueEditor value={[['A', '1'], ['B', '2']]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('kv-rm-0'));
    expect(onChange).toHaveBeenLastCalledWith([['B', '2']]);
  });
});
