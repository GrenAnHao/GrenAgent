import { useCallback } from 'react';
import { EditorSlashMenu, type EditorSlashMenuOption } from '@lobehub/ui';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { createStaticStyles, cssVar } from 'antd-style';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { pi } from '../../../lib/pi';
import { useChatInput } from './ChatInputContext';
import { parseSlashMenuValue } from './commandUtils';
import { useSlashCommands } from './useSlashCommands';
import type { SlashContext } from './slashMenuUtils';
import { insertCommandDraft, stripSlashToken } from './slashMenuUtils';

interface SlashCommandMenuProps {
  open: boolean;
  query: string;
  slashContext: SlashContext | null;
  value: string;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  textareaRef: React.RefObject<TextAreaRef | null>;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
}

function focusTextAreaAt(textareaRef: React.RefObject<TextAreaRef | null>, cursor: number) {
  requestAnimationFrame(() => {
    const el = textareaRef.current?.resizableTextArea?.textArea;
    if (!el) return;
    el.focus();
    el.setSelectionRange(cursor, cursor);
  });
}

const styles = createStaticStyles(({ css }) => ({
  itemRow: css`
    display: flex;
    flex: 1;
    gap: 12px;
    align-items: center;
    min-width: 0;
  `,
  itemLabel: css`
    overflow: hidden;
    flex-shrink: 0;
    max-width: 45%;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  itemExtra: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;

    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-align: end;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

export function SlashCommandMenu({
  open,
  query,
  slashContext,
  value,
  anchorRef,
  textareaRef,
  onOpenChange,
  onClose,
}: SlashCommandMenuProps) {
  const { workspace, store } = useAgentStoreContext();
  const { setValue } = useChatInput();
  const { items } = useSlashCommands(open, workspace);

  const handleSelect = useCallback(
    (item: EditorSlashMenuOption) => {
      const parsed = parseSlashMenuValue(item.value);
      if (!parsed) {
        onClose();
        return;
      }

      if (parsed.kind === 'frontend') {
        const nextValue = slashContext ? stripSlashToken(value, slashContext) : value;

        if (parsed.name === 'compact') {
          setValue(nextValue);
          onClose();
          void pi.compact(workspace);
          return;
        }

        if (parsed.name === 'newSession') {
          onClose();
          void (async () => {
            await pi.newSession(workspace);
            store.reset();
            setValue('');
          })();
          return;
        }

        setValue(nextValue);
        onClose();
        return;
      }

      if (!slashContext) {
        onClose();
        return;
      }

      const { text: newText, cursor } = insertCommandDraft(value, slashContext, parsed.name);
      setValue(newText);
      onClose();
      focusTextAreaAt(textareaRef, cursor);
    },
    [slashContext, value, workspace, store, setValue, onClose, textareaRef],
  );

  const renderItem = useCallback(
    (item: EditorSlashMenuOption) => (
      <div className={styles.itemRow}>
        <span className={styles.itemLabel}>{item.label}</span>
        {item.extra ? (
          <span
            className={styles.itemExtra}
            title={typeof item.extra === 'string' ? item.extra : undefined}
          >
            {item.extra}
          </span>
        ) : null}
      </div>
    ),
    [styles],
  );

  return (
    <EditorSlashMenu
      items={items}
      anchor={anchorRef}
      open={open}
      onOpenChange={onOpenChange}
      value={query}
      onSelect={handleSelect}
      renderItem={renderItem}
      reserveIconSpace={false}
      positionerProps={{ side: 'top', align: 'start' }}
    />
  );
}
