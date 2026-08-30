import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ConnectionSettings', () => ({ ConnectionSettings: () => <div data-testid="connection-settings" /> }));
vi.mock('./AssetCenter', () => ({ AssetCenter: () => <div data-testid="asset-center" /> }));
vi.mock('./AgentLoadout', () => ({ AgentLoadout: () => <div data-testid="agent-loadout" /> }));

import { TencentdbCenter } from './TencentdbCenter';

afterEach(cleanup);

describe('TencentdbCenter', () => {
  it('does not expose the retired migration wizard', () => {
    render(<TencentdbCenter />);
    expect(screen.getByTestId('connection-settings')).toBeTruthy();
    expect(screen.queryByText('迁移向导')).toBeNull();
    expect(screen.getByText('知识注入规则')).toBeTruthy();
    expect(screen.queryByText('Agent 装备')).toBeNull();
  });
});
