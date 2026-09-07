import { useCallback, useEffect, useState } from 'react';
import { Copy, FolderOpen, RefreshCw } from 'lucide-react';
import { openPath } from '../../platform/runtime';
import { useSessionStore } from '../../store';
import { devApi, type DevRuntimeInfo } from '../../lib/devRuntime';
import { useAgentRegistryStore } from '../../stores/agentStoreRegistry';
import { styles } from './devtoolsStyles';
import { formatBytes, prettyJson } from './devtoolsFormat';

interface RendererMetrics {
  userAgent: string;
  viewport: string;
  pixelRatio: number;
  language: string;
  cores: number;
  domNodes: number;
  heapUsed: number | null;
  heapLimit: number | null;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  firstPaintMs: number | null;
  firstContentfulPaintMs: number | null;
  uptimeSec: number;
}

function readRendererMetrics(): RendererMetrics {
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const paints = performance.getEntriesByType('paint');
  // performance.memory 是 Chromium 的非标准扩展，且只在未启用高精度隔离时给出真实值。
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const paint = (name: string) => {
    const entry = paints.find((item) => item.name === name);
    return entry ? Math.round(entry.startTime) : null;
  };
  return {
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    pixelRatio: window.devicePixelRatio,
    language: navigator.language,
    cores: navigator.hardwareConcurrency ?? 0,
    domNodes: document.getElementsByTagName('*').length,
    heapUsed: memory?.usedJSHeapSize ?? null,
    heapLimit: memory?.jsHeapSizeLimit ?? null,
    domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
    loadMs: navigation ? Math.round(navigation.loadEventEnd) : null,
    firstPaintMs: paint('first-paint'),
    firstContentfulPaintMs: paint('first-contentful-paint'),
    uptimeSec: Math.round(performance.now() / 1000),
  };
}

export function RuntimeTab({ workspace }: { workspace: string }) {
  const [info, setInfo] = useState<DevRuntimeInfo | null>(null);
  const [metrics, setMetrics] = useState<RendererMetrics>(() => readRendererMetrics());
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await devApi.info());
      setMetrics(readRendererMetrics());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 自动刷新只更新渲染进程指标（DOM 节点数、堆占用这类会变的量）；主进程信息只在手动/首次刷新时取，
  // 避免每 2s 走一次 IPC。
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => setMetrics(readRendererMetrics()), 2000);
    return () => clearInterval(timer);
  }, [auto]);

  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const worksDir = useSessionStore((s) => s.worksDir);
  const sessionCount = useSessionStore((s) => s.sessions.length);
  const allSessionCount = useSessionStore((s) => s.allSessions.length);
  const runningWorkspaces = useAgentRegistryStore((s) => s.runningWorkspaces);

  const copyDiagnostics = async () => {
    const text = prettyJson({ main: info, renderer: metrics, workspace, activeSessionPath, runningWorkspaces });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('复制失败：剪贴板不可用');
    }
  };

  const heapRatio =
    metrics.heapUsed && metrics.heapLimit ? Math.min(100, (metrics.heapUsed / metrics.heapLimit) * 100) : null;

  return (
    <div className={styles.scroll} data-testid="dev-runtime-tab">
      {error ? <div className={styles.error} role="alert">{error}</div> : null}

      <div className={styles.toolbar} style={{ padding: '0 0 12px' }}>
        <button type="button" className={styles.button} onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={13} />
          {loading ? '刷新中…' : '刷新主进程信息'}
        </button>
        <button type="button" className={styles.button} onClick={() => void copyDiagnostics()}>
          <Copy size={13} />
          {copied ? '已复制' : '复制诊断信息'}
        </button>
        <label className={styles.hint} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          每 2s 刷新渲染进程指标
        </label>
      </div>

      <Section title="应用上下文" hint="当前前端状态">
        <Grid
          items={[
            ['活跃工作区', workspace || '(未打开)'],
            ['活跃会话', activeSessionPath ?? '(新建对话)'],
            ['works 目录', worksDir || '(未获取)'],
            ['当前项目会话数', String(sessionCount)],
            ['全量会话数', String(allSessionCount)],
            ['流式中工作区', runningWorkspaces.length ? runningWorkspaces.join(', ') : '无'],
          ]}
        />
      </Section>

      <Section title="主进程" hint={info ? `${info.appName} · PID ${info.pid}` : '未连接'}>
        {info ? (
          <Grid
            items={[
              ['应用版本', `${info.appVersion}${info.isPackaged ? '（已打包）' : '（开发模式）'}`],
              ['Electron / Chrome', `${info.electron} / ${info.chrome}`],
              ['Node / V8', `${info.node} / ${info.v8}`],
              ['平台 / 架构', `${info.platform} / ${info.arch}`],
              ['语言 / 窗口数', `${info.locale} / ${info.windowCount}`],
              ['主进程运行时间', `${info.uptimeSec}s`],
              ['主进程堆占用', `${formatBytes(info.memory.heapUsed)} / ${formatBytes(info.memory.heapTotal)}（RSS ${formatBytes(info.memory.rss)}）`],
              ['userData', info.paths.userData],
              ['日志目录', info.paths.logs],
              ['应用根目录', info.paths.appPath],
              ['工作目录', info.paths.cwd],
              ['ELECTRON_RENDERER_URL', info.env.rendererUrl ?? '(未设置，说明加载的是 dist)'],
              ['PI_CODING_AGENT_DIR', info.env.piAgentDir ?? '(未设置，走默认 ~/.pi/agent)'],
              ['NODE_ENV', info.env.nodeEnv || '(空)'],
            ]}
          />
        ) : (
          <div className={styles.state}>{error ? '主进程信息不可用（多半是生产构建，dev_* 命令未注册）' : '读取中…'}</div>
        )}
      </Section>

      {info ? (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            <h3 className={styles.heading}>目录</h3>
          </div>
          <div className={styles.toolbar} style={{ padding: 0, gap: 8 }}>
            <button type="button" className={styles.button} onClick={() => void openPath(info.paths.userData)}>
              <FolderOpen size={13} />
              userData
            </button>
            <button type="button" className={styles.button} onClick={() => void openPath(info.paths.logs)}>
              <FolderOpen size={13} />
              日志
            </button>
            <button type="button" className={styles.button} onClick={() => void openPath(info.paths.home)}>
              <FolderOpen size={13} />
              主目录
            </button>
            {workspace ? (
              <button type="button" className={styles.button} onClick={() => void openPath(workspace)}>
                <FolderOpen size={13} />
                当前工作区
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <Section title="渲染进程" hint={`已运行 ${metrics.uptimeSec}s`}>
        <Grid
          items={[
            ['视口 / DPR', `${metrics.viewport} @ ${metrics.pixelRatio}x`],
            ['语言 / 逻辑核数', `${metrics.language} / ${metrics.cores}`],
            ['DOM 节点数', String(metrics.domNodes)],
            ['JS 堆占用', metrics.heapUsed ? `${formatBytes(metrics.heapUsed)} / ${formatBytes(metrics.heapLimit)}` : '（当前环境不暴露 performance.memory）'],
            ['DOMContentLoaded', metrics.domContentLoadedMs === null ? '-' : `${metrics.domContentLoadedMs}ms`],
            ['load', metrics.loadMs === null ? '-' : `${metrics.loadMs}ms`],
            ['首次绘制 / 首次内容绘制', `${metrics.firstPaintMs ?? '-'}ms / ${metrics.firstContentfulPaintMs ?? '-'}ms`],
            ['User-Agent', metrics.userAgent],
          ]}
        />
        {heapRatio === null ? null : (
          <div className={styles.card} style={{ marginBlockStart: 8 }}>
            <div className={styles.meter}>
              <span style={{ flex: '0 0 62px' }}>堆占用</span>
              <div className={styles.meterBar}>
                <div className={styles.meterFill} style={{ width: `${heapRatio}%` }} />
              </div>
              <span className={styles.mono}>{heapRatio.toFixed(1)}%</span>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>
        <h3 className={styles.heading}>{title}</h3>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Grid({ items }: { items: Array<[string, string]> }) {
  return (
    <div className={styles.grid}>
      {items.map(([label, value]) => (
        <div key={label} className={styles.gridItem}>
          <span className={styles.gridLabel}>{label}</span>
          <span className={styles.gridValue}>{value}</span>
        </div>
      ))}
    </div>
  );
}
