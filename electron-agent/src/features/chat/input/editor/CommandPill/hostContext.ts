import { createContext } from 'react';

/** 胶囊里按 Enter 时要走的发送逻辑。输入框和消息编辑框各自提供。 */
export interface CommandPillHost {
  /** Ctrl/Cmd+Enter 时带 `{ interrupt: true }`，和输入框里的 Ctrl+Enter 一样打断当前回复。 */
  submit: (options?: { interrupt?: boolean }) => void;
}

export const CommandPillHostContext = createContext<CommandPillHost | null>(null);
