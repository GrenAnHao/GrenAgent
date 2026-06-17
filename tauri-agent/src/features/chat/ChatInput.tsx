import { useCallback, useMemo, useState } from 'react';
import { Flexbox } from '@lobehub/ui';
import { ChatInputAreaInner } from '@lobehub/ui/chat';
import { createStaticStyles, cssVar } from 'antd-style';
import { useAgentStore } from '../../stores/AgentStoreContext';
import {
  ChatInputProvider,
  useChatInput,
  type ChatInputContextValue,
  type ImageAttachment,
  type PromptImage,
} from './input/ChatInputContext';
import { ActionBar } from './input/ActionBar';
import { SendArea } from './input/SendArea';
import { AttachmentPreview } from './input/AttachmentPreview';
import { DEFAULT_LEFT_ACTIONS, DEFAULT_RIGHT_ACTIONS, type ActionKey } from './input/config';
import { SlashCommandMenu } from './input/SlashCommandMenu';
import { useSlashMenu } from './input/useSlashMenu';
import { ContextUsageTag } from './input/ContextUsageTag';

const styles = createStaticStyles(({ css }) => ({
  surface: css`
    position: relative;
    flex: none;

    margin: 8px 16px 16px;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
  `,
  inputWrap: css`
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadiusLG};
    padding: 4px 8px;
    background: ${cssVar.colorBgContainer};
  `,
}));

interface ChatInputProps {
  onSend: (message: string, images?: PromptImage[]) => Promise<void> | void;
  onAbort: () => Promise<void> | void;
  leftActions?: ActionKey[];
  rightActions?: ActionKey[];
}

export function ChatInput({
  onSend,
  onAbort,
  leftActions = DEFAULT_LEFT_ACTIONS,
  rightActions = DEFAULT_RIGHT_ACTIONS,
}: ChatInputProps) {
  const { useStore } = useAgentStore();
  const isStreaming = useStore((s) => s.isStreaming);
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);

  const send = useCallback(() => {
    const text = value.trim();
    if ((!text && attachments.length === 0) || isStreaming) return;
    const images: PromptImage[] = attachments.map(({ type, mimeType, data }) => ({
      type,
      mimeType,
      data,
    }));
    setValue('');
    setAttachments([]);
    void onSend(text, images.length ? images : undefined);
  }, [value, attachments, isStreaming, onSend]);

  const stop = useCallback(() => {
    void onAbort();
  }, [onAbort]);

  const ctx: ChatInputContextValue = useMemo(
    () => ({
      value,
      setValue,
      attachments,
      addAttachments: (items) => setAttachments((prev) => [...prev, ...items]),
      removeAttachment: (index) => setAttachments((prev) => prev.filter((_, i) => i !== index)),
      isStreaming,
      send,
      stop,
    }),
    [value, attachments, isStreaming, send, stop],
  );

  return (
    <ChatInputProvider value={ctx}>
      <InputSurface leftActions={leftActions} rightActions={rightActions} />
    </ChatInputProvider>
  );
}

interface InputSurfaceProps {
  leftActions: ActionKey[];
  rightActions: ActionKey[];
}

function InputSurface({ leftActions, rightActions }: InputSurfaceProps) {
  const { value, setValue, isStreaming, send } = useChatInput();
  const {
    textareaRef,
    anchorRef,
    open: slashOpen,
    query: slashQuery,
    slashContext,
    close: closeSlashMenu,
    handleInput,
    handleSelectionChange,
    handleOpenChange,
    slashMenuOpen,
  } = useSlashMenu(value, setValue);

  return (
    <div className={styles.surface}>
      <Flexbox gap={8} align="stretch">
        <AttachmentPreview />
        <div ref={anchorRef} className={styles.inputWrap}>
          <ChatInputAreaInner
            ref={textareaRef}
            value={value}
            loading={isStreaming}
            placeholder="Type a message..."
            autoSize={{ minRows: 1, maxRows: 8 }}
            onInput={handleInput}
            onSelect={handleSelectionChange}
            onKeyUp={handleSelectionChange}
            onKeyDown={(e) => {
              if (slashMenuOpen) {
                // Slash menu owns Enter/Escape while open: Esc closes it, Enter is
                // consumed by the menu's document keydown listener to pick a command.
                // onPressEnter below blocks the textarea newline, so never send here.
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeSlashMenu();
                }
                return;
              }
              // Menu closed: Enter sends, Shift+Enter adds a newline. Rely on the native
              // isComposing flag so a stale IME state inside ChatInputAreaInner cannot
              // swallow Enter and turn a send into a newline.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            onPressEnter={(e) => {
              if (slashMenuOpen) e.preventDefault();
            }}
          />
          <SlashCommandMenu
            open={slashOpen}
            query={slashQuery}
            slashContext={slashContext}
            value={value}
            anchorRef={anchorRef}
            textareaRef={textareaRef}
            onOpenChange={handleOpenChange}
            onClose={closeSlashMenu}
          />
        </div>
        <Flexbox horizontal align="center" gap={8}>
          <ActionBar actions={leftActions} />
          <Flexbox horizontal align="center" gap={8} style={{ flexShrink: 0 }}>
            <ContextUsageTag />
            <SendArea actions={rightActions} />
          </Flexbox>
        </Flexbox>
      </Flexbox>
    </div>
  );
}
