import { memo, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { createStaticStyles } from 'antd-style';
import { InlineQuestionCard } from '../InlineQuestionCard';
import { OverlayUiPromptCard } from './OverlayUiPromptCard';
import { shouldRenderUiPromptInOverlay } from './overlayPrompt';
import { useSessionOverlayBox } from './sessionOverlay';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useInlineQuestionStore } from '../../../stores/inlineQuestionStore';
import { useUiPromptStore } from '../../../stores/uiPromptStore';

const MENU_GAP = 8;

const styles = createStaticStyles(({ css }) => ({
  root: css`
    position: absolute;
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
 * 挂在对话列内，不挂到应用根上。切到别的模块时列被隐藏，浮层跟着走。
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
  const { host, box } = useSessionOverlayBox(anchorRef, hasQuestion || hasOverlayPrompt, MENU_GAP);

  if (!hasQuestion && !hasOverlayPrompt) return null;
  if (!host || !box) return null;

  return createPortal(
    <div
      className={styles.root}
      data-testid="composer-prompt-overlay"
      style={{ left: box.left, bottom: box.bottom, width: box.width }}
    >
      {hasQuestion ? <InlineQuestionCard /> : <OverlayUiPromptCard />}
    </div>,
    host,
  );
});
