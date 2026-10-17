import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGoalRoundPrompt } from '@extensions/goal/prompt';
import { GoalRoundPill, goalRoundTitle } from './GoalRoundPill';

afterEach(() => cleanup());

describe('GoalRoundPill', () => {
  it('turns the model-facing first line into the round number, without the budget', () => {
    expect(goalRoundTitle('Goal Round 4/256。')).toBe('目标续跑 · 第 4 轮');
    expect(goalRoundTitle('something else')).toBe('目标续跑');
  });

  it('reads the real round prompt: collapsed shows only the round, expanded shows the condition', () => {
    const content = buildGoalRoundPrompt({ condition: '按 M1→M4 推进客服模块', round: 5, maxRounds: 256 });
    render(<GoalRoundPill content={content} />);
    const el = screen.getByTestId('goal-round-pill');
    expect(el.textContent).toContain('目标续跑 · 第 5 轮');
    expect(el.textContent).not.toContain('256');
    expect(el.textContent).not.toContain('按 M1→M4 推进客服模块');

    fireEvent.click(screen.getByText('目标续跑 · 第 5 轮'));
    return screen.findByText(/按 M1→M4 推进客服模块/);
  });
});
