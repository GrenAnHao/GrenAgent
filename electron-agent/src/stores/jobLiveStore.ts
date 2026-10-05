import { useEffect } from 'react';
import { create } from 'zustand';
import { onJobFrames, pi, type JobFrame, type JobLiveView } from '../lib/pi';

/** 卡片认 job 的凭据：进程内 id 重启后会复用，所以带上开始时间。 */
export interface JobRef {
  jobId: string;
  jobStartedAt: number;
}

export interface JobLiveEntry {
  /** loading：快照在路上；live：跟随中；missing：job 已不在（重启或清理），卡片回退到工具结果。 */
  state: 'loading' | 'live' | 'missing';
  job?: JobLiveView;
  text: string;
  /** text 末尾对应的绝对字节偏移，下一帧应从这里接上。 */
  next: number;
  /** 开头有输出已不在（注册表淘汰或界面截掉）。 */
  lossy: boolean;
  spillPaths?: string[];
}

/** 界面只留尾部，超出就截掉开头。 */
export const JOB_TEXT_CAP = 256 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function jobKey(ref: JobRef): string {
  return `${ref.jobId}@${ref.jobStartedAt}`;
}

function capText(text: string, lossy: boolean): { text: string; lossy: boolean } {
  if (text.length <= JOB_TEXT_CAP) return { text, lossy };
  const cut = text.slice(text.length - JOB_TEXT_CAP);
  const newline = cut.indexOf('\n');
  return { text: newline >= 0 && newline < 4096 ? cut.slice(newline + 1) : cut, lossy: true };
}

/**
 * 把一帧接到条目上。按字节偏移对齐：重叠的部分跳过（快照已经包含），断档返回 'gap' 让调用方重拉快照。
 */
export function applyFrame(entry: JobLiveEntry, frame: JobFrame): JobLiveEntry | 'gap' {
  let next: JobLiveEntry = { ...entry, job: frame.job };
  const delta = frame.delta;
  if (!delta || delta.next <= entry.next) return next;
  if (delta.from > entry.next) return 'gap';
  let text = delta.text;
  if (delta.from < entry.next) {
    const skip = entry.next - delta.from;
    text = decoder.decode(encoder.encode(text).subarray(skip));
  }
  const capped = capText(entry.text + text, entry.lossy);
  next = { ...next, text: capped.text, lossy: capped.lossy, next: delta.next };
  return next;
}

interface JobLiveState {
  entries: Record<string, JobLiveEntry>;
  ensure: (ref: JobRef) => void;
  refresh: (ref: JobRef) => Promise<void>;
  apply: (frames: JobFrame[]) => void;
  kill: (ref: JobRef) => Promise<void>;
}

let listening: Promise<unknown> | null = null;

function listen(): void {
  listening ??= onJobFrames((payload) => useJobLiveStore.getState().apply(payload.frames)).catch(() => {
    listening = null;
  });
}

export const useJobLiveStore = create<JobLiveState>((set, get) => ({
  entries: {},

  ensure: (ref) => {
    listen();
    if (get().entries[jobKey(ref)]) return;
    void get().refresh(ref);
  },

  refresh: async (ref) => {
    const key = jobKey(ref);
    const prev = get().entries[key];
    set((s) => ({
      entries: { ...s.entries, [key]: { ...(prev ?? { text: '', next: 0, lossy: false }), state: prev?.job ? 'live' : 'loading' } },
    }));
    let snapshot;
    try {
      snapshot = await pi.jobSnapshot(ref.jobId, ref.jobStartedAt);
    } catch {
      snapshot = null;
    }
    set((s) => {
      if (!snapshot) {
        const current = s.entries[key];
        // 跟随过的 job 被移除时保留最后的样子；从没见过的就是不在了。
        if (current?.job) return { entries: { ...s.entries, [key]: { ...current, state: 'live' } } };
        return { entries: { ...s.entries, [key]: { state: 'missing', text: '', next: 0, lossy: false } } };
      }
      const capped = capText(snapshot.text, snapshot.lossy);
      return {
        entries: {
          ...s.entries,
          [key]: {
            state: 'live',
            job: snapshot.job,
            text: capped.text,
            next: snapshot.next,
            lossy: capped.lossy,
            ...(snapshot.spillPaths ? { spillPaths: snapshot.spillPaths } : {}),
          },
        },
      };
    });
  },

  apply: (frames) => {
    const entries = get().entries;
    let changed: Record<string, JobLiveEntry> | null = null;
    const gaps: JobRef[] = [];
    for (const frame of frames) {
      const ref = { jobId: frame.job.id, jobStartedAt: frame.job.startedAt };
      const key = jobKey(ref);
      const entry = (changed ?? entries)[key];
      // 只跟随有卡片在看的 job；loading 中的帧由快照覆盖。
      if (!entry || entry.state !== 'live') continue;
      const next = applyFrame(entry, frame);
      if (next === 'gap') {
        gaps.push(ref);
        continue;
      }
      changed ??= { ...entries };
      changed[key] = next;
    }
    if (changed) set({ entries: changed });
    for (const ref of gaps) void get().refresh(ref);
  },

  kill: async (ref) => {
    await pi.jobKill(ref.jobId, ref.jobStartedAt);
  },
}));

/** 跟随一个后台 job：首次使用时拉快照，之后接 pi://jobs 帧。ref 为空时不做事。 */
export function useJobLive(ref: JobRef | null): JobLiveEntry | undefined {
  const key = ref ? jobKey(ref) : '';
  const ensure = useJobLiveStore((s) => s.ensure);
  useEffect(() => {
    if (ref) ensure(ref);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ensure]);
  return useJobLiveStore((s) => (key ? s.entries[key] : undefined));
}

export function __resetJobLiveForTest(): void {
  listening = null;
  useJobLiveStore.setState({ entries: {} });
}
