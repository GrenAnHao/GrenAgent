import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ActionIcon, Button, Icon } from '@lobehub/ui';
import { Wand2, X } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { pi } from '../../../lib/pi';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useEnhancePromptStore, type EnhancePromptSlot } from '../../../stores/enhancePromptStore';
import { useChatInput } from './ChatInputContext';
import { useSessionOverlayBox } from './sessionOverlay';

const MENU_GAP = 8;

const styles = createStaticStyles(({ css }) => ({
  root: css`
    position: absolute;
    z-index: 1040;
    box-sizing: border-box;

    display: flex;
    flex-direction: column;

    max-height: min(60vh, 480px);
    background: transparent;
  `,
  card: css`
    width: 100%;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
  `,
  head: css`
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  headTitle: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  status: css`
    flex: none;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    white-space: nowrap;
  `,
  preview: css`
    overflow-y: auto;
    max-height: min(40vh, 280px);
    margin-block-start: 6px;
    font-size: 13px;
    line-height: 1.5;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
  `,
  error: css`
    margin-block-start: 8px;
    font-size: 12px;
    color: ${cssVar.colorError};
  `,
  row: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-block-start: 10px;
  `,
}));

function statusLabel(slot: EnhancePromptSlot): string {
  if (slot.status === 'error') return '失败';
  if (slot.awaitingContext) return '正在结合项目上下文…';
  if (slot.status === 'streaming') return slot.preview ? '生成中' : '等待模型响应…';
  if (slot.status === 'done') return '完成';
  return '';
}

/** 只在流式期间走秒，让「模型慢」和「卡死」在界面上可区分。 */
function useElapsedSeconds(startedAt: number, active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active || !startedAt) {
      setSeconds(0);
      return;
    }
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt, active]);
  return seconds;
}

/**
 * 锚定 Composer 的增强提示词预览浮层。
 * idle / 无槽不 portal；只 setValue 写回正文，粘贴块由 ChatInput 状态保持。
 * 关闭：取消、X、Esc（capture）。不关：失焦、点外面。
 */
export const EnhancePromptOverlay = memo(function EnhancePromptOverlay({
  anchorRef,
}: {
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const { workspace } = useAgentStoreContext();
  const { setValue } = useChatInput();
  const slot = useEnhancePromptStore((s) => s.byWorkspace[workspace]);
  const visible = Boolean(slot && slot.status !== 'idle');
  const elapsed = useElapsedSeconds(slot?.startedAt ?? 0, slot?.status === 'streaming');
  const prevWorkspaceRef = useRef(workspace);
  const { host, box } = useSessionOverlayBox(anchorRef, visible, MENU_GAP);

  const dismiss = useCallback(() => {
    void pi.abortEnhancePrompt(workspace);
    useEnhancePromptStore.getState().cancel(workspace);
  }, [workspace]);

  const apply = useCallback(() => {
    const cur = useEnhancePromptStore.getState().byWorkspace[workspace];
    if (!cur || cur.status === 'error' || !cur.preview.trim()) return;
    setValue(cur.preview);
    void pi.abortEnhancePrompt(workspace);
    useEnhancePromptStore.getState().clear(workspace);
  }, [workspace, setValue]);

  useEffect(() => {
    const prev = prevWorkspaceRef.current;
    if (prev && prev !== workspace) {
      void pi.abortEnhancePrompt(prev);
      useEnhancePromptStore.getState().clear(prev);
    }
    prevWorkspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    return () => {
      const prev = prevWorkspaceRef.current;
      if (!prev) return;
      void pi.abortEnhancePrompt(prev);
      useEnhancePromptStore.getState().clear(prev);
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      dismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible, dismiss]);

  if (!visible || !slot) return null;
  if (!host || !box) return null;

  const applyDisabled = slot.status === 'error' || !slot.preview.trim();
  const previewText = slot.preview || slot.source;

  return createPortal(
    <div
      className={styles.root}
      data-testid="enhance-prompt-overlay"
      style={{ left: box.left, bottom: box.bottom, width: box.width }}
    >
      <div className={styles.card}>
        <div className={styles.head}>
          <Icon icon={Wand2} size={13} />
          <span className={styles.headTitle}>增强提示词</span>
          <span className={styles.status} data-testid="enhance-prompt-status">
            {statusLabel(slot)}
            {slot.status === 'streaming' && elapsed > 0 ? ` · ${elapsed}s` : ''}
          </span>
          <ActionIcon
            data-testid="enhance-prompt-close"
            icon={X}
            onClick={dismiss}
            size="small"
            title="关闭"
          />
        </div>
        <div className={styles.preview} data-testid="enhance-prompt-preview">
          {previewText}
        </div>
        {slot.status === 'error' && slot.error ? (
          <div className={styles.error} data-testid="enhance-prompt-error">
            {slot.error}
          </div>
        ) : null}
        <div className={styles.row}>
          <Button data-testid="enhance-prompt-cancel" onClick={dismiss} size="small">
            取消
          </Button>
          <Button
            data-testid="enhance-prompt-apply"
            disabled={applyDisabled}
            onClick={apply}
            size="small"
            type="primary"
          >
            应用
          </Button>
        </div>
      </div>
    </div>,
    host,
  );
});
