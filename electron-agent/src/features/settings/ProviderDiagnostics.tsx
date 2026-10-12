import { Button, Icon } from '@lobehub/ui';
import { Input, Select, Switch } from 'antd';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Activity, ChevronDown, ChevronRight, ChevronUp, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { pi, type DiagnoseChunk, type DiagnoseResult } from '../../lib/pi';
import { Channel } from '../../platform/runtime';
import { useAvailableModelsState } from './availableModelsCache';
import {
  clampDockHeight,
  diagnosticLevelOptions,
  fmtMs,
  fmtNum,
  fmtRate,
  pickDiagnosticLevel,
  reasoningForLevel,
} from './providerDiagnosticsUtils';

const DEFAULT_PROMPT = 'Who are you?';
const DEFAULT_BODY_HEIGHT = 300;

// 测活层的开合与高度跨供应商、跨设置页保留；只在内存里，重启回默认。默认收起：进供应商详情先看设置，要测再点开。
let dockMemory = { open: false, height: DEFAULT_BODY_HEIGHT };
let requestSeq = 0;

const styles = createStaticStyles(({ css }) => ({
  dock: css`
    position: relative;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    max-height: calc(100% - 120px);
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgContainer};
  `,
  resizer: css`
    position: absolute;
    inset-block-start: -3px;
    inset-inline: 0;
    height: 6px;
    cursor: row-resize;
    z-index: 1;
    &:hover,
    &:active {
      background: ${cssVar.colorPrimaryBorder};
    }
  `,
  header: css`
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 9px 16px;
    border: none;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    cursor: pointer;
    text-align: start;
    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  title: css`
    font-size: var(--pi-font-size, 14px);
    font-weight: 600;
  `,
  status: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    font-variant-numeric: tabular-nums;
  `,
  ok: css`
    color: ${cssVar.colorSuccess};
  `,
  err: css`
    color: ${cssVar.colorError};
  `,
  chevron: css`
    margin-inline-start: auto;
    color: ${cssVar.colorTextTertiary};
  `,
  body: css`
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  controls: css`
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px 12px;
    margin-block-end: 10px;
  `,
  control: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  `,
  controlLabel: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  switchRow: css`
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    font-size: 13px;
    color: ${cssVar.colorText};
    white-space: nowrap;
  `,
  promptRow: css`
    display: flex;
    align-items: flex-end;
    gap: 10px;
  `,
  hint: css`
    margin-block-start: 8px;
    font-size: 12px;
    color: ${cssVar.colorWarning};
  `,
  metrics: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 8px;
    margin-block-start: 12px;
  `,
  metric: css`
    padding: 6px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
  `,
  metricLabel: css`
    font-size: 11px;
    color: ${cssVar.colorTextDescription};
    margin-block-end: 2px;
  `,
  metricValue: css`
    font-size: 14px;
    font-weight: 600;
    color: ${cssVar.colorText};
    font-variant-numeric: tabular-nums;
  `,
  blockToggle: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-block-start: 12px;
    padding: 0;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    cursor: pointer;
  `,
  output: css`
    margin: 8px 0 0;
    max-height: 220px;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: ${cssVar.colorText};
  `,
  thinkingOutput: css`
    color: ${cssVar.colorTextTertiary};
  `,
}));

interface Props {
  providerId: string;
  /** 设置有未保存的改动：测活走已保存的配置，要提醒。 */
  dirty: boolean;
  /** 自定义供应商没填 API Key：只提醒，不拦（可能走环境变量）。 */
  missingKey: boolean;
}

export function ProviderDiagnostics({ providerId, dirty, missingKey }: Props) {
  const { models: catalog, loading } = useAvailableModelsState(undefined);
  const providerModels = useMemo(() => (catalog ?? []).filter((m) => m.provider === providerId), [catalog, providerId]);
  const [open, setOpen] = useState(dockMemory.open);
  const [height, setHeight] = useState(dockMemory.height);
  const [modelId, setModelId] = useState('');
  const [level, setLevel] = useState('off');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [stream, setStream] = useState(true);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [liveText, setLiveText] = useState('');
  const [liveThinking, setLiveThinking] = useState('');
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const activeRef = useRef<string | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  const model = providerModels.find((m) => m.id === modelId);
  const levels = useMemo(() => diagnosticLevelOptions(model), [model]);

  // 换供应商：停掉在飞的请求，晚到的分片和结果都丢弃。
  useEffect(() => {
    setResult(null);
    setLiveText('');
    setLiveThinking('');
    setRunning(false);
    setCancelling(false);
    return () => {
      const id = activeRef.current;
      activeRef.current = null;
      if (id) void pi.abortDiagnoseProviderModel(id).catch(() => {});
    };
  }, [providerId]);

  useEffect(() => {
    if (!providerModels.some((m) => m.id === modelId)) setModelId(providerModels[0]?.id ?? '');
  }, [providerModels, modelId]);

  useEffect(() => {
    setLevel((current) => pickDiagnosticLevel(model, current));
  }, [model]);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - started), 100);
    return () => clearInterval(timer);
  }, [running]);

  const toggleOpen = () => {
    dockMemory = { ...dockMemory, open: !open };
    setOpen(!open);
  };

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = height;
    const container = dockRef.current?.parentElement?.clientHeight ?? 0;
    const move = (ev: PointerEvent) => {
      const next = clampDockHeight(startHeight + startY - ev.clientY, container);
      dockMemory = { ...dockMemory, height: next };
      setHeight(next);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const run = async () => {
    if (!modelId || running) return;
    const requestId = `diag-${Date.now().toString(36)}-${(requestSeq++).toString(36)}`;
    activeRef.current = requestId;
    setRunning(true);
    setCancelling(false);
    setResult(null);
    setLiveText('');
    setLiveThinking('');
    const onChunk = new Channel<DiagnoseChunk>();
    onChunk.onmessage = (chunk) => {
      if (activeRef.current !== requestId) return;
      if (chunk.type === 'thinking') setLiveThinking((prev) => prev + chunk.text);
      else setLiveText((prev) => prev + chunk.text);
    };
    let out: DiagnoseResult;
    try {
      out = await pi.diagnoseProviderModel(
        { requestId, providerId, modelId, prompt, stream, reasoning: reasoningForLevel(level) },
        onChunk,
      );
    } catch (e) {
      out = { ok: false, error: e instanceof Error ? e.message : String(e), content: '', ttftMs: 0, totalMs: 0 };
    }
    if (activeRef.current !== requestId) return;
    activeRef.current = null;
    setResult(out);
    setRunning(false);
    setCancelling(false);
  };

  // 主进程收到取消立即返回 cancelled 结果（不等卡住的供应商），这里只发信号。
  const cancel = () => {
    const id = activeRef.current;
    if (!id) return;
    setCancelling(true);
    void pi.abortDiagnoseProviderModel(id).catch(() => {});
  };

  const onPromptKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void run();
    }
  };

  const hint = !loading && providerModels.length === 0
    ? dirty ? '保存后才能测活：测活走已保存的配置。' : '这个供应商暂无可用模型，先添加模型并保存。'
    : dirty
      ? '有未保存的改动，测活使用的是已保存的配置。'
      : missingKey
        ? '没有填写 API Key，请求多半会被拒绝。'
        : null;

  const content = result ? result.content : liveText;
  const thinking = result ? (result.thinking ?? '') : liveThinking;
  const status = running
    ? <span className={styles.status}>{cancelling ? '正在取消…' : `测试中 ${fmtMs(elapsedMs)}`}</span>
    : result?.cancelled
      ? <span className={styles.status}>已取消</span>
      : result
        ? <span className={cx(styles.status, result.ok ? styles.ok : styles.err)}>{result.ok ? `成功 · ${fmtMs(result.totalMs)}` : '失败'}</span>
        : null;

  return (
    <div ref={dockRef} className={styles.dock} data-testid="prov-diagnostics">
      {open ? (
        <div
          aria-label="拖动调整测活区高度"
          aria-orientation="horizontal"
          className={styles.resizer}
          data-testid="prov-diag-resizer"
          role="separator"
          onPointerDown={startResize}
        />
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        className={styles.header}
        data-testid="prov-diag-toggle"
        onClick={toggleOpen}
      >
        <Icon icon={Activity} size={14} />
        <span className={styles.title}>模型测活 / 诊断</span>
        {status}
        <Icon icon={open ? ChevronDown : ChevronUp} size={16} className={styles.chevron} />
      </button>
      {open ? (
        <div className={styles.body} data-testid="prov-diag-body" style={{ height }}>
          <div className={styles.controls}>
            <div className={styles.control} style={{ flex: '1 1 260px' }}>
              <span className={styles.controlLabel}>模型</span>
              <Select
                data-testid="prov-diag-model"
                disabled={running || providerModels.length === 0}
                loading={loading}
                options={providerModels.map((m) => ({ value: m.id, label: m.id }))}
                placeholder={loading ? '加载模型…' : '没有可测的模型'}
                showSearch
                value={modelId || undefined}
                variant="filled"
                onChange={(v) => setModelId(String(v ?? ''))}
              />
            </div>
            <div className={styles.control} style={{ flex: '0 0 168px' }}>
              <span className={styles.controlLabel}>思考档位</span>
              <Select
                data-testid="prov-diag-level"
                disabled={running || !model}
                options={levels}
                value={level}
                variant="filled"
                onChange={(v) => setLevel(String(v))}
              />
            </div>
            <div className={styles.control}>
              <span className={styles.controlLabel}>输出</span>
              <span className={styles.switchRow}>
                <Switch checked={stream} data-testid="prov-diag-stream" disabled={running} size="small" onChange={setStream} />
                {stream ? '流式' : '完成后显示'}
              </span>
            </div>
          </div>
          <div className={styles.promptRow}>
            <Input.TextArea
              autoSize={{ minRows: 1, maxRows: 4 }}
              data-testid="prov-diag-prompt"
              placeholder={DEFAULT_PROMPT}
              value={prompt}
              variant="filled"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onPromptKeyDown}
            />
            {running ? (
              <Button
                danger
                data-testid="prov-diag-cancel"
                disabled={cancelling}
                icon={<Icon icon={Square} size={12} />}
                onClick={cancel}
              >
                取消
              </Button>
            ) : (
              <Button
                data-testid="prov-diag-run"
                disabled={!modelId}
                icon={<Icon icon={Activity} size={14} />}
                title="Ctrl+Enter 发送"
                type="primary"
                onClick={() => void run()}
              >
                开始测活
              </Button>
            )}
          </div>
          {hint ? <div className={styles.hint}>{hint}</div> : null}
          {result && !result.cancelled ? <DiagnoseMetrics result={result} /> : null}
          {thinking ? (
            <>
              <button
                type="button"
                aria-expanded={thinkingOpen}
                className={styles.blockToggle}
                data-testid="prov-diag-thinking-toggle"
                onClick={() => setThinkingOpen((v) => !v)}
              >
                <Icon icon={thinkingOpen ? ChevronDown : ChevronRight} size={14} />
                思考过程 · {thinking.length} 字
              </button>
              {thinkingOpen ? (
                <pre className={cx(styles.output, styles.thinkingOutput)} data-testid="prov-diag-thinking">{thinking}</pre>
              ) : null}
            </>
          ) : null}
          {content ? (
            <pre className={styles.output} data-testid="prov-diag-output">{content}{running ? '▌' : ''}</pre>
          ) : null}
          {result?.error ? (
            <pre className={cx(styles.output, styles.err)} data-testid="prov-diag-error">{result.error}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DiagnoseMetrics({ result }: { result: DiagnoseResult }) {
  const items: [string, string][] = [
    ['首字 (TTFT)', result.ttftMs ? fmtMs(result.ttftMs) : '—'],
    ['总耗时', fmtMs(result.totalMs)],
    ['输入 tokens', fmtNum(result.promptTokens)],
    ['输出 tokens', fmtNum(result.completionTokens)],
    ...(result.reasoningTokens != null ? [['思考 tokens', fmtNum(result.reasoningTokens)] as [string, string]] : []),
    ['速率', fmtRate(result.tokensPerSec)],
  ];
  return (
    <div className={styles.metrics} data-testid="prov-diag-metrics">
      {items.map(([label, value]) => (
        <div key={label} className={styles.metric}>
          <div className={styles.metricLabel}>{label}</div>
          <div className={styles.metricValue}>{value}</div>
        </div>
      ))}
    </div>
  );
}
