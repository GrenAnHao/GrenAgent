// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { steerQueued, agentState } = vi.hoisted(() => ({
  steerQueued: vi.fn(),
  agentState: {
    composerQueue: [] as Array<{ id: string; text: string }>,
  },
}));

vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStore: () => ({
    useStore: Object.assign((sel: (s: typeof agentState) => unknown) => sel(agentState), {
      getState: () => agentState,
      setState: (partial: Partial<typeof agentState> | ((s: typeof agentState) => Partial<typeof agentState>)) => {
        const patch = typeof partial === 'function' ? partial(agentState) : partial;
        Object.assign(agentState, patch);
      },
    }),
  }),
}));

vi.mock('./ChatInputContext', () => ({
  useChatInput: () => ({ steerQueued }),
}));

import { SteerQueue } from './SteerQueue';

beforeEach(() => {
  steerQueued.mockClear();
  agentState.composerQueue = [{ id: 'cq-1', text: '先别再测了' }];
});

afterEach(() => {
  cleanup();
});

describe('SteerQueue', () => {
  it('渲染跟进条和三个操作', () => {
    render(<SteerQueue />);
    expect(screen.getByTestId('steer-queue')).toBeTruthy();
    expect(screen.getByRole('button', { name: /排队/ })).toBeTruthy();
    expect(screen.queryByText('先别再测了')).toBeNull();
    expect(screen.queryByRole('button', { name: '发送引导' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑消息' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除这条' })).toBeNull();
  });

  it('收起时显示条数和第一条原文', () => {
    agentState.composerQueue = [
      { id: 'cq-1', text: '先改测试' },
      { id: 'cq-2', text: '第二条' },
    ];
    render(<SteerQueue />);
    const header = screen.getByRole('button', { name: /排队/ });
    expect(header.textContent).toBe('排队 · 2 · 先改测试');
    expect(header).toHaveAttribute('title', '先改测试');
    expect(screen.queryByText('第二条')).toBeNull();
  });

  it('第一条没有文字时标题只有条数', () => {
    agentState.composerQueue = [{ id: 'cq-1', text: '   ' }];
    render(<SteerQueue />);
    expect(screen.getByRole('button', { name: '排队 · 1' }).textContent).toBe('排队 · 1');
  });

  it('点标题才展开每条跟进', () => {
    render(<SteerQueue />);
    expect(screen.queryByRole('button', { name: '发送引导' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /排队/ }));
    expect(screen.getByText('先别再测了')).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送引导' })).toBeTruthy();
  });

  it('点发送引导会把这条交给 steerQueued', () => {
    render(<SteerQueue />);
    fireEvent.click(screen.getByRole('button', { name: /排队/ }));
    fireEvent.click(screen.getByRole('button', { name: '发送引导' }));
    expect(steerQueued).toHaveBeenCalledWith('cq-1');
  });

  it('点删除这条会从本地队列拿走', () => {
    const { rerender } = render(<SteerQueue />);
    fireEvent.click(screen.getByRole('button', { name: /排队/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除这条' }));
    expect(agentState.composerQueue).toEqual([]);
    rerender(<SteerQueue />);
    expect(screen.queryByTestId('steer-queue')).toBeNull();
  });

  function mockRect(el: HTMLElement, top: number, bottom: number) {
    el.getBoundingClientRect = () => ({
      top,
      bottom,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
      x: 0,
      y: top,
      toJSON() {
        return {};
      },
    });
  }

  it('拖动手柄交换两条顺序', () => {
    agentState.composerQueue = [
      { id: 'cq-1', text: '先改测试' },
      { id: 'cq-2', text: '第二条' },
    ];
    const { rerender } = render(<SteerQueue />);
    fireEvent.click(screen.getByRole('button', { name: /排队/ }));

    const row1 = screen.getByTestId('composer-queue-item-cq-1');
    const row2 = screen.getByTestId('composer-queue-item-cq-2');
    mockRect(row1, 0, 20);
    mockRect(row2, 20, 40);

    const handle = screen.getAllByTestId('queue-drag-handle')[0]!;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerUp(window, { button: 0, pointerId: 1, clientY: 35 });
    rerender(<SteerQueue />);

    expect(agentState.composerQueue.map((item) => item.id)).toEqual(['cq-2', 'cq-1']);
  });

  it('点引导不改变顺序', () => {
    agentState.composerQueue = [
      { id: 'cq-1', text: '先改测试' },
      { id: 'cq-2', text: '第二条' },
    ];
    render(<SteerQueue />);
    fireEvent.click(screen.getByRole('button', { name: /排队/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '发送引导' })[0]!);
    expect(agentState.composerQueue.map((item) => item.id)).toEqual(['cq-1', 'cq-2']);
    expect(steerQueued).toHaveBeenCalledWith('cq-1');
  });

  it('编辑中被拖走仍在编辑', () => {
    agentState.composerQueue = [
      { id: 'cq-1', text: '先改测试' },
      { id: 'cq-2', text: '第二条' },
    ];
    const { rerender } = render(<SteerQueue />);
    fireEvent.click(screen.getByRole('button', { name: /排队/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '编辑消息' })[0]!);

    const row1 = screen.getByTestId('composer-queue-item-cq-1');
    const row2 = screen.getByTestId('composer-queue-item-cq-2');
    mockRect(row1, 0, 20);
    mockRect(row2, 20, 40);

    const handle = screen.getAllByTestId('queue-drag-handle')[0]!;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerUp(window, { button: 0, pointerId: 1, clientY: 35 });
    rerender(<SteerQueue />);

    expect(screen.getByLabelText('编辑跟进')).toBeTruthy();
    expect(agentState.composerQueue.map((item) => item.id)).toEqual(['cq-2', 'cq-1']);
  });

  it('拖拽过程中条目被删则不写回', () => {
    agentState.composerQueue = [
      { id: 'cq-1', text: '先改测试' },
      { id: 'cq-2', text: '第二条' },
    ];
    const { rerender } = render(<SteerQueue />);
    fireEvent.click(screen.getByRole('button', { name: /排队/ }));

    const handle = screen.getAllByTestId('queue-drag-handle')[0]!;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 10 });

    agentState.composerQueue = [{ id: 'cq-2', text: '第二条' }];
    rerender(<SteerQueue />);

    fireEvent.pointerUp(window, { button: 0, pointerId: 1, clientY: 35 });
    expect(agentState.composerQueue.map((item) => item.id)).toEqual(['cq-2']);
  });
});
