import { useMemo, useRef } from 'react';
import { Flexbox } from '@lobehub/ui';
import { Editor } from '@lobehub/editor/react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useChatInput } from '../ChatInputContext';
import { ActionBar } from '../ActionBar';
import { SendArea } from '../SendArea';
import { SteerQueue } from '../SteerQueue';
import { GoalPill } from '../GoalPill';
import { WorkspaceBar } from '../workspace/WorkspaceBar';
import { PromptRequestCard } from '../PromptRequestCard';
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

const PLACEHOLDER = '输入消息，@ 引用文件/目录，/ 调用命令…';
const STREAMING_PLACEHOLDER = '继续跟进，引导当前回答…';

const styles = createStaticStyles(({ css }) => ({
  zone: css`
    position: relative;
    flex: none;
    margin: 8px 16px 16px;
  `,
  // 单层无缝容器：chips / 编辑器 / 操作栏共用同一底色与边框。
  surface: css`
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
  body: css`
    scrollbar-width: thin;

    overflow-y: auto;

    min-height: 105px;
    max-height: 300px;

    cursor: text;
  `,
  editor: css`
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
  const { editor, send, addAttachments, addPastedText, setEmpty, attachments, pastedTexts, isGenerating } =
    useChatInput();
  const zoneRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

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

  const hasChips = attachments.length > 0 || pastedTexts.length > 0;

  return (
    <div ref={zoneRef} className={styles.zone}>
      <SteerQueue />
      <GoalPill />
      <WorkspaceBar />
      <PromptRequestCard />
      <div ref={surfaceRef} className={styles.surface}>
        {hasChips ? <InputChips /> : null}
        <div
          className={styles.body}
          onClick={(e) => {
            // 点击编辑器下方空白区也聚焦输入（整块 105 区域可用）。
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
              send();
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
      {dragOver ? (
        <div className={styles.dropHint}>
          {dragKind === 'text' ? '拖放以插入文本' : dragKind === 'image' ? '拖放以插入图片' : '拖放文件以引用'}
        </div>
      ) : null}
    </div>
  );
}
