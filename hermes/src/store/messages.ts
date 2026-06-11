import { create } from 'zustand';
import type { AgentMessage, ToolExecution } from '../lib/types';

interface MessageStore {
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  isStreaming: boolean;
  toolExecutions: Map<string, ToolExecution>;

  addMessage: (msg: AgentMessage) => void;
  updateStreamingMessage: (delta: string) => void;
  setStreamingThinking: (thinking: string) => void;
  finishStreaming: () => void;
  clearMessages: () => void;
  addToolExecution: (toolCallId: string, execution: ToolExecution) => void;
  updateToolExecution: (toolCallId: string, update: Partial<ToolExecution>) => void;
}

export const useMessageStore = create<MessageStore>((set) => ({
  messages: [],
  streamingMessage: null,
  isStreaming: false,
  toolExecutions: new Map(),

  addMessage: (msg) => set((state) => ({
    messages: [...state.messages, msg],
  })),

  updateStreamingMessage: (delta) => set((state) => {
    const current = state.streamingMessage || { role: 'assistant' as const, content: '', timestamp: Date.now() };
    const currentContent = typeof current.content === 'string' ? current.content : '';
    return {
      streamingMessage: { ...current, content: currentContent + delta },
      isStreaming: true,
    };
  }),

  setStreamingThinking: (thinking) => set((state) => {
    if (!state.streamingMessage) return state;
    return {
      streamingMessage: { ...state.streamingMessage, thinking },
    };
  }),

  finishStreaming: () => set((state) => {
    if (!state.streamingMessage) return state;
    return {
      messages: [...state.messages, state.streamingMessage as AgentMessage],
      streamingMessage: null,
      isStreaming: false,
    };
  }),

  clearMessages: () => set({ messages: [], streamingMessage: null, isStreaming: false }),

  addToolExecution: (toolCallId, execution) => set((state) => {
    const newMap = new Map(state.toolExecutions);
    newMap.set(toolCallId, execution);
    return { toolExecutions: newMap };
  }),

  updateToolExecution: (toolCallId, update) => set((state) => {
    const existing = state.toolExecutions.get(toolCallId);
    if (!existing) return state;
    const newMap = new Map(state.toolExecutions);
    newMap.set(toolCallId, { ...existing, ...update });
    return { toolExecutions: newMap };
  }),
}));
