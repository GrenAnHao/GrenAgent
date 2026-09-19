import { fireEvent, render, screen } from '@testing-library/react';
import { Bot } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ConvStrip } from './ConvStrip';

describe('ConvStrip', () => {
  it('renders title/role and toggles', () => {
    const onToggle = vi.fn();
    render(
      <ConvStrip
        status="done"
        icon={Bot}
        title="子代理 #1"
        role="审查改动"
        open={false}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByText('子代理 #1')).toBeTruthy();
    expect(screen.getByText('审查改动')).toBeTruthy();
    fireEvent.click(screen.getByText('子代理 #1'));
    expect(onToggle).toHaveBeenCalled();
  });

  it('does not toggle when clicking actions', () => {
    const onToggle = vi.fn();
    render(
      <ConvStrip
        status="running"
        icon={Bot}
        title="子代理"
        onToggle={onToggle}
        actions={<button>停止</button>}
      />,
    );
    fireEvent.click(screen.getByText('停止'));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('renders line2 and model; stop on hover calls onStop not toggle', () => {
    const onToggle = vi.fn();
    const onStop = vi.fn();
    render(
      <ConvStrip
        status="running"
        icon={Bot}
        title="子代理 #1"
        model="gpt-5.3-codex"
        line2="第 3 步 · 正在读取 x.rs"
        onStop={onStop}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByText('gpt-5.3-codex')).toBeTruthy();
    expect(screen.getByText('第 3 步 · 正在读取 x.rs')).toBeTruthy();
    fireEvent.click(screen.getByTitle('停止子代理'));
    expect(onStop).toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('ellipsis-truncates a long role instead of expanding the strip', () => {
    render(
      <div style={{ width: 160 }}>
        <ConvStrip
          status="done"
          icon={Bot}
          title="子代理 #3"
          role="任务: 本工作目录 (cwd) 目前是很长很长很长很长很长"
          line2="已完成 · 任务: 本工作目录 (cwd) 目前是很长很长很长"
        />
      </div>,
    );
    const role = screen.getByTestId('conv-strip-role');
    expect(role).toHaveStyle({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    expect(role.getAttribute('title')).toContain('本工作目录');
  });
});
