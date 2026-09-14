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

  it('collapses to counts without task names', () => {
    render(<TodoDock todos={LIST} />);
    expect(screen.getByTestId('todo-dock').textContent).toContain('任务');
    expect(screen.getByTestId('todo-dock').textContent).toContain('1 已完成');
    expect(screen.getByTestId('todo-dock').textContent).toContain('1 进行中');
    expect(screen.getByTestId('todo-dock').textContent).toContain('1 待处理');
    expect(screen.queryByText('写组件')).toBeNull();
  });

  it('omits zero-count segments', () => {
    render(<TodoDock todos={[{ id: 1, text: 'x', status: 'completed' }]} />);
    expect(screen.getByTestId('todo-dock').textContent).toContain('1 已完成');
    expect(screen.getByTestId('todo-dock').textContent).not.toContain('进行中');
    expect(screen.getByTestId('todo-dock').textContent).not.toContain('待处理');
  });

  it('expands to one row per item and allows parallel in_progress', () => {
    render(<TodoDock todos={[
      ...LIST,
      { id: 4, text: '跑后台构建', status: 'in_progress' },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    expect(screen.getByText('写组件')).toBeTruthy();
    expect(screen.getByText('跑后台构建')).toBeTruthy();
    expect(screen.getByTestId('todo-dock-list')).toHaveStyle({ maxHeight: '180px' });
  });
});
