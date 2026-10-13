import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMessagePill, agentMessageTitle } from './AgentMessagePill';

afterEach(() => cleanup());

describe('AgentMessagePill', () => {
  it('names the sender and says it did not wake the recipient', () => {
    expect(agentMessageTitle('Agent sa-1 sent a message without waking you:')).toBe('来自 sa-1 的消息（未唤醒）');
    expect(agentMessageTitle('something else')).toBe('something else');
  });

  it('shows the readable title collapsed, not the generic injected-context label', () => {
    render(<AgentMessagePill content={'Agent p-9 sent a message without waking you:\nkeep the cache warm'} />);
    const el = screen.getByTestId('agent-message-pill');
    expect(el.textContent).toContain('来自 p-9 的消息（未唤醒）');
    expect(el.textContent).not.toContain('已注入上下文');
    expect(el.textContent).not.toContain('keep the cache warm');
  });
});
