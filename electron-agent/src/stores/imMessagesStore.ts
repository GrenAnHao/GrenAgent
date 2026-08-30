import { create } from 'zustand';

/** 单条微信会话消息（与 sidecar im-platforms 的 ImTurn 对齐）。 */
export interface ImTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** 一个微信用户的有界会话历史（最近 IM_CTX_MAX 条，越靠后越新）。 */
export interface ImConversation {
  /** 微信用户 ID（fromUser），用于区分多会话。 */
  user: string;
  messages: ImTurn[];
}

interface ImMessagesState {
  /** 微信收发记录（由 sidecar im-platforms 扩展经 setStatus("wechat-messages") 推送）。 */
  conversations: ImConversation[];
  setConversations: (conversations: ImConversation[]) => void;
}

/**
 * 微信会话只读镜像：主人的交互式会话是隔离的、不含微信流量，所以这份镜像是桌面 UI
 * 唯一能看到「微信里都聊了什么」的地方。快照覆盖式（每次推送携带全量当前状态）。
 */
export const useImMessagesStore = create<ImMessagesState>((set) => ({
  conversations: [],
  setConversations: (conversations) => set({ conversations }),
}));
