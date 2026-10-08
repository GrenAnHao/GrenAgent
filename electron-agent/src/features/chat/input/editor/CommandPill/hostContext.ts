import { createContext } from 'react';

/** 胶囊里按 Enter 时要走的发送逻辑。输入框和消息编辑框各自提供。 */
export interface CommandPillHost {
  submit: () => void;
}

export const CommandPillHostContext = createContext<CommandPillHost | null>(null);
