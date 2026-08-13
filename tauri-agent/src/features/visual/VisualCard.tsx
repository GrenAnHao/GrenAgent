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
    border: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgContainer};
    overflow: hidden;
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

export const VisualCard = memo(function VisualCard() {
  const { workspace } = useAgentStoreContext();
  const html = useVisualStore((s) => s.html);
  const sessionId = useVisualStore((s) => s.sessionId);
  const pending = useVisualStore((s) => s.pending);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(200);
  const [submitted, setSubmitted] = useState(false);

  // postMessage fallback（helper.js 路径）
  const onMessage = useCallback(
    (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;
      const msg = e.data as { type?: string; choice?: string; text?: string; height?: number };
      if (msg.type === 'visual-choice' && msg.choice) {
        const rid = useVisualStore.getState().requestId;
        if (submitted || !rid) return;
        setSubmitted(true);
        extensionUiRespond(workspace, { id: rid, value: JSON.stringify({ choice: msg.choice, text: msg.text ?? '', timestamp: Date.now() }) });
        useVisualStore.getState().setPending(false);
      }
    },
    [submitted, workspace],
  );

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onMessage]);

  // 主路径：onLoad 后直接操作 contentDocument
  const onIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
      if (!doc) return;

      // 1. 修复 CSS：取消 overflow:hidden / height:100%，让 body 自由伸展
      const styleEl = doc.createElement('style');
      styleEl.textContent = `html, body { height: auto !important; overflow: visible !important; }`;
      doc.head.appendChild(styleEl);

      // 2. 测量真实高度并调整 iframe
      const measure = () => {
        const h = doc.body.scrollHeight;
        if (h > 0) setFrameHeight(h + 8);
      };
      // 稍微等 style 应用
      requestAnimationFrame(() => { measure(); });
      // ResizeObserver 持续同步
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(measure);
        ro.observe(doc.body);
        const prev = (iframe as HTMLIFrameElement & { _ro?: ResizeObserver })._ro;
        prev?.disconnect();
        (iframe as HTMLIFrameElement & { _ro?: ResizeObserver })._ro = ro;
      }

      // 3. 直接给每个 .option/.card 加点击监听，不依赖 helper.js postMessage
      const handleClick = (el: Element) => {
        const choice = el.getAttribute('data-choice') ?? el.closest('[data-choice]')?.getAttribute('data-choice') ?? '';
        const text = (el.querySelector('h3, .content h3, .card-body h3') as HTMLElement | null)?.textContent?.trim()
          ?? (el.querySelector('.letter') as HTMLElement | null)?.textContent?.trim()
          ?? choice;

        // 视觉反馈：移除其他选中，高亮当前
        const container = el.closest('.options, .cards');
        container?.querySelectorAll('.option, .card').forEach(o => o.classList.remove('selected'));
        el.classList.add('selected');

        if (!choice) return;
        const rid = useVisualStore.getState().requestId;
        if (!rid) return;
        setSubmitted(true);
        extensionUiRespond(workspace, { id: rid, value: JSON.stringify({ choice, text, timestamp: Date.now() }) });
        useVisualStore.getState().setPending(false);
      };

      doc.querySelectorAll('[data-choice]').forEach(el => {
        el.addEventListener('click', () => handleClick(el));
      });

      // 兜底：监听整个 body 的点击
      doc.body.addEventListener('click', (e) => {
        const target = (e.target as Element).closest('[data-choice]');
        if (target) handleClick(target);
      });

    } catch {
      // contentDocument 不可访问时什么都不做
    }
  }, [submitted, workspace]);

  useEffect(() => { setSubmitted(false); setFrameHeight(200); }, [sessionId]);

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
          sandbox="allow-scripts allow-same-origin"
          srcDoc={buildSrcDoc(html)}
          style={{ height: frameHeight }}
          title="Visual Companion"
          onLoad={onIframeLoad}
        />
      )}
    </div>
  );
});
