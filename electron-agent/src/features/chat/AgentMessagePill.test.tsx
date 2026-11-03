import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMessagePill, agentMessageTitle } from './AgentMessagePill';

afterEach(() => cleanup());

describe('AgentMessagePill', () => {
  it('names the sender and says it did not wake the recipient', () => {
    expect(agentMessageTitle('Agent sa-1 sent a message without waking you:')).toBe('来自 sa-1 的消息（未唤醒）');
    expect(agentMessageTitle('something else')).toBe('something else');
  });

  it('shows the sender, recipient and full body without opening a disclosure', async () => {
    render(<AgentMessagePill content={'Agent p-9 sent a message without waking you:\nkeep the cache warm'} />);
    const el = screen.getByTestId('agent-message-pill');
    expect(el.textContent).toContain('p-9');
    expect(el.textContent).toContain('当前会话代理');
    expect(el.textContent).not.toContain('已注入上下文');
    expect(await screen.findByText('keep the cache warm')).toBeTruthy();
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('keep the cache warm')).toBeNull();
    expect(el.textContent).toContain('p-9');
    fireEvent.click(toggle);
    expect(await screen.findByText('keep the cache warm')).toBeTruthy();
  });
});
