import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'antd';
import { Editor, useEditor } from '@lobehub/editor/react';
import type { ISlashOption } from '@lobehub/editor';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import {
  ChatInputProvider,
  type ChatInputContextValue,
  type ImageAttachment,
  type PromptImage,
} from './input/ChatInputContext';
import { composeMessage } from './input/editor/composeMessage';
import type { PastedText } from './input/editor/types';
import { InputChips } from './input/editor/InputChips';
import { createBoxMenu } from './input/editor/SlashBoxMenu';
import ReactChatTagPlugin from './input/editor/ChatTag/ReactChatTagPlugin';
import { useCommandPaste } from './input/editor/useCommandPaste';
import { useUrlPaste } from './input/editor/useUrlPaste';
import { usePasteCapture } from './input/editor/usePasteCapture';
import { useFileMention } from './input/editor/useFileMention';
import { useSlashOptions } from './input/editor/useSlashOptions';
import { useTauriFileDrop } from './input/editor/useTauriFileDrop';
import ReactCommandPillPlugin from './input/editor/CommandPill/ReactCommandPillPlugin';
import { CommandPillHostContext } from './input/editor/CommandPill/hostContext';
import { focusMissingPillArg, readComposerText, writeComposerText } from './input/editor/CommandPill/composerText';

const PLACEHOLDER = '编辑消息，@ 引用文件/目录，/ 调用技能…';

const styles = createStaticStyles(({ css }) => ({
  zone: css`
    position: relative;
  `,
  surface: css`
    container-type: inline-size;

    display: flex;
    flex-direction: column;
    gap: 4px;

    width: 100%;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgElevated};

    transition: border-color 0.15s ease;

    &:focus-within {
      border-color: ${cssVar.colorPrimary};
    }
  `,
  body: css`
    scrollbar-width: thin;

    overflow-y: auto;

    min-height: clamp(72px, 12cqw, 108px);
    max-height: 300px;

    cursor: text;
  `,
  editor: css`
    font: var(--pi-md-base);

    p {
      margin-block: 0;
    }

    /* 与底部输入框相同：段落边距清零后，占位层的 4px 上边距也要去掉。 */
    [contenteditable] + div {
      margin-block: 0;
    }

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
  actions: css`
    display: flex;
    gap: 4px;
    align-items: center;
    justify-content: flex-end;
  `,
}));

export interface MessageEditBoxProps {
  initialText: string;
  /** 原消息图片：进入编辑时以附件块预填。 */
  initialImages?: Array<{ mimeType: string; data: string }>;
  onCancel: () => void;
  onSend: (text: string, images?: PromptImage[]) => void;
}

type SlashSearch = {
  leadOffset: number;
  matchingString: string;
  replaceableString: string;
} | null;

function toInitialAttachments(
  images: Array<{ mimeType: string; data: string }> | undefined,
): ImageAttachment[] {
  if (!images?.length) return [];
  return images.map((img, i) => ({
    type: 'image' as const,
    mimeType: img.mimeType,
    data: img.data,
    name: `image-${i + 1}`,
    url: `data:${img.mimeType};base64,${img.data}`,
  }));
}

/**
 * 编辑框 / 只保留技能命令。
 * 用稳定字段 metadata.group === 'skill' 判定；丢弃 type:'divider' 分组标题
 * （标题文案本地化，单组时也不需要）。切勿用中文 label 过滤。
 */
export function filterSkillSlashOptions(items: ISlashOption[]): ISlashOption[] {
  return items.filter((item) => {
    if ('type' in item && item.type === 'divider') return false;
    const meta = (item as { metadata?: { group?: string } }).metadata;
    return meta?.group === 'skill';
  });
}

/** 编辑专用简化输入框：复用底部编辑器 / 图片块 / 拖放 / @，/ 只保留技能，工具栏仅取消与发送。 */
export function MessageEditBox({
  initialText,
  initialImages,
  onCancel,
  onSend,
}: MessageEditBoxProps) {
  const { workspace } = useAgentStoreContext();
  const editor = useEditor();
  const [empty, setEmpty] = useState(!initialText.trim());
  const [attachments, setAttachments] = useState<ImageAttachment[]>(() =>
    toInitialAttachments(initialImages),
  );
  const [pastedTexts, setPastedTexts] = useState<PastedText[]>([]);
  const zoneRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const primedRef = useRef(false);

  useEffect(() => {
    if (primedRef.current) return;
    primedRef.current = true;
    writeComposerText(editor, initialText);
    setEmpty(!initialText.trim());
    requestAnimationFrame(() => editor.focus());
  }, [editor, initialText]);

  const readDraft = useCallback(() => readComposerText(editor), [editor]);

  const send = useCallback(() => {
    if (focusMissingPillArg(editor.getLexicalEditor?.())) return;
    const text = composeMessage(readDraft(), pastedTexts);
    const images: PromptImage[] = attachments.map(({ type, mimeType, data }) => ({
      type,
      mimeType,
      data,
    }));
    if (!text && images.length === 0) return;
    onSend(text, images.length ? images : undefined);
  }, [attachments, editor, onSend, pastedTexts, readDraft]);
  const pillHost = useMemo(() => ({ submit: () => void send() }), [send]);

  const boxMenu = useMemo(() => createBoxMenu(surfaceRef), []);
  const { mentionItems, onSelect: mentionOnSelect } = useFileMention(workspace);
  const { slashItems: loadSlashItems, onSelect: slashOnSelect } = useSlashOptions(
    workspace,
    () => editor.cleanDocument(),
    editor,
  );
  const slashItems = useCallback(
    async (search: SlashSearch): Promise<ISlashOption[]> =>
      filterSkillSlashOptions(await loadSlashItems(search)),
    [loadSlashItems],
  );
  const { tryCommandPaste } = useCommandPaste(workspace, editor);
  const { tryUrlPaste } = useUrlPaste(editor);

  const addAttachments = useCallback((items: ImageAttachment[]) => {
    setAttachments((prev) => [...prev, ...items]);
  }, []);
  const addPastedText = useCallback((text: PastedText) => {
    setPastedTexts((prev) => [...prev, text]);
  }, []);

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

  const ctx: ChatInputContextValue = useMemo(
    () => ({
      editor,
      empty,
      setEmpty,
      setValue: (text: string) => {
        writeComposerText(editor, text);
        setEmpty(!text);
      },
      readDraft,
      attachments,
      addAttachments,
      removeAttachment: (index) => setAttachments((prev) => prev.filter((_, i) => i !== index)),
      pastedTexts,
      addPastedText,
      removePastedText: (id) => setPastedTexts((prev) => prev.filter((p) => p.id !== id)),
      isStreaming: false,
      isGenerating: false,
      hasRunningTool: false,
      steering: [],
      followUp: [],
      steerQueued: () => undefined,
      interruptQueued: () => undefined,
      hasComposerQueue: false,
      inFlight: false,
      retrying: false,
      send,
      stop: () => undefined,
    }),
    [addAttachments, addPastedText, attachments, editor, empty, pastedTexts, readDraft, send],
  );

  const hasChips = attachments.length > 0 || pastedTexts.length > 0;
  const canSend = !empty || attachments.length > 0 || pastedTexts.length > 0;

  return (
    <ChatInputProvider value={ctx}>
      <div
        ref={zoneRef}
        className={styles.zone}
        data-testid="message-edit-box"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onCancel();
        }}
      >
        <div ref={surfaceRef} className={styles.surface}>
          {hasChips ? <InputChips /> : null}
          <div
            className={styles.body}
            onClick={(e) => {
              if (e.target === e.currentTarget) editor.focus();
            }}
          >
            <CommandPillHostContext.Provider value={pillHost}>
              <Editor
                autoFocus
                editor={editor}
                content={initialText}
                type="text"
                variant="chat"
                className={cx(styles.editor)}
                pasteAsPlainText
                enablePasteMarkdown={false}
                markdownOption={false}
                slashPlacement="top"
                placeholder={PLACEHOLDER}
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
                  void send();
                  return true;
                }}
              />
            </CommandPillHostContext.Provider>
          </div>
          <div className={styles.actions}>
            <Button type="link" size="small" danger aria-label="取消" onClick={onCancel}>
              取消
            </Button>
            <Button
              type="link"
              size="small"
              aria-label="发送"
              disabled={!canSend}
              onClick={() => void send()}
            >
              发送
            </Button>
          </div>
        </div>
        {dragOver ? (
          <div className={styles.dropHint}>
            {dragKind === 'text'
              ? '拖放以插入文本'
              : dragKind === 'image'
                ? '拖放以插入图片'
                : '拖放文件以引用'}
          </div>
        ) : null}
      </div>
    </ChatInputProvider>
  );
}
