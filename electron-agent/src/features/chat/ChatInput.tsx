import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@lobehub/editor/react';
import { useAgentStore, useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store';
import { useChatDraftStore } from '../../stores/chatDraftStore';
import {
  ChatInputProvider,
  type ChatInputContextValue,
  type ImageAttachment,
  type PromptImage,
} from './input/ChatInputContext';
import { MessageEditor } from './input/editor/MessageEditor';
import { composeMessage } from './input/editor/composeMessage';
import type { PastedText } from './input/editor/types';
import { DEFAULT_LEFT_ACTIONS, DEFAULT_RIGHT_ACTIONS, type ActionKey } from './input/config';

interface ChatInputProps {
  onSend: (
    message: string,
    images?: PromptImage[],
    behavior?: 'steer' | 'followUp',
  ) => Promise<void> | void;
  onAbort: () => Promise<void> | void;
  leftActions?: ActionKey[];
  rightActions?: ActionKey[];
}

export function ChatInput({
  onSend,
  onAbort,
  leftActions = DEFAULT_LEFT_ACTIONS,
  rightActions = DEFAULT_RIGHT_ACTIONS,
}: ChatInputProps) {
  const { useStore } = useAgentStore();
  const { workspace } = useAgentStoreContext();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  // 草稿按会话隔离：优先用会话文件路径（每会话独立），新建/草稿对话还没落盘 session 时回退到 workspace(cwd)。
  const draftKey = activeSessionPath || workspace;

  const isStreaming = useStore((s) => s.isStreaming);
  // 「正在生成」：存在流式中的 assistant 消息。回合文字完成后的收尾窗口 / 工具执行间隙里，
  // isStreaming（整段 run）仍为 true 但 isGenerating 为 false——据此把"回合刚结束的紧跟消息"
  // 路由为 followUp(跟进) 而非 steer(引导)，且不去动并发关键的 isStreaming。
  const isGenerating = useStore((s) => s.messages.some((m) => m.kind === 'assistant' && m.streaming));
  const steering = useStore((s) => s.steering);
  const followUp = useStore((s) => s.followUp);
  const editor = useEditor();
  const [empty, setEmpty] = useState(true);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [pastedTexts, setPastedTexts] = useState<PastedText[]>([]);

  // 读当前编辑器正文（markdown）。
  // @lobehub/editor 的 markdown 序列化会把 _ 转义成 \_，对 AI 消息无意义，这里还原。
  const readDraft = useCallback(() => String(editor.getDocument('markdown') || '').replace(/\\_/g, '_'), [editor]);

  // 草稿持久化：debounce 写，避免每键都落 localStorage。
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleSaveDraft = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (draftKey) useChatDraftStore.getState().setDraft(draftKey, readDraft());
    }, 300);
  }, [draftKey, readDraft]);

  const send = useCallback(() => {
    const markdown = readDraft();
    const text = composeMessage(markdown, pastedTexts);
    const images: PromptImage[] = attachments.map(({ type, mimeType, data }) => ({
      type,
      mimeType,
      data,
    }));
    if (!text && images.length === 0) return;
    editor.cleanDocument();
    setAttachments([]);
    setPastedTexts([]);
    setEmpty(true);
    // 已发送：清掉该会话草稿（debounce 也一并取消，避免随后把空内容当草稿又写回）。
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (draftKey) useChatDraftStore.getState().clearDraft(draftKey);
    requestAnimationFrame(() => editor.focus());
    // 路由：正在生成中发送 = 引导当前回合（steer）；run 进行中但已停笔（收尾/工具间隙）发送 =
    // 跟进（followUp，回合结束后作为新一轮跑）；完全空闲 = 新一轮提示。这样回合刚答完紧跟的消息
    // 不会被误当引导，且不触碰并发关键的 isStreaming。
    void onSend(
      text,
      images.length ? images : undefined,
      isGenerating ? 'steer' : isStreaming ? 'followUp' : undefined,
    );
  }, [editor, readDraft, pastedTexts, attachments, isGenerating, isStreaming, onSend, draftKey]);

  const stop = useCallback(() => {
    void onAbort();
  }, [onAbort]);

  const setValue = useCallback(
    (text: string) => {
      if (text) editor.setDocument('markdown', text);
      else editor.cleanDocument();
      setEmpty(!text);
      requestAnimationFrame(() => editor.focus());
    },
    [editor],
  );

  // 输入变化：更新空态 + 安排草稿持久化（MessageEditor 的 onChange 经 ctx.setEmpty 走到这里）。
  const handleChange = useCallback(
    (value: boolean) => {
      setEmpty(value);
      scheduleSaveDraft();
    },
    [scheduleSaveDraft],
  );

  // 切会话（draftKey 变）：先把上一个会话的当前内容存回，再载入新会话草稿（含重启后的持久化恢复）。
  const prevKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!draftKey) return;
    const prev = prevKeyRef.current;
    if (prev === draftKey) return;
    // 关键：清掉上一个会话 pending 的 debounce save，否则它会在切换后用「新会话内容」覆盖「旧会话草稿」。
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (prev !== null) {
      useChatDraftStore.getState().setDraft(prev, readDraft());
    }
    prevKeyRef.current = draftKey;
    setValue(useChatDraftStore.getState().getDraft(draftKey));
  }, [draftKey, readDraft, setValue]);

  // 卸载时把当前草稿同步落盘（debounce 可能还没触发）。
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const key = prevKeyRef.current;
      if (key) useChatDraftStore.getState().setDraft(key, readDraft());
    };
  }, [readDraft]);

  const ctx: ChatInputContextValue = useMemo(
    () => ({
      editor,
      empty,
      // ctx.setEmpty 给 MessageEditor 的 onChange 用：在更新空态的同时安排草稿持久化。
      setEmpty: handleChange,
      setValue,
      attachments,
      addAttachments: (items) => setAttachments((prev) => [...prev, ...items]),
      removeAttachment: (index) => setAttachments((prev) => prev.filter((_, i) => i !== index)),
      pastedTexts,
      addPastedText: (text) => setPastedTexts((prev) => [...prev, text]),
      removePastedText: (id) => setPastedTexts((prev) => prev.filter((p) => p.id !== id)),
      isStreaming,
      isGenerating,
      steering,
      followUp,
      send,
      stop,
    }),
    [
      editor,
      empty,
      handleChange,
      setValue,
      attachments,
      pastedTexts,
      isStreaming,
      isGenerating,
      steering,
      followUp,
      send,
      stop,
    ],
  );

  return (
    <ChatInputProvider value={ctx}>
      <MessageEditor leftActions={leftActions} rightActions={rightActions} />
    </ChatInputProvider>
  );
}
