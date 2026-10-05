import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskPromptFrame } from './TaskPromptFrame';

afterEach(cleanup);

describe('TaskPromptFrame', () => {
  it('收起最多 350px，展开最多 550px，不满则跟着内容', () => {
    render(
      <ThemeProvider themeMode="dark">
        <TaskPromptFrame text={'指令\n'.repeat(40)} />
      </ThemeProvider>,
    );
    const frame = screen.getByTestId('task-prompt-frame');
    expect(frame.getAttribute('data-expanded')).toBe('false');
    const scroller = frame.firstElementChild as HTMLElement;
    expect(scroller.style.maxHeight).toBe('350px');
    expect(scroller.style.height).toBe('');
    expect(scroller.style.overflowY).toBe('hidden');

    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      bottom: 400, top: 50, left: 0, right: 200, width: 200, height: 350, x: 0, y: 50, toJSON() { return {}; },
    });
    fireEvent.mouseMove(frame, { clientY: 380 });
    fireEvent.click(screen.getByRole('button', { name: '展开任务提示词' }));
    expect(frame.getAttribute('data-expanded')).toBe('true');
    expect(scroller.style.height).toBe('');
    expect(scroller.style.maxHeight).toBe('550px');
    expect(scroller.style.overflowY).toBe('auto');

    fireEvent.mouseMove(frame, { clientY: 380 });
    fireEvent.click(screen.getByRole('button', { name: '收起任务提示词' }));
    expect(frame.getAttribute('data-expanded')).toBe('false');
    expect(scroller.style.maxHeight).toBe('350px');
    expect(scroller.style.height).toBe('');
  });
});
