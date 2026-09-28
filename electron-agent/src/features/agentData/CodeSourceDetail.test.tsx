// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeSourceDetail } from './CodeSourceDetail';
import { files } from '../../lib/files';
import { openPath } from '../../platform/runtime';

vi.mock('../../lib/files', () => ({ files: { read: vi.fn() } }));
vi.mock('../../platform/runtime', () => ({ openPath: vi.fn() }));
const scroll = vi.fn();
const copy = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('CodeSourceDetail', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    vi.mocked(files.read).mockResolvedValue('first\nsecond\nthird');
    vi.mocked(openPath).mockResolvedValue(undefined);
    copy.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it('reads through the protected service, renders real lines and scrolls once per explicit jump', async () => {
    const { rerender } = render(<CodeSourceDetail workspace="D:/repo" file="src/a.ts" line={2} />);
    expect(await screen.findByText('second')).toBeTruthy();
    expect(files.read).toHaveBeenCalledWith('D:/repo', 'src/a.ts');
    expect(screen.getByTestId('code-source-line-2').getAttribute('aria-current')).toBe('location');
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    rerender(<CodeSourceDetail workspace="D:/repo" file="src/a.ts" line={2} />);
    expect(scroll).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('行号'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转到行' }));
    expect(scroll).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '跳转到行' }));
    expect(scroll).toHaveBeenCalledTimes(3);
    rerender(<CodeSourceDetail workspace="D:/repo" file="src/a.ts" line={2} reloadVersion={1} />);
    await waitFor(() => expect(files.read).toHaveBeenCalledTimes(2));
    expect(scroll).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, 0, -1, 1.5])('does not jump to line one when the indexed line is %s', async (line) => {
    render(<CodeSourceDetail workspace="D:/repo" file="src/a.ts" line={line} />);
    await screen.findByText('first');
    expect(screen.getByText('未提供行号')).toBeTruthy();
    expect(document.querySelector('[aria-current="location"]')).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
  });

  it('shows an out-of-range index and validates manual jumps', async () => {
    render(<CodeSourceDetail workspace="D:/repo" file="src/a.ts" line={99} />);
    expect(await screen.findByText('索引行号已超出文件范围')).toBeTruthy();
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('行号'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转到行' }));
    expect(screen.getByRole('alert').textContent).toMatch(/1.*3/);
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('行号'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转到行' }));
    expect(screen.getByTestId('code-source-line-3').getAttribute('aria-current')).toBe('location');
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('resets a manual jump when the indexed location changes and does not revive an old jump', async () => {
    const { rerender } = render(<CodeSourceDetail workspace="D:/repo" file="src/a.ts" line={2} />);
    await screen.findByText('second');
    fireEvent.change(screen.getByLabelText('行号'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转到行' }));
    rerender(<CodeSourceDetail workspace="D:/repo" file="src/a.ts" line={3} />);
    expect(screen.getByTestId('code-source-line-3').getAttribute('aria-current')).toBe('location');
    rerender(<CodeSourceDetail workspace="D:/repo" file="src/a.ts" line={2} />);
    expect(screen.getByTestId('code-source-line-2').getAttribute('aria-current')).toBe('location');
    expect(files.read).toHaveBeenCalledTimes(1);
  });

  it('keeps same-file content on refresh failure but never exposes the old file for a failed new target', async () => {
    const { rerender } = render(<CodeSourceDetail workspace="D:/repo" file="src/a.ts" line={2} />);
    await screen.findByText('second');
    vi.mocked(files.read).mockRejectedValue(new Error('File too large to preview (max 512KB)'));
    rerender(<CodeSourceDetail workspace="D:/repo" file="src/a.ts" line={2} reloadVersion={1} />);
    expect((await screen.findByRole('alert')).textContent).toContain('512KB');
    expect(screen.getByText('second')).toBeTruthy();
    rerender(<CodeSourceDetail workspace="D:/repo" file="src/b.ts" line={2} />);
    expect(screen.queryByText('second')).toBeNull();
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: '使用系统打开文件' })).toBeNull();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('discards a delayed old-file response after switching targets', async () => {
    const old = deferred<string>();
    vi.mocked(files.read).mockReturnValueOnce(old.promise).mockResolvedValue('beta content');
    const { rerender } = render(<CodeSourceDetail workspace="D:/repo" file="src/a.ts" line={2} />);
    rerender(<CodeSourceDetail workspace="D:/repo" file="src/b.ts" line={1} />);
    await screen.findByText('beta content');
    await act(async () => { old.resolve('old content'); });
    expect(screen.queryByText('old content')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '使用系统打开文件' }));
    expect(openPath).toHaveBeenCalledWith('D:/repo/src/b.ts');
  });

  it.each([
    ['D:/Project Files/repo', 'd:\\Project Files\\repo\\src\\a.ts', 'd:/Project Files/repo/src/a.ts'],
    ['//server/share/repo', '\\\\server\\share\\repo\\src\\a.ts', '//server/share/repo/src/a.ts'],
    ['D:/repo', 'src/a.ts', 'D:/repo/src/a.ts'],
  ])('opens only the successful in-project target and copies its relative path', async (workspace, file, absolute) => {
    render(<CodeSourceDetail workspace={workspace} file={file} line={2} />);
    await screen.findByText('second');
    fireEvent.click(screen.getByRole('button', { name: '使用系统打开文件' }));
    expect(openPath).toHaveBeenCalledWith(absolute);
    fireEvent.click(screen.getByRole('button', { name: '复制相对路径' }));
    expect(copy).toHaveBeenCalledWith('src/a.ts');
    expect(screen.getByText(/系统打开文件不保证定位行号/)).toBeTruthy();
  });

  it.each(['../other/a.ts', 'D:/repository/a.ts', 'E:/other/a.ts', 'D:relative.ts', 'file:///D:/repo/a.ts', '//other/share/a.ts', 'src/../../a.ts'])('does not open an unsafe path even if a test backend returns content: %s', async (file) => {
    render(<CodeSourceDetail workspace="D:/repo" file={file} />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: '使用系统打开文件' })).toBeNull();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('pauses when hidden, ignores in-flight responses and refreshes without scrolling back', async () => {
    const { rerender } = render(<CodeSourceDetail workspace="D:/repo" file="a.ts" line={2} visible={false} />);
    expect(files.read).not.toHaveBeenCalled();
    rerender(<CodeSourceDetail workspace="D:/repo" file="a.ts" line={2} />);
    await screen.findByText('second');
    const pending = deferred<string>();
    vi.mocked(files.read).mockReturnValueOnce(pending.promise).mockResolvedValue('first\nnew second\nthird');
    rerender(<CodeSourceDetail workspace="D:/repo" file="a.ts" line={2} reloadVersion={1} />);
    rerender(<CodeSourceDetail workspace="D:/repo" file="a.ts" line={2} visible={false} reloadVersion={1} />);
    await act(async () => { pending.resolve('hidden stale'); });
    expect(screen.queryByText('hidden stale')).toBeNull();
    expect(files.read).toHaveBeenCalledTimes(2);
    rerender(<CodeSourceDetail workspace="D:/repo" file="a.ts" line={2} reloadVersion={1} />);
    await screen.findByText('new second');
    expect(files.read).toHaveBeenCalledTimes(3);
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});
