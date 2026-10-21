// 侧栏底部的「已归档」入口和弹窗：只读查看、取消归档、删除。
// Note: 见 .agents/notes/implemented/feature/2026-10-19-session-archive.md
import { memo, useMemo, useState } from 'react';
import { Icon } from '@lobehub/ui';
import { Alert, Button, Empty, Modal, Space } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Archive } from 'lucide-react';
import type { SessionInfo } from '../../lib/pi';
import { archivedSessions } from '../../lib/mergeSessions';
import { isUnder } from '../../lib/pathUtils';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import { friendlyTime } from './useConversations';
import { ReadonlySessionView } from './ReadonlySessionView';

const styles = createStaticStyles(({ css }) => ({
  entry: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;
    margin: 4px 6px 6px;
    padding: 6px 10px;
    border-radius: ${cssVar.borderRadius};
    color: ${cssVar.colorTextSecondary};
    font-size: var(--pi-font-size-secondary, 13px);
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }
  `,
  count: css`
    margin-inline-start: auto;
    color: ${cssVar.colorTextTertiary};
    font-variant-numeric: tabular-nums;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    max-height: 60vh;
    overflow-y: auto;
  `,
  row: css`
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 10px 4px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};

    &:last-child {
      border-bottom: none;
    }
  `,
  main: css`
    flex: 1;
    min-width: 0;
  `,
  title: css`
    overflow: hidden;
    color: ${cssVar.colorText};
    white-space: nowrap;
    text-overflow: ellipsis;
  `,
  meta: css`
    margin-top: 2px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
}));

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

function formatTime(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const titleOfSession = (s: SessionInfo) => s.name || friendlyTime(s.timestamp);

export interface ArchivedSessionsProps {
  onUnarchive: (session: SessionInfo) => void;
  onDelete: (cwd: string, path: string) => void;
}

export const ArchivedSessions = memo(function ArchivedSessions({ onUnarchive, onDelete }: ArchivedSessionsProps) {
  const all = useSessionStore((s) => s.allSessions);
  const deleted = useSessionStore((s) => s.deletedSessionPaths);
  const worksDir = useSessionStore((s) => s.worksDir);
  const aliases = useSidebarPrefsStore((s) => s.aliases);
  const list = useMemo(() => archivedSessions(all, deleted), [all, deleted]);

  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<SessionInfo | null>(null);
  const [deleting, setDeleting] = useState<SessionInfo | null>(null);

  const placeOf = (s: SessionInfo) => {
    if (!s.cwd) return '';
    if (worksDir && isUnder(s.cwd, worksDir)) return '对话';
    return aliases[s.cwd] || basename(s.cwd);
  };

  // 弹窗开着时最后一条也取消归档了，入口仍要留着让弹窗显示空状态；关掉后再收起。
  if (list.length === 0 && !open) return null;

  const unarchive = (s: SessionInfo) => {
    if (viewing && viewing.path === s.path) setViewing(null);
    onUnarchive(s);
  };

  return (
    <>
      <div className={styles.entry} data-testid="archived-entry" onClick={() => setOpen(true)}>
        <Icon icon={Archive} size="small" />
        <span>已归档</span>
        <span className={styles.count} data-testid="archived-count">
          {list.length}
        </span>
      </div>
      <Modal
        open={open}
        title="已归档的会话"
        footer={null}
        width={640}
        centered
        onCancel={() => setOpen(false)}
        wrapClassName="archived-modal"
      >
        {list.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有已归档的会话" />
        ) : (
          <div className={styles.list} data-testid="archived-list">
            {list.map((s) => (
              <div key={s.path} className={styles.row} data-testid="archived-row" data-path={s.path}>
                <div className={styles.main}>
                  <div className={styles.title}>{titleOfSession(s)}</div>
                  <div className={styles.meta}>
                    {[placeOf(s), formatTime(s.timestamp)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <Space size={4}>
                  <Button size="small" data-testid="archived-view" onClick={() => setViewing(s)}>
                    查看
                  </Button>
                  <Button size="small" data-testid="archived-restore" onClick={() => unarchive(s)}>
                    取消归档
                  </Button>
                  <Button size="small" danger data-testid="archived-delete" onClick={() => setDeleting(s)}>
                    删除
                  </Button>
                </Space>
              </div>
            ))}
          </div>
        )}
      </Modal>
      <Modal
        open={viewing != null}
        title={viewing ? titleOfSession(viewing) : ''}
        width={860}
        centered
        destroyOnHidden
        wrapClassName="archived-viewer"
        onCancel={() => setViewing(null)}
        footer={
          viewing ? (
            <Button data-testid="archived-viewer-restore" onClick={() => unarchive(viewing)}>
              取消归档
            </Button>
          ) : null
        }
      >
        <Alert
          type="info"
          showIcon
          message="这个会话已归档，只能查看。取消归档后回到侧栏，可以继续对话。"
          style={{ marginBottom: 12 }}
        />
        {viewing ? <ReadonlySessionView sessionPath={viewing.path} testId="archived-readonly-session" /> : null}
      </Modal>
      <Modal
        open={deleting != null}
        title="删除会话"
        okText="删除"
        cancelText="取消"
        centered
        wrapClassName="archived-delete"
        okButtonProps={{ danger: true, 'data-testid': 'archived-delete-confirm' }}
        cancelButtonProps={{ 'data-testid': 'archived-delete-cancel' }}
        onOk={() => {
          const target = deleting;
          setDeleting(null);
          if (target?.cwd) onDelete(target.cwd, target.path);
        }}
        onCancel={() => setDeleting(null)}
      >
        确定删除「{deleting ? titleOfSession(deleting) : ''}」吗？此操作不可恢复。
      </Modal>
    </>
  );
});
