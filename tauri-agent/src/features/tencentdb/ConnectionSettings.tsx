import { Alert, Button, Input, Segmented, Select } from 'antd';
import { Flexbox } from '@lobehub/ui';
import { createStyles } from 'antd-style';
import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_TENCENTDB_CONFIG,
  tencentdbApi,
  useTencentdbConnection,
  type TencentdbConnectionConfig,
} from './tencentdbApi';

const useStyles = createStyles(({ css, token }) => ({
  root: css`display: flex; flex-direction: column; gap: 16px; max-width: 720px;`,
  card: css`border: 1px solid ${token.colorBorderSecondary}; border-radius: ${token.borderRadiusLG}px; padding: 16px 20px;`,
  title: css`font-size: 14px; font-weight: 600; margin-block-end: 12px;`,
  label: css`font-size: 12px; color: ${token.colorTextSecondary}; margin-block-end: 5px;`,
  row: css`display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;`,
  field: css`min-width: 0;`,
  actions: css`display: flex; align-items: center; gap: 8px;`,
  meta: css`font-size: 12px; color: ${token.colorTextDescription};`,
}));

function blankConfig(config: TencentdbConnectionConfig | null): TencentdbConnectionConfig {
  return { ...DEFAULT_TENCENTDB_CONFIG, ...(config ?? {}) };
}

export function ConnectionSettings() {
  const { styles } = useStyles();
  const { config, status, loading, error, reload, setStatus } = useTencentdbConnection();
  const [draft, setDraft] = useState<TencentdbConnectionConfig>(DEFAULT_TENCENTDB_CONFIG);
  const [gatewayApiKey, setGatewayApiKey] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (config) setDraft(blankConfig(config));
  }, [config]);

  const stateLabel = useMemo(() => {
    if (!status) return '未连接';
    return { stopped: '已停止', starting: '启动中', ready: '已连接', failed: '失败' }[status.state] ?? status.state;
  }, [status]);

  const update = (key: keyof TencentdbConnectionConfig, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const next = await tencentdbApi.save({
        config: draft,
        gatewayApiKey: gatewayApiKey.trim() || undefined,
        llmApiKey: llmApiKey.trim() || undefined,
      });
      setStatus(next);
      setGatewayApiKey('');
      setLlmApiKey('');
      setMessage('连接配置已保存；密钥仅写入系统凭据库。');
      await reload();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setMessage(null);
    try {
      setStatus(await tencentdbApi.test());
      setMessage('连接测试成功。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div data-testid="tencentdb-connection-loading">加载连接配置…</div>;

  return (
    <Flexbox className={styles.root} data-testid="tencentdb-connection-settings">
      {error ? <Alert type="error" message={error} /> : null}
      {message ? <Alert type={message.includes('成功') || message.includes('已保存') ? 'success' : 'error'} message={message} /> : null}
      <div className={styles.card}>
        <div className={styles.title}>个人记忆空间</div>
        <Flexbox gap={12}>
          <div className={styles.field}>
            <div className={styles.label}>Gateway 模式</div>
            <Segmented
              block
              value={draft.mode}
              options={[{ label: '本机 local', value: 'local' }, { label: '远程 remote', value: 'remote' }]}
              onChange={(value) => update('mode', String(value))}
            />
          </div>
          <div className={styles.field}>
            <div className={styles.label}>远程端点（remote 必填）</div>
            <Input
              data-testid="tencentdb-endpoint"
              value={draft.endpoint}
              placeholder="https://memory.example.com"
              onChange={(event) => update('endpoint', event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <div className={styles.label}>Knowledge 端点（可选）</div>
            <Input
              data-testid="tencentdb-knowledge-endpoint"
              value={draft.knowledgeEndpoint ?? ''}
              placeholder="https://knowledge.example.com/v3"
              onChange={(event) => update('knowledgeEndpoint', event.target.value)}
            />
          </div>
          <div className={styles.row}>
            <div className={styles.field}><div className={styles.label}>Service ID</div><Input value={draft.serviceId} onChange={(e) => update('serviceId', e.target.value)} /></div>
            <div className={styles.field}><div className={styles.label}>Team ID</div><Input value={draft.teamId} onChange={(e) => update('teamId', e.target.value)} /></div>
            <div className={styles.field}><div className={styles.label}>Agent ID</div><Select style={{ width: '100%' }} value={draft.agentId} options={['pi-personal', 'coding', 'research'].map((value) => ({ value, label: value }))} onChange={(value) => update('agentId', value)} /></div>
            <div className={styles.field}><div className={styles.label}>User ID</div><Input value={draft.userId} onChange={(e) => update('userId', e.target.value)} /></div>
          </div>
          <div className={styles.row}>
            <div className={styles.field}><div className={styles.label}>可选 Task ID</div><Input value={draft.taskId ?? ''} onChange={(e) => update('taskId', e.target.value)} placeholder="Git remote 或项目 UUID" /></div>
            <div className={styles.field}><div className={styles.label}>本机 LLM Base URL</div><Input value={draft.llmBaseUrl ?? ''} onChange={(e) => update('llmBaseUrl', e.target.value)} placeholder="https://api.openai.com/v1" /></div>
          </div>
        </Flexbox>
      </div>
      <div className={styles.card}>
        <div className={styles.title}>凭据（留空表示保留已有值）</div>
        <Flexbox gap={12}>
          <div className={styles.field}><div className={styles.label}>Gateway API Key</div><Input.Password value={gatewayApiKey} onChange={(e) => setGatewayApiKey(e.target.value)} placeholder={status?.credentialConfigured ? '已配置，输入新值可替换' : '输入远程 Gateway 密钥'} /></div>
          <div className={styles.field}><div className={styles.label}>本机 LLM API Key</div><Input.Password value={llmApiKey} onChange={(e) => setLlmApiKey(e.target.value)} placeholder="仅本机 MemoryKnowledge 使用" /></div>
        </Flexbox>
      </div>
      <div className={styles.actions}>
        <Button type="primary" loading={saving} onClick={() => void save()}>保存配置</Button>
        <Button loading={testing} onClick={() => void test()}>测试连接</Button>
        <span className={styles.meta}>状态：{stateLabel}{status?.lastSuccessAt ? ` · 最近成功 ${new Date(status.lastSuccessAt).toLocaleString()}` : ''}</span>
      </div>
    </Flexbox>
  );
}
