import { ChatListView } from './ChatListView';
import { ChatListSkeleton } from './ChatListSkeleton';
import { ChatInput } from './ChatInput';
import type { PromptImage } from './input/ChatInputContext';
import { pi } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { commandLanes } from '../../lib/commandLanes';
import { awaitStreamingEnd } from '../../lib/streamingGate';

export function ChatView() {
  const { workspace, store, workspaceReady } = useAgentStoreContext();

  const handleSend = async (message: string, images?: PromptImage[]) => {
    const text = message.trim();
    if (!text && !images?.length) return;
    // pi 不会回发用户消息，发送前主动加入以乐观显示用户气泡。
    if (text) store.pushUserMessage(text);
    // 经两级 Lane：同会话串行 + 全局并发上限；占住并发槽直到本会话流式结束。
    await commandLanes.run(workspace, async () => {
      await pi.prompt(workspace, text, undefined, images);
      await awaitStreamingEnd(store.useStore);
    });
  };

  const handleAbort = async () => {
    await pi.abort(workspace);
  };

  // Flex 列：消息区 flex:1 滚动，输入框在流内置于底部（不浮动遮挡内容，对齐 lobe）。
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {workspaceReady ? <ChatListView /> : <ChatListSkeleton />}
      </div>
      <ChatInput onSend={handleSend} onAbort={handleAbort} />
    </div>
  );
}
