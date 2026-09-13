import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SubagentSettledPill } from './SubagentSettledPill';

afterEach(() => cleanup());

describe('SubagentSettledPill', () => {
  it('uses the first line as title and does not say 已注入上下文', () => {
    render(
      <SubagentSettledPill
        content={
          'Background subagent sa-1 finished and will do no further work unless you send it more.\nIts closing message:\nok'
        }
      />,
    );
    const el = screen.getByTestId('subagent-settled-pill');
    expect(el.textContent).toContain('Background subagent sa-1 finished');
    expect(el.textContent).not.toContain('已注入上下文');
  });
});
