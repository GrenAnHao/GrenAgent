import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { StreamingFileBody } from './StreamingFileBody';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StreamingFileBody', () => {
  it('内容增长时滚到底部', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const { rerender } = render(
      <ThemeProvider themeMode="dark">
        <StreamingFileBody toolName="write" args={{ content: 'a' }} />
      </ThemeProvider>,
    );
    const flush = () => {
      const pending = frames.splice(0, frames.length);
      for (const cb of pending) cb(0);
    };
    flush();
    flush();
    const scroller = screen.getByTestId('streaming-file-body');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 480 });
    rerender(
      <ThemeProvider themeMode="dark">
        <StreamingFileBody toolName="write" args={{ content: 'a\nb\nc' }} />
      </ThemeProvider>,
    );
    flush();
    flush();
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });
});