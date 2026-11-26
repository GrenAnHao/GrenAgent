import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createStaticStyles, cssVar } from 'antd-style';
import { ExternalLink, Minimize2 } from 'lucide-react';
import { ActionIcon, HtmlPreview } from '@lobehub/ui';
import { useVisualStore, visualKeyOf } from '../../stores/visualStore';
import { buildSrcDoc } from './frameAssets';
import { invoke, openUrl } from '../../platform/runtime';
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
    font-weight: 500;
    letter-spacing: 0.01em;
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
    width: 100%;
    min-width: 0;
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
    font-weight: 500;
    letter-spacing: 0.01em;
    color: ${cssVar.colorPrimary};
    text-transform: uppercase;
    flex: 1;
    opacity: 0.75;
  `,
  overlayFrame: css`
    flex: 1;
    width: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
  `,
}));

export const VisualCard = memo(function VisualCard({ content }: { content: string }) {
  const { workspace, store } = useAgentStoreContext();
  // 历史卡使用保存的 HTML；当前会话卡按 owner 读取最新预览。
  const loadedPath = store?.getLoadedSessionPath?.() ?? null;
  const visualKey = visualKeyOf({ sessionPath: loadedPath || null, workspace });
  const entry = useVisualStore((s) => s.entries[visualKey]);
  const html = content && content !== 'visual-inline' ? content : (entry?.html ?? '');
  const sessionId = entry?.rev ?? 0;
  const [showOverlay, setShowOverlay] = useState(false);

  // 浏览器打开：写临时文件 → file:// URL → openUrl（openPath 走文件默认程序，
  // 开发机上 .html 可能被编辑器覆盖；openUrl 走浏览器 URL handler，更可靠）
  const openInBrowser = useCallback(async () => {
    if (!html) return;
    try {
      const path = await invoke<string>('write_temp_html', { content: buildSrcDoc(html) });
      // Windows 路径 C:\...\file.html → file:///C:/…/file.html
      const fileUrl = 'file:///' + (path as string).replace(/\\/g, '/');
      await openUrl(fileUrl);
    } catch (e) {
      console.error('[VisualCard] openInBrowser failed:', e);
    }
  }, [html]);

  useEffect(() => { setShowOverlay(false); }, [sessionId]);

  useEffect(() => {
    if (!showOverlay) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowOverlay(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showOverlay]);

  if (!html) return null;

  const srcDoc = buildSrcDoc(html);
  const fillSrcDoc = buildSrcDoc(html, { fill: true });

  const browserAction = (originalNode: ReactNode) => (
    <>
      {originalNode}
      <ActionIcon icon={ExternalLink} size="small" title="在浏览器中打开" onClick={() => void openInBrowser()} style={{ opacity: 0.6 }} />
    </>
  );

  const fullscreenPortal = showOverlay ? createPortal(
    <div className={styles.overlay}>
      <div className={styles.overlayHeader}>
        <span className={styles.overlayTitle}>视觉设计</span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>评审请在询问卡作答</span>
        <span style={{ flex: 1 }} />
        <ActionIcon icon={Minimize2} size="small" title="关闭全屏（ESC）" onClick={() => setShowOverlay(false)} style={{ opacity: 0.6 }} />
      </div>
      <HtmlPreview
        key={`overlay-${sessionId}`}
        animated={false}
        className={styles.overlayFrame}
        copyable={false}
        defaultHeight={480}
        defaultMode="preview"
        downloadable={false}
        styles={{ iframe: { flex: 1, height: 0, minHeight: 0 } }}
        theme="dark"
        variant="borderless"
      >
        {fillSrcDoc}
      </HtmlPreview>
    </div>,
    document.body
  ) : null;

  return (
    <>
      <div className={styles.root}>
        <div className={styles.header}>
          <span className={styles.dot} />
          视觉设计
          <span style={{ opacity: 0.5, fontWeight: 400 }}>{' '}· 评审请在询问卡作答</span>
          <span className={styles.spacer} />
        </div>
        <HtmlPreview
          key={sessionId}
          actionsRender={({ originalNode }) => browserAction(originalNode)}
          animated={false}
          className={styles.frame}
          copyable={false}
          defaultHeight={200}
          defaultMode="preview"
          downloadable={false}
          styles={{
            iframe: {
              maxHeight: MAX_CARD_HEIGHT,
              transition: 'opacity 0.2s',
            },
          }}
          theme="dark"
          variant="borderless"
          onExpand={() => setShowOverlay(true)}
        >
          {srcDoc}
        </HtmlPreview>
      </div>
      {fullscreenPortal}
    </>
  );
});
