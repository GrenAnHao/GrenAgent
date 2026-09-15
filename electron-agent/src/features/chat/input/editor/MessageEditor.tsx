import { useEffect, useMemo, useRef, useState } from 'react';
import { Flexbox } from '@lobehub/ui';
import { Editor } from '@lobehub/editor/react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useChatInput } from '../ChatInputContext';
import { ActionBar } from '../ActionBar';
import { SendArea } from '../SendArea';
import { SteerQueue } from '../SteerQueue';
import { GoalPill } from '../GoalPill';
import { TodoDockFromStore } from '../TodoDock';
import { SessionGoalDrawer } from '../SessionGoalDrawer';
import { WorkspaceBar } from '../workspace/WorkspaceBar';
import { PromptRequestCard } from '../PromptRequestCard';
import { ComposerPromptOverlay } from '../ComposerPromptOverlay';
import { ContextUsageTag } from '../ContextUsageTag';
import type { ActionKey } from '../config';
import { InputChips } from './InputChips';
import { createBoxMenu } from './SlashBoxMenu';
import ReactChatTagPlugin from './ChatTag/ReactChatTagPlugin';
import { useCommandPaste } from './useCommandPaste';
import { useUrlPaste } from './useUrlPaste';
import { usePasteCapture } from './usePasteCapture';
import { useFileMention } from './useFileMention';
import { useSlashOptions } from './useSlashOptions';
import { useTauriFileDrop } from './useTauriFileDrop';
import { useGoalStore, type GoalSnapshot } from '../../../../stores/goalStore';
import { draftShouldForwardWheel } from '../../composerWheel';

const PLACEHOLDER = '输入消息，@ 引用文件/目录，/ 调用命令…';
const STREAMING_PLACEHOLDER = '继续跟进，引导当前回答…';

const styles = createStaticStyles(({ css }) => ({
  zone: css`
    position: relative;
    flex: none;
    margin: 8px 16px 16px;
  `,
  // 单层无缝容器：chips / 编辑器 / 操作栏共用同一底色与边框。
  // 作为 body 空闲高度的度量容器：内容列宽随会话区伸缩，固定高度会让窄列下的输入框显得方而笨重。
  surface: css`
    container-type: inline-size;

    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};

    transition: border-color 0.15s ease;

    &:focus-within {
      border-color: ${cssVar.colorBorder};
    }
  `,
  dock: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 6px;

    &:empty {
      display: none;
      margin: 0;
    }
  `,
  body: css`
    scrollbar-width: thin;

    overflow-y: auto;

    /* 空闲高度跟着列宽走，让输入框的长宽比在窄列下不塌成方块：宽列仍保持原先约 105 的手感，
       窄列压到 72（约三行）——真要输入更多内容时本来就会顶到 max-height 自行长高。 */
    min-height: clamp(72px, 12cqw, 108px);
    max-height: 300px;

    cursor: text;
  `,
  editor: css`
    font: var(--pi-md-base);

    p {
      margin-block: 0;
    }

    /* 填充式 @ 提及 chip，贴合输入区视觉。 */
    .editor_mention {
      padding: 1px 6px;
      border: none;
      border-radius: ${cssVar.borderRadius};

      color: ${cssVar.colorPrimary};

      background: ${cssVar.colorPrimaryBg};
    }
  `,
  dropHint: css`
    position: absolute;
    inset: 0;

    display: flex;
    align-items: center;
    justify-content: center;

    border: 1px dashed ${cssVar.colorPrimary};
    border-radius: ${cssVar.borderRadiusLG};

    font-size: 13px;
    color: ${cssVar.colorPrimary};

    background: ${cssVar.colorPrimaryBg};

    pointer-events: none;
  `,
}));

interface MessageEditorProps {
  leftActions: ActionKey[];
  rightActions: ActionKey[];
}

export function MessageEditor({ leftActions, rightActions }: MessageEditorProps) {
  const { workspace } = useAgentStoreContext();
  const { editor, send, addAttachments, addPastedText, setEmpty, attachments, pastedTexts, isGenerating, scrollTranscript } =
    useChatInput();
  const zoneRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLDivElement>(null);
  const [goalDrawerSessionId, setGoalDrawerSessionId] = useState<string>();
  const goalDrawerSnapshot = useGoalStore((state) =>
    goalDrawerSessionId ? state.bySession[goalDrawerSessionId] : undefined,
  );
  const setGoalSnapshot = useGoalStore((state) => state.setSnapshot);

  // 菜单锚定在输入框上方，宽度与输入框齐宽（@ 与 / 共用）。
  const boxMenu = useMemo(() => createBoxMenu(surfaceRef), []);

  const { mentionItems, onSelect: mentionOnSelect } = useFileMention(workspace);
  const { slashItems, onSelect: slashOnSelect } = useSlashOptions(workspace, () =>
    editor.cleanDocument(),
  );
  const { tryCommandPaste } = useCommandPaste(workspace, editor);
  const { tryUrlPaste } = useUrlPaste(editor);

  usePasteCapture({
    targetRef: zoneRef,
    onImages: addAttachments,
    onPastedText: addPastedText,
    onUrlText: tryUrlPaste,
    onCommandText: tryCommandPaste,
  });
  const { dragOver, dragKind } = useTauriFileDrop({
    editor,
    workspace,
    zoneRef,
    onImages: addAttachments,
    onPastedText: addPastedText,
  });

  useEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const draft = draftRef.current;
      if (!draft) return;
      if (
        !draftShouldForwardWheel({
          scrollTop: draft.scrollTop,
          clientHeight: draft.clientHeight,
          scrollHeight: draft.scrollHeight,
          deltaY: e.deltaY,
        })
      )
        return;
      e.preventDefault();
      scrollTranscript?.(e.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scrollTranscript]);

  const hasChips = attachments.length > 0 || pastedTexts.length > 0;

  return (
    <div ref={zoneRef} className={styles.zone}>
      <div data-testid="composer-dock" className={styles.dock}><TodoDockFromStore /><GoalPill onOpenDetails={(snapshot: GoalSnapshot) => setGoalDrawerSessionId(snapshot.sessionId)} /><SteerQueue /></div>
      <SessionGoalDrawer
        onClose={() => setGoalDrawerSessionId(undefined)}
        onSnapshot={(snapshot) => setGoalSnapshot(snapshot.sessionId, snapshot)}
        open={!!goalDrawerSessionId}
        sessionId={goalDrawerSessionId ?? ''}
        snapshot={goalDrawerSnapshot}
      />
      <WorkspaceBar onReferencePastedText={addPastedText} />
      <PromptRequestCard />
      <div ref={surfaceRef} className={styles.surface} data-testid="composer-surface">
        {hasChips ? <InputChips /> : null}
        <div
          ref={draftRef}
          className={styles.body}
          data-composer-draft
          onClick={(e) => {
            // 点击编辑器下方空白区也聚焦输入（整块 body 区域可用）。
            if (e.target === e.currentTarget) editor.focus();
          }}
        >
          <Editor
            autoFocus
            editor={editor}
            content=""
            type="text"
            variant="chat"
            className={cx(styles.editor)}
            pasteAsPlainText
            enablePasteMarkdown={false}
            markdownOption={false}
            slashPlacement="top"
            placeholder={isGenerating ? STREAMING_PLACEHOLDER : PLACEHOLDER}
            plugins={[ReactChatTagPlugin]}
            mentionOption={{
              items: mentionItems,
              onSelect: mentionOnSelect,
              maxLength: 80,
              renderComp: boxMenu,
            }}
            slashOption={{
              items: slashItems,
              onSelect: slashOnSelect,
              maxLength: 32,
              renderComp: boxMenu,
            }}
            onChange={() => setEmpty(editor.isEmpty)}
            onPressEnter={({ event }) => {
              if (event.shiftKey || event.isComposing) return;
              event.preventDefault();
              void send();
              return true;
            }}
          />
        </div>
        <Flexbox horizontal align="center" gap={8}>
          <ActionBar actions={leftActions} />
          <Flexbox horizontal align="center" gap={8} style={{ flexShrink: 0 }}>
            <ContextUsageTag />
            <SendArea actions={rightActions} />
          </Flexbox>
        </Flexbox>
      </div>
      <ComposerPromptOverlay anchorRef={surfaceRef} />
      {dragOver ? (
        <div className={styles.dropHint}>
          {dragKind === 'text' ? '拖放以插入文本' : dragKind === 'image' ? '拖放以插入图片' : '拖放文件以引用'}
        </div>
      ) : null}
    </div>
  );
}
