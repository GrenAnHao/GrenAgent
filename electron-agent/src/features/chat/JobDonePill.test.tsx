import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { JobDonePill, jobNoticeTitle } from './JobDonePill';

afterEach(() => cleanup());

describe('JobDonePill', () => {
  it('uses the first line as title and does not say 已注入上下文', () => {
    render(
      <JobDonePill content={'Background job subagent-1 (subagent: L) finished completed.\nout'} />,
    );
    expect(screen.getByTestId('job-done-pill')).toBeTruthy();
    expect(screen.getByText('后台任务 subagent-1 已完成 · L')).toBeTruthy();
    expect(screen.queryByText('已注入上下文')).toBeNull();
  });

  it('turns the model-facing head into a short Chinese title, keeping parentheses inside the label', () => {
    expect(jobNoticeTitle('Background job subagent-10 (subagent: 写计划（任务 1）: 不改源码) finished failed.'))
      .toBe('后台任务 subagent-10 失败 · 写计划（任务 1）: 不改源码');
    expect(jobNoticeTitle('Background job subagent-4 (subagent: x) finished killed.')).toBe('后台任务 subagent-4 已终止 · x');
    expect(jobNoticeTitle('something else')).toBe('something else');
  });
});
