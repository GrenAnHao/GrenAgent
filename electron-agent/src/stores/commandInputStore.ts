import { create } from 'zustand';
import type { CommandInputMessage } from '../features/chat/groupMessages';

const EMPTY: CommandInputMessage[] = [];

interface CommandInputState {
  bySession: Record<string, CommandInputMessage[]>;
  append: (sessionId: string, input: { command: string; rest: string; beforeCount: number }) => void;
  list: (sessionId: string) => CommandInputMessage[];
  dropSession: (sessionId: string) => void;
}

export const useCommandInputStore = create<CommandInputState>((set, get) => ({
  bySession: {},
  append: (sessionId, { command, rest, beforeCount }) => {
    const row: CommandInputMessage = {
      kind: 'command-input',
      id: crypto.randomUUID(),
      command,
      rest,
      beforeCount: Math.max(0, beforeCount),
    };
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: [...(s.bySession[sessionId] ?? []), row],
      },
    }));
  },
  list: (sessionId) => get().bySession[sessionId] ?? EMPTY,
  dropSession: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),
}));
