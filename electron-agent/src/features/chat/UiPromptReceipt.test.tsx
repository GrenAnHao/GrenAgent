import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UiPromptReceipt } from './UiPromptReceipt';

afterEach(cleanup);

describe('UiPromptReceipt', () => {
  it('renders answered / confirmed / cancelled', () => {
    const { rerender } = render(
      <UiPromptReceipt content={JSON.stringify({ outcome: 'answered', title: '色', value: '红' })} />,
    );
    expect(screen.getByTestId('ui-prompt-receipt')).toBeTruthy();
    expect(screen.getByText('已回答')).toBeTruthy();
    expect(screen.getByText('红')).toBeTruthy();

    rerender(<UiPromptReceipt content={JSON.stringify({ outcome: 'confirmed', title: '信任', value: '确定' })} />);
    expect(screen.getByText('已确认')).toBeTruthy();

    rerender(<UiPromptReceipt content={JSON.stringify({ outcome: 'cancelled', title: '色' })} />);
    expect(screen.getByText('已取消')).toBeTruthy();
  });

  it('renders nothing for garbage', () => {
    const { container } = render(<UiPromptReceipt content="nope" />);
    expect(container.firstChild).toBeNull();
  });
});
