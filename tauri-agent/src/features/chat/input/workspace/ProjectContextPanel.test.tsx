import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectContextPanel } from './ProjectContextPanel';

describe('ProjectContextPanel', () => {
  it('shows self-owned module context without external service state', () => {
    render(<ProjectContextPanel active workspace="C:/repo" />);
    expect(screen.getByRole('region', { name: 'repo 项目上下文' })).toBeTruthy();
    expect(screen.getByText(/Agent 数据由本地 Runtime 管理/)).toBeTruthy();
  });
});
