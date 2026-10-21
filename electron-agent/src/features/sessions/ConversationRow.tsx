import { memo, useCallback } from 'react';
import { useSessionAttention } from '../../stores/sessionAttention';
import { SessionItem } from './SessionItem';
import type { ConversationItem } from './useConversations';

interface ConversationRowProps {
  item: ConversationItem;
  active: boolean;
  running: boolean;
  pinned: boolean;
  editing: boolean;
  onOpen: (cwd: string, path: string) => void;
  onDelete: (cwd: string) => void;
  onPinToggle: (cwd: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
  onRequestRename: (path: string) => void;
  onReveal: (cwd: string) => void;
  /** 归档整个对话目录（下面的会话一起归档，否则次新的那份会顶上来）。 */
  onArchive?: (cwd: string) => void;
  onRegenerateTitle?: (cwd: string, path: string) => void;
}

export const ConversationRow = memo(function ConversationRow({
  item,
  active,
  running,
  pinned,
  editing,
  onOpen,
  onDelete,
  onPinToggle,
  onSubmitRename,
  onRequestRename,
  onReveal,
  onArchive,
  onRegenerateTitle,
}: ConversationRowProps) {
  const handleClick = useCallback(() => onOpen(item.cwd, item.sessionPath), [onOpen, item.cwd, item.sessionPath]);
  const handleDelete = useCallback(() => onDelete(item.cwd), [onDelete, item.cwd]);
  const handlePinToggle = useCallback(() => onPinToggle(item.cwd), [onPinToggle, item.cwd]);
  const handleReveal = useCallback(() => onReveal(item.cwd), [onReveal, item.cwd]);
  const handleArchive = useCallback(() => onArchive?.(item.cwd), [onArchive, item.cwd]);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateTitle?.(item.cwd, item.sessionPath),
    [onRegenerateTitle, item.cwd, item.sessionPath],
  );
  const handleRename = useCallback(
    (name: string) => onSubmitRename(item.cwd, item.sessionPath, name),
    [onSubmitRename, item.cwd, item.sessionPath],
  );
  const handleRequestRename = useCallback(() => onRequestRename(item.sessionPath), [onRequestRename, item.sessionPath]);
  const attention = useSessionAttention(item.sessionPath, running);

  return (
    <SessionItem
      title={item.name}
      active={active}
      running={running}
      attention={attention}
      pinned={pinned}
      editing={editing}
      onClick={handleClick}
      onPinToggle={handlePinToggle}
      onRequestRename={handleRequestRename}
      onRename={handleRename}
      onDelete={handleDelete}
      onReveal={handleReveal}
      onArchive={onArchive ? handleArchive : undefined}
      onRegenerateTitle={onRegenerateTitle ? handleRegenerateTitle : undefined}
    />
  );
});
