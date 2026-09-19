import { useState } from 'react';
import { ActionIcon, Icon } from '@lobehub/ui';
import { CornerDownRight, GripVertical, PencilLine, Trash2 } from 'lucide-react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { useChatInput } from './ChatInputContext';
import { updateComposerItem } from './composerQueue';
import { dockCard } from './dockCard';
import { useAgentStore } from '../../../stores/AgentStoreContext';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  head: css`
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
  `,
  grip: css`
    flex: none;
    color: ${cssVar.colorTextQuaternary};
  `,
  title: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;

    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  actions: css`
    display: flex;
    flex: none;
    gap: 2px;
    margin-left: auto;
  `,
  body: css`
    min-height: 44px;
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  editor: css`
    width: 100%;
    min-height: 44px;
    padding: 6px 8px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius};
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgContainer};
    outline: none;
    resize: vertical;
    font: inherit;
  `,
}));

function actionProps(label: string) {
  return { 'aria-label': label, title: label } as { 'aria-label': string; title: string };
}

/**
 * 执行中发送后停在输入栏的跟进条。
 * 点引导 → 注入当前回合；不点 → 本轮结束后自动跟进；可编辑 / 删除。
 */
export function SteerQueue() {
  const { useStore } = useAgentStore();
  const queue = useStore((s) => s.composerQueue) ?? [];
  const { steerQueued } = useChatInput();
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState('');
  if (queue.length === 0) return null;

  return (
    <div className={styles.wrap} data-testid="steer-queue">
      {queue.map((item) => {
        const editing = editingId === item.id;
        return (
          <div className={cx(dockCard.card, styles.card)} data-testid={`composer-queue-item-${item.id}`} key={item.id}>
            <div className={styles.head}>
              <Icon className={styles.grip} icon={GripVertical} size={14} />
              <span className={styles.title}>跟进</span>
              <div className={styles.actions}>
                <ActionIcon
                  {...actionProps('发送引导')}
                  icon={CornerDownRight}
                  onClick={() => steerQueued(item.id)}
                  size="small"
                />
                <ActionIcon
                  {...actionProps('编辑消息')}
                  icon={PencilLine}
                  onClick={() => {
                    setEditingId(item.id);
                    setDraft(item.text);
                  }}
                  size="small"
                />
                <ActionIcon
                  {...actionProps('删除这条')}
                  icon={Trash2}
                  onClick={() => {
                    useStore.setState((s) => ({
                      composerQueue: (s.composerQueue ?? []).filter((entry) => entry.id !== item.id),
                    }));
                    if (editingId === item.id) setEditingId(undefined);
                  }}
                  size="small"
                />
              </div>
            </div>
            {editing ? (
              <textarea
                aria-label="编辑跟进"
                className={styles.editor}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    const next = draft.trim();
                    if (!next) return;
                    useStore.setState((s) => ({
                      composerQueue: updateComposerItem(s.composerQueue ?? [], item.id, next),
                    }));
                    setEditingId(undefined);
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setEditingId(undefined);
                    setDraft(item.text);
                  }
                }}
                value={draft}
              />
            ) : (
              <p className={styles.body}>{item.text}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
