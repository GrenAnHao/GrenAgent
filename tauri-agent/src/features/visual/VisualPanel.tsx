import { memo, useCallback, useEffect, useState } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { X } from 'lucide-react';
import { ActionIcon } from '@lobehub/ui';
import { useVisualStore } from '../../stores/visualStore';
import { buildSrcDoc } from './frameAssets';
import { extensionUiRespond } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    flex-shrink: 0;
  `,
  title: css`
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 700;
    color: ${cssVar.colorPrimary};
    letter-spacing: 0.05em;
    text-transform: uppercase;
  `,
  dot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
  `,
  frame: css`
    flex: 1;
    border: none;
    width: 100%;
    min-height: 0;
  `,
  empty: css`
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

interface VisualPanelProps {
  onClose?: () => void;
}

export const VisualPanel = memo(function VisualPanel({ onClose }: VisualPanelProps) {
  const { workspace } = useAgentStoreContext();
  const { html, sessionId, pending, requestId } = useVisualStore((s) => ({
    html: s.html,
    sessionId: s.sessionId,
    pending: s.pending,
    requestId: s.requestId,
  }));
  const [submitted, setSubmitted] = useState(false);

  const onMessage = useCallback(
    (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;
      const { type, choice, text } = e.data as { type?: string; choice?: string; text?: string };
      if (type !== 'visual-choice' || !choice) return;
      if (submitted || !pending || !requestId) return;
      setSubmitted(true);
      const answer = JSON.stringify({ choice, text: text ?? '', timestamp: Date.now() });
      extensionUiRespond(workspace, { id: requestId, value: answer });
      useVisualStore.getState().setPending(false);
    },
    [submitted, pending, requestId, workspace],
  );

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onMessage]);

  useEffect(() => { setSubmitted(false); }, [sessionId]);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>
          <span className={styles.dot} />
          Visual
          {submitted ? ' · 已选择' : pending ? ' · 等待选择' : ''}
        </span>
        {onClose && (
          <ActionIcon icon={X} size="small" onClick={onClose} title="关闭面板" />
        )}
      </div>
      {html ? (
        <iframe
          key={sessionId}
          className={styles.frame}
          sandbox="allow-scripts"
          srcDoc={buildSrcDoc(html)}
          title="Visual Companion Panel"
        />
      ) : (
        <div className={styles.empty}>等待 Agent 推送内容…</div>
      )}
    </div>
  );
});
