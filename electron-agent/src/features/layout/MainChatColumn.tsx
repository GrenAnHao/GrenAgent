import { memo } from 'react';
import { Flexbox } from '@lobehub/ui';
import { ChatView } from '../chat/ChatView';
import { ChildSessionOverlay } from '../subagents/ChildSessionOverlay';
import { useChildOverlayStore } from '../../stores/childOverlayStore';
import { MainColumnHeader } from './MainColumnHeader';

export const MainChatColumn = memo(function MainChatColumn() {
  const overlay = useChildOverlayStore((s) => s.overlay);
  return (
    <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
      <MainColumnHeader />
      <Flexbox flex={1} style={{ minHeight: 0, position: 'relative' }}>
        <Flexbox flex={1} style={{ minHeight: 0, height: '100%', position: 'relative' }}>
          <div
            style={{ flex: 1, height: '100%', minHeight: 0, ...(overlay ? { pointerEvents: 'none' } : {}) }}
            inert={overlay ? true : undefined}
            aria-hidden={overlay ? true : undefined}
          >
            <ChatView />
          </div>
          {overlay ? <ChildSessionOverlay /> : null}
        </Flexbox>
      </Flexbox>
    </Flexbox>
  );
});
