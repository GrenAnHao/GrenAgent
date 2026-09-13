import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptPendingRow } from './PromptPendingRow';

afterEach(cleanup);

describe('PromptPendingRow', () => {
  it('renders the waiting label with the given test id', () => {
    render(<PromptPendingRow data-testid="ask-user-pending" label="等待你选择" live />);
    expect(screen.getByTestId('ask-user-pending')).toBeTruthy();
    expect(screen.getByText('等待你选择')).toBeTruthy();
  });

  it('renders a static cancelled row', () => {
    render(<PromptPendingRow data-testid="ask-user-cancelled" label="已取消" />);
    expect(screen.getByTestId('ask-user-cancelled')).toBeTruthy();
    expect(screen.getByText('已取消')).toBeTruthy();
  });
});
