// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { steerQueued, interruptQueued, agentState } = vi.hoisted(() => ({
  steerQueued: vi.fn(),
  interruptQueued: vi.fn(),
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
  useChatInput: () => ({ steerQueued, interruptQueued }),
}));

import { SteerQueue } from './SteerQueue';

beforeEach(() => {
  steerQueued.mockClear();
  interruptQueued.mockClear();
  agentState.composerQueue = [{ id: 'cq-1', text: '先别再测了' }];
});

afterEach(() => {
  cleanup();
});

describe('SteerQueue', () => {
  it('单条跟进直接露出一行，不收进排队', () => {
    render(<SteerQueue />);
    expect(screen.getByTestId('steer-queue')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /排队/ })).toBeNull();
    expect(screen.getByText('先别再测了')).toBeTruthy();
    const hotkeys = screen.getByTestId('follow-up-hotkeys');
    expect(hotkeys.textContent).toContain('引导');
    expect(hotkeys.textContent).toContain('Enter');
    expect(hotkeys.textContent).toContain('截断');
    expect(hotkeys.textContent).toContain('Ctrl');
    expect(screen.getByRole('button', { name: '引导' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '截断发送' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑消息' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除这条' })).toBeTruthy();
    expect(screen.queryByTestId('queue-drag-handle')).toBeNull();
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

  it('多条且第一条没有文字时标题只有条数', () => {
    agentState.composerQueue = [
      { id: 'cq-1', text: '   ' },
      { id: 'cq-2', text: '第二条' },
    ];
    render(<SteerQueue />);
    expect(screen.getByRole('button', { name: '排队 · 2' }).textContent).toBe('排队 · 2');
  });

  it('多条默认收起，点标题才展开每一行', () => {
    agentState.composerQueue = [
      { id: 'cq-1', text: '先别再测了' },
      { id: 'cq-2', text: '第二条' },
    ];
    render(<SteerQueue />);
    expect(screen.queryByRole('button', { name: '引导' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /排队/ }));
    expect(screen.getByText('先别再测了')).toBeTruthy();
    expect(screen.getByText('第二条')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '引导' })).toHaveLength(2);
  });

  it('点引导会把这条交给 steerQueued', () => {
    render(<SteerQueue />);
    fireEvent.click(screen.getByRole('button', { name: '引导' }));
    expect(steerQueued).toHaveBeenCalledWith('cq-1');
  });

  it('点截断发送会把这条交给 interruptQueued', () => {
    render(<SteerQueue />);
    fireEvent.click(screen.getByRole('button', { name: '截断发送' }));
    expect(interruptQueued).toHaveBeenCalledWith('cq-1');
    expect(steerQueued).not.toHaveBeenCalled();
  });

  it('点删除这条会从本地队列拿走', () => {
    const { rerender } = render(<SteerQueue />);
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
    fireEvent.click(screen.getAllByRole('button', { name: '引导' })[0]!);
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

  it('pointercancel 后不再重排', () => {
    agentState.composerQueue = [
      { id: 'cq-1', text: '先改测试' },
      { id: 'cq-2', text: '第二条' },
    ];
    render(<SteerQueue />);
    fireEvent.click(screen.getByRole('button', { name: /排队/ }));

    const row1 = screen.getByTestId('composer-queue-item-cq-1');
    const row2 = screen.getByTestId('composer-queue-item-cq-2');
    mockRect(row1, 0, 20);
    mockRect(row2, 20, 40);

    const handle = screen.getAllByTestId('queue-drag-handle')[0]!;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerCancel(window, { pointerId: 1, clientY: 35 });
    fireEvent.pointerUp(window, { button: 0, pointerId: 1, clientY: 35 });

    expect(agentState.composerQueue.map((item) => item.id)).toEqual(['cq-1', 'cq-2']);
  });
});
