import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Dropdown, Input, Modal } from 'antd';
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
  /* 行尾一格：转圈和「更多」叠在同一格里，悬停只切换谁可见，标题不会被挤动。
     24px 是 ActionIcon size="small" 的边长，ui-harness 的 session-row 场景会断言两者同尺寸。 */
  tail: css`
    display: none;
    flex: none;
    place-items: center;
    width: 24px;
    height: 24px;

    .pi-session-row:hover &,
    &[data-running='true'] {
      display: grid;
    }
  `,
  spin: css`
    display: inline-flex;
    grid-area: 1 / 1;
    color: ${cssVar.colorWarning};
    animation: piSidebarSpin 1.1s linear infinite;

    @keyframes piSidebarSpin {
      to {
        transform: rotate(360deg);
      }
    }

    .pi-session-row:hover & {
      visibility: hidden;
    }
  `,
  acts: css`
    display: flex;
    grid-area: 1 / 1;
    visibility: hidden;

    .pi-session-row:hover & {
      visibility: visible;
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestDelete = useCallback(() => setDeleteOpen(true), []);
  const confirmDelete = useCallback(() => {
    setDeleteOpen(false);
    onDelete();
  }, [onDelete]);

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
    onDelete: requestDelete,
    onReveal,
  });

  return (
    <>
      <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']}>
        <div
          className={cx('pi-session-row', styles.row, active && styles.active)}
          onClick={onClick}
          onMouseEnter={() => {
            if (!hovered) setHovered(true);
          }}
        >
          <span className={styles.title}>{title}</span>
          <span className={styles.tail} data-running={running}>
            {running && (
              <span data-testid="session-running" className={styles.spin}>
                <Icon icon={waiting ? Hand : LoaderCircle} size="small" />
              </span>
            )}
            {/* 运行中的行靠 CSS 在这一格里换转圈和按钮，按钮得提前挂好，否则首次悬停会空一帧 */}
            <span className={styles.acts}>{(hovered || running) && <RowActions menuItems={menuItems} />}</span>
          </span>
        </div>
      </Dropdown>
      <Modal
        open={deleteOpen}
        title="删除会话"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true, 'data-testid': 'session-delete-confirm' }}
        cancelButtonProps={{ 'data-testid': 'session-delete-cancel' }}
        onOk={confirmDelete}
        onCancel={() => setDeleteOpen(false)}
        centered
      >
        确定删除「{title}」吗？此操作不可恢复。
      </Modal>
    </>
  );
});
