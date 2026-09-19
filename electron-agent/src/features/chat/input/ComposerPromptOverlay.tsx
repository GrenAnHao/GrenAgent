import { memo, useEffect, useMemo, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LOBE_THEME_APP_ID } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { InlineQuestionCard } from '../InlineQuestionCard';
import { OverlayUiPromptCard } from './OverlayUiPromptCard';
import { shouldRenderUiPromptInOverlay } from './overlayPrompt';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useInlineQuestionStore } from '../../../stores/inlineQuestionStore';
import { useUiPromptStore } from '../../../stores/uiPromptStore';

const MENU_GAP = 8;

const styles = createStaticStyles(({ css }) => ({
  root: css`
    position: fixed;
    z-index: 1050;
    box-sizing: border-box;

    display: flex;
    flex-direction: column;

    max-height: min(60vh, 480px);
    background: transparent;
  `,
}));

/**
 * 锚定 Composer 的阻塞式提问浮层：ask_user 优先，其次 overlay ui prompt。
 * 无条目时不 portal；关闭由卡片自身回传，不挂 Escape / 点外面。
 */
export const ComposerPromptOverlay = memo(function ComposerPromptOverlay({
  anchorRef,
}: {
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const { workspace } = useAgentStoreContext();
  const hasQuestion = useInlineQuestionStore((s) => Boolean(s.byWorkspace[workspace]));
  const uiPrompt = useUiPromptStore((s) => s.byWorkspace[workspace]?.request);
  const hasOverlayPrompt = Boolean(uiPrompt && shouldRenderUiPromptInOverlay(uiPrompt));
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);

  const portalContainer = useMemo(
    () => document.getElementById(LOBE_THEME_APP_ID) ?? document.body,
    [],
  );

  useEffect(() => {
    if (!hasQuestion && !hasOverlayPrompt) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      if (rect.width === 0) return;
      setPos({
        left: Math.round(rect.left),
        bottom: Math.round(window.innerHeight - rect.top + MENU_GAP),
        width: Math.round(rect.width),
      });
    };
    measure();
    const onChange = () => requestAnimationFrame(measure);
    const ro = new ResizeObserver(onChange);
    ro.observe(anchor);
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [anchorRef, hasOverlayPrompt, hasQuestion]);

  if (!hasQuestion && !hasOverlayPrompt) return null;
  if (!pos) return null;

  return createPortal(
    <div
      className={styles.root}
      data-testid="composer-prompt-overlay"
      style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}
    >
      {hasQuestion ? <InlineQuestionCard /> : <OverlayUiPromptCard />}
    </div>,
    portalContainer,
  );
});
