import { useCallback, useEffect, useState } from 'react';
import { App } from 'antd';
import { ActionIcon } from '@lobehub/ui';
import { Wand2 } from 'lucide-react';
import { Channel } from '../../../../platform/runtime';
import { pi } from '../../../../lib/pi';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useEnhancePromptStore } from '../../../../stores/enhancePromptStore';
import { useGoalStore } from '../../../../stores/goalStore';
import { useInlineQuestionStore } from '../../../../stores/inlineQuestionStore';
import { useUiPromptStore } from '../../../../stores/uiPromptStore';
import { useChatInput } from '../ChatInputContext';
import { readSessionId } from '../GoalPill';
import { shouldRenderUiPromptInOverlay } from '../overlayPrompt';
import { peekComposerModel } from './ModelThinkingAction';

const MAX_DRAFT_CHARS = 16000;
const MAX_GOAL_CHARS = 2000;

export default function EnhancePromptAction() {
  const { workspace } = useAgentStoreContext();
  const { empty, readDraft } = useChatInput();
  const { message } = App.useApp();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const slot = useEnhancePromptStore((s) => s.byWorkspace[workspace]);
  const hasInline = useInlineQuestionStore((s) => Boolean(s.byWorkspace[workspace]));
  const uiPrompt = useUiPromptStore((s) => s.byWorkspace[workspace]);
  const hasBlockingPrompt =
    hasInline || Boolean(uiPrompt && shouldRenderUiPromptInOverlay(uiPrompt.request));
  const enhanceModel = (settings.enhancePromptModel ?? '').trim();
  const disabled =
    empty || hasBlockingPrompt || (!peekComposerModel(workspace) && !enhanceModel);
  const streaming = slot?.status === 'streaming';

  useEffect(() => {
    let alive = true;
    setSettings({});
    void pi.getSettings().then((next) => {
      if (alive) setSettings(next);
    });
    return () => {
      alive = false;
    };
  }, [workspace]);

  const onClick = useCallback(async () => {
    const cur = useEnhancePromptStore.getState().byWorkspace[workspace];
    if (cur && cur.status !== 'idle') return;
    const text = readDraft().trim();
    if (!text) return;
    if (text.length > MAX_DRAFT_CHARS) {
      message.warning('正文过长，请缩短后再增强');
      return;
    }
    const useProjectContext = settings.enhancePromptUseProjectContext === '1';
    let goalText: string | undefined;
    if (useProjectContext) {
      const sessionId = readSessionId(await pi.getState(workspace));
      const goal = sessionId ? useGoalStore.getState().bySession[sessionId] : undefined;
      goalText = goal ? `状态: ${goal.status}\n条件: ${goal.condition}` : '';
      if (goalText.length > MAX_GOAL_CHARS) goalText = goalText.slice(0, MAX_GOAL_CHARS);
    }
    const again = useEnhancePromptStore.getState().byWorkspace[workspace];
    if (again && again.status !== 'idle') return;
    const seq = useEnhancePromptStore.getState().start(workspace, {
      awaitingContext: useProjectContext,
      source: text,
    });
    const onChunk = new Channel<string>();
    onChunk.onmessage = (chunk) => {
      useEnhancePromptStore.getState().append(workspace, seq, chunk);
    };
    try {
      const result = useProjectContext
        ? await pi.enhancePrompt(workspace, text, onChunk, goalText)
        : await pi.enhancePrompt(workspace, text, onChunk);
      if (result.cancelled) {
        if (useEnhancePromptStore.getState().byWorkspace[workspace]?.seq === seq) {
          useEnhancePromptStore.getState().clear(workspace);
        }
        return;
      }
      if (result.ok) {
        useEnhancePromptStore.getState().finish(workspace, seq, result.content);
        return;
      }
      useEnhancePromptStore.getState().fail(workspace, seq, result.error || '增强失败');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      useEnhancePromptStore.getState().fail(workspace, seq, messageText || '增强失败');
    }
  }, [workspace, readDraft, message, settings]);

  return (
    <ActionIcon
      icon={Wand2}
      size="small"
      title={streaming ? '正在增强…' : '增强提示词'}
      data-testid="composer-enhance-prompt"
      disabled={disabled}
      aria-busy={streaming || undefined}
      onClick={() => void onClick()}
    />
  );
}
