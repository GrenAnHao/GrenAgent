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
  attachments: ImageAttachment[];
  addAttachments: (items: ImageAttachment[]) => void;
  removeAttachment: (index: number) => void;
  pastedTexts: PastedText[];
  addPastedText: (text: PastedText) => void;
  removePastedText: (id: string) => void;
  isStreaming: boolean;
  /** 是否正在「生成」（存在流式中的 assistant 消息）。区别于 isStreaming（整段 agent run）：
   * 回合文字完成后的收尾窗口 / 工具执行间隙，isStreaming 仍为 true 但 isGenerating 为 false。
   * 发送路由据此区分 steer（打断当前生成）与 followUp（排队为跟进），避免回合刚结束的紧跟消息被当引导。 */
  isGenerating: boolean;
  /** 已排队的引导消息（注入当前回合）；来自 pi 的 queue_update 事件。 */
  steering: string[];
  /** 已排队的跟进消息（当前回合结束后执行）；来自 pi 的 queue_update 事件。 */
  followUp: string[];
  send: () => void;
  stop: () => void;
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
