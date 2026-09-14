import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderMessageBody } from './ChatMessageItems';

afterEach(() => cleanup());

describe('renderMessageBody', () => {
  it('renders job-done notices as a JobDonePill with the first line as title', () => {
    render(
      <>
        {renderMessageBody(
          {
            kind: 'notice',
            id: 'n1',
            customType: 'job-done',
            content: 'Background job subagent-1 (subagent: L) finished completed.\nout',
          },
          new Map(),
          new Set(),
        )}
      </>,
    );
    expect(screen.getByTestId('job-done-pill')).toBeTruthy();
    expect(screen.getByText('Background job subagent-1 (subagent: L) finished completed.')).toBeTruthy();
    expect(screen.queryByText('已注入上下文')).toBeNull();
  });
});
