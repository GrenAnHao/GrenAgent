import { createStaticStyles, cssVar } from 'antd-style';
import { CircleStop } from 'lucide-react';
import { memo, useCallback, useState, type MouseEvent } from 'react';
import { TerminalBlock } from '../chat/conv/TerminalBlock';
import { useJobLive, useJobLiveStore, type JobLiveEntry, type JobRef } from '../../stores/jobLiveStore';
import { jobEndedBadly, jobFooterText, jobIsLive, jobStatusLabel } from './bashCardModel';

const styles = createStaticStyles(({ css }) => ({
  label: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  stop: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 4px;
    padding: 0 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
    font-size: 12px;
    line-height: 18px;

    &:hover:not(:disabled) {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorError};
    }

    &:disabled {
      cursor: default;
      opacity: 0.5;
    }
  `,
}));

/** 开头被截掉时在输出顶上说明一句，有完整日志就点名。 */
export function jobDisplayText(entry: JobLiveEntry): string {
  if (!entry.lossy) return entry.text;
  const spill = entry.spillPaths?.[0];
  return `… 前面的输出已不在内存${spill ? `，完整日志：${spill}` : ''}\n${entry.text}`;
}

/**
 * 后台 bash job 的命令卡：run_in_background 起的，或前台等待超时转后台的。
 * 输出跟随 pi://jobs 实时增长，底栏给状态和停止；job 已不在（应用重启）就回退到工具结果文本。
 */
export const BashJobTerminal = memo(function BashJobTerminal({
  jobRef,
  command,
  cwd,
  resultText,
}: {
  jobRef: JobRef;
  command: string;
  cwd?: string;
  resultText: string;
}) {
  const entry = useJobLive(jobRef);
  const kill = useJobLiveStore((s) => s.kill);
  const [stopping, setStopping] = useState(false);
  const job = entry?.job;

  const stop = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      setStopping(true);
      void kill(jobRef).catch(() => setStopping(false));
    },
    [jobRef, kill],
  );

  if (!entry || entry.state === 'loading') {
    return <TerminalBlock command={command} cwd={cwd} output={resultText} running />;
  }
  if (entry.state === 'missing' || !job) {
    return (
      <TerminalBlock
        command={command}
        cwd={cwd}
        output={resultText}
        footer={<span className={styles.label} data-testid="bash-job-missing">后台任务 {jobRef.jobId} 已不在（应用重启或已清理）</span>}
      />
    );
  }

  const live = jobIsLive(job);
  const output = entry.text || entry.lossy ? jobDisplayText(entry) : live ? '' : resultText;
  return (
    <TerminalBlock
      command={command}
      cwd={cwd}
      output={output}
      running={live}
      isError={!live && jobEndedBadly(job)}
      footer={
        <>
          <span className={styles.label} data-testid="bash-job-status" title={job.detail}>
            {jobFooterText(job)}
          </span>
          {job.status === 'running' ? (
            <button type="button" className={styles.stop} onClick={stop} disabled={stopping} data-testid="bash-job-stop">
              <CircleStop size={12} aria-hidden />
              {stopping ? '正在停止' : '停止'}
            </button>
          ) : null}
        </>
      }
    />
  );
});

/** 折叠行上的状态：后台运行中 / 已完成 / 已停止…… */
export const BashJobMeta = memo(function BashJobMeta({ jobRef }: { jobRef: JobRef }) {
  const entry = useJobLive(jobRef);
  if (!entry?.job) return null;
  return <span data-testid="bash-job-meta">{jobStatusLabel(entry.job)}</span>;
});
