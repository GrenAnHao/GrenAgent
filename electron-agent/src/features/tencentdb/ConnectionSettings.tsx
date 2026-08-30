import { Alert, Button, Input, Segmented } from 'antd';
import { Flexbox } from '@lobehub/ui';
import { createStyles } from 'antd-style';
import { ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { openUrl } from '../../platform/runtime';
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
  const [userApiKey, setUserApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [openingPanel, setOpeningPanel] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (config) setDraft(blankConfig(config));
  }, [config]);

  const stateLabel = useMemo(() => {
    if (!status) return '未连接';
    return { stopped: '已停止', starting: '启动中', ready: '已连接', failed: '失败', restart_required: '需重启应用' }[status.state] ?? status.state;
  }, [status]);

  const update = (key: keyof TencentdbConnectionConfig, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const updateMode = (mode: TencentdbConnectionConfig['mode']) => {
    setDraft((current) => ({
      ...current,
      mode,
      ...(mode === 'local' ? {
        endpoint: '',
        knowledgeEndpoint: undefined,
        teamId: DEFAULT_TENCENTDB_CONFIG.teamId,
        agentId: DEFAULT_TENCENTDB_CONFIG.agentId,
        userId: DEFAULT_TENCENTDB_CONFIG.userId,
      } : {}),
    }));
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const next = await tencentdbApi.save({
        config: draft,
        gatewayApiKey: gatewayApiKey.trim() || undefined,
        userApiKey: userApiKey.trim() || undefined,
      });
      setStatus(next);
      setGatewayApiKey('');
      setUserApiKey('');
      setMessage(
        next.restartRequired
          ? '连接配置已保存；当前工作区仍使用旧连接，请重启应用后生效。密钥仅写入系统凭据库。'
          : '连接配置已保存；密钥仅写入系统凭据库。',
      );
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

  const openPanel = async () => {
    if (openingPanel) return;
    setOpeningPanel(true);
    setMessage(null);
    try {
      const result = await tencentdbApi.openPanel();
      await openUrl(result.url);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpeningPanel(false);
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
              onChange={(value) => updateMode(value as TencentdbConnectionConfig['mode'])}
            />
          </div>
          {draft.mode === 'remote' ? (
            <div className={styles.row}>
              <div className={styles.field}>
                <div className={styles.label}>Core 端点（必填）</div>
                <Input
                  required
                  data-testid="tencentdb-endpoint"
                  value={draft.endpoint}
                  placeholder="https://memory.example.com"
                  onChange={(event) => update('endpoint', event.target.value)}
                />
              </div>
              <div className={styles.field}>
                <div className={styles.label}>Knowledge 端点（必填）</div>
                <Input
                  required
                  data-testid="tencentdb-knowledge-endpoint"
                  value={draft.knowledgeEndpoint ?? ''}
                  placeholder="https://knowledge.example.com/v3"
                  onChange={(event) => update('knowledgeEndpoint', event.target.value)}
                />
              </div>
            </div>
          ) : (
            <Alert type="info" showIcon message="本机运行时随应用启动和退出，并使用固定单用户身份" />
          )}
          <div className={styles.row}>
            <div className={styles.field}><div className={styles.label}>Service ID</div><Input data-testid="tencentdb-service-id" value={draft.serviceId} onChange={(e) => update('serviceId', e.target.value)} /></div>
            <div className={styles.field}><div className={styles.label}>Team ID</div><Input data-testid="tencentdb-team-id" disabled={draft.mode === 'local'} value={draft.teamId} onChange={(e) => update('teamId', e.target.value)} /></div>
            <div className={styles.field}><div className={styles.label}>Agent ID</div><Input data-testid="tencentdb-agent-id" disabled={draft.mode === 'local'} value={draft.agentId} onChange={(e) => update('agentId', e.target.value)} /></div>
            <div className={styles.field}><div className={styles.label}>User ID</div><Input data-testid="tencentdb-user-id" disabled={draft.mode === 'local'} value={draft.userId} onChange={(e) => update('userId', e.target.value)} /></div>
          </div>
          <div className={styles.field}><div className={styles.label}>可选 Task ID</div><Input value={draft.taskId ?? ''} onChange={(e) => update('taskId', e.target.value)} placeholder="Git remote 或项目 UUID" /></div>
        </Flexbox>
      </div>
      {draft.mode === 'remote' ? (
        <div className={styles.card}>
          <div className={styles.title}>凭据（留空表示保留已有值）</div>
          <Flexbox gap={12}>
            <div className={styles.row}>
              <div className={styles.field}><div className={styles.label}>Gateway API Key</div><Input.Password data-testid="tencentdb-gateway-key" value={gatewayApiKey} onChange={(e) => setGatewayApiKey(e.target.value)} placeholder={status?.credentialConfigured ? '已配置，输入新值可替换' : '输入远程 Gateway 密钥'} /></div>
              <div className={styles.field}><div className={styles.label}>User Key</div><Input.Password required data-testid="tencentdb-user-key" value={userApiKey} onChange={(e) => setUserApiKey(e.target.value)} placeholder={status?.userCredentialConfigured ? '已配置，输入新值可替换' : '输入 x-tdai-user-key'} /></div>
            </div>
          </Flexbox>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button type="primary" loading={saving} onClick={() => void save()}>保存配置</Button>
        <Button loading={testing} onClick={() => void test()}>测试连接</Button>
        <Button
          disabled={openingPanel}
          icon={<ExternalLink size={14} />}
          loading={openingPanel}
          onClick={() => void openPanel()}
        >
          打开原生后台
        </Button>
        <span className={styles.meta}>状态：{stateLabel}{status?.lastSuccessAt ? ` · 最近成功 ${new Date(status.lastSuccessAt).toLocaleString()}` : ''}</span>
      </div>
    </Flexbox>
  );
}
