import { memo, useCallback } from 'react';
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
}: ConversationRowProps) {
  const handleClick = useCallback(() => onOpen(item.cwd, item.sessionPath), [onOpen, item.cwd, item.sessionPath]);
  const handleDelete = useCallback(() => onDelete(item.cwd), [onDelete, item.cwd]);
  const handlePinToggle = useCallback(() => onPinToggle(item.cwd), [onPinToggle, item.cwd]);
  const handleReveal = useCallback(() => onReveal(item.cwd), [onReveal, item.cwd]);
  const handleRename = useCallback(
    (name: string) => onSubmitRename(item.cwd, item.sessionPath, name),
    [onSubmitRename, item.cwd, item.sessionPath],
  );
  const handleRequestRename = useCallback(() => onRequestRename(item.sessionPath), [onRequestRename, item.sessionPath]);

  return (
    <SessionItem
      title={item.name}
      active={active}
      running={running}
      pinned={pinned}
      editing={editing}
      onClick={handleClick}
      onPinToggle={handlePinToggle}
      onRequestRename={handleRequestRename}
      onRename={handleRename}
      onDelete={handleDelete}
      onReveal={handleReveal}
    />
  );
});
