import { memo, useCallback } from 'react';
import type { SessionInfo } from '../../lib/pi';
import { SessionItem } from './SessionItem';

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
}: GroupSessionRowProps) {
  const path = session.path;
  const handleClick = useCallback(() => onOpen(cwd, path), [onOpen, cwd, path]);
  const handleDelete = useCallback(() => onDelete(cwd, path), [onDelete, cwd, path]);
  const handleRename = useCallback((name: string) => onSubmitRename(cwd, path, name), [onSubmitRename, cwd, path]);
  const handleRequestRename = useCallback(() => onRequestRename(path), [onRequestRename, path]);
  const handlePinToggle = useCallback(() => onPinToggle(path), [onPinToggle, path]);

  return (
    <SessionItem
      title={session.name || '新对话'}
      active={active}
      running={running}
      pinned={pinned}
      editing={editing}
      onClick={handleClick}
      onPinToggle={handlePinToggle}
      onRequestRename={handleRequestRename}
      onRename={handleRename}
      onDelete={handleDelete}
    />
  );
});
