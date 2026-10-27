import { create } from 'zustand';

export type EnhancePromptStatus = 'idle' | 'streaming' | 'done' | 'error';

export interface EnhancePromptSlot {
  status: EnhancePromptStatus;
  preview: string;
  error: string;
  seq: number;
  awaitingContext: boolean;
  /** 当前这一步在做什么。流式期间浮层直接显示这句话。 */
  phase: string;
  source: string;
  /** 本次开始时间（ms）。浮层据此显示已等待时长，区分「模型慢」与「卡住」。 */
  startedAt: number;
}

interface EnhancePromptState {
  byWorkspace: Record<string, EnhancePromptSlot>;
  start: (workspace: string, opts?: { awaitingContext?: boolean; source?: string }) => number;
  setPhase: (workspace: string, seq: number, phase: string) => void;
  append: (workspace: string, seq: number, chunk: string) => void;
  finish: (workspace: string, seq: number, content: string) => void;
  fail: (workspace: string, seq: number, error: string) => void;
  cancel: (workspace: string) => void;
  clear: (workspace: string) => void;
}

const empty = (): EnhancePromptSlot => ({
  status: 'idle', preview: '', error: '', seq: 0, awaitingContext: false, phase: '', source: '', startedAt: 0,
});

function isStreamingSeq(cur: EnhancePromptSlot | undefined, seq: number): cur is EnhancePromptSlot {
  return Boolean(cur && cur.seq === seq && cur.status === 'streaming');
}

export const useEnhancePromptStore = create<EnhancePromptState>((set, get) => ({
  byWorkspace: {},
  start: (workspace, opts) => {
    const prev = get().byWorkspace[workspace];
    const seq = (prev?.seq ?? 0) + 1;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [workspace]: {
          status: 'streaming',
          preview: '',
          error: '',
          seq,
          awaitingContext: Boolean(opts?.awaitingContext),
          phase: opts?.awaitingContext ? '正在理解草稿' : '等待模型响应',
          source: opts?.source ?? '',
          startedAt: Date.now(),
        },
      },
    });
    return seq;
  },
  setPhase: (workspace, seq, phase) => {
    const cur = get().byWorkspace[workspace];
    if (!isStreamingSeq(cur, seq) || cur.phase === phase) return;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [workspace]: { ...cur, phase },
      },
    });
  },
  append: (workspace, seq, chunk) => {
    const cur = get().byWorkspace[workspace];
    if (!isStreamingSeq(cur, seq)) return;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [workspace]: { ...cur, preview: cur.preview + chunk, awaitingContext: false },
      },
    });
  },
  finish: (workspace, seq, content) => {
    const cur = get().byWorkspace[workspace];
    if (!isStreamingSeq(cur, seq)) return;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [workspace]: { ...cur, status: 'done', preview: content, awaitingContext: false, error: '' },
      },
    });
  },
  fail: (workspace, seq, error) => {
    const cur = get().byWorkspace[workspace];
    if (!isStreamingSeq(cur, seq)) return;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [workspace]: { ...cur, status: 'error', error, awaitingContext: false },
      },
    });
  },
  cancel: (workspace) => {
    const cur = get().byWorkspace[workspace];
    if (!cur) return;
    // seq 必须 +1：cancel/clear 后若还没 start，主进程迟到的 delta 仍带着旧 seq，匹配上就会写进空槽。
    set({ byWorkspace: { ...get().byWorkspace, [workspace]: { ...empty(), seq: cur.seq + 1 } } });
  },
  clear: (workspace) => {
    get().cancel(workspace);
  },
}));
