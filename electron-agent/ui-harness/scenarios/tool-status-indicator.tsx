import { useEffect, useState } from 'react';
import { StatusIndicator, type StatusKind } from '../../src/features/tools/StatusIndicator';
import { exposeActions } from '../stubs';

const labels = { running: '运行中', done: '已完成', error: '失败' } as const;
type State = Extract<StatusKind, keyof typeof labels>;

function Row({ name, status, live }: { name: string; status: State; live?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 44 }}>
      <div data-testid={live ? 'live-indicator' : undefined}><StatusIndicator status={status} /></div>
      <span style={{ flex: 1 }}>{name}</span>
      <span style={{ color: 'var(--gren-text-secondary)', fontSize: 12 }}>{labels[status]}</span>
    </div>
  );
}

export default function ToolStatusScenario() {
  const [status, setStatus] = useState<State>('running');
  useEffect(() => { exposeActions({ setStatus }); }, []);
  return (
    <main style={{ padding: '16px 24px', height: '100vh', boxSizing: 'border-box', background: 'var(--gren-content-bg)', color: 'var(--gren-text)' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 14 }}>工具调用</h2>
      <Row name="搜索代码" status={status} live />
      <Row name="读取文件" status="done" />
      <Row name="运行命令" status="error" />
    </main>
  );
}
