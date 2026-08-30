import { Component, type ErrorInfo, type ReactNode } from 'react';

interface RootErrorBoundaryProps {
  children: ReactNode;
}

interface RootErrorBoundaryState {
  error: Error | null;
}

/**
 * 应用根错误边界：任何渲染期崩溃都在此兜住，显示可读错误 + 重载按钮，
 * 而不是让 index.html 的静态首屏（boot-splash）永久停在加载态。同时打日志，
 * 便于在 devtools / 启动终端看到真实堆栈。
 */
export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[GrenAgent] 应用渲染崩溃：', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        data-testid="root-error-boundary"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 99999,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#0b0d12',
          color: '#e6e6e6',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600 }}>应用启动出错</div>
        <pre
          style={{
            maxWidth: 720,
            maxHeight: '50vh',
            overflow: 'auto',
            margin: 0,
            padding: 12,
            borderRadius: 8,
            background: 'rgba(255,255,255,0.06)',
            color: '#ff9d9d',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.18)',
            background: '#4c8bf5',
            color: '#fff',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          重新加载
        </button>
      </div>
    );
  }
}
