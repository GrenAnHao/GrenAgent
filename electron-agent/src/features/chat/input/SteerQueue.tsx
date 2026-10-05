import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ActionIcon, Hotkey, Icon, KeyMapEnum, combineKeys } from '@lobehub/ui';
import { ArrowUp, GripVertical, PencilLine, SquareArrowUp, Trash2 } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { useChatInput } from './ChatInputContext';
import { moveComposerItem, updateComposerItem } from './composerQueue';
import { queueDropBeforeId } from './queueDrop';
import { queueSummaryLabel } from './queueSummary';
import { useAgentStore } from '../../../stores/AgentStoreContext';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  header: css`
    display: flex;
    align-items: center;
    width: 100%;
    padding: 6px 12px;
    overflow: hidden;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 13px;
    color: ${cssVar.colorText};
    text-align: left;
    white-space: nowrap;
  `,
  headerLabel: css`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  row: css`
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
    padding: 4px 12px;
  `,
  grip: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    color: ${cssVar.colorTextQuaternary};
    background: transparent;
    cursor: grab;
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
  hint: css`
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    white-space: nowrap;
  `,
  hintItem: css`
    display: inline-flex;
    gap: 4px;
    align-items: center;
  `,
  actions: css`
    display: flex;
    flex: none;
    gap: 2px;
    margin-left: auto;
  `,
  editor: css`
    flex: 1;
    min-width: 0;
    min-height: 32px;
    padding: 4px 8px;
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
 * 执行中发送后停在输入栏的跟进。
 * 只有一条时直接露出这一行，不收进排队摘要。
 * 多条才收成「排队 · N」，点开后每条仍是一行。
 * 引导把这条注入当前回合；截断发送先停掉当前回复再作为新消息发出。
 */
export function SteerQueue() {
  const { useStore } = useAgentStore();
  const queue = useStore((s) => s.composerQueue) ?? [];
  const { steerQueued, interruptQueued } = useChatInput();
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState('');
  const dragDetachRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      dragDetachRef.current?.();
      dragDetachRef.current = null;
    },
    [],
  );

  if (queue.length === 0) return null;

  const single = queue.length === 1;
  const summary = queueSummaryLabel(queue);
  const firstTitle = queue[0]?.text.trim() || undefined;

  const onDragHandlePointerDown = (draggingId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    dragDetachRef.current?.();

    const pointerId = event.pointerId;

    const detach = () => {
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      if (dragDetachRef.current === detach) dragDetachRef.current = null;
    };

    const onPointerUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      detach();
      const current = useStore.getState().composerQueue ?? [];
      if (!current.some((entry) => entry.id === draggingId)) return;
      const rects = Array.from(document.querySelectorAll<HTMLElement>('[data-queue-id]'))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { id: el.dataset.queueId ?? '', top: rect.top, bottom: rect.bottom };
        })
        .filter((row) => row.id);
      const beforeId = queueDropBeforeId(rects, draggingId, up.clientY);
      useStore.setState({ composerQueue: moveComposerItem(current, draggingId, beforeId) });
    };

    const onPointerCancel = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      detach();
    };

    dragDetachRef.current = detach;
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  };

  return (
    <div className={styles.wrap} data-cap-layer="" data-testid="steer-queue">
      {single ? null : (
        <button
          aria-expanded={expanded}
          className={styles.header}
          onClick={() => setExpanded((v) => !v)}
          title={firstTitle}
          type="button"
        >
          <span className={styles.headerLabel}>{summary}</span>
        </button>
      )}
      {single || expanded
        ? queue.map((item) => {
            const editing = editingId === item.id;
            return (
              <div
                className={styles.row}
                data-dock-card=""
                data-queue-id={item.id}
                data-testid={`composer-queue-item-${item.id}`}
                key={item.id}
              >
                {single ? null : (
                  <button
                    aria-label="拖拽排序"
                    className={styles.grip}
                    data-testid="queue-drag-handle"
                    onPointerDown={(event) => onDragHandlePointerDown(item.id, event)}
                    type="button"
                  >
                    <Icon icon={GripVertical} size={14} />
                  </button>
                )}
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
                  <span className={styles.title} title={item.text}>{item.text}</span>
                )}
                {single && !editing ? (
                  <span className={styles.hint} data-testid="follow-up-hotkeys">
                    <span className={styles.hintItem}>
                      引导
                      <Hotkey compact keys={KeyMapEnum.Enter} variant="borderless" />
                    </span>
                    <span className={styles.hintItem}>
                      截断
                      <Hotkey compact keys={combineKeys([KeyMapEnum.Ctrl, KeyMapEnum.Enter])} variant="borderless" />
                    </span>
                  </span>
                ) : null}
                <div className={styles.actions}>
                  <ActionIcon
                    {...actionProps('引导')}
                    icon={ArrowUp}
                    onClick={() => steerQueued(item.id)}
                    size="small"
                  />
                  <ActionIcon
                    {...actionProps('截断发送')}
                    icon={SquareArrowUp}
                    onClick={() => void interruptQueued(item.id)}
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
            );
          })
        : null}
    </div>
  );
}
