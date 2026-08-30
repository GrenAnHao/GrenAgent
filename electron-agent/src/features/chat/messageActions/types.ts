import type { LucideIcon } from 'lucide-react';

export type MessageRole = 'user' | 'assistant';

/** 动作运行时上下文。上下文控制类动作（移出/恢复/回退）需要 timestamp + 由 MessageActionBar 注入的回调。 */
export interface MessageActionContext {
  role: MessageRole;
  text: string;
  /** 该消息的 pi 毫秒 timestamp（移出上下文 / 回退到此的稳定 key）。缺失时相关动作禁用。 */
  timestamp?: number;
  /** 该消息当前是否已被移出 LLM 上下文。 */
  excluded?: boolean;
  /** 移出上下文（由 MessageActionBar 在有 store 上下文时注入，内部调 store.excludeMessage）。 */
  onExclude?: (timestamp: number) => void | Promise<void>;
  /** 恢复到上下文（内部调 store.restoreMessage）。 */
  onRestore?: (timestamp: number) => void | Promise<void>;
  /** 回退到此（内部调 store.rewindTo）。 */
  onRewind?: (timestamp: number) => void | Promise<void>;
}

/** 轻量提示句柄（解耦 antd MessageInstance，便于测试）。 */
export interface Notify {
  success: (content: string) => void;
  error: (content: string) => void;
}

/** bar / menu 里的槽位 key。'divider' 仅用于菜单分隔。 */
export type MessageActionSlot =
  | 'copy'
  | 'edit'
  | 'regenerate'
  | 'del'
  | 'exclude'
  | 'rewind'
  | 'divider';
export type MessageActionKey = Exclude<MessageActionSlot, 'divider'>;

export interface MessageActionItem {
  key: MessageActionKey;
  icon: LucideIcon;
  label: string;
  onClick?: () => void | Promise<void>;
  disabled?: boolean;
  danger?: boolean;
}
