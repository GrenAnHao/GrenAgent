import { TaskDetailDrawer } from '../../src/features/agentData/TaskDetailDrawer';
import type { TaskDetail } from '../../electron/agentData/operationsContracts';
import { installBridge } from '../stubs';

const detail: TaskDetail = {
  ref: { source: 'user', id: 'native:op' }, key: 'user:native:op', kind: 'repoWiki.native', label: 'Repo Wiki 文档生成', status: 'completed',
  workspace: 'D:/example', resource: { type: 'repoWiki', id: 'D:/example', language: 'zh' }, cancellationRequested: false,
  createdAt: 1, updatedAt: 2, capabilities: { cancel: false, retry: false, remove: true }, events: [],
  nativeWiki: { engine: 'qoder-wiki-local-v1', operationId: 'operation-1', revision: 3,
    publication: { id: 'publication-1', coverage: { published: 9, readable: 10, failed: ['a', 'b'], partial: true }, projection: { status: 'error' } } },
};
installBridge({ invoke: async (command: string) => { if (command === 'agentData_tasks_read') return detail; throw new Error(`unexpected ${command}`); } });
export default function NativeTaskSummaryScenario() {
  return <TaskDetailDrawer taskRef={detail.ref} onClose={() => {}} />;
}
