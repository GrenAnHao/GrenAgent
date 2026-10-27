import { useCallback, useEffect, useState } from 'react';
import { App } from 'antd';
import { ActionIcon } from '@lobehub/ui';
import { Wand2 } from 'lucide-react';
import { Channel } from '../../../../platform/runtime';
import { pi } from '../../../../lib/pi';
import { useAgentStore, useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useEnhancePromptStore } from '../../../../stores/enhancePromptStore';
import { useGoalStore } from '../../../../stores/goalStore';
import { useInlineQuestionStore } from '../../../../stores/inlineQuestionStore';
import { useUiPromptStore } from '../../../../stores/uiPromptStore';
import { useChatInput } from '../ChatInputContext';
import { readSessionId } from '../GoalPill';
import { shouldRenderUiPromptInOverlay } from '../overlayPrompt';
import { formatRecentTurn } from '../recentTurn';
import { peekComposerModel } from './ModelThinkingAction';

const MAX_DRAFT_CHARS = 16000;
const MAX_GOAL_CHARS = 2000;
/**
 * 渲染层看门狗：主进程若被拖住（同步 I/O、原生模块），它的定时器不会跑，
 * 而 invoke 也不会 reject——界面就会永远停在「生成中」。渲染进程独立于主进程，
 * 超时后主动 abort + 置错，保证按钮和浮层一定能恢复。
 * 取值比主进程超时（60s / 90s）各留 15s 余量。
 */
const DEFAULT_WATCHDOG_MS = 75_000;
const PROJECT_WATCHDOG_MS = 105_000;

export default function EnhancePromptAction() {
  const { workspace } = useAgentStoreContext();
  const agent = useAgentStore();
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
    // 挂载时那次 getSettings 可能还没回来（settings 仍是 {}），此时读实验开关会读成关：
    // 界面上写「生成中」而主进程走项目路径，goalText 也会被丢掉。这里按需补一次。
    const snapshot = Object.keys(settings).length ? settings : await pi.getSettings().catch(() => settings);
    const useProjectContext = snapshot.enhancePromptUseProjectContext === '1';
    let goalText: string | undefined;
    let recentTurn: string | undefined;
    if (useProjectContext) {
      const sessionId = readSessionId(await pi.getState(workspace));
      const goal = sessionId ? useGoalStore.getState().bySession[sessionId] : undefined;
      goalText = goal ? `状态: ${goal.status}\n条件: ${goal.condition}` : '';
      if (goalText.length > MAX_GOAL_CHARS) goalText = goalText.slice(0, MAX_GOAL_CHARS);
      const session = agent.useStore.getState();
      recentTurn = formatRecentTurn(session.messages, session.excluded);
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
    const onStatus = new Channel<string>();
    onStatus.onmessage = (phase) => {
      useEnhancePromptStore.getState().setPhase(workspace, seq, phase);
    };
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        useProjectContext
          ? pi.enhancePrompt(workspace, text, onChunk, goalText, recentTurn, onStatus)
          : pi.enhancePrompt(workspace, text, onChunk, undefined, undefined, onStatus),
        new Promise<null>((resolve) => {
          watchdog = setTimeout(
            () => resolve(null),
            useProjectContext ? PROJECT_WATCHDOG_MS : DEFAULT_WATCHDOG_MS,
          );
        }),
      ]);
      if (!result) {
        void pi.abortEnhancePrompt(workspace);
        useEnhancePromptStore.getState().fail(workspace, seq, '增强超时，请重试');
        return;
      }
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
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }, [workspace, readDraft, message, settings, agent]);

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
