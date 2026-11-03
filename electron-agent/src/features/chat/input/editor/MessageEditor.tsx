import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { WORKSPACE_BAR_ROW_HEIGHT } from '../workspace/styles';
import { PromptRequestCard } from '../PromptRequestCard';
import { ComposerPromptOverlay } from '../ComposerPromptOverlay';
import { EnhancePromptOverlay } from '../EnhancePromptOverlay';
import EnhancePromptAction from '../actions/EnhancePromptAction';
import type { ActionKey } from '../config';
import { InputChips } from './InputChips';
import { createBoxMenu } from './SlashBoxMenu';
import ReactChatTagPlugin from './ChatTag/ReactChatTagPlugin';
import ReactCommandPillPlugin from './CommandPill/ReactCommandPillPlugin';
import { CommandPillHostContext } from './CommandPill/hostContext';
import { useCommandPaste } from './useCommandPaste';
import { useUrlPaste } from './useUrlPaste';
import { usePasteCapture } from './usePasteCapture';
import { useFileMention } from './useFileMention';
import { useSlashOptions } from './useSlashOptions';
import { useTauriFileDrop } from './useTauriFileDrop';
import { useGoalStore, type GoalSnapshot } from '../../../../stores/goalStore';
import { draftShouldForwardWheel } from '../../composerWheel';
import { ComposerCompactProvider, composerIsCompact } from '../composerCompact';

const PLACEHOLDER = '输入消息，@ 引用文件/目录，/ 调用命令…';
const STREAMING_PLACEHOLDER = '继续跟进，引导当前回答…';

const styles = createStaticStyles(({ css }) => ({
  zone: css`
    position: relative;
    flex: none;
    margin: 8px 16px 4px;
  `,
  // 单层无缝容器：chips / 编辑器 / 操作栏共用同一底色与边框。
  // 作为 body 空闲高度的度量容器：内容列宽随会话区伸缩，固定高度会让窄列下的输入框显得方而笨重。
  surface: css`
    position: relative;
    container-type: inline-size;

    display: flex;
    flex-direction: column;
    gap: 10px;

    padding: 14px 14px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;

    background: var(--gren-composer-bg, ${cssVar.colorBgElevated});
    box-shadow: var(--gren-composer-shadow, ${cssVar.boxShadowSecondary});

    transition: border-color 0.15s ease;

    &:focus-within {
      border-color: color-mix(in srgb, var(--gren-accent, ${cssVar.colorPrimary}) 40%, ${cssVar.colorBorderSecondary});
    }

    @container empty-chat (max-width: 620px) {
      padding: 12px 12px 9px;
      border-radius: 14px;
      gap: 8px;
    }
  `,
  dock: css`
    display: flex;
    flex-direction: column;
    /* 比输入卡片窄一个圆角，避免直边探出卡片上沿的弧。 */
    margin: 0 ${cssVar.borderRadiusLG} -1px;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-bottom: none;
    border-radius: ${cssVar.borderRadiusLG} ${cssVar.borderRadiusLG} 0 0;

    background: ${cssVar.colorBgElevated};

    &:empty {
      display: none;
      margin: 0;
      border: none;
    }

    [data-dock-card] {
      border: none;
      border-radius: 0;
      background: transparent;
    }

    [data-dock-card] + [data-dock-card] {
      border-top: 1px solid ${cssVar.colorBorderSecondary};
    }

    [data-cap-layer] + [data-cap-layer] {
      border-top: 1px solid ${cssVar.colorBorderSecondary};
    }
  `,
  toolLead: css`
    display: flex;
    flex: 1;
    min-width: 0;
  `,
  below: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 2px;
  `,
  enhance: css`
    position: absolute;
    z-index: 1;
    top: 8px;
    right: 8px;
  `,
  bodyWithEnhance: css`
    padding-right: 28px;
  `,
  body: css`
    scrollbar-width: thin;

    overflow-y: auto;

    /* 空闲时保持紧凑，多行内容仍可自然长到 max-height。 */
    min-height: clamp(56px, 8cqw, 72px);
    max-height: 300px;

    [data-chat-empty='true'] & {
      min-height: clamp(40px, 8cqw, 72px);
    }

    cursor: text;
  `,
  editor: css`
    font: var(--pi-md-base);

    p {
      margin-block: 0;
    }

    /* lobe 占位层按段落 margin-block: 4px 对齐。段落边距清零后占位要一起上移，否则光标会悬在占位文字上方。 */
    [contenteditable] + div {
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
    z-index: 2;
    /* 盖住卡片自身 1px 边框，虚线框与卡片轮廓重合。 */
    inset: -1px;

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
  const { editor, send, addAttachments, addPastedText, setEmpty, attachments, pastedTexts, isGenerating, hasRunningTool, scrollTranscript } =
    useChatInput();
  const zoneRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLDivElement>(null);
  const [goalDrawerSessionId, setGoalDrawerSessionId] = useState<string>();
  const goalDrawerSnapshot = useGoalStore((state) =>
    goalDrawerSessionId ? state.bySession[goalDrawerSessionId] : undefined,
  );
  const setGoalSnapshot = useGoalStore((state) => state.setSnapshot);

  useLayoutEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;
    const update = () => setCompact(composerIsCompact(zone.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(zone);
    return () => observer.disconnect();
  }, []);

  // 菜单锚定在输入框上方，宽度与输入框齐宽（@ 与 / 共用）。
  const boxMenu = useMemo(() => createBoxMenu(surfaceRef), []);
  // 胶囊参数里按 Enter 走同一个发送，Ctrl/Cmd+Enter 同样打断。
  const pillHost = useMemo(
    () => ({ submit: (options?: { interrupt?: boolean }) => void send(options) }),
    [send],
  );

  const { mentionItems, onSelect: mentionOnSelect } = useFileMention(workspace);
  const { slashItems, onSelect: slashOnSelect } = useSlashOptions(
    workspace,
    () => editor.cleanDocument(),
    editor,
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
    // 命中区与提示层一致：只认输入卡片，不含上方 dock 与下方工作区栏。
    zoneRef: surfaceRef,
    onImages: addAttachments,
    onPastedText: addPastedText,
  });

  useEffect(() => {
    // 空态整组使用原生滚动；只有消息态才把正文边界滚轮转给对话列表。
    if (!scrollTranscript) return;
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

  // 编辑器命令在流式重绘时可能接不住回车。冒泡到这里再补一次；斜杠菜单已处理过的不再发。
  useEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
      event.preventDefault();
      void send(event.ctrlKey || event.metaKey ? { interrupt: true } : undefined);
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [send]);

  const hasChips = attachments.length > 0 || pastedTexts.length > 0;
  const showEnhance = rightActions.includes('enhancePrompt');
  const sendActions = rightActions.filter((key) => key !== 'enhancePrompt');

  return (
    <ComposerCompactProvider compact={compact}>
    <div ref={zoneRef} className={styles.zone}>
      <div data-testid="composer-dock" className={styles.dock}><SteerQueue /><TodoDockFromStore /><GoalPill onOpenDetails={(snapshot: GoalSnapshot) => setGoalDrawerSessionId(snapshot.sessionId)} /></div>
      <SessionGoalDrawer
        onClose={() => setGoalDrawerSessionId(undefined)}
        onSnapshot={(snapshot) => setGoalSnapshot(snapshot.sessionId, snapshot)}
        open={!!goalDrawerSessionId}
        sessionId={goalDrawerSessionId ?? ''}
        snapshot={goalDrawerSnapshot}
      />
      <PromptRequestCard />
      <div ref={surfaceRef} className={styles.surface} data-testid="composer-surface">
        {showEnhance ? (
          <div className={styles.enhance}>
            <EnhancePromptAction />
          </div>
        ) : null}
        {hasChips ? <InputChips /> : null}
        <div
          ref={draftRef}
          className={cx(styles.body, showEnhance && styles.bodyWithEnhance)}
          data-composer-draft
          onClick={(e) => {
            // 点击编辑器下方空白区也聚焦输入（整块 body 区域可用）。
            if (e.target === e.currentTarget) editor.focus();
          }}
        >
          <CommandPillHostContext.Provider value={pillHost}>
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
              placeholder={isGenerating || hasRunningTool ? STREAMING_PLACEHOLDER : PLACEHOLDER}
              plugins={[ReactChatTagPlugin, ReactCommandPillPlugin]}
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
                void send(event.ctrlKey || event.metaKey ? { interrupt: true } : undefined);
                return true;
              }}
            />
          </CommandPillHostContext.Provider>
        </div>
        <Flexbox horizontal align="center" gap={8}>
          <div className={styles.toolLead}>
            <ActionBar actions={leftActions} />
          </div>
          <Flexbox horizontal align="center" gap={8} style={{ flexShrink: 0 }}>
            <SendArea actions={sendActions} />
          </Flexbox>
        </Flexbox>
        {/* 提示层只罩住输入卡片，不覆盖下方工作区栏。 */}
        {dragOver ? (
          <div className={styles.dropHint}>
            {dragKind === 'text' ? '拖放以插入文本' : dragKind === 'image' ? '拖放以插入图片' : '拖放文件以引用'}
          </div>
        ) : null}
      </div>
      <div className={styles.below} data-testid="composer-below" style={{ minHeight: WORKSPACE_BAR_ROW_HEIGHT }}>
        <WorkspaceBar onReferencePastedText={addPastedText} />
      </div>
      <ComposerPromptOverlay anchorRef={surfaceRef} />
      <EnhancePromptOverlay anchorRef={surfaceRef} />
    </div>
    </ComposerCompactProvider>
  );
}
