import { Briefcase } from 'lucide-react';
import { memo } from 'react';
import { NoticeSplitPill } from './NoticeSplitPill';

const STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  killed: '已终止',
};

const HEAD = /^Background job (\S+) \((\w+): ([\s\S]*)\) finished (\w+)\.$/;

/**
 * 通知首行是写给模型的英文整句，里面嵌着整段任务原文，直接当标题会撑成好几行。
 * 界面上换成「后台任务 subagent-10 失败 · 任务首句」，长了由 MutedLine 单行省略。
 */
export function jobNoticeTitle(firstLine: string): string {
  const match = HEAD.exec(firstLine.trim());
  if (!match) return firstLine;
  const [, id, , label, status] = match;
  const state = STATUS_LABEL[status] ?? status;
  const task = label.trim();
  return task ? `后台任务 ${id} ${state} · ${task}` : `后台任务 ${id} ${state}`;
}

function JobDonePillInner({ content }: { content: string }) {
  return <NoticeSplitPill content={content} icon={Briefcase} testId="job-done-pill" formatTitle={jobNoticeTitle} />;
}

export const JobDonePill = memo(JobDonePillInner);
