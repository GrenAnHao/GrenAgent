import { describe, expect, it } from 'vitest';
import { composerCanSend, composerSendBehavior } from './sendBehavior';

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
