import { describe, expect, it } from 'vitest';
import {
  composerCanSend,
  composerPrimaryAction,
  composerSendBehavior,
  shouldDispatchSingleQueued,
  waitForTurnIdle,
} from './sendBehavior';

describe('composerSendBehavior', () => {
  it('生成中发送也先落成跟进条', () => {
    expect(composerSendBehavior({ isGenerating: true, isStreaming: true, hasFollowUp: false })).toBe('followUp');
  });

  it('工具执行中发送为跟进条，不立刻引导', () => {
    expect(composerSendBehavior({
      isGenerating: false,
      isStreaming: true,
      hasFollowUp: false,
      hasRunningTool: true,
    })).toBe('followUp');
  });

  it('执行中停笔且无工具发送为跟进', () => {
    expect(composerSendBehavior({ isGenerating: false, isStreaming: true, hasFollowUp: false })).toBe('followUp');
  });

  it('本地跟进条未发完时继续跟进，不新开一轮', () => {
    expect(composerSendBehavior({
      isGenerating: false,
      isStreaming: false,
      hasFollowUp: false,
      hasComposerQueue: true,
    })).toBe('followUp');
  });

  it('跟进仍在队列时即使已停流也继续跟进，不新开一轮', () => {
    expect(composerSendBehavior({ isGenerating: false, isStreaming: false, hasFollowUp: true })).toBe('followUp');
  });

  it('空闲且无跟进才是新一轮', () => {
    expect(composerSendBehavior({ isGenerating: false, isStreaming: false, hasFollowUp: false })).toBeUndefined();
  });
});

describe('composerPrimaryAction', () => {
  it('错误横幅出现后回到发送', () => {
    expect(composerPrimaryAction({ inFlight: false, canSend: true })).toBe('send');
  });

  it('进行中已有草稿时同一个按钮是发送，方便增量发出', () => {
    expect(composerPrimaryAction({ inFlight: true, canSend: true })).toBe('send');
  });

  it('进行中输入为空时同一个按钮变成停止', () => {
    expect(composerPrimaryAction({ inFlight: true, canSend: false })).toBe('stop');
  });

  it('空闲且没有可发内容时仍是禁用的发送', () => {
    expect(composerPrimaryAction({ inFlight: false, canSend: false })).toBe('send');
  });
});

describe('空回车发送单条跟进', () => {
  it('只有一条跟进、输入为空、本轮还在进行时才由回车发出', () => {
    expect(shouldDispatchSingleQueued({
      empty: true,
      hasAttachments: false,
      composerQueueCount: 1,
      busy: true,
    })).toBe(true);
    expect(shouldDispatchSingleQueued({
      empty: true,
      hasAttachments: false,
      composerQueueCount: 2,
      busy: true,
    })).toBe(false);
    expect(shouldDispatchSingleQueued({
      empty: false,
      hasAttachments: false,
      composerQueueCount: 1,
      busy: true,
    })).toBe(false);
    expect(shouldDispatchSingleQueued({
      empty: true,
      hasAttachments: false,
      composerQueueCount: 1,
      busy: false,
    })).toBe(false);
  });

  it('回合停下后不再继续等', async () => {
    let busy = true;
    const done = waitForTurnIdle(() => ({ busy }), async () => {
      busy = false;
    }, 1000);
    await done;
    expect(busy).toBe(false);
  });
});

describe('composerCanSend', () => {
  it('空闲且有跟进时允许空回车继续', () => {
    expect(composerCanSend({ empty: true, hasAttachments: false, hasFollowUp: true, isStreaming: false })).toBe(true);
  });

  it('空闲且有本地跟进条时允许空回车继续', () => {
    expect(composerCanSend({
      empty: true,
      hasAttachments: false,
      hasFollowUp: false,
      hasComposerQueue: true,
      isStreaming: false,
    })).toBe(true);
  });

  it('执行中有跟进仍不允许空发送', () => {
    expect(composerCanSend({ empty: true, hasAttachments: false, hasFollowUp: true, isStreaming: true })).toBe(false);
  });

  it('空闲无跟进不允许空发送', () => {
    expect(composerCanSend({ empty: true, hasAttachments: false, hasFollowUp: false, isStreaming: false })).toBe(false);
  });
});
