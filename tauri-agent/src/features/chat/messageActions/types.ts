import type { LucideIcon } from 'lucide-react';

export type MessageRole = 'user' | 'assistant';

/** 动作运行时上下文。Phase 2 再加 entryId。 */
export interface MessageActionContext {
  role: MessageRole;
  text: string;
}

/** 轻量提示句柄（解耦 antd MessageInstance，便于测试）。 */
export interface Notify {
  success: (content: string) => void;
  error: (content: string) => void;
}

/** bar / menu 里的槽位 key。'divider' 仅用于菜单分隔。 */
export type MessageActionSlot = 'copy' | 'edit' | 'regenerate' | 'del' | 'divider';
export type MessageActionKey = Exclude<MessageActionSlot, 'divider'>;

export interface MessageActionItem {
  key: MessageActionKey;
  icon: LucideIcon;
  label: string;
  onClick?: () => void | Promise<void>;
  disabled?: boolean;
  danger?: boolean;
}
