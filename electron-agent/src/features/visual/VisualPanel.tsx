import { memo, useCallback, useEffect, useState } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { HtmlPreview } from '@lobehub/ui';
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
    font-weight: 600;
    color: ${cssVar.colorTextSecondary};
  `,
  dot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
  `,
  frame: css`
    flex: 1;
    width: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
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

export const VisualPanel = memo(function VisualPanel() {
  const { workspace } = useAgentStoreContext();
  const html = useVisualStore((s) => s.html);
  const sessionId = useVisualStore((s) => s.sessionId);
  const pending = useVisualStore((s) => s.pending);
  const requestId = useVisualStore((s) => s.requestId);
  const [submitted, setSubmitted] = useState(false);

  const onMessage = useCallback(
    (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;
      const { type, choice, text } = e.data as { type?: string; choice?: string; text?: string };
      if (type !== 'visual-choice' || !choice) return;
      if (submitted || !pending || !requestId) return;
      setSubmitted(true);
      const answer = JSON.stringify({ choice, text: text ?? '', timestamp: Date.now() });
      extensionUiRespond(workspace, { type: 'extension_ui_response', id: requestId, value: answer });
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
      {submitted || pending ? (
        <div className={styles.header}>
          <span className={styles.title}>
            <span className={styles.dot} />
            {submitted ? '已选择' : '等待选择'}
          </span>
        </div>
      ) : null}
      {html ? (
        <HtmlPreview
          key={sessionId}
          animated={false}
          className={styles.frame}
          copyable={false}
          defaultHeight={320}
          defaultMode="preview"
          downloadable={false}
          style={{ flex: 1, height: '100%', minHeight: 0 }}
          styles={{ iframe: { flex: 1, width: '100%', height: '100%', minHeight: 0 } }}
          theme="dark"
          variant="borderless"
        >
          {buildSrcDoc(html, { fill: true })}
        </HtmlPreview>
      ) : (
        <div className={styles.empty}>等待 Agent 推送内容…</div>
      )}
    </div>
  );
});
