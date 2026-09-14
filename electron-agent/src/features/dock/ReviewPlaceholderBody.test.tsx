import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewPlaceholderBody } from './ReviewPlaceholderBody';

afterEach(cleanup);

const tab = {
  id: 'review:right',
  kind: 'review' as const,
  region: 'right' as const,
  title: '审查',
  closable: true,
  order: 0,
  payload: { workspace: '/repo' },
};

describe('ReviewPlaceholderBody', () => {
  it('shows a placeholder, not a diff', () => {
    render(<ReviewPlaceholderBody tab={tab} active />);
    expect(screen.getByTestId('review-placeholder').textContent).toContain('审查尚未接入');
  });
});
