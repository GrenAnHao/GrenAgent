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
    expect(screen.getByTestId('conv-strip-model')).toHaveTextContent('gpt-5.3-codex');
    expect(screen.getByTestId('conv-strip-model').className).toMatch(/ant-tag/);
    expect(screen.getByText('第 3 步 · 正在读取 x.rs')).toBeTruthy();
    const stop = screen.getByTitle('停止子代理');
    expect(stop.getAttribute('data-role')).toBe('run-stop');
    const css = Array.from(document.querySelectorAll('style'))
      .map((node) => node.textContent ?? '')
      .join('\n');
    expect(css).toContain("[data-role='run-stop']");
    expect(css).toContain("[data-role='run-spinner']");
    expect(css).not.toMatch(/\.conv-strip:hover\s+\.[^{]*run/);
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('does not render a model tag when the name is blank', () => {
    render(
      <ConvStrip
        status="error"
        icon={Bot}
        title="子代理 #35"
        role="整体实现终审"
        model="  "
        line2="出错"
      />,
    );
    expect(screen.queryByTestId('conv-strip-model')).toBeNull();
    expect(screen.getByText('出错')).toBeTruthy();
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
