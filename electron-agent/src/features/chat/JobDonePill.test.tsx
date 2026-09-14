import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { JobDonePill } from './JobDonePill';

afterEach(() => cleanup());

describe('JobDonePill', () => {
  it('uses the first line as title and does not say 已注入上下文', () => {
    render(
      <JobDonePill content={'Background job subagent-1 (subagent: L) finished completed.\nout'} />,
    );
    expect(screen.getByTestId('job-done-pill')).toBeTruthy();
    expect(screen.getByText('Background job subagent-1 (subagent: L) finished completed.')).toBeTruthy();
    expect(screen.queryByText('已注入上下文')).toBeNull();
  });
});
