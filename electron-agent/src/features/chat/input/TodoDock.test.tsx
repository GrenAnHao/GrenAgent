import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TodoDock } from './TodoDock';
import type { Todo } from '@extensions/_shared/todo-model';

afterEach(cleanup);

const LIST: Todo[] = [
  { id: 1, text: '搭骨架', status: 'completed' },
  { id: 2, text: '写组件', status: 'in_progress' },
  { id: 3, text: '补测试', status: 'pending' },
];

describe('TodoDock', () => {
  it('renders nothing when empty', () => {
    const { container } = render(<TodoDock todos={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('unmounts after todos is cleared to an empty list', () => {
    const { rerender } = render(<TodoDock todos={LIST} />);
    expect(screen.getByTestId('todo-dock')).toBeTruthy();
    rerender(<TodoDock todos={[]} />);
    expect(screen.queryByTestId('todo-dock')).toBeNull();
  });

  it('shows the running task in the collapsed bar', () => {
    render(<TodoDock todos={LIST} />);
    const bar = screen.getByRole('button', { name: '任务' });
    expect(bar.textContent).toContain('任务');
    expect(bar.textContent).toContain('1 已完成');
    expect(bar.textContent).toContain('1 进行中');
    expect(bar.textContent).toContain('1 待处理');
    expect(bar.textContent).toContain('写组件');
    expect(bar.textContent).not.toContain('正在执行');
    expect(bar).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('todo-dock-running').textContent).toContain('写组件');
    expect(screen.getAllByTestId('todo-dock-running-name')).toHaveLength(1);
    expect(screen.queryByTestId('todo-dock-list')).toBeNull();
  });

  it('omits zero-count segments', () => {
    render(<TodoDock todos={[{ id: 1, text: 'x', status: 'completed' }]} />);
    const bar = screen.getByRole('button', { name: '任务' });
    expect(bar.textContent).toContain('1 已完成');
    expect(bar.textContent).not.toContain('进行中');
    expect(bar.textContent).not.toContain('待处理');
    expect(bar.textContent).not.toContain('正在执行');
    expect(bar).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByTestId('todo-dock-running')).toBeNull();
  });

  it('marks leftover in_progress done after a finished turn with nothing pending', () => {
    render(<TodoDock todos={[{ id: 1, text: '注册', status: 'in_progress' }]} settleFinished />);
    const bar = screen.getByRole('button', { name: '任务' });
    expect(bar.textContent).toContain('1 已完成');
    expect(bar.textContent).not.toContain('进行中');
    expect(bar.textContent).not.toContain('正在执行');
    expect(screen.queryByTestId('todo-dock-running')).toBeNull();
    fireEvent.click(bar);
    expect(screen.getByTestId('todo-dock-list').textContent).toContain('注册');
    expect(bar.textContent).not.toContain('正在执行');
  });

  it('keeps in_progress while a pending item remains', () => {
    render(<TodoDock todos={LIST} settleFinished />);
    expect(screen.getByRole('button', { name: '任务' }).textContent).toContain('写组件');
    expect(screen.getByRole('button', { name: '任务' }).textContent).not.toContain('正在执行');
  });

  it('stops the loader after the run ends while pending items remain', () => {
    render(<TodoDock todos={LIST} settleFinished runActive={false} />);
    const bar = screen.getByRole('button', { name: '任务' });
    expect(bar.textContent).toContain('1 进行中');
    expect(bar.textContent).toContain('1 待处理');
    expect(bar.textContent).not.toContain('写组件');
    expect(bar).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByTestId('todo-dock-running')).toBeNull();
    fireEvent.click(bar);
    const list = screen.getByTestId('todo-dock-list');
    expect(list.querySelector('[data-busy="true"]')).toBeNull();
    expect(list.textContent).toContain('写组件');
    expect(list.textContent).toContain('补测试');
  });

  it('keeps the expanded bar as counts only', () => {
    render(<TodoDock todos={LIST} />);
    const bar = screen.getByRole('button', { name: '任务' });
    fireEvent.click(bar);
    expect(bar.textContent).toContain('1 进行中');
    expect(bar.textContent).toContain('1 待处理');
    expect(bar.textContent).not.toContain('正在执行');
    expect(bar.textContent).not.toContain('写组件');
    expect(bar).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByTestId('todo-dock-running')).toBeNull();
    expect(screen.getByTestId('todo-dock-list').textContent).toContain('写组件');
  });

  it('loops concatenated running names slowly from right to left', () => {
    render(<TodoDock todos={[
      ...LIST,
      { id: 4, text: '跑后台构建', status: 'in_progress' },
    ]} />);
    const bar = screen.getByRole('button', { name: '任务' });
    const unit = '写组件\u2002·\u2002跑后台构建\u2002·\u2002';
    expect(bar.textContent).not.toContain('正在执行');
    expect(screen.getByTestId('todo-dock-running-name').textContent).toBe(unit);
    expect(screen.getByTestId('todo-dock-running').textContent).toBe(`${unit}${unit}`);
    const track = screen.getByTestId('todo-dock-running-track');
    expect(track.style.animation).toContain('todo-dock-marquee');
    expect(track.style.animation).toContain('linear infinite');
    expect(track.style.getPropertyValue('--todo-marquee-shift').startsWith('-')).toBe(true);
    expect(screen.getByTestId('todo-dock-running')).toHaveAttribute('title', '写组件\u2002·\u2002跑后台构建');
  });

  it('keeps concatenated names still when motion is reduced', () => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      render(<TodoDock todos={[
        { id: 2, text: '写组件', status: 'in_progress' },
        { id: 4, text: '跑后台构建', status: 'in_progress' },
      ]} />);
      expect(screen.getByTestId('todo-dock-running').textContent).toBe('写组件\u2002·\u2002跑后台构建');
      expect(screen.getByTestId('todo-dock-running-track').style.animation).toBe('');
    } finally {
      window.matchMedia = original;
    }
  });

  it('expands to one row per item and allows parallel in_progress', () => {
    render(<TodoDock todos={[
      ...LIST,
      { id: 4, text: '跑后台构建', status: 'in_progress' },
    ]} />);
    const bar = screen.getByRole('button', { name: '任务' });
    fireEvent.click(bar);
    expect(bar.textContent).not.toContain('正在执行');
    expect(screen.getByText('写组件')).toBeTruthy();
    expect(screen.getByText('跑后台构建')).toBeTruthy();
    expect(screen.getByTestId('todo-dock-list')).toHaveStyle({ maxHeight: '180px' });
  });
});
