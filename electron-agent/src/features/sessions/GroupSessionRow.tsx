import { memo, useCallback } from 'react';
import type { SessionInfo } from '../../lib/pi';
import { useSessionAttention } from '../../stores/sessionAttention';
import { SessionItem } from './SessionItem';
import { friendlyTime } from './useConversations';

interface GroupSessionRowProps {
  cwd: string;
  session: SessionInfo;
  active: boolean;
  running: boolean;
  pinned: boolean;
  editing: boolean;
  onOpen: (cwd: string, path: string) => void;
  onDelete: (cwd: string, path: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
  onRequestRename: (path: string) => void;
  onPinToggle: (path: string) => void;
  onReveal: (cwd: string) => void;
  onArchive?: (cwd: string, path: string) => void;
  onRegenerateTitle?: (cwd: string, path: string) => void;
}

export const GroupSessionRow = memo(function GroupSessionRow({
  cwd,
  session,
  active,
  running,
  pinned,
  editing,
  onOpen,
  onDelete,
  onSubmitRename,
  onRequestRename,
  onPinToggle,
  onReveal,
  onArchive,
  onRegenerateTitle,
}: GroupSessionRowProps) {
  const path = session.path;
  const handleClick = useCallback(() => onOpen(cwd, path), [onOpen, cwd, path]);
  const handleDelete = useCallback(() => onDelete(cwd, path), [onDelete, cwd, path]);
  const handleRename = useCallback((name: string) => onSubmitRename(cwd, path, name), [onSubmitRename, cwd, path]);
  const handleRequestRename = useCallback(() => onRequestRename(path), [onRequestRename, path]);
  const handlePinToggle = useCallback(() => onPinToggle(path), [onPinToggle, path]);
  const handleReveal = useCallback(() => onReveal(cwd), [onReveal, cwd]);
  const handleArchive = useCallback(() => onArchive?.(cwd, path), [onArchive, cwd, path]);
  const handleRegenerateTitle = useCallback(() => onRegenerateTitle?.(cwd, path), [onRegenerateTitle, cwd, path]);
  const attention = useSessionAttention(path, running);

  return (
    <SessionItem
      title={session.name || friendlyTime(session.timestamp)}
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
