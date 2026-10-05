import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/agentReducer';
import { settleAbortedSteers } from './steerAbort';

const steer = (id: string, text: string, steerState: 'written' | 'consumed' | 'requeued' = 'written'): ChatMessage => ({
  kind: 'user',
  id,
  text,
  steering: true,
  steerState,
});

describe('settleAbortedSteers', () => {
  it('只把第一条未注入的引导当成新消息，其余回到排队', () => {
    const messages: ChatMessage[] = [
      { kind: 'user', id: 'u0', text: '原来的问题' },
      steer('s1', '改用 chrome'),
      steer('s2', '再补登录态'),
      steer('s3', '多账号自动填充'),
    ];
    const plan = settleAbortedSteers(messages, [{ id: 'cq-old', text: '已有排队' }], [
      '改用 chrome',
      '再补登录态',
      '多账号自动填充',
    ]);
    expect(plan.send).toEqual({ text: '改用 chrome', images: undefined, alreadyShown: true });
    expect(plan.messages.map((message) => message.kind === 'user' ? message.text : message.kind)).toEqual([
      '原来的问题',
      '改用 chrome',
    ]);
    expect(plan.messages[1]).not.toHaveProperty('steering');
    expect(plan.composerQueue.map((item) => item.text)).toEqual(['再补登录态', '多账号自动填充', '已有排队']);
  });

  it('已经注入当前回合的引导不再发送', () => {
    const plan = settleAbortedSteers(
      [steer('s1', '已经引导', 'consumed')],
      [],
      [],
    );
    expect(plan.send).toBeNull();
    expect(plan.messages).toHaveLength(1);
  });
});
