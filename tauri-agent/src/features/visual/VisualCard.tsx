import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createStaticStyles, cssVar } from 'antd-style';
import { Expand, ExternalLink, Minimize2 } from 'lucide-react';
import { ActionIcon } from '@lobehub/ui';
import { useVisualStore } from '../../stores/visualStore';
import { buildSrcDoc } from './frameAssets';
import { extensionUiRespond } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';

const MAX_CARD_HEIGHT = 480;

const styles = createStaticStyles(({ css }) => ({
  root: css`
    width: 100%;
    min-width: 0;
    margin: 4px 0;
    border-radius: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    background: #141416;
    overflow: hidden;
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px 5px 12px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: ${cssVar.colorPrimary};
    text-transform: uppercase;
    opacity: 0.85;
  `,
  dot: css`
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
    flex-shrink: 0;
  `,
  spacer: css`flex: 1;`,
  frame: css`
    border: none;
    width: 100%;
    display: block;
    overflow: auto;
  `,
  // 全屏遮罩：通过 Portal 挂到 document.body，彻底脱离父容器截断
  overlay: css`
    position: fixed;
    inset: 0;
    z-index: 99999;
    background: #0a0a0e;
    display: flex;
    flex-direction: column;
  `,
  overlayHeader: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    background: #141418;
    flex-shrink: 0;
  `,
  overlayTitle: css`
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.07em;
    color: ${cssVar.colorPrimary};
    text-transform: uppercase;
    flex: 1;
    opacity: 0.75;
  `,
  overlayFrame: css`
    flex: 1;
    border: none;
    width: 100%;
    min-height: 0;
  `,
}));

export const VisualCard = memo(function VisualCard({ content }: { content: string }) {
  const { workspace } = useAgentStoreContext();
  const storeHtml = useVisualStore((s) => s.html);
  const html = content && content !== 'visual-inline' ? content : (storeHtml ?? '');
  const sessionId = useVisualStore((s) => s.sessionId);
  const pending = useVisualStore((s) => s.pending);
  const submittedIds = useVisualStore((s) => s.submittedIds);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const overlayIframeRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(200);
  const [showOverlay, setShowOverlay] = useState(false);
  const cardKey = sessionId;
  const isSubmitted = submittedIds.has(cardKey);
  const [choiceLabel, setChoiceLabel] = useState('');

  const doSubmit = useCallback((choice: string, text: string) => {
    const rid = useVisualStore.getState().requestId;
    if (!rid) return false;
    useVisualStore.getState().markSubmitted(cardKey);
    setChoiceLabel(text);
    extensionUiRespond(workspace, { type: 'extension_ui_response', id: rid, value: JSON.stringify({ choice, text, timestamp: Date.now() }) });
    useVisualStore.getState().setPending(false);
    setShowOverlay(false);
    return true;
  }, [cardKey, workspace]);

  // 浏览器打开：写临时文件 → Tauri opener 打开（Blob URL 在 WebView 里不工作）
  const openInBrowser = useCallback(async () => {
    if (!html) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { openPath } = await import('@tauri-apps/plugin-opener');
      const path = await invoke<string>('write_temp_html', { content: buildSrcDoc(html) });
      await openPath(path);
    } catch (e) {
      console.error('[VisualCard] openInBrowser failed:', e);
    }
  }, [html]);

  const onMessage = useCallback(
    (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;
      const msg = e.data as { type?: string; choice?: string; text?: string };
      if (msg.type === 'visual-choice' && msg.choice && !isSubmitted) {
        doSubmit(msg.choice, msg.text ?? msg.choice);
      }
    },
    [isSubmitted, doSubmit],
  );

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onMessage]);

  const bindClicks = useCallback((doc: Document) => {
    if (isSubmitted) return;
    const SELECTOR = '[data-choice], [data-value]';
    const handleClick = (el: Element) => {
      const choice = el.getAttribute('data-choice') ?? el.getAttribute('data-value') ?? '';
      const text = (el.querySelector('h3, .content h3, .card-body h3') as HTMLElement | null)?.textContent?.trim()
        ?? el.textContent?.trim().slice(0, 80) ?? choice;
      if (!choice) return;
      el.closest('.options, .cards')?.querySelectorAll('.option, .card').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      if (!doSubmit(choice, text)) {
        let n = 0;
        const poll = setInterval(() => { if (doSubmit(choice, text) || ++n > 50) clearInterval(poll); }, 100);
      }
    };
    doc.body.addEventListener('click', (e) => {
      const target = (e.target as Element).closest(SELECTOR);
      if (target) handleClick(target);
    });
  }, [isSubmitted, doSubmit]);

  const onIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
      if (!doc) return;
      const measure = () => {
        const h = doc.body.scrollHeight;
        if (h > 0) setFrameHeight(Math.min(h + 8, MAX_CARD_HEIGHT));
      };
      requestAnimationFrame(measure);
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(measure);
        ro.observe(doc.body);
        const prev = (iframe as HTMLIFrameElement & { _ro?: ResizeObserver })._ro;
        prev?.disconnect();
        (iframe as HTMLIFrameElement & { _ro?: ResizeObserver })._ro = ro;
      }
      bindClicks(doc);
    } catch { /* 忽略 */ }
  }, [bindClicks]);

  const onOverlayIframeLoad = useCallback(() => {
    const iframe = overlayIframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
      if (doc) bindClicks(doc);
    } catch { /* 忽略 */ }
  }, [bindClicks]);

  useEffect(() => { setChoiceLabel(''); setFrameHeight(200); setShowOverlay(false); }, [sessionId]);

  useEffect(() => {
    if (!showOverlay) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowOverlay(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showOverlay]);

  if (!html) return null;

  const srcDoc = buildSrcDoc(html);

  // Portal 遮罩：挂到 document.body，真正覆盖整个 Tauri 窗口
  const fullscreenPortal = showOverlay ? createPortal(
    <div className={styles.overlay}>
      <div className={styles.overlayHeader}>
        <span className={styles.overlayTitle}>● VISUAL</span>
        {isSubmitted
          ? <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>已选择{choiceLabel ? `：${choiceLabel}` : ''}</span>
          : pending
            ? <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontWeight: 400 }}>等待选择</span>
            : null
        }
        <span style={{ flex: 1 }} />
        <ActionIcon icon={ExternalLink} size="small" title="在浏览器中打开" onClick={() => void openInBrowser()} style={{ opacity: 0.6 }} />
        <ActionIcon icon={Minimize2} size="small" title="关闭全屏（ESC）" onClick={() => setShowOverlay(false)} style={{ opacity: 0.6 }} />
      </div>
      <iframe
        key={`overlay-${sessionId}`}
        ref={overlayIframeRef}
        className={styles.overlayFrame}
        sandbox="allow-scripts allow-same-origin"
        srcDoc={srcDoc}
        title="Visual Companion (Fullscreen)"
        onLoad={onOverlayIframeLoad}
      />
    </div>,
    document.body
  ) : null;

  return (
    <>
      <div className={styles.root}>
        <div className={styles.header}>
          <span className={styles.dot} />
          Visual
          {isSubmitted
            ? <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, opacity: 0.6 }}>
                {' '}· 已选择{choiceLabel ? `：${choiceLabel}` : ''}
              </span>
            : pending
              ? <span style={{ opacity: 0.5, fontWeight: 400 }}>{' '}· 等待选择</span>
              : null
          }
          <span className={styles.spacer} />
          <ActionIcon icon={Expand} size="small" title="全屏查看" onClick={() => setShowOverlay(true)} style={{ opacity: 0.6 }} />
          <ActionIcon icon={ExternalLink} size="small" title="在浏览器中打开" onClick={() => void openInBrowser()} style={{ opacity: 0.6 }} />
        </div>
        <iframe
          key={sessionId}
          ref={iframeRef}
          className={styles.frame}
          sandbox="allow-scripts allow-same-origin"
          srcDoc={srcDoc}
          style={{ height: frameHeight, opacity: isSubmitted ? 0.45 : 1, pointerEvents: isSubmitted ? 'none' : 'auto', transition: 'opacity 0.2s' }}
          title="Visual Companion"
          onLoad={onIframeLoad}
        />
      </div>
      {fullscreenPortal}
    </>
  );
});
