import { Bot } from 'lucide-react';
import { memo, useMemo } from 'react';
import {
  TaskNoticeCard,
  TaskNoticeDiagnostic,
  TaskNoticeNote,
  TaskNoticeText,
} from './TaskNoticeCard';
import { parseSubagentSettled } from './taskNoticeModel';

/**
 * subagent-settled（extensions/multi-agent/settlement-notice.ts）：
 * 首行是写给模型的英文摘要，正文是子代理的收尾消息，失败时另有一行 Diagnostic。
 * 卡片直接写出状态、子代理身份和完整收尾正文；诊断单独一节，超时 / 中止 / 失败互相区分。
 */
function SubagentSettledPillInner({
  content,
  details,
  timestamp,
}: {
  content: string;
  details?: unknown;
  timestamp?: number;
}) {
  const model = useMemo(() => parseSubagentSettled(content, details), [content, details]);
  const failed = model.outcome === 'failed' || model.outcome === 'timeout';
  const hasClosing = model.closing.trim().length > 0;
  return (
    <TaskNoticeCard
      icon={Bot}
      title={model.title}
      tone={model.tone}
      statusText={model.statusText}
      outcome={model.outcome}
      timestamp={timestamp}
      data-testid="subagent-settled-pill"
    >
      {hasClosing ? (
        <TaskNoticeText label={model.outcome === 'aborted' ? '已保留的回复' : failed ? '已有的输出' : '收尾消息'} testId="subagent-settled-body">
          {model.closing}
        </TaskNoticeText>
      ) : null}
      {model.diagnosticText ? (
        <TaskNoticeDiagnostic
          label={model.outcome === 'timeout' ? '超时原因' : '诊断'}
          text={model.diagnosticText}
          testId="subagent-settled-diagnostic"
        />
      ) : null}
      {/* 有身份、没正文也要能展开：一句说明，不留空白展开块。 */}
      {!hasClosing && !model.diagnosticText ? (
        <TaskNoticeNote text="结算通知未附结果正文。" testId="subagent-settled-no-body" />
      ) : null}
      {model.note ? <TaskNoticeNote text={model.note} testId="subagent-settled-note" /> : null}
      {model.extra ? (
        <TaskNoticeText label="通知附加内容" testId="subagent-settled-extra">
          {model.extra}
        </TaskNoticeText>
      ) : null}
    </TaskNoticeCard>
  );
}

export const SubagentSettledPill = memo(SubagentSettledPillInner);
