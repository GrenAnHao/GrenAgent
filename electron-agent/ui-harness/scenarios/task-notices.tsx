import { useMemo, useState } from 'react';
import { applyEvent, initialAgentState, messagesFromAgent } from '../../src/stores/agentReducer';
import type { AgentMessage, JobFrame, JobLiveSnapshot } from '../../src/lib/pi';
import { groupMessages } from '../../src/features/chat/groupMessages';
import { renderMessageBody } from '../../src/features/chat/ChatMessageItems';
import { MessageTimelineContext } from '../../src/features/chat/MessageTimelineContext';
import { formatSettlementNotice } from '@extensions/multi-agent/settlement-notice';
import { exposeActions, installBridge, track } from '../stubs';

const snapshots = new Map<string, JobLiveSnapshot>();
const handlers = new Set<(event: { payload: { frames: JobFrame[] } }) => void>();
installBridge({
  invoke: async (command: string, args: { jobId: string; startedAt: number }) => {
    if (command !== 'job_snapshot') throw new Error(`unexpected command: ${command}`);
    track(`snapshot:${args.jobId}`);
    const snapshot = snapshots.get(args.jobId);
    return snapshot?.job.startedAt === args.startedAt ? snapshot : null;
  },
  subscribe: async (event: string, handler: (event: { payload: { frames: JobFrame[] } }) => void) => {
    if (event !== 'pi://jobs') throw new Error(`unexpected subscription: ${event}`);
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
});

const history: AgentMessage[] = [];
function job(id: string, status: string, detail: string, output: string, startedAt: number, present = true, withOrigin = true) {
  if (withOrigin) history.push(
    { role: 'assistant', content: [{ type: 'toolCall', id: `call-${id}`, name: 'bash', arguments: { command: 'npm run test:unit', description: '验证单元测试' } }] } as AgentMessage,
    { role: 'toolResult', toolCallId: `call-${id}`, toolName: 'bash', content: [], details: { jobId: id, jobStartedAt: startedAt } } as AgentMessage,
  );
  history.push({ role: 'custom', customType: 'job-done', display: true, timestamp: 40000,
    content: `Background job ${id} (bash: npm run test:unit) finished ${status}.\n[status: ${status}, ${detail}]\nRead its output with job_output.`,
    details: { jobId: id, kind: 'bash', status },
  } as unknown as AgentMessage);
  if (present) snapshots.set(id, {
    job: { id, kind: 'bash', label: '验证单元测试', owner: 'ui-task-notices', workspace: 'ui-task-notices', status: status as 'completed', detail, startedAt, finishedAt: startedAt + 3500 },
    text: output, next: new TextEncoder().encode(output).length, lossy: false,
  });
}
job('bash-ok', 'completed', 'exit code: 0', 'PASS 18 tests\nreport: output/results.json\n', 1000);
job('bash-exit', 'completed', 'exit code: 1', 'FAIL a.test.ts\nExpected 1, received 2\n', 2000);
job('bash-failed', 'failed', 'runner unavailable', '', 3000);
job('bash-cancel', 'killed', 'killed before exit; cancelled by the user', 'partial output before cancellation', 4000);
job('bash-timeout', 'failed', 'hard timeout after 15s', 'partial output before timeout', 5000);
job('bash-missing', 'completed', 'exit code: 0', '', 6000, false);
job('bash-stale', 'completed', 'exit code: 0', 'retained terminal output', 7000);
const stale = snapshots.get('bash-stale')!;
snapshots.set('bash-stale', { ...stale, job: { ...stale.job, status: 'running', finishedAt: undefined } });
job('bash-unknown', 'unrecognized', 'no structured outcome', '', 8000, false, false);
job('bash-unresolved', 'completed', 'exit code: 0', '', 9000, false, false);

function child(childId: string, stopReason: 'completed' | 'error' | 'aborted', output: string, diagnostic?: string) {
  const notice = formatSettlementNotice({ childId, stopReason, output, diagnostic });
  history.push({ role: 'custom', customType: 'subagent-settled', content: notice.content, details: { childId, stopReason }, display: true, timestamp: 41000 } as unknown as AgentMessage);
}
child('sa-done', 'completed', '## 结果\n\n已修复 `date.ts`。\n\nDiagnostic: this is quoted output, not a timeout.');
child('sa-error', 'error', '已产出的部分结果。', 'uncaught error: boom');
child('sa-abort', 'aborted', '审查工作已给出最终报告。');
child('sa-timeout', 'error', '已保存部分结果。', 'hard timeout after 30s');
child('sa-long', 'completed', `${Array.from({ length: 70 }, (_, i) => `第 ${i + 1} 行：完整输出正文。`).join('\n\n')}\n\n最后一行仍然保留。`);
history.push({ role: 'custom', customType: 'subagent-settled', content: '', details: { childId: 'sa-empty', stopReason: 'error' }, display: true, timestamp: 42000 } as unknown as AgentMessage);

let push: () => void = () => {};
exposeActions({
  pushLive: () => push(),
  staleFrame: () => { for (const handler of handlers) handler({ payload: { frames: [{ job: snapshots.get('bash-stale')!.job }] } }); },
});

export default function TaskNotices() {
  const [state, setState] = useState(() => ({ ...initialAgentState(), messages: messagesFromAgent(history) }));
  push = () => {
    const message = { role: 'custom', customType: 'subagent-settled', content: formatSettlementNotice({ childId: 'sa-live', stopReason: 'completed', output: '实时收尾结果。' }).content, details: { childId: 'sa-live', stopReason: 'completed' }, display: true, timestamp: 43000 };
    setState((previous) => applyEvent(applyEvent(previous, { type: 'message_start', message } as never), { type: 'message_end', message } as never));
  };
  const display = useMemo(() => groupMessages(state.messages), [state.messages]);
  return <MessageTimelineContext.Provider value={display}>
    <div id="task-notices-scroll" style={{ height: '100vh', overflow: 'auto', background: 'var(--gren-content-bg)' }}>
      <div id="task-notices" style={{ width: 'min(820px, 100%)', margin: '0 auto', padding: '24px 16px', boxSizing: 'border-box' }}>
        {display.filter((message) => message.kind === 'notice').map((message) => {
          const details = message.kind === 'notice' ? message.details : undefined;
          return <div key={message.id} data-case={String(details?.jobId ?? details?.childId ?? '')} style={{ marginBottom: 8 }}>
            {renderMessageBody(message, new Map(), new Set())}
          </div>;
        })}
      </div>
    </div>
  </MessageTimelineContext.Provider>;
}
