import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { useVisualStore } from '../../stores/visualStore';
import { buildSrcDoc } from './frameAssets';
import { extensionUiRespond } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    width: 100%;
    min-width: 0;
    margin: 4px 0;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: ${cssVar.colorPrimary};
    text-transform: uppercase;
  `,
  dot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
    flex-shrink: 0;
  `,
  frame: css`
    border: none;
    width: 100%;
    display: block;
  `,
  done: css`
    padding: 8px 12px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-align: center;
  `,
}));

/**
 * 内联视觉卡片：渲染 visualStore 中的 html（iframe sandbox）。
 * 挂载点：ChatMessageItems → notice customType="visual-inline"
 */
export const VisualCard = memo(function VisualCard() {
  const { workspace } = useAgentStoreContext();
  const html = useVisualStore((s) => s.html);
  const sessionId = useVisualStore((s) => s.sessionId);
  const pending = useVisualStore((s) => s.pending);
  const requestId = useVisualStore((s) => s.requestId);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(280);
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

  const onResize = useCallback((e: MessageEvent) => {
    if (e.data?.type === 'visual-resize' && typeof e.data.height === 'number') {
      setFrameHeight(Math.max(120, Math.min((e.data.height as number) + 32, 800)));
    }
  }, []);

  useEffect(() => {
    window.addEventListener('message', onResize);
    return () => window.removeEventListener('message', onResize);
  }, [onResize]);

  useEffect(() => { setSubmitted(false); }, [sessionId]);

  if (!html) return null;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.dot} />
        Visual
        {submitted ? ' · 已选择' : pending ? ' · 等待选择' : ''}
      </div>
      {submitted ? (
        <div className={styles.done}>已提交选择</div>
      ) : (
        <iframe
          key={sessionId}
          ref={iframeRef}
          className={styles.frame}
          sandbox="allow-scripts"
          srcDoc={buildSrcDoc(html)}
          style={{ height: frameHeight }}
          title="Visual Companion"
        />
      )}
    </div>
  );
});
