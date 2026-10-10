import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisplayMessage, TimelineSegment } from './groupMessages';

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('./VirtualizedMessageList', () => ({
  VirtualizedMessageList: (props: unknown) => { list(props); return null; },
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
  useOptionalAgentStoreContext: () => undefined,
}));
vi.mock('../../platform/runtime', () => ({ openPath: vi.fn(), revealItemInDir: vi.fn() }));

import { ChatMessageItems } from './ChatMessageItems';

afterEach(() => { cleanup(); list.mockClear(); });

const tool = (id: string, name: string, parentToolCallId?: string): TimelineSegment => ({
  kind: 'tool', id, toolCallId: id, toolName: name, args: {}, result: {}, status: 'done',
  ...(parentToolCallId ? { parentToolCallId } : {}),
});

const turn: DisplayMessage = {
  kind: 'turn', id: 'turn-1', segments: [
    { kind: 'text', id: 'intro', content: '开始调查', streaming: false },
    tool('read-1', 'read'), tool('read-2', 'read'),
    tool('script', 'codemode'), tool('nested', 'bash', 'script'),
    { kind: 'text', id: 'answer', content: '调查完成', streaming: false },
  ],
};

function rows(virtualizeTurnRows = false) {
  render(<ChatMessageItems messages={[turn]} unitsByMessage={new Map()} answeredQuestions={new Set()} virtualizeTurnRows={virtualizeTurnRows} />);
  return list.mock.calls.at(-1)![0].display;
}

describe('ChatMessageItems 子代理时间线行虚拟化', () => {
  it('主对话默认仍以完整 turn 作为条目', () => {
    expect(rows()).toEqual([turn]);
  });

  it('按真实渲染行交给列表，上下文分组和嵌套工具不拆散', () => {
    const items = rows(true);
    expect(items).toHaveLength(4);
    expect(items.map((item: { id: string }) => item.id)).toEqual([
      'turn-1:intro', 'turn-1:ctx-read-1', 'turn-1:script', 'turn-1:answer',
    ]);
    expect(items[1].row.tools.map((item: { id: string }) => item.id)).toEqual(['read-1', 'read-2']);
    expect(items[2].row.segment.children.map((item: { id: string }) => item.id)).toEqual(['nested']);
  });

  it('整轮只在最后一行显示复制入口，并复制整轮正文', () => {
    const items = rows(true);
    expect(items.filter((item: { actionText?: string }) => item.actionText)).toHaveLength(1);
    expect(items.at(-1).actionText).toBe('开始调查\n\n\n\n\n调查完成');
  });
});
