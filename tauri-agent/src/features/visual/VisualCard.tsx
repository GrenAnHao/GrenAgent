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
    background: #141416;
    overflow: hidden;
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: ${cssVar.colorPrimary};
    text-transform: uppercase;
    opacity: 0.7;
  `,
  dot: css`
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
    flex-shrink: 0;
  `,
  frame: css`
    border: none;
    width: 100%;
    display: block;
  `,
}));

export const VisualCard = memo(function VisualCard() {
  const { workspace } = useAgentStoreContext();
  const html = useVisualStore((s) => s.html);
  const sessionId = useVisualStore((s) => s.sessionId);
  const pending = useVisualStore((s) => s.pending);
  const submittedIds = useVisualStore((s) => s.submittedIds);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(200);
  // submitted 从 store 的 submittedIds 派生，防止重新加载对话后重置
  const isSubmitted = submittedIds.has(sessionId);
  const [choiceLabel, setChoiceLabel] = useState('');

  const doSubmit = useCallback((choice: string, text: string) => {
    const rid = useVisualStore.getState().requestId;
    if (!rid) return false;
    useVisualStore.getState().markSubmitted(sessionId);
    setChoiceLabel(text);
    extensionUiRespond(workspace, { type: 'extension_ui_response', id: rid, value: JSON.stringify({ choice, text, timestamp: Date.now() }) });
    useVisualStore.getState().setPending(false);
    return true;
  }, [sessionId, workspace]);

  // postMessage fallback
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

  const onIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
      if (!doc) return;

      // 高度自适应
      const measure = () => {
        const h = doc.body.scrollHeight;
        if (h > 0) setFrameHeight(h + 8);
      };
      requestAnimationFrame(measure);
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(measure);
        ro.observe(doc.body);
        const prev = (iframe as HTMLIFrameElement & { _ro?: ResizeObserver })._ro;
        prev?.disconnect();
        (iframe as HTMLIFrameElement & { _ro?: ResizeObserver })._ro = ro;
      }

      // 已提交状态：不绑定点击，仅降低透明度
      if (isSubmitted) return;

      // 点击处理：同时支持 data-choice 和 data-value
      const SELECTOR = '[data-choice], [data-value]';

      const handleClick = (el: Element) => {
        const choice = el.getAttribute('data-choice') ?? el.getAttribute('data-value') ?? '';
        const text = (el.querySelector('h3, .content h3, .card-body h3') as HTMLElement | null)?.textContent?.trim()
          ?? el.textContent?.trim().slice(0, 80)
          ?? choice;

        if (!choice) return;

        // 视觉反馈
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

    } catch { /* contentDocument 不可访问时忽略 */ }
  }, [isSubmitted, doSubmit]);

  useEffect(() => { setChoiceLabel(''); setFrameHeight(200); }, [sessionId]);

  if (!html) return null;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.dot} />
        Visual
        {isSubmitted
          ? <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'inherit', opacity: 0.6 }}>
              {' '}· 已选择{choiceLabel ? `：${choiceLabel}` : ''}
            </span>
          : pending
            ? <span style={{ opacity: 0.5, fontWeight: 400 }}>{' '}· 等待选择</span>
            : null
        }
      </div>
      {/* 始终保留 iframe，选择后变透明度降低但不消失 */}
      <iframe
        key={sessionId}
        ref={iframeRef}
        className={styles.frame}
        sandbox="allow-scripts allow-same-origin"
        srcDoc={buildSrcDoc(html)}
        style={{ height: frameHeight, opacity: isSubmitted ? 0.45 : 1, pointerEvents: isSubmitted ? 'none' : 'auto', transition: 'opacity 0.2s' }}
        title="Visual Companion"
        onLoad={onIframeLoad}
      />
    </div>
  );
});
