import { describe, expect, it } from 'vitest';
import { incomingAgentMessage, outgoingAgentMessage } from './agentCommunicationModel';

const receipt = (text: string, details = {}) => ({ content: [{ type: 'text', text }], details });

describe('agent communication semantics', () => {
  it('reads both existing envelopes, preserving newlines, indent and embedded envelopes in the body', () => {
    const body = '  code\n\nAgent nested sent a message: not a separate event';
    expect(incomingAgentMessage(`Agent sa-1 sent a message without waking you:\n${body}`))
      .toEqual({ sender: 'sa-1', quiet: true, body });
    expect(incomingAgentMessage('Agent parent sent a message: hello'))
      .toEqual({ sender: 'parent', quiet: false, body: 'hello' });
    expect(incomingAgentMessage('a human mentioned Agent sa-1 sent a message: hi')).toBeNull();
  });

  it('keeps the entire outgoing body and does not mistake a wake request for a delivery fact', () => {
    const body = 'long text '.repeat(5000);
    const pending = outgoingAgentMessage({ agent_id: 'sa-1', message: body }, null, 'running', false);
    expect(pending.body).toBe(body);
    expect(pending.state).toBe('正在准备消息');
    expect(pending.policy).toBe('允许唤醒');
    expect(outgoingAgentMessage({}, undefined, 'done').state).toBe('投递回执未保留');
  });

  it('distinguishes queued delivery, no-wake delivery and overridden wake', () => {
    const args = { agent_id: 'sa-1', message: 'result', wake: false };
    expect(outgoingAgentMessage(args, receipt('message delivered to agent sa-1', { woken: false, delivery: 'next-step' }), 'done').state).toContain('下一步读取');
    expect(outgoingAgentMessage(args, receipt('message delivered to agent sa-1', { woken: false, delivery: 'appended' }), 'done').state).toContain('未唤醒');
    const override = outgoingAgentMessage(args, receipt('message delivered to agent sa-1 and woke it', { woken: true, reason: 'sender-has-live-work' }), 'done');
    expect(override.state).toContain('已唤醒');
    expect(override.note).toContain('仍有子代理或后台任务');
  });

  it('recovers a missing target from the receipt and flags conflicting participants instead of claiming delivery', () => {
    expect(outgoingAgentMessage({ message: 'hello' }, receipt('message delivered to agent sa-9; it is running and will see it at its next step'), 'done'))
      .toMatchObject({ recipient: 'sa-9', state: '已送达 · 下一步读取' });
    const conflict = outgoingAgentMessage({ agent_id: 'sa-1', message: 'hello' }, receipt('message delivered to agent sa-2'), 'done');
    expect(conflict.state).toBe('投递对象待核对');
    expect(conflict.note).toContain('sa-2');
  });

  it('keeps rejection reasons visible without treating error details as a delivery receipt', () => {
    expect(outgoingAgentMessage({ message: 'keep me' }, receipt('未送达 (UNAUTHORIZED): target unavailable'), 'error'))
      .toMatchObject({ state: '未送达', body: 'keep me', note: '未送达 (UNAUTHORIZED): target unavailable', status: 'error' });
    expect(outgoingAgentMessage(null, { details: null }, 'done')).toMatchObject({ body: '', recipient: '' });
  });
});
