import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Dropdown, Input, Modal, Tooltip } from 'antd';
import { ActionIcon, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Archive, LoaderCircle } from 'lucide-react';
import type { AttentionKind } from '../../stores/attentionView';
import { AttentionIcon } from './AttentionIcon';
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
    &[data-running='true'],
    &[data-attention] {
      display: grid;
    }
  `,
  /* 注意状态角标：和转圈同一个位置，悬停时同样让位给「更多」。 */
  badge: css`
    display: inline-flex;
    grid-area: 1 / 1;

    .pi-session-row:hover & {
      visibility: hidden;
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
  /* 「更多」左边的归档按钮：只在悬停时占位。负边距抵掉行的 8px gap，和「更多」间距 2px，同 RowActions。 */
  archive: css`
    display: none;
    flex: none;
    margin-inline-end: -6px;

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
  /** 会话注意状态。给了就画它不画转圈；转圈压过它时调用方不传（见 useSessionAttention）。 */
  attention?: { kind: AttentionKind; tooltip: string };
  pinned: boolean;
  editing?: boolean;
  onClick: () => void;
  onPinToggle: () => void;
  onRequestRename: () => void;
  onRename: (name: string) => void;
  onRegenerateTitle?: () => void;
  onDelete: () => void;
  onReveal?: () => void;
  onArchive?: () => void;
}

export const SessionItem = memo(function SessionItem(props: SessionItemProps) {
  const {
    title,
    active,
    running,
    attention,
    pinned,
    editing,
    onClick,
    onPinToggle,
    onRequestRename,
    onRename,
    onRegenerateTitle,
    onDelete,
    onReveal,
    onArchive,
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
    onRegenerateTitle,
    onDelete: requestDelete,
    onReveal,
    onArchive,
    archiveDisabled: running,
  });
  // 回合在跑的行不出归档按钮（菜单里那项是灰的并写了原因）。
  const showArchive = Boolean(onArchive) && !running && hovered;

  return (
    <>
      <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']}>
        {/* Tooltip 总是挂着：按有没有状态条件包裹会让整行重挂、丢掉悬停状态。行尾格悬停会换成按钮，状态说明放在整行上。 */}
        <Tooltip title={attention?.tooltip} placement="right" mouseEnterDelay={0.4}>
        <div
          className={cx('pi-session-row', styles.row, active && styles.active)}
          onClick={onClick}
          onMouseEnter={() => {
            if (!hovered) setHovered(true);
          }}
        >
          <span className={styles.title}>{title}</span>
          {showArchive && (
            <span className={styles.archive} onClick={(e) => e.stopPropagation()}>
              <ActionIcon
                icon={Archive}
                size="small"
                title="归档"
                data-testid="session-archive-button"
                onClick={onArchive}
              />
            </span>
          )}
          <span className={styles.tail} data-running={running} data-attention={attention?.kind}>
            {attention ? (
              <span
                data-testid="session-attention"
                data-kind={attention.kind}
                aria-label={attention.tooltip}
                className={styles.badge}
              >
                <AttentionIcon kind={attention.kind} />
              </span>
            ) : (
              running && (
                <span data-testid="session-running" className={styles.spin}>
                  <Icon icon={LoaderCircle} size="small" />
                </span>
              )
            )}
            {/* 运行中 / 有角标的行靠 CSS 在这一格里换图标和按钮，按钮得提前挂好，否则首次悬停会空一帧 */}
            <span className={styles.acts}>
              {(hovered || running || Boolean(attention)) && <RowActions menuItems={menuItems} />}
            </span>
          </span>
        </div>
        </Tooltip>
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
