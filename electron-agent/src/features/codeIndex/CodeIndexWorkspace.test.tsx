import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const invoked: string[] = [];
vi.mock('../../platform/runtime', () => ({
  invoke: async (command: string) => {
    invoked.push(command);
    if (command === 'agentData_tasks_list') return { items: [], activeCount: 0, pollingCount: 0 };
    if (command === 'agentData_code_projects') return [{ workspace: 'D:/repo', indexed: true }];
    if (command === 'agentData_code_status') return { workspace: 'D:/repo', connected: true, indexed: true, state: 'ready', files: 1, nodes: 2, edges: 1 };
    if (command === 'read_file') return '';
    return null;
  },
  listen: async () => () => {},
  openPath: async () => {},
}));

import { CodeIndexWorkspace } from './CodeIndexWorkspace';

describe('code index module entry', () => {
  it('renders the code index without going through the Agent Data workbench', async () => {
    render(<CodeIndexWorkspace visible initialProject="D:/repo" />);
    await waitFor(() => expect(screen.getByText('代码索引')).toBeInTheDocument(), { timeout: 20000 });
    // 只请求代码索引自己的数据，不请求工作台的概览/审计/诊断/资料 Wiki。
    expect(invoked).toContain('agentData_code_projects');
    expect(invoked).not.toContain('agentData_overview');
    expect(invoked).not.toContain('agentData_audit_query');
    expect(invoked).not.toContain('agentData_diagnostics_check');
    expect(invoked).not.toContain('agentData_wiki_list');
  });
});
