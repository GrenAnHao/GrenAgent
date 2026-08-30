import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { DisplayMessage } from './groupMessages';
import { VirtualizedMessageList } from './VirtualizedMessageList';

afterEach(cleanup);

describe('VirtualizedMessageList', () => {
  it('mounts the scroll container with the given testid without crashing', () => {
    const msgs: DisplayMessage[] = [
      { kind: 'user', id: 'u1', text: 'a' } as DisplayMessage,
      { kind: 'user', id: 'u2', text: 'b' } as DisplayMessage,
    ];
    const { getByTestId } = render(
      <VirtualizedMessageList
        display={msgs}
        renderItem={(m) => <div data-testid={`item-${m.id}`}>x</div>}
        data-testid="vlist"
      />,
    );
    // jsdom 无真实测高，virtua 首屏渲染条数不确定；冒烟只验容器挂载，行为交手动验收。
    expect(getByTestId('vlist')).toBeTruthy();
  });

  it('renders empty (no footer) without crashing', () => {
    const { getByTestId } = render(
      <VirtualizedMessageList display={[]} renderItem={() => null} data-testid="vlist-empty" />,
    );
    expect(getByTestId('vlist-empty')).toBeTruthy();
  });
});
