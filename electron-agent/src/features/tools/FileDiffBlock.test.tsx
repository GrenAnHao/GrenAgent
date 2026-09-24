import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FileDiffBlock } from './FileDiffBlock';
import { FileReadBlock } from './FileReadBlock';
import type { DiffRow } from './fileDiffModel';

afterEach(cleanup);

const many: DiffRow[] = Array.from({ length: 20 }, (_, i) => ({ marker: '+' as const, text: `L${i}` }));

describe('FileDiffBlock', () => {
  it('renders the new content through CodeDiff', () => {
    render(<FileDiffBlock path="secret.txt" rows={[{ marker: '+', text: 'hello' }]} added={1} deleted={0} />);
    expect(screen.getByTestId('file-diff-block').getAttribute('data-new-content')).toContain('hello');
  });

  it('keeps the file header and drops the inner collapse control', () => {
    render(<FileDiffBlock path="secret.txt" rows={[{ marker: '+', text: 'hello' }]} added={1} deleted={0} />);
    expect(screen.getByTestId('code-card-name').textContent).toBe('secret.txt');
    expect(screen.getByTestId('code-card-stats').textContent).toContain('+1');
    expect(screen.getByTestId('code-card-header').querySelector('button')).toBeNull();
  });

  it('keeps both sides of an edit', () => {
    render(
      <FileDiffBlock
        path="a.ts"
        rows={[
          { marker: '-', text: 'old' },
          { marker: '+', text: 'new' },
        ]}
        added={1}
        deleted={1}
      />,
    );
    expect(screen.getByTestId('file-diff-block').getAttribute('data-new-content')).toContain('new');
    expect(screen.getByTestId('file-diff-block').getAttribute('data-old-content')).toContain('old');
  });

  it('shows a long write instead of folding it away', () => {
    render(<FileDiffBlock path="a.txt" rows={many} added={20} deleted={0} />);
    const text = screen.getByTestId('file-diff-block').getAttribute('data-new-content') ?? '';
    expect(text).toContain('L0');
    expect(text).toContain('L19');
  });
});

describe('FileReadBlock', () => {
  it('shows the file name and the file text', async () => {
    render(<FileReadBlock path="note.txt" text={'alpha\nbeta'} />);
    expect(screen.getByTestId('code-card-name').textContent).toBe('note.txt');
    expect(screen.getByTestId('code-card-header').querySelector('button')).toBeNull();
    expect(await screen.findByText(/alpha/)).toBeTruthy();
    expect(screen.getByTestId('file-read-block').textContent).toContain('beta');
  });

  it('renders nothing when text is empty', () => {
    render(<FileReadBlock path="note.txt" text="" />);
    expect(screen.queryByTestId('file-read-block')).toBeNull();
  });
});
