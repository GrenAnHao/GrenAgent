import { App } from 'antd';
import { memo, useEffect, useRef, useState } from 'react';
import { QuestionSelector } from '../../components/QuestionSelector';
import { encodeAskUserAnswer, formatAnswers, selectedVisualReview } from '../../components/QuestionSelector/answers';
import type { ImageAttachment } from './input/ChatInputContext';
import {
  completeAskUser,
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
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (
      m.kind === 'tool' &&
      m.status === 'running' &&
      typeof m.toolName === 'string' &&
      m.toolName.toLowerCase() === 'ask_user'
    ) {
      return m.toolCallId;
    }
  }
}

/**
 * 阻塞式 ask_user 富卡，由 `ComposerPromptOverlay` 渲染。
 */
export const InlineQuestionCard = memo(function InlineQuestionCard() {
  const { message } = App.useApp();
  const { workspace, store } = useAgentStoreContext();
  const item = useInlineQuestionStore((s) => s.byWorkspace[workspace]);
  const toolCallId = store.useStore((s) => item && (item.toolCallId ?? findRunningAskUserToolCallId(s.messages)));
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [extraText, setExtraText] = useState('');
  const [extraImages, setExtraImages] = useState<ImageAttachment[]>([]);
  /** 已按当前 reqId 完成草稿灌入；写盘前必须匹配。 */
  const [readyReqId, setReadyReqId] = useState<string | undefined>();
  /** undefined=未取；null=取过但没有；string=sessionFile。随 reqId 重置。 */
  const sessionFileRef = useRef<string | null | undefined>(undefined);
  const responding = useRef<string | undefined>(undefined);
  const [pendingReply, setPendingReply] = useState<string | undefined>();

  const reqId = item?.id;
  useEffect(() => {
    sessionFileRef.current = undefined;
    const cur = useInlineQuestionStore.getState().byWorkspace[workspace];
    if (!cur || cur.id !== reqId) {
      setReadyReqId(undefined);
      return;
    }
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
    setReadyReqId(reqId);
  }, [reqId, workspace]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!item || readyReqId !== item.id) return;
      if (!toolCallId) return;

      let sessionPath = item.sessionPath;
      if (!sessionPath) {
        if (sessionFileRef.current === undefined) {
          try {
            const state = (await pi.getState(workspace)) as { sessionFile?: string | null };
            if (cancelled) return;
            sessionFileRef.current =
              typeof state?.sessionFile === 'string' && state.sessionFile ? state.sessionFile : null;
          } catch {
            // 抛错不记 null，保持 undefined 以便下次选择再试。
            if (cancelled) return;
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
      }, sessionPath, item.mode === 'live' ? item.id : undefined).catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [
    workspace,
    item,
    toolCallId,
    readyReqId,
    selected,
    customTexts,
    extraText,
    extraImages,
  ]);

  if (!item) return null;
  const { data } = item;

  const clear = () => useInlineQuestionStore.getState().clear(workspace, item.id);

  const respond = (payload: { value?: string; cancelled?: boolean }) => {
    if (responding.current === item.id) return;
    responding.current = item.id;
    setPendingReply(item.id);
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
          ...(toolCallId ? { askUserDraftToolCallId: toolCallId } : {}),
        });
        clear();
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    })().finally(() => {
      if (responding.current === item.id) {
        responding.current = undefined;
        setPendingReply(undefined);
      }
    });
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
      key={item.id}
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
            selectedVisualReview(data, selected),
          ),
        })
      }
      onCustomTextChange={(qid, v) => setCustomTexts((p) => ({ ...p, [qid]: v }))}
      onExtraImagesChange={setExtraImages}
      onExtraTextChange={setExtraText}
      onSkip={() => respond({ cancelled: true })}
      onToggle={toggle}
      submitting={pendingReply === item.id}
      questions={data.questions}
      selected={selected}
    />
  );
});
