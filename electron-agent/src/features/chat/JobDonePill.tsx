import { Briefcase } from 'lucide-react';
import { memo } from 'react';
import { NoticeSplitPill } from './NoticeSplitPill';

function JobDonePillInner({ content }: { content: string }) {
  return <NoticeSplitPill content={content} icon={Briefcase} testId="job-done-pill" />;
}

export const JobDonePill = memo(JobDonePillInner);
