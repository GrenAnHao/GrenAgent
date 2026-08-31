// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditDiagnosticsPanel } from './AuditDiagnosticsPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { audit: vi.fn(), diagnostics: vi.fn() },
}));
import { agentDataApi } from '../../lib/agentData';

describe('AuditDiagnosticsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentDataApi.audit).mockResolvedValue([{
      id: 'audit-1', action: 'config.update', createdAt: 1, detail: { apiKey: 'secret-value', nested: { token: 'token-value' }, module: 'memory' },
    }]);
    vi.mocked(agentDataApi.diagnostics).mockResolvedValue({ jobs: { total: 2, failed: 1 }, auditEvents: 3 });
  });
  afterEach(cleanup);

  it('renders audit events and redacts sensitive detail fields', async () => {
    render(<AuditDiagnosticsPanel />);
    expect(await screen.findByText('config.update')).toBeTruthy();
    expect(screen.getAllByText(/[redacted]/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/secret-value|token-value/)).toBeNull();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('shows a retry action when diagnostics fail', async () => {
    vi.mocked(agentDataApi.diagnostics).mockRejectedValueOnce(new Error('diagnostics unavailable'));
    render(<AuditDiagnosticsPanel />);
    expect((await screen.findByRole('alert')).textContent).toContain('diagnostics unavailable');
    fireEvent.click(screen.getByRole('button', { name: '重试诊断' }));
    await waitFor(() => expect(agentDataApi.diagnostics).toHaveBeenCalledTimes(2));
  });
});
