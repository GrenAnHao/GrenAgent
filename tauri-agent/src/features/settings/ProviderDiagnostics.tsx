import { Button, Icon } from '@lobehub/ui';
import { Channel } from '@tauri-apps/api/core';
import { Input, Select, Switch } from 'antd';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Activity, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { pi, type DiagnoseResult } from '../../lib/pi';

const DEFAULT_PROMPT = 'Who are you?';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    margin-block-start: 24px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    overflow: hidden;
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 12px 14px;
    border: none;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    cursor: pointer;
    text-align: start;
    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  headerOpen: css`
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  title: css`
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  chevron: css`
    margin-inline-start: auto;
    color: ${cssVar.colorTextTertiary};
  `,
  body: css`
    padding: 16px 14px;
  `,
  desc: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    margin-block-end: 14px;
  `,
  field: css`
    margin-block-end: 12px;
    max-width: 520px;
  `,
  label: css`
    font-size: 13px;
    color: ${cssVar.colorText};
    margin-block-end: 6px;
  `,
  metrics: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 8px;
    margin-block: 12px 0;
    max-width: 720px;
  `,
  metric: css`
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
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
  metricOk: css`
    color: ${cssVar.colorSuccess};
  `,
  metricErr: css`
    color: ${cssVar.colorError};
  `,
  preview: css`
    margin-block-start: 10px;
    max-width: 720px;
    max-height: 200px;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: ${cssVar.colorTextSecondary};
  `,
  actions: css`
    display: flex;
    align-items: center;
    gap: 10px;
    margin-block-start: 4px;
  `,
}));

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms} ms`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return String(n);
}

function fmtRate(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n.toFixed(1)} tok/s`;
}

interface Props {
  providerId: string;
  modelIds: string[];
  hasApiKey: boolean;
}

export function ProviderDiagnostics({ providerId, modelIds, hasApiKey }: Props) {
  const [modelId, setModelId] = useState(modelIds[0] ?? '');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [stream, setStream] = useState(true);
  const [running, setRunning] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setModelId(modelIds[0] ?? '');
    setResult(null);
  }, [providerId, modelIds.join('|')]);

  const run = async () => {
    if (!modelId.trim() || !hasApiKey) return;
    setRunning(true);
    setResult(null);
    setStreamContent('');
    try {
      const onChunk = new Channel<string>();
      onChunk.onmessage = (chunk) => setStreamContent((prev) => prev + chunk);
      const out = await pi.diagnoseProviderModel(providerId, modelId.trim(), prompt, stream, onChunk);
      setResult(out);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e), content: '', ttftMs: 0, totalMs: 0 });
    } finally {
      setRunning(false);
    }
  };

  const options = modelIds.map((id) => ({ value: id, label: id }));

  return (
    <div className={styles.card} data-testid="prov-diagnostics">
      <button
        type="button"
        data-testid="prov-diag-toggle"
        className={cx(styles.header, open && styles.headerOpen)}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={Activity} size={14} />
        <span className={styles.title}>测活 / 诊断</span>
        <Icon icon={open ? ChevronDown : ChevronRight} size={16} className={styles.chevron} />
      </button>
      {open ? (
        <div className={styles.body}>
          <div className={styles.desc}>
            向当前供应商发送一条测试消息，测量连通性、首字耗时(TTFT)、总耗时与 token 速率（OpenAI 兼容接口支持流式指标）。
          </div>
          <div className={styles.field}>
            <div className={styles.label}>模型</div>
            <Select
              data-testid="prov-diag-model"
              disabled={!modelIds.length}
              options={options}
              placeholder={modelIds.length ? '选择模型' : '请先在上方添加模型'}
              style={{ width: '100%', maxWidth: 520 }}
              value={modelId || undefined}
              variant="filled"
              onChange={(v) => setModelId(String(v ?? ''))}
            />
          </div>
          <div className={styles.field}>
            <div className={styles.label}>提示词</div>
            <Input.TextArea
              data-testid="prov-diag-prompt"
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={DEFAULT_PROMPT}
              value={prompt}
              variant="filled"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div className={styles.field} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Switch checked={stream} onChange={setStream} size="small" data-testid="prov-diag-stream" />
            <span className={styles.label} style={{ marginBottom: 0 }}>
              {stream ? '流式（SSE）' : '非流式'}
            </span>
          </div>
          <div className={styles.actions}>
            <Button
              data-testid="prov-diag-run"
              disabled={running || !hasApiKey || !modelId.trim()}
              icon={running ? <Icon icon={Loader2} spin size={14} /> : <Icon icon={Activity} size={14} />}
              onClick={() => void run()}
              size="small"
              type="primary"
            >
              {running ? '测试中…' : '开始测活'}
            </Button>
            {!hasApiKey ? (
              <span style={{ fontSize: 12, color: cssVar.colorTextDescription }}>请先配置 API Key</span>
            ) : null}
          </div>
          {result ? (
            <>
              <div className={styles.metrics}>
                <div className={styles.metric}>
                  <div className={styles.metricLabel}>状态</div>
                  <div className={result.ok ? styles.metricOk : styles.metricErr}>
                    {result.ok ? '成功' : '失败'}
                  </div>
                </div>
                <div className={styles.metric}>
                  <div className={styles.metricLabel}>首字 (TTFT)</div>
                  <div className={styles.metricValue}>{fmtMs(result.ttftMs)}</div>
                </div>
                <div className={styles.metric}>
                  <div className={styles.metricLabel}>总耗时</div>
                  <div className={styles.metricValue}>{fmtMs(result.totalMs)}</div>
                </div>
                <div className={styles.metric}>
                  <div className={styles.metricLabel}>Prompt tokens</div>
                  <div className={styles.metricValue}>{fmtNum(result.promptTokens)}</div>
                </div>
                <div className={styles.metric}>
                  <div className={styles.metricLabel}>Completion tokens</div>
                  <div className={styles.metricValue}>{fmtNum(result.completionTokens)}</div>
                </div>
                <div className={styles.metric}>
                  <div className={styles.metricLabel}>速率</div>
                  <div className={styles.metricValue}>{fmtRate(result.tokensPerSec)}</div>
                </div>
              </div>
              {result.error ? (
                <div className={styles.preview} style={{ color: cssVar.colorError }}>
                  {result.error}
                </div>
              ) : null}
              {streamContent ? <pre className={styles.preview}>{streamContent}</pre> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
