import { memo, useEffect, useRef, useState } from 'react';
import { Dropdown, Input } from 'antd';
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Hand, LoaderCircle } from 'lucide-react';
import { RowActions } from './RowActions';
import { buildSessionMenuItems } from './useSessionMenu';

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    margin: 0 6px;
    padding: 0 8px 0 16px;
    border-radius: 7px;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  active: css`
    color: ${cssVar.colorText};
    background: ${cssVar.colorFill};

    &:hover {
      background: ${cssVar.colorFill};
    }
  `,
  title: css`
    overflow: hidden;
    flex: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  spin: css`
    display: inline-flex;
    color: ${cssVar.colorWarning};
    animation: piSidebarSpin 1.1s linear infinite;

    @keyframes piSidebarSpin {
      to {
        transform: rotate(360deg);
      }
    }
  `,
  acts: css`
    display: none;

    .pi-session-row:hover & {
      display: flex;
    }
  `,
  editWrap: css`
    display: flex;
    align-items: center;
    height: 28px;
    margin: 0 6px;
    padding: 0 8px 0 16px;
  `,
}));

export interface SessionItemProps {
  title: string;
  active: boolean;
  running: boolean;
  waiting?: boolean;
  pinned: boolean;
  editing?: boolean;
  onClick: () => void;
  onPinToggle: () => void;
  onRequestRename: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onReveal?: () => void;
}

export const SessionItem = memo(function SessionItem(props: SessionItemProps) {
  const {
    title,
    active,
    running,
    waiting,
    pinned,
    editing,
    onClick,
    onPinToggle,
    onRequestRename,
    onRename,
    onDelete,
    onReveal,
  } = props;
  const [draft, setDraft] = useState(title);
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(title);
      inputRef.current?.focus();
    }
  }, [editing, title]);

  if (editing) {
    const submit = () => {
      const v = draft.trim();
      onRename(v && v !== title ? v : title);
    };
    return (
      <div className={styles.editWrap}>
        <Input
          ref={inputRef as never}
          data-testid="session-rename-input"
          size="small"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') onRename(title);
          }}
          onBlur={submit}
        />
      </div>
    );
  }

  const menuItems = buildSessionMenuItems({
    pinned,
    onPinToggle,
    onRename: onRequestRename,
    onDelete,
    onReveal,
  });

  return (
    <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']}>
      <div
        className={cx('pi-session-row', styles.row, active && styles.active)}
        onClick={onClick}
        onMouseEnter={() => {
          if (!hovered) setHovered(true);
        }}
      >
        <span className={styles.title}>{title}</span>
        {running && (
          <span data-testid="session-running" className={styles.spin}>
            <Icon icon={waiting ? Hand : LoaderCircle} size="small" />
          </span>
        )}
        <span className={styles.acts}>{hovered && <RowActions menuItems={menuItems} />}</span>
      </div>
    </Dropdown>
  );
});
