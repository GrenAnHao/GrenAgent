import { memo, useEffect, useState } from 'react';
import { createStaticStyles } from 'antd-style';
import { QuestionSelector } from '../../components/QuestionSelector';
import { formatAnswers } from '../../components/QuestionSelector/answers';
import type { ImageAttachment } from './input/ChatInputContext';
import { extensionUiRespond } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    margin-block: 6px 2px;
  `,
}));

/**
 * 阻塞式 ask_user 富卡：渲染在对话流末尾（紧跟提问消息），用户作答 → 回传 `[我的选择]`
 * 经 extension_ui_response resolve 掉 sidecar 端 ctx.ui.input 的阻塞调用。
 */
export const InlineQuestionCard = memo(function InlineQuestionCard() {
  const { workspace } = useAgentStoreContext();
  const item = useInlineQuestionStore((s) => s.byWorkspace[workspace]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [extraText, setExtraText] = useState('');
  const [extraImages, setExtraImages] = useState<ImageAttachment[]>([]);

  const reqId = item?.id;
  useEffect(() => {
    setSelected({});
    setCustomTexts({});
    setExtraText('');
    setExtraImages([]);
  }, [reqId]);

  if (!item) return null;
  const { data } = item;

  const respond = (payload: Record<string, unknown>) => {
    void extensionUiRespond(workspace, { type: 'extension_ui_response', id: item.id, ...payload });
    useInlineQuestionStore.getState().clear(workspace, item.id);
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
    <div className={styles.wrap}>
      <QuestionSelector
        allowExtra={Boolean(data.allowExtra)}
        allowExtraImages={data.allowExtraImages !== false}
        customTexts={customTexts}
        data-testid="inline-question"
        extraImages={extraImages}
        extraPlaceholder={data.extraPlaceholder}
        extraText={extraText}
        onContinue={() => respond({ value: formatAnswers(data, selected, customTexts, extraText) })}
        onCustomTextChange={(qid, v) => setCustomTexts((p) => ({ ...p, [qid]: v }))}
        onExtraImagesChange={setExtraImages}
        onExtraTextChange={setExtraText}
        onSkip={() => respond({ cancelled: true })}
        onToggle={toggle}
        questions={data.questions}
        selected={selected}
      />
    </div>
  );
});
