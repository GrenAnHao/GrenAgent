import { createContext, useContext } from 'react';
import type { IEditor } from '@lobehub/editor';
import type { PastedText } from './editor/types';

/** pi.prompt 接受的图片格式（纯 base64 data）。 */
export interface PromptImage {
  type: 'image';
  mimeType: string;
  data: string;
}

/** UI 侧附件：在 PromptImage 基础上附带预览所需的 name/url。 */
export interface ImageAttachment extends PromptImage {
  name: string;
  url: string;
}

/**
 * 输入区共享状态。
 * actionMap 渲染出的按钮没有 props 通道，需从此 context 读取编辑器实例、
 * 附件、粘贴块、流式状态并触发发送/停止。
 */
export interface ChatInputContextValue {
  /** @lobehub/editor 实例（富文本输入 + 行内 pill）。 */
  editor: IEditor;
  /** 编辑器正文是否为空（驱动发送按钮可用态）。 */
  empty: boolean;
  setEmpty: (value: boolean) => void;
  /** 用文本覆盖编辑器内容并聚焦（动作按钮预填提示词、新会话清空等沿用此入口）。 */
  setValue: (text: string) => void;
  /** 读当前编辑器正文（markdown，与发送同一套序列化）。 */
  readDraft: () => string;
  attachments: ImageAttachment[];
  addAttachments: (items: ImageAttachment[]) => void;
  removeAttachment: (index: number) => void;
  pastedTexts: PastedText[];
  addPastedText: (text: PastedText) => void;
  removePastedText: (id: string) => void;
  isStreaming: boolean;
  /** 是否正在「生成」（存在流式中的 assistant 消息）。区别于 isStreaming（整段 agent run）：
   * 回合文字完成后的收尾窗口，isStreaming 仍为 true 但 isGenerating 为 false。
   * 发送路由据此区分 steer（打断当前生成）与 followUp（排队为跟进），避免回合刚结束的紧跟消息被当引导。 */
  isGenerating: boolean;
  /** 当前有工具卡片在 running（如 bash）。工具执行中发送走引导，等工具结束后注入当前回合。 */
  hasRunningTool: boolean;
  /** 已排队的引导消息（注入当前回合）；来自 pi 的 queue_update 事件。 */
  steering: string[];
  /** 已排队的跟进消息（当前回合结束后执行）；来自 pi 的 queue_update 事件。 */
  followUp: string[];
  /** 把跟进条立刻作为引导注入当前回合。 */
  steerQueued: (id: string) => void;
  /** 先停掉当前回复，再把这条跟进作为新消息发出。 */
  interruptQueued: (id: string) => void | Promise<void>;
  /** 输入栏本地跟进条是否还有未发出的条目。 */
  hasComposerQueue: boolean;
  /**
   * 本轮尚未结束：流式中、发送失败自动重试、或仍在等首个 agent_start。
   * 停止按钮用这个，而不是只看 isStreaming——否则失败重试时会只剩发送、无法取消。
   */
  inFlight: boolean;
  /** 发送失败、错误横幅还没出来的自动重试。算进 inFlight；输入为空时同一个按钮显示停止。 */
  retrying: boolean;
  /** interrupt 为 Ctrl+Enter：先停掉当前回复再发出。普通回车和发送按钮不传。 */
  send: (options?: { interrupt?: boolean }) => void | Promise<void>;
  stop: () => void;
  /** 草稿滚到边缘时把滚轮交给对话列表；空会话不传。 */
  scrollTranscript?: (deltaY: number) => void;
}

const ChatInputContext = createContext<ChatInputContextValue | null>(null);

export const ChatInputProvider = ChatInputContext.Provider;

export function useChatInput(): ChatInputContextValue {
  const ctx = useContext(ChatInputContext);
  if (!ctx) {
    throw new Error('useChatInput must be used within a ChatInput');
  }
  return ctx;
}
