import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileDiffBlock } from './FileDiffBlock';
import { FileReadBlock } from './FileReadBlock';
import type { DiffRow } from './fileDiffModel';

afterEach(cleanup);

const many: DiffRow[] = Array.from({ length: 20 }, (_, i) => ({ marker: '+' as const, text: `L${i}` }));

describe('FileDiffBlock', () => {
  it('does not render the path, and copies +/- text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<FileDiffBlock path="secret.txt" rows={[{ marker: '+', text: 'hello' }]} added={1} deleted={0} />);
    expect(screen.queryByText('secret.txt')).toBeNull();
    expect(screen.getByTestId('file-diff-block').textContent).toContain('+ hello');
    expect(screen.getByTestId('file-diff-block').textContent).toContain('+1 -0 · 1 个文件');
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith('+ hello');
  });

  it('folds the middle when there are more than 16 lines', () => {
    render(<FileDiffBlock path="a.txt" rows={many} added={20} deleted={0} />);
    expect(screen.getByText('+ L0')).toBeTruthy();
    expect(screen.queryByText('+ L10')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /展开/ }));
    expect(screen.getByText('+ L10')).toBeTruthy();
  });
});

describe('FileReadBlock', () => {
  it('shows line numbers without the filename', () => {
    render(<FileReadBlock path="note.txt" text={'alpha\nbeta'} />);
    expect(screen.queryByText('note.txt')).toBeNull();
    expect(screen.getByTestId('file-read-block').textContent).toMatch(/1\s*alpha/);
    expect(screen.getByTestId('file-read-block').textContent).toMatch(/2\s*beta/);
  });

  it('renders nothing when text is empty', () => {
    render(<FileReadBlock path="note.txt" text="" />);
    expect(screen.queryByTestId('file-read-block')).toBeNull();
  });

  it('copies raw text without line numbers', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<FileReadBlock path="note.txt" text={'alpha\nbeta'} />);
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith('alpha\nbeta');
  });
});
