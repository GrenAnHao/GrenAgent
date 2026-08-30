import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalInfo } from '../../../stores/goalStore';

const { runCommand, goalRef } = vi.hoisted(() => ({
  runCommand: vi.fn(() => Promise.resolve()),
  goalRef: { current: undefined as GoalInfo | undefined },
}));
vi.mock('../../../lib/pi', () => ({ pi: { runCommand } }));
vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../../stores/goalStore', () => ({
  useGoalStore: (selector: (s: { goal: GoalInfo | undefined }) => unknown) =>
    selector({ goal: goalRef.current }),
}));

import { GoalPill } from './GoalPill';

afterEach(() => {
  cleanup();
  runCommand.mockClear();
  goalRef.current = undefined;
});

describe('GoalPill', () => {
  it('renders nothing without an active goal', () => {
    const { container } = render(<GoalPill />);
    expect(container.querySelector('[data-testid="goal-pill"]')).toBeNull();
  });

  it('shows the condition and pauses via /goal pause', () => {
    goalRef.current = { condition: '写完测试', paused: false, react: 0 };
    render(<GoalPill />);
    expect(screen.getByText('写完测试')).toBeTruthy();
    expect(screen.getByText('目标')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button')[1]);
    expect(runCommand).toHaveBeenCalledWith('/ws', '/goal pause');
  });

  it('resumes when paused', () => {
    goalRef.current = { condition: '写完测试', paused: true, react: 1 };
    render(<GoalPill />);
    expect(screen.getByText('已暂停的目标')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button')[1]);
    expect(runCommand).toHaveBeenCalledWith('/ws', '/goal resume');
  });

  it('deletes via /goal clear after confirm', () => {
    goalRef.current = { condition: '写完测试', paused: false, react: 0 };
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<GoalPill />);
    fireEvent.click(screen.getAllByRole('button')[2]);
    expect(runCommand).toHaveBeenCalledWith('/ws', '/goal clear');
    confirmSpy.mockRestore();
  });

  it('edits via /goal <new> from prompt input', () => {
    goalRef.current = { condition: '旧目标', paused: false, react: 0 };
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('新目标');
    render(<GoalPill />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(runCommand).toHaveBeenCalledWith('/ws', '/goal 新目标');
    promptSpy.mockRestore();
  });
});
