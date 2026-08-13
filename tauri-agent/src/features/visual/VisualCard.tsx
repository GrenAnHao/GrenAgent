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
    overflow: visible;
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
    border-radius: 10px 10px 0 0;
  `,
  dot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
    flex-shrink: 0;
  `,
  frameWrap: css`
    width: 100%;
    border-radius: 0 0 10px 10px;
    overflow: hidden;
  `,
  frame: css`
    border: none;
    width: 100%;
    display: block;
    min-height: 120px;
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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 初始给一个宽松的大高度，避免内容被截；resize 消息到来后精确调整
  const [frameHeight, setFrameHeight] = useState(600);
  const [submitted, setSubmitted] = useState(false);

  // 处理来自 iframe 的 postMessage
  const onMessage = useCallback(
    (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;
      const msg = e.data as { type?: string; choice?: string; text?: string; height?: number };

      // 高度调整
      if (msg.type === 'visual-resize' && typeof msg.height === 'number') {
        // +24 给底部留一点喘息空间，防止滚动条出现
        setFrameHeight(Math.max(120, Math.min(msg.height + 24, 1200)));
        return;
      }

      // 选项点击回传：只要有 requestId 就回传，不依赖 pending 时序
      if (msg.type === 'visual-choice' && msg.choice) {
        const currentRequestId = useVisualStore.getState().requestId;
        if (submitted || !currentRequestId) return;
        setSubmitted(true);
        const answer = JSON.stringify({ choice: msg.choice, text: msg.text ?? '', timestamp: Date.now() });
        extensionUiRespond(workspace, { id: currentRequestId, value: answer });
        useVisualStore.getState().setPending(false);
      }
    },
    [submitted, workspace],
  );

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onMessage]);

  // iframe onLoad 后用 ResizeObserver 测量实际高度（比 postMessage 更可靠）
  const onIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;
      const measure = () => {
        const h = doc.documentElement.scrollHeight || doc.body?.scrollHeight;
        if (h && h > 0) setFrameHeight(Math.max(120, Math.min(h + 24, 1200)));
      };
      measure();
      // 用 ResizeObserver 监听 iframe 内容高度变化
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(measure);
        ro.observe(doc.documentElement);
        // 返回清理函数，但 useCallback 不支持直接返回，用 ref 存
        (iframeRef as React.MutableRefObject<HTMLIFrameElement & { _ro?: ResizeObserver }>).current._ro?.disconnect();
        (iframeRef as React.MutableRefObject<HTMLIFrameElement & { _ro?: ResizeObserver }>).current._ro = ro;
      }
    } catch {
      // 跨域 iframe 无法访问 contentDocument，忽略
    }
  }, []);

  useEffect(() => {
    return () => {
      // 清理 ResizeObserver
      const iframe = iframeRef.current as (HTMLIFrameElement & { _ro?: ResizeObserver }) | null;
      iframe?._ro?.disconnect();
    };
  }, [sessionId]);

  useEffect(() => { setSubmitted(false); setFrameHeight(600); }, [sessionId]);

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
        <div className={styles.frameWrap}>
          <iframe
            key={sessionId}
            ref={iframeRef}
            className={styles.frame}
            sandbox="allow-scripts allow-same-origin"
            srcDoc={buildSrcDoc(html)}
            style={{ height: frameHeight }}
            title="Visual Companion"
            onLoad={onIframeLoad}
          />
        </div>
      )}
    </div>
  );
});
