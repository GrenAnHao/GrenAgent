import { jobs } from '../../../extensions/jobs/service.js';
import {
  createJobObserver,
  jobLiveSnapshot,
  killJobForUser,
  type JobFrame,
  type JobLiveSnapshot,
} from '../../../extensions/jobs/observer.js';

/**
 * 后台 job 的界面通道：jobs 注册表与扩展同在主进程（同一模块实例），这里订阅它的事件，
 * 合并成帧经 `pi://jobs` 广播；晚加入的卡片用 job_snapshot 拿保留输出，再接后续帧。
 * 只读非消耗偏移，不碰模型的读取游标和完成通知。
 */
export interface JobsBridgeService {
  snapshot(jobId: string, startedAt: number): JobLiveSnapshot | null;
  kill(jobId: string, startedAt: number): 'requested' | 'already-finished' | 'not-found';
}

export interface JobsBridge extends JobsBridgeService {
  stop(): void;
}

export function startJobsBridge(
  broadcast: (event: string, payload: { frames: JobFrame[] }) => void,
  opts: { workspaceForCwd?: (cwd: string) => string; intervalMs?: number } = {},
): JobsBridge {
  // job 记的是扩展的 ctx.cwd；界面按 AgentStore 的 workspace 认。对上活 handle 就换成 handle.workspace。
  const mapWorkspace = (frame: JobFrame): JobFrame => {
    const mapped = opts.workspaceForCwd?.(frame.job.workspace);
    return mapped && mapped !== frame.job.workspace ? { ...frame, job: { ...frame.job, workspace: mapped } } : frame;
  };
  const observer = createJobObserver(
    jobs,
    (frames) => broadcast('pi://jobs', { frames: frames.map(mapWorkspace) }),
    opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {},
  );
  return {
    snapshot: (jobId, startedAt) => jobLiveSnapshot(jobs, jobId, startedAt) ?? null,
    kill: (jobId, startedAt) => killJobForUser(jobs, jobId, startedAt),
    stop: () => observer.stop(),
  };
}
