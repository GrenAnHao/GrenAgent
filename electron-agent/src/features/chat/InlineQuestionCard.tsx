import { App } from 'antd';
import { memo, useEffect, useRef, useState } from 'react';
import { QuestionSelector } from '../../components/QuestionSelector';
import { encodeAskUserAnswer, formatAnswers } from '../../components/QuestionSelector/answers';
import type { ImageAttachment } from './input/ChatInputContext';
import {
  completeAskUser,
  deleteAskUserDraft,
  extensionUiRespond,
  pi,
  writeAskUserDraft,
} from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import type { ChatMessage } from '../../stores/agentReducer';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';

function draftImagesToAttachments(
  images: Array<{ type: 'image'; mimeType: string; data: string }>,
): ImageAttachment[] {
  return images.map((img, i) => ({
    type: 'image',
    mimeType: img.mimeType,
    data: img.data,
    name: `image-${i + 1}`,
    url: `data:${img.mimeType};base64,${img.data}`,
  }));
}

/** 从 ChatMessage 列表取最后一条 running ask_user 的 toolCallId。 */
function findRunningAskUserToolCallId(messages: ChatMessage[]): string | undefined {
  let last: string | undefined;
  for (const m of messages) {
    if (
      m.kind === 'tool' &&
      m.status === 'running' &&
      typeof m.toolName === 'string' &&
      m.toolName.toLowerCase() === 'ask_user'
    ) {
      last = m.toolCallId;
    }
  }
  return last;
}

/**
 * 阻塞式 ask_user 富卡，由 `ComposerPromptOverlay` 渲染。
 */
export const InlineQuestionCard = memo(function InlineQuestionCard() {
  const { message } = App.useApp();
  const { workspace, store } = useAgentStoreContext();
  const messages = store.useStore((s) => s.messages);
  const item = useInlineQuestionStore((s) => s.byWorkspace[workspace]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [extraText, setExtraText] = useState('');
  const [extraImages, setExtraImages] = useState<ImageAttachment[]>([]);
  /** undefined=未取；null=取过但没有；string=sessionFile */
  const sessionFileRef = useRef<string | null | undefined>(undefined);

  const reqId = item?.id;
  useEffect(() => {
    const cur = useInlineQuestionStore.getState().byWorkspace[workspace];
    if (!cur || cur.id !== reqId) return;
    if (cur.draft) {
      setSelected(cur.draft.selected);
      setCustomTexts(cur.draft.customTexts);
      setExtraText(cur.draft.extraText);
      setExtraImages(draftImagesToAttachments(cur.draft.extraImages));
    } else {
      setSelected({});
      setCustomTexts({});
      setExtraText('');
      setExtraImages([]);
    }
  }, [reqId, workspace]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!item) return;
      const toolCallId = item.toolCallId ?? findRunningAskUserToolCallId(messages);
      if (!toolCallId) return;

      let sessionPath = item.sessionPath;
      if (!sessionPath) {
        if (sessionFileRef.current === undefined) {
          try {
            const state = (await pi.getState(workspace)) as { sessionFile?: string | null };
            sessionFileRef.current =
              typeof state?.sessionFile === 'string' && state.sessionFile ? state.sessionFile : null;
          } catch {
            sessionFileRef.current = null;
          }
        }
        sessionPath = sessionFileRef.current ?? undefined;
      }
      if (cancelled || !sessionPath) return;

      await writeAskUserDraft(workspace, {
        toolCallId,
        selected,
        customTexts,
        extraText,
        extraImages: extraImages.map(({ type, mimeType, data }) => ({ type, mimeType, data })),
      }).catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [
    workspace,
    item,
    messages,
    selected,
    customTexts,
    extraText,
    extraImages,
  ]);

  if (!item) return null;
  const { data } = item;

  const clear = () => useInlineQuestionStore.getState().clear(workspace, item.id);

  const respond = (payload: { value?: string; cancelled?: boolean }) => {
    void (async () => {
      if (item.mode === 'restored') {
        const toolCallId = item.toolCallId ?? item.id;
        try {
          const result = await completeAskUser(
            workspace,
            toolCallId,
            payload.cancelled ? undefined : payload.value,
            payload.cancelled ? true : undefined,
          );
          if (result === 'ok' || result === 'duplicate') clear();
        } catch (err) {
          message.error(err instanceof Error ? err.message : String(err));
        }
        return;
      }

      try {
        await extensionUiRespond(workspace, {
          type: 'extension_ui_response',
          id: item.id,
          ...payload,
        });
        await deleteAskUserDraft(workspace).catch(() => {});
        clear();
      } catch {
        // live 失败：保留浮层与草稿，与 restored 一致不清。
      }
    })();
  };

  const toggle = (qid: string, oid: string, multi: boolean) =>
    setSelected((prev) => {
      const cur = prev[qid] ?? [];
      if (multi) {
        return { ...prev, [qid]: cur.includes(oid) ? cur.filter((x) => x !== oid) : [...cur, oid] };
      }
      return { ...prev, [qid]: cur.includes(oid) ? [] : [oid] };
    });

  return (
    <QuestionSelector
      allowExtra={Boolean(data.allowExtra)}
      allowExtraImages={data.allowExtraImages !== false}
      customTexts={customTexts}
      data-testid="inline-question"
      extraImages={extraImages}
      extraPlaceholder={data.extraPlaceholder}
      extraText={extraText}
      fullWidth
      onContinue={() =>
        respond({
          value: encodeAskUserAnswer(
            formatAnswers(data, selected, customTexts, extraText, extraImages.length),
            extraImages,
          ),
        })
      }
      onCustomTextChange={(qid, v) => setCustomTexts((p) => ({ ...p, [qid]: v }))}
      onExtraImagesChange={setExtraImages}
      onExtraTextChange={setExtraText}
      onSkip={() => respond({ cancelled: true })}
      onToggle={toggle}
      questions={data.questions}
      selected={selected}
    />
  );
});
