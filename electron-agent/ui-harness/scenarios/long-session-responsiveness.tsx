import { App } from 'antd';
import { InlineQuestionCard } from '../../src/features/chat/InlineQuestionCard';
import type { AgentEvent, AgentMessage, PiEventEnvelope } from '../../src/lib/pi';
import { AgentStoreContext } from '../../src/stores/AgentStoreContext';
import { createAgentStore } from '../../src/stores/agent';
import { useInlineQuestionStore } from '../../src/stores/inlineQuestionStore';
import { exposeActions, installBridge } from '../stubs';

const PROJECTS = ['/long-session-a', '/long-session-b'];
const pathFor = (workspace: string) => workspace + '/session.jsonl';
const ROWS = 6000;
const listeners = new Set<(message: { payload: PiEventEnvelope }) => void>();
const encoder = new TextEncoder();
const amounts: Record<string, { initial: number; full: number; patch: number; batches: number; metadata: number }> = {};
let revision = 0;
let replies = 0;
let draftDeletes = 0;
let clickedAt = 0;
let closedAfterMs = 0;
let repeat: ReturnType<typeof setInterval> | undefined;
let tick = 0;

installBridge({
  subscribe: async (channel: string, listener: (message: { payload: PiEventEnvelope }) => void) => {
    if (channel === 'pi://event') listeners.add(listener);
    return () => listeners.delete(listener);
  },
  invoke: async (command: string, args: Record<string, unknown>) => {
    const state = amounts[String(args.workspace)];
    switch (command) {
      case 'ui_history_write': {
        const bytes = encoder.encode(String(args.content)).byteLength;
        if (!state.initial) state.initial = bytes;
        else state.full += bytes;
        return String(++revision);
      }
      case 'ui_history_patch':
        state.patch += encoder.encode(String(args.content)).byteLength;
        state.batches += 1;
        return String(++revision);
      case 'agent_get_messages':
        if (!args.userEntriesOnly) throw new Error('full history pulled during streaming');
        state.metadata += 1;
        return { messages: [{ role: 'user', entryId: 'user-accepted', timestamp: 42 }] };
      case 'ask_user_draft_write': return undefined;
      case 'ask_user_draft_delete': draftDeletes += 1; return new Promise(() => {});
      case 'extension_ui_respond':
        replies += 1;
        return new Promise(resolve => setTimeout(resolve, 40));
      default: throw new Error(`unstubbed invoke: ${command}`);
    }
  },
});

const stores = PROJECTS.map(workspace => createAgentStore(workspace));
const [workspace] = PROJECTS;
const context = { workspace, store: stores[0]!, workspaceReady: true, setWorkspaceReady: () => {}, appBooted: true };
function emit(target: string, event: AgentEvent): void {
  for (const listener of listeners) listener({ payload: { workspace: target, sessionPath: pathFor(target), source: 'interactive', event } });
}
function seed(index: number): void {
  const target = PROJECTS[index]!;
  amounts[target] = { initial: 0, full: 0, patch: 0, batches: 0, metadata: 0 };
  const decoder = new TextDecoder();
  const block = new Uint8Array(12 * 1024).fill(65 + index);
  const rows = Array.from({ length: ROWS }, (_, i): AgentMessage => {
    block[0] = 65 + i % 20;
    block[block.length - 1] = 65 + (i >> 4) % 20;
    return { role: 'assistant', entryId: `entry-${i}`, content: [{ type: 'text', text: decoder.decode(block) }], timestamp: i + 100 };
  });
  stores[index]!.loadMessages(rows, { force: true, sessionPath: pathFor(target) });
  stores[index]!.pushUserMessage('新任务');
  void stores[index]!.syncEntryIdsAfterAccept();
}
function begin(parallel: boolean): void {
  const active = parallel ? PROJECTS : PROJECTS.slice(0, 1);
  for (const target of active) emit(target, { type: 'agent_start' });
  repeat = setInterval(() => {
    const id = ++tick;
    for (const target of active) {
      const message: AgentMessage = { role: 'assistant', timestamp: 10000 + id, content: [{ type: 'text', text: `流式结果 ${id}` }] };
      emit(target, { type: 'message_start', message });
      emit(target, { type: 'message_end', message });
    }
  }, 55);
  useInlineQuestionStore.getState().setRequest({
    workspace, id: `request-${tick}`, toolCallId: 'call-q', sessionPath: pathFor(workspace), mode: 'live',
    data: { kind: 'questions', id: 'q', questions: [{ id: 'q', title: '继续处理这批结果？', options: [{ id: 'yes', label: '继续' }, { id: 'no', label: '先等等' }] }] },
  });
}

document.addEventListener('click', event => {
  const target = event.target;
  if (target instanceof Element && target.closest('[data-testid="inline-question-continue"]')) {
    clickedAt = event.timeStamp;
    closedAfterMs = 0;
  }
}, true);
new MutationObserver(() => {
  if (clickedAt && !closedAfterMs && !document.querySelector('[data-testid="inline-question"]')) closedAfterMs = performance.now() - clickedAt;
}).observe(document.body, { childList: true, subtree: true });

exposeActions({
  seed, begin,
  stop: () => { clearInterval(repeat); },
  metrics: () => ({
    amounts, replies, draftDeletes, closedAfterMs, tick,
    rows: stores.map(store => store.useStore.getState().messages.length),
  }),
});

export default function LongSessionResponsiveness() {
  return (
    <App>
      <AgentStoreContext.Provider value={context}>
        <div style={{ maxWidth: 700, margin: '48px auto' }}><InlineQuestionCard /></div>
      </AgentStoreContext.Provider>
    </App>
  );
}
