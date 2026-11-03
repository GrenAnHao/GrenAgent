import { Briefcase } from 'lucide-react';
import { memo, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useJobLive, useJobLiveStore, type JobLiveEntry, type JobRef } from '../../stores/jobLiveStore';
import { AgentIdentityContext } from './AgentCommunicationCard';
import { MessageTimelineContext } from './MessageTimelineContext';
import { TaskNoticeCard, TaskNoticeNote, TaskNoticeOutput, TaskNoticeText } from './TaskNoticeCard';
import {
  applyJobLive,
  durationLabel,
  findJobStartedAt,
  jobOutputText,
  parseJobNotice,
  pickJobEntry,
  type JobNoticeModel,
} from './taskNoticeModel';

const HEAD = /^Background job (\S+) \((\w+): ([\s\S]*)\) finished (\w+)\.$/;

/**
 * 通知首行是写给模型的英文整句，界面换成「后台任务 <id> <状态> · <短描述>」。
 * 保留这个导出：旧调用方和历史测试仍按首行取值。
 */
export function jobNoticeTitle(firstLine: string): string {
  return parseJobNotice(firstLine).title;
}

/**
 * 通知 details 只有 jobId，没有开始时间；快照按 (id, startedAt) 认任务。
 * 开始时间从同一时间线的 bash 工具结果（details.jobStartedAt）找回；
 * 会话里已经跟随过这个 job 的卡片也会把开始时间留在 jobLiveStore 里。
 */
function resolveJobRef(
  jobId: string | undefined,
  timestamp: number | undefined,
  startedAt: number | undefined,
  entries: Record<string, JobLiveEntry>,
): JobRef | null {
  if (!jobId) return null;
  if (startedAt !== undefined) return { jobId, jobStartedAt: startedAt };
  const entry = pickJobEntry(entries, jobId, timestamp);
  if (entry?.job?.startedAt !== undefined) return { jobId, jobStartedAt: entry.job.startedAt };
  return null;
}

/** 时间线里能提供 jobStartedAt 的条目：单独的 tool 消息，或 turn 里的 tool 段。 */
type TimelineSource = {
  kind: string;
  result?: unknown;
  segments?: readonly { kind: string; result?: unknown }[];
};

function timelineToolResults(messages: readonly TimelineSource[]): { kind: string; result?: unknown }[] {
  const out: { kind: string; result?: unknown }[] = [];
  for (const message of messages) {
    if (message.kind === 'tool') {
      out.push({ kind: 'tool', result: message.result });
      continue;
    }
    if (message.kind !== 'turn' || !Array.isArray(message.segments)) continue;
    for (const segment of message.segments) {
      if (segment?.kind === 'tool') out.push({ kind: 'tool', result: segment.result });
    }
  }
  return out;
}

/**
 * 从同一时间线的消息里找这条通知对应的 bash 启动结果。
 * 优先用 ChatMessageItems 提供的 MessageTimelineContext（父/子会话各自的真实对话），
 * 其次订阅 store（无 timeline 的直调 / harness）；子会话不读父 store 冒充自己的数据。
 * 通知可能先于启动结果到达（或历史分段载入）：store 路径用订阅而不是一次快照。
 */
function useTimelineJobStartedAt(jobId: string | undefined, timestamp: number | undefined): number | undefined {
  const timeline = useContext(MessageTimelineContext);
  const ctx = useOptionalAgentStoreContext();
  const childTranscript = useContext(AgentIdentityContext) !== undefined;
  const useStore = childTranscript ? undefined : ctx?.store?.useStore;
  const getSnapshot = useCallback(() => {
    if (!useStore || !jobId) return undefined;
    try {
      return findJobStartedAt(useStore.getState().messages, jobId, timestamp);
    } catch {
      return undefined;
    }
  }, [useStore, jobId, timestamp]);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!useStore) return () => {};
      try {
        return useStore.subscribe(onChange);
      } catch {
        return () => {};
      }
    },
    [useStore],
  );
  const fromStore = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const fromTimeline = useMemo(
    () => (timeline ? findJobStartedAt(timelineToolResults(timeline), jobId, timestamp) : undefined),
    [timeline, jobId, timestamp],
  );
  return fromTimeline ?? fromStore;
}

/** 已结算的通知不因迟到的运行中快照退回运行；快照的终态原因、起止时间优先。 */
function withLive(model: JobNoticeModel, entry: JobLiveEntry | undefined): JobNoticeModel {
  if (!entry?.job) return model;
  return applyJobLive(model, entry.job);
}

function OutputSection({ entry }: { entry: JobLiveEntry | undefined }) {
  if (!entry) return null;
  if (entry.state === 'loading') {
    return <TaskNoticeNote text="正在读取任务的留存输出…" testId="job-done-loading" />;
  }
  if (entry.state === 'missing' || !entry.job) {
    return <TaskNoticeNote text="任务记录已清理，取不到留存输出；上面是结算通知里的终态。" testId="job-done-missing" />;
  }
  const { text, lossyNote } = jobOutputText(entry);
  if (!text.trim()) {
    // 空尾部不等于没输出：开头（甚至全部）可能已被丢弃/清理，此时只说已知的缺口。
    if (lossyNote) {
      return (
        <TaskNoticeNote
          text={`${lossyNote}；尾部也没有可显示的留存内容`}
          testId="job-done-lossy-empty"
        />
      );
    }
    return <TaskNoticeNote text="任务没有留下输出。" testId="job-done-empty-output" />;
  }
  return <TaskNoticeOutput label="留存输出" text={text} lossyNote={lossyNote} testId="job-done-output" />;
}

function JobDonePillInner({ content, details, timestamp }: { content: string; details?: unknown; timestamp?: number }) {
  const model = useMemo(() => parseJobNotice(content, details, timestamp), [content, details, timestamp]);
  const fromTimeline = useTimelineJobStartedAt(model.id, timestamp);
  const entries = useJobLiveStore((s) => s.entries);
  const ref = useMemo(
    () => resolveJobRef(model.id, timestamp, fromTimeline, entries),
    [model.id, timestamp, fromTimeline, entries],
  );
  const entry = useJobLive(ref);
  const view = useMemo(() => withLive(model, entry), [model, entry]);

  // 纯退出码原因已经在头部标题里（失败 · 退出码 N），展开体不重复同句；
  // 带了 error / 沙箱 / 取消等原因的仍完整显示。
  const pureExit = view.detailRaw !== undefined && /^exit code: -?\d+$/i.test(view.detailRaw.trim());
  const reason = pureExit ? undefined : view.detail;
  // 展开后只补头部没有的事实：完整原因、留存输出、数据缺口（最多一句）。
  const gap = !ref ? '通知里没有任务开始时间，取不到留存输出与耗时。' : undefined;
  const hasBody =
    Boolean(reason) || Boolean(ref) || Boolean(gap) || Boolean(view.liveNote) || Boolean(view.extra);

  return (
    <TaskNoticeCard
      icon={Briefcase}
      title={view.title}
      tone={view.tone}
      statusText={view.statusText}
      outcome={view.outcome}
      timestamp={timestamp}
      duration={durationLabel(view.durationMs)}
      data-testid="job-done-pill"
    >
      {hasBody ? (
        <>
          {reason ? <TaskNoticeNote text={`终态原因：${reason}`} testId="job-done-detail" /> : null}
          {view.liveNote ? <TaskNoticeNote text={view.liveNote} testId="job-done-live-note" /> : null}
          {gap ? <TaskNoticeNote text={gap} testId="job-done-unresolved" /> : null}
          <OutputSection entry={ref ? entry : undefined} />
          {view.extra ? (
            <TaskNoticeText label="通知附加内容" testId="job-done-extra">
              {view.extra}
            </TaskNoticeText>
          ) : null}
        </>
      ) : null}
    </TaskNoticeCard>
  );
}

export const JobDonePill = memo(JobDonePillInner);

/** 旧的模型通知格式仍按首行认领域；保留供兼容测试引用。 */
export const jobNoticeHead = HEAD;
