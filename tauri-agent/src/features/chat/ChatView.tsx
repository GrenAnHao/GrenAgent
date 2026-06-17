import type { CSSProperties } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { Icon } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { AlertTriangle, X } from 'lucide-react';
import { ChatListView } from './ChatListView';
import { ChatListSkeleton } from './ChatListSkeleton';
import { ChatInput } from './ChatInput';
import { EmptyChatPrompt } from './EmptyChatPrompt';
import type { PromptImage } from './input/ChatInputContext';
import { pi } from '../../lib/pi';
import { isUnder } from '../../lib/pathUtils';
import { syncSidebarOnSend } from '../../lib/sidebarSessionSync';
import { useSessionStore } from '../../store/session';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { commandLanes } from '../../lib/commandLanes';
import { awaitStreamingEnd } from '../../lib/streamingGate';

const SLIDE_EASE = [0.22, 1, 0.36, 1] as const;
const SLIDE_DURATION = 0.68;

const composeTransition = {
  layout: { duration: SLIDE_DURATION, ease: SLIDE_EASE },
};

const errorBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  margin: '0 16px 8px',
  padding: '8px 12px',
  borderRadius: 8,
  fontSize: 12,
  lineHeight: 1.5,
  color: cssVar.colorError,
  background: cssVar.colorErrorBg,
  border: `1px solid ${cssVar.colorErrorBorder}`,
};
const errorTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
};
const errorCloseStyle: CSSProperties = {
  display: 'inline-flex',
  flex: '0 0 auto',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
};

export function ChatView() {
  const { workspace, store, workspaceReady } = useAgentStoreContext();
  const worksDir = useSessionStore((s) => s.worksDir);
  const messages = store.useStore((s) => s.messages);
  const lastError = store.useStore((s) => s.lastError);
  const isEmpty = messages.length === 0;
  const isConversation = Boolean(worksDir && isUnder(workspace, worksDir));
  const showEmptyLayout = isEmpty && workspaceReady;

  const handleSend = async (message: string, images?: PromptImage[]) => {
    const text = message.trim();
    if (!text && !images?.length) return;
    store.useStore.setState({ lastError: undefined });
    if (text) store.pushUserMessage(text);
    if (text) void syncSidebarOnSend(workspace, text);
    try {
      await commandLanes.run(workspace, async () => {
        await pi.prompt(workspace, text, undefined, images);
        await awaitStreamingEnd(store.useStore);
      });
      // 兜底诊断：本轮结束后若没有任何助手/工具输出（最后一条仍是刚发的用户消息），
      // 说明模型/供应商返回为空或静默失败——给出可见提示，避免「没反应也没报错」。
      // 若稍后流式才真正开始，agent_start 事件会清掉这条提示（自纠正）。
      const cur = store.useStore.getState();
      const last = cur.messages[cur.messages.length - 1];
      if (!cur.isStreaming && cur.lastError == null && last?.kind === 'user') {
        store.useStore.setState({
          lastError:
            '本轮没有返回任何内容：模型/供应商可能返回为空或出错。请检查该供应商的 Base URL、模型 ID 与 API Key（自定义 Anthropic 一般是 {baseUrl}/v1/messages）；也可在启动 app 的终端查看 [pi stderr] 日志。',
        });
      }
    } catch (e) {
      // pi.prompt 在 Pi 返回 success:false（模型/供应商不可用等）时会 reject——此前未捕获导致静默失败。
      store.useStore.setState({
        lastError: e instanceof Error ? e.message : String(e),
        isStreaming: false,
      });
    }
  };

  const dismissError = () => store.useStore.setState({ lastError: undefined });

  const errorBanner = lastError ? (
    <div style={errorBannerStyle}>
      <Icon icon={AlertTriangle} size={14} />
      <span style={errorTextStyle}>{lastError}</span>
      <button type="button" aria-label="关闭" onClick={dismissError} style={errorCloseStyle}>
        <Icon icon={X} size={14} />
      </button>
    </div>
  ) : null;

  const handleAbort = async () => {
    await pi.abort(workspace);
  };

  return (
    <LayoutGroup id="chat-compose">
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        {showEmptyLayout ? (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'stretch',
            }}
          >
            <motion.div
              layout
              layoutId="chat-compose-shell"
              transition={composeTransition}
              style={{ width: '100%' }}
              data-testid="chat-input-region"
            >
              <AnimatePresence>
                <motion.div
                  key="empty-prompt"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -16 }}
                  transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
                >
                  <EmptyChatPrompt workspace={workspace} isConversation={isConversation} />
                </motion.div>
              </AnimatePresence>
              {errorBanner}
              <ChatInput onSend={handleSend} onAbort={handleAbort} />
            </motion.div>
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
              {workspaceReady ? <ChatListView /> : <ChatListSkeleton />}
            </div>
            <motion.div
              layout
              layoutId="chat-compose-shell"
              transition={composeTransition}
              style={{ flex: 'none', width: '100%' }}
              data-testid="chat-input-region"
            >
              {errorBanner}
              <ChatInput onSend={handleSend} onAbort={handleAbort} />
            </motion.div>
          </>
        )}
      </div>
    </LayoutGroup>
  );
}
